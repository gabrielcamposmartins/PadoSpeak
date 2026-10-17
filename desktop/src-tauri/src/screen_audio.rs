//! Som da transmissão de tela, capturado pelo Windows (WASAPI "process loopback", Windows 10 2004+):
//! - **janela**: só o som do programa dono da janela (e dos processos filhos dele — ex.: o Chrome toca
//!   o som num processo filho);
//! - **tela inteira**: o som do sistema todo **menos o do PadoSpeak** (as vozes da chamada não voltam
//!   para quem assiste). O som do app sai do processo do WebView2 (msedgewebview2.exe, filho do app),
//!   que para o Windows não faz parte da "árvore" do app: é ele que fica de fora.
//! O áudio (48 kHz, estéreo, 16 bits) vai para a página em pedaços de 50 ms por um canal do Tauri; lá
//! um AudioWorklet vira a trilha de áudio da transmissão (client/src/lib/screenAudio.js).
use serde_json::{json, Value};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use tauri::ipc::{Channel, InvokeResponseBody};

/// Captura atual; uma nova (ou parar) troca o número e a anterior termina sozinha.
#[derive(Default)]
pub struct ScreenAudio(Arc<AtomicU64>);

const RATE: usize = 48_000;
const CHANNELS: usize = 2;
/// 50 ms por pedaço: cada pedaço passa pela thread principal (que é a das janelas) para chegar à página;
/// com 20 ms eram 50 por segundo e a janela do PadoSpeak pesava durante a transmissão com som.
const CHUNK_FRAMES: usize = RATE / 20;

/// `async`: esperar o Windows aceitar a captura (até 5 s) não pode segurar a thread principal, que é a
/// das janelas (o PadoSpeak inteiro travava ao transmitir uma janela com som).
#[tauri::command]
pub async fn screen_audio_start(
    state: tauri::State<'_, ScreenAudio>,
    hwnd: Option<u64>,
    title: Option<String>,
    on_data: Channel<InvokeResponseBody>,
) -> Result<Value, String> {
    // A janela vem pelo HWND (rótulo "window:<HWND>:0" da trilha) ou, se não, pelo título dela.
    let hwnd = hwnd.or_else(|| title.as_deref().filter(|t| !t.trim().is_empty()).and_then(win::find_by_title));
    let (pid, include, label) = target(hwnd)?;
    let gen = state.0.fetch_add(1, Ordering::SeqCst) + 1;
    let current = state.0.clone();
    let (ready_tx, ready_rx) = std::sync::mpsc::channel::<Result<(), String>>();
    std::thread::Builder::new()
        .name("som-da-transmissao".into())
        .spawn(move || capture(pid, include, gen, current, on_data, ready_tx))
        .map_err(|e| e.to_string())?;
    // Espera o Windows aceitar (ou recusar) antes de responder, numa thread de espera.
    tauri::async_runtime::spawn_blocking(move || ready_rx.recv_timeout(std::time::Duration::from_secs(5)))
        .await
        .map_err(|e| e.to_string())?
        .map_err(|_| "O Windows não respondeu".to_string())??;
    Ok(json!({ "mode": if include { "window" } else { "system" }, "source": label }))
}

#[tauri::command]
pub fn screen_audio_stop(state: tauri::State<'_, ScreenAudio>) {
    state.0.fetch_add(1, Ordering::SeqCst);
}

/// Processo alvo: o dono da janela (incluir) ou o WebView2 do PadoSpeak (excluir, para a tela inteira).
/// O processo principal do WebView2 deste app (é dele a barra de "compartilhando", veja `share_bar.rs`).
pub fn webview_pid() -> Option<u32> {
    win::webview_pid()
}

fn target(hwnd: Option<u64>) -> Result<(u32, bool, String), String> {
    match hwnd {
        Some(h) => {
            let pid = win::window_pid(h).ok_or("Janela não encontrada")?;
            let exe = crate::activity::exe_of(pid).unwrap_or_default();
            let name = exe.rsplit(['\\', '/']).next().unwrap_or_default().to_string();
            Ok((pid, true, name))
        }
        None => Ok((win::webview_pid().unwrap_or_else(std::process::id), false, String::new())),
    }
}

#[cfg(windows)]
fn capture(
    pid: u32,
    include: bool,
    gen: u64,
    current: Arc<AtomicU64>,
    out: Channel<InvokeResponseBody>,
    ready: std::sync::mpsc::Sender<Result<(), String>>,
) {
    use std::collections::VecDeque;
    use wasapi::{AudioClient, Direction, SampleType, StreamMode, WaveFormat};

    let _ = wasapi::initialize_mta();
    let setup = || -> Result<_, String> {
        let mut client = AudioClient::new_application_loopback_client(pid, include).map_err(|e| e.to_string())?;
        let format = WaveFormat::new(16, 16, &SampleType::Int, RATE, CHANNELS, None);
        let mode = StreamMode::EventsShared { autoconvert: true, buffer_duration_hns: 0 };
        client.initialize_client(&format, &Direction::Capture, &mode).map_err(|e| e.to_string())?;
        let event = client.set_get_eventhandle().map_err(|e| e.to_string())?;
        let capture = client.get_audiocaptureclient().map_err(|e| e.to_string())?;
        client.start_stream().map_err(|e| e.to_string())?;
        Ok((client, event, capture))
    };
    let (client, event, capture) = match setup() {
        Ok(v) => {
            let _ = ready.send(Ok(()));
            v
        }
        Err(e) => {
            let _ = ready.send(Err(format!("Captura de som indisponível: {e}")));
            return;
        }
    };
    let chunk_bytes = CHUNK_FRAMES * CHANNELS * 2;
    let mut queue: VecDeque<u8> = VecDeque::with_capacity(chunk_bytes * 8);
    while current.load(Ordering::SeqCst) == gen {
        // Sem som tocando, o Windows não manda nada: o tempo limite só serve para ver se é para parar.
        let _ = event.wait_for_event(100);
        loop {
            match capture.get_next_packet_size() {
                Ok(Some(n)) if n > 0 => {}
                _ => break,
            }
            let before = queue.len();
            match capture.read_from_device_to_deque(&mut queue) {
                Ok(info) if info.flags.silent => queue.range_mut(before..).for_each(|b| *b = 0),
                Ok(_) => {}
                Err(_) => break,
            }
        }
        while queue.len() >= chunk_bytes {
            let chunk: Vec<u8> = queue.drain(..chunk_bytes).collect();
            if out.send(InvokeResponseBody::Raw(chunk)).is_err() {
                current.fetch_add(1, Ordering::SeqCst);
                break;
            }
        }
    }
    let _ = client.stop_stream();
}

#[cfg(not(windows))]
fn capture(
    _pid: u32,
    _include: bool,
    _gen: u64,
    _current: Arc<AtomicU64>,
    _out: Channel<InvokeResponseBody>,
    ready: std::sync::mpsc::Sender<Result<(), String>>,
) {
    let _ = ready.send(Err("Disponível só no Windows".into()));
}

#[cfg(windows)]
mod win {
    use windows::Win32::Foundation::HWND;
    use windows::Win32::UI::WindowsAndMessaging::{GetWindowThreadProcessId, IsWindow};

    /// Janela de nível superior visível com exatamente este título.
    pub fn find_by_title(title: &str) -> Option<u64> {
        use windows::core::BOOL;
        use windows::Win32::Foundation::LPARAM;
        use windows::Win32::UI::WindowsAndMessaging::{EnumWindows, GetWindowTextW, IsWindowVisible};
        struct Search {
            title: Vec<u16>,
            found: Option<u64>,
        }
        unsafe extern "system" fn each(h: HWND, l: LPARAM) -> BOOL {
            let search = unsafe { &mut *(l.0 as *mut Search) };
            let mut buf = [0u16; 512];
            let n = unsafe { GetWindowTextW(h, &mut buf) }.max(0) as usize;
            if buf[..n] == search.title[..] && unsafe { IsWindowVisible(h) }.as_bool() {
                search.found = Some(h.0 as usize as u64);
                return BOOL(0);
            }
            BOOL(1)
        }
        let mut search = Search { title: title.encode_utf16().collect(), found: None };
        unsafe {
            let _ = EnumWindows(Some(each), LPARAM(&mut search as *mut Search as isize));
        }
        search.found
    }

    /// O processo principal do WebView2 deste app (msedgewebview2.exe filho direto do app): é de onde
    /// sai todo o som do PadoSpeak (vozes, sons de aviso, música).
    pub fn webview_pid() -> Option<u32> {
        use windows::Win32::Foundation::CloseHandle;
        use windows::Win32::System::Diagnostics::ToolHelp::{
            CreateToolhelp32Snapshot, Process32FirstW, Process32NextW, PROCESSENTRY32W, TH32CS_SNAPPROCESS,
        };
        let me = std::process::id();
        unsafe {
            let snap = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0).ok()?;
            let mut entry = PROCESSENTRY32W { dwSize: size_of::<PROCESSENTRY32W>() as u32, ..Default::default() };
            let mut found = None;
            let mut ok = Process32FirstW(snap, &mut entry).is_ok();
            while ok {
                let len = entry.szExeFile.iter().position(|&c| c == 0).unwrap_or(entry.szExeFile.len());
                let name = String::from_utf16_lossy(&entry.szExeFile[..len]);
                if entry.th32ParentProcessID == me && name.eq_ignore_ascii_case("msedgewebview2.exe") {
                    found = Some(entry.th32ProcessID);
                    break;
                }
                ok = Process32NextW(snap, &mut entry).is_ok();
            }
            let _ = CloseHandle(snap);
            found
        }
    }

    pub fn window_pid(hwnd: u64) -> Option<u32> {
        unsafe {
            let h = HWND(hwnd as usize as *mut _);
            if !IsWindow(Some(h)).as_bool() {
                return None;
            }
            let mut pid = 0u32;
            GetWindowThreadProcessId(h, Some(&mut pid));
            (pid != 0).then_some(pid)
        }
    }
}

#[cfg(not(windows))]
mod win {
    pub fn window_pid(_hwnd: u64) -> Option<u32> {
        None
    }
    pub fn find_by_title(_title: &str) -> Option<u64> {
        None
    }
    pub fn webview_pid() -> Option<u32> {
        None
    }
}
