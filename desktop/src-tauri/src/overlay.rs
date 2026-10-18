//! Sobreposição nos jogos: uma janela transparente, sempre por cima e que não recebe cliques, com as
//! fotos de quem está na chamada (em coluna, à esquerda) e a música tocando (no canto de cima). Aparece
//! só enquanto o jogo detectado para a atividade (veja `activity.rs`) está em foco, na tela dele.
//! O conteúdo vem da janela principal por eventos (overlay.html, veja client/src/lib/gameOverlay.js).
//! Em tela cheia ela aparece nos jogos que usam a tela cheia otimizada do Windows 10/11 (a maioria dos
//! DirectX 11/12): como alguns jogos se colocam por cima de novo, ela se recoloca por cima a cada segundo.
//! A tela cheia exclusiva antiga (DirectX 9, ou com a otimização desligada) não deixa nenhuma janela por
//! cima; só injetando código no jogo, o que os anti-cheats punem, então não fazemos.
use crate::activity;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tauri::{AppHandle, Manager, PhysicalPosition, PhysicalSize, WebviewWindow};

pub const LABEL: &str = "game-overlay";
/// Largura da faixa da esquerda (pixels lógicos): cabe o nome da música e a coluna de fotos.
const WIDTH: f64 = 360.0;

#[derive(Default)]
pub struct Overlay {
    /// A pessoa ligou a opção e está numa chamada.
    on: AtomicBool,
    /// Do lado direito da tela (escolhido em Configurações; o canto de cima ou de baixo é da página).
    right: AtomicBool,
    /// Jogos sem sobreposição (nome do status, em minúsculas), escolhidos em Configurações.
    blocked: Mutex<Vec<String>>,
}

pub type Shared = Arc<Overlay>;

impl Overlay {
    pub fn set(&self, on: bool, right: bool) {
        self.on.store(on, Ordering::Relaxed);
        self.right.store(right, Ordering::Relaxed);
    }

    pub fn set_blocked(&self, names: Vec<String>) {
        *self.blocked.lock().unwrap() = names.iter().map(|n| n.trim().to_lowercase()).filter(|n| !n.is_empty()).collect();
    }

    fn is_blocked(&self, game: &str) -> bool {
        let game = game.trim().to_lowercase();
        self.blocked.lock().unwrap().iter().any(|n| *n == game)
    }
}

/// Faixa da sobreposição (x, y, largura, altura em pixels) na tela onde está o centro do jogo, à esquerda
/// ou à direita (`right`). `monitors`: (x, y, largura, altura, escala) de cada tela.
fn strip(game: (i32, i32, i32, i32), monitors: &[(i32, i32, u32, u32, f64)], right: bool) -> Option<(i32, i32, u32, u32)> {
    let (cx, cy) = ((game.0 + game.2) / 2, (game.1 + game.3) / 2);
    let inside = |m: &&(i32, i32, u32, u32, f64)| cx >= m.0 && cy >= m.1 && cx < m.0 + m.2 as i32 && cy < m.1 + m.3 as i32;
    let m = monitors.iter().find(inside).or(monitors.first())?;
    // Jogo em janela menor que a tela: a faixa fica dentro da janela do jogo.
    let left = game.0.max(m.0);
    let edge = game.2.min(m.0 + m.2 as i32);
    let top = game.1.max(m.1);
    let bottom = game.3.min(m.1 + m.3 as i32);
    let width = ((WIDTH * m.4).round() as u32).min(m.2).min((edge - left).max(0) as u32);
    let x = if right { edge - width as i32 } else { left };
    (bottom > top && width > 0).then_some((x, top, width, (bottom - top) as u32))
}

/// Retângulo da janela do jogo, se ele está em foco agora (e não está na lista de jogos sem sobreposição).
fn focused_game(games: &activity::Shared, overlay: &Overlay) -> Option<(i32, i32, i32, i32)> {
    let pid = {
        let current = games.current.lock().unwrap();
        let game = current.as_ref()?;
        if overlay.is_blocked(&game.name) {
            return None;
        }
        game.pid()
    };
    let (hwnd, fg) = activity::foreground_window()?;
    if fg != pid {
        return None;
    }
    activity::window_rect(hwnd)
}

fn build(app: &AppHandle) -> Option<WebviewWindow> {
    if let Some(w) = app.get_webview_window(LABEL) {
        return Some(w);
    }
    let mut b = tauri::WebviewWindowBuilder::new(app, LABEL, tauri::WebviewUrl::App("overlay.html".into()))
        .title("PadoSpeak — sobreposição")
        .decorations(false)
        .transparent(true)
        .shadow(false)
        .resizable(false)
        .always_on_top(true)
        .skip_taskbar(true)
        // Não entra nas transmissões de tela (nem na sua).
        .content_protected(true)
        .focused(false)
        .focusable(false)
        .visible(false);
    // Todas as janelas do WebView2 precisam dos mesmos argumentos do navegador.
    if let Some(args) = app.config().app.windows.iter().find(|c| c.label == "main").and_then(|c| c.additional_browser_args.clone()) {
        b = b.additional_browser_args(&args);
    }
    let w = b.build().map_err(|e| eprintln!("[sobreposição] {e}")).ok()?;
    // Os cliques passam direto para o jogo.
    let _ = w.set_ignore_cursor_events(true);
    Some(w)
}

/// Mostra sem tirar o foco do jogo e por cima dele.
fn show(w: &WebviewWindow, (x, y, width, height): (i32, i32, u32, u32)) {
    let _ = w.set_position(PhysicalPosition::new(x, y));
    let _ = w.set_size(PhysicalSize::new(width, height));
    #[cfg(windows)]
    if let Ok(h) = w.hwnd() {
        use windows::Win32::Foundation::HWND;
        use windows::Win32::UI::WindowsAndMessaging::{ShowWindow, SW_SHOWNOACTIVATE};
        unsafe {
            let _ = ShowWindow(HWND(h.0), SW_SHOWNOACTIVATE);
        }
        raise(w);
        return;
    }
    let _ = w.show();
}

/// Esconde pelo próprio Windows, como foi mostrada (`show`). O `hide()` do Tauri não servia: a janela
/// nasceu invisível e foi mostrada por fora dele, então ele achava que ela já estava escondida e não
/// fazia nada (a sobreposição ficava por cima de tudo depois do primeiro jogo).
fn conceal(w: &WebviewWindow) {
    #[cfg(windows)]
    if let Ok(h) = w.hwnd() {
        use windows::Win32::Foundation::HWND;
        use windows::Win32::UI::WindowsAndMessaging::{IsWindowVisible, ShowWindow, SW_HIDE};
        let hwnd = HWND(h.0);
        unsafe {
            if IsWindowVisible(hwnd).as_bool() {
                let _ = ShowWindow(hwnd, SW_HIDE);
            }
        }
        return;
    }
    let _ = w.hide();
}

/// Põe (de novo) por cima de tudo, sem tirar o foco do jogo: jogos em tela cheia se colocam por cima.
fn raise(w: &WebviewWindow) {
    #[cfg(windows)]
    if let Ok(h) = w.hwnd() {
        use windows::Win32::Foundation::HWND;
        use windows::Win32::UI::WindowsAndMessaging::{SetWindowPos, HWND_TOPMOST, SWP_NOACTIVATE, SWP_NOMOVE, SWP_NOSIZE};
        unsafe {
            let _ = SetWindowPos(HWND(h.0), Some(HWND_TOPMOST), 0, 0, 0, 0, SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE);
        }
    }
    #[cfg(not(windows))]
    let _ = w;
}

pub fn spawn(app: AppHandle, games: activity::Shared) -> Shared {
    let overlay: Shared = Arc::default();
    let me = overlay.clone();
    std::thread::Builder::new()
        .name("sobreposição".into())
        .spawn(move || {
            let mut last_game = None;
            let mut last_right = false;
            let mut shown: Option<(i32, i32, u32, u32)> = None;
            let mut tick: u32 = 0;
            loop {
                std::thread::sleep(Duration::from_millis(250));
                tick = tick.wrapping_add(1);
                if !me.on.load(Ordering::Relaxed) {
                    // Opção desligada ou fora da chamada: fecha a janela (libera a memória dela).
                    if let Some(w) = app.get_webview_window(LABEL) {
                        let _ = w.close();
                    }
                    shown = None;
                    last_game = None;
                    continue;
                }
                let game = focused_game(&games, &me);
                let right = me.right.load(Ordering::Relaxed);
                let place = match game {
                    // A janela do jogo não mexeu (nem o lado escolhido): mesma faixa.
                    Some(g) if last_game == Some(g) && right == last_right && shown.is_some() => shown,
                    Some(g) => {
                        let monitors: Vec<_> = app
                            .available_monitors()
                            .unwrap_or_default()
                            .iter()
                            .map(|m| (m.position().x, m.position().y, m.size().width, m.size().height, m.scale_factor()))
                            .collect();
                        strip(g, &monitors, right)
                    }
                    None => None,
                };
                last_game = game;
                last_right = right;
                match place {
                    Some(rect) if shown != Some(rect) => {
                        if let Some(w) = build(&app) {
                            show(&w, rect);
                            shown = Some(rect);
                        }
                    }
                    // Sem jogo em foco: some. Confere a janela de verdade a cada passada (e não só quando
                    // acabou de sair do jogo), para nunca ficar por cima de outro programa.
                    None => {
                        shown = None;
                        if let Some(w) = app.get_webview_window(LABEL) {
                            conceal(&w);
                        }
                    }
                    // Mesma faixa: a cada segundo, de volta por cima (o jogo em tela cheia pode ter passado à frente).
                    Some(_) if tick % 4 == 0 => {
                        if let Some(w) = app.get_webview_window(LABEL) {
                            raise(&w);
                        }
                    }
                    _ => {}
                }
            }
        })
        .expect("thread da sobreposição");
    overlay
}

#[cfg(test)]
mod tests {
    use super::*;

    const TELAS: &[(i32, i32, u32, u32, f64)] = &[(0, 0, 1920, 1080, 1.0), (1920, 0, 2560, 1440, 1.5)];

    #[test]
    fn faixa_na_tela_do_jogo() {
        // Jogo em tela cheia (sem bordas) na primeira tela.
        assert_eq!(strip((0, 0, 1920, 1080), TELAS, false), Some((0, 0, 360, 1080)));
        // Na segunda tela, com escala de 150%: a faixa acompanha a escala.
        assert_eq!(strip((1920, 0, 4480, 1440), TELAS, false), Some((1920, 0, 540, 1440)));
        // Jogo em janela: a faixa fica dentro dela.
        assert_eq!(strip((200, 100, 1480, 820), TELAS, false), Some((200, 100, 360, 720)));
        // Do lado direito: encostada na borda direita do jogo.
        assert_eq!(strip((0, 0, 1920, 1080), TELAS, true), Some((1560, 0, 360, 1080)));
        assert_eq!(strip((200, 100, 1480, 820), TELAS, true), Some((1120, 100, 360, 720)));
    }
}
