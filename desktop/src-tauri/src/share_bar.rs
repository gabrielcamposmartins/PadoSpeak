//! Esconde a barra "… está compartilhando … / Parar compartilhamento / Ocultar" que o WebView2 abre ao
//! transmitir a tela: o dock do PadoSpeak (dock.html) faz esse papel, com Trocar, Som e Parar. Só mexe
//! nas janelas do WebView2 deste app (o msedgewebview2.exe filho dele) cujo título é esse aviso; o
//! seletor de tela e as janelas de outros programas ficam como estão.
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::Duration;

/// Ligada enquanto a transmissão dura.
#[derive(Default)]
pub struct ShareBar(Arc<AtomicBool>);

impl ShareBar {
    pub fn set(&self, on: bool) {
        if !on {
            self.0.store(false, Ordering::SeqCst);
            return;
        }
        if self.0.swap(true, Ordering::SeqCst) {
            return; // já está escondendo
        }
        let on = self.0.clone();
        let _ = std::thread::Builder::new().name("barra-do-webview2".into()).spawn(move || {
            let mut browser = None;
            while on.load(Ordering::SeqCst) {
                browser = browser.or_else(crate::screen_audio::webview_pid);
                if let Some(pid) = browser {
                    win::hide_notices(pid);
                }
                // A barra volta a cada transmissão nova (e ao trocar o que transmite): fica de olho.
                std::thread::sleep(Duration::from_millis(300));
            }
        });
    }
}

/// O título da barra é o próprio aviso ("tauri.localhost está compartilhando uma janela.").
fn is_share_notice(title: &str) -> bool {
    let t = title.to_lowercase();
    ["está compartilhando", "esta compartilhando", "is sharing", "compartilhando sua tela", "compartilhando uma"]
        .iter()
        .any(|k| t.contains(k))
}

#[cfg(windows)]
mod win {
    use windows::core::BOOL;
    use windows::Win32::Foundation::{HWND, LPARAM};
    use windows::Win32::UI::WindowsAndMessaging::{EnumWindows, GetWindowTextW, GetWindowThreadProcessId, IsWindowVisible, ShowWindow, SW_HIDE};

    /// Esconde as janelas visíveis do processo `pid` (o WebView2 do app) que são o aviso de compartilhamento.
    pub fn hide_notices(pid: u32) {
        unsafe extern "system" fn each(hwnd: HWND, l: LPARAM) -> BOOL {
            let want = *(l.0 as *const u32);
            if IsWindowVisible(hwnd).as_bool() {
                let mut owner = 0u32;
                GetWindowThreadProcessId(hwnd, Some(&mut owner));
                if owner == want {
                    let mut title = [0u16; 256];
                    let n = GetWindowTextW(hwnd, &mut title).max(0) as usize;
                    if super::is_share_notice(&String::from_utf16_lossy(&title[..n])) {
                        let _ = ShowWindow(hwnd, SW_HIDE);
                    }
                }
            }
            true.into()
        }
        unsafe {
            let _ = EnumWindows(Some(each), LPARAM(&pid as *const u32 as isize));
        }
    }
}

#[cfg(not(windows))]
mod win {
    pub fn hide_notices(_pid: u32) {}
}

#[cfg(test)]
mod tests {
    use super::is_share_notice;

    #[test]
    fn reconhece_o_aviso() {
        assert!(is_share_notice("tauri.localhost está compartilhando uma janela."));
        assert!(is_share_notice("tauri.localhost está compartilhando sua tela."));
        assert!(is_share_notice("tauri.localhost is sharing your screen."));
        assert!(!is_share_notice("Escolha o que compartilhar"));
        assert!(!is_share_notice("PadoSpeak"));
        assert!(!is_share_notice(""));
    }
}
