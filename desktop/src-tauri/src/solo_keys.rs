// Atalho de voz com uma tecla modificadora sozinha (Ctrl, Alt, Shift ou Win), em qualquer lugar do
// Windows. O atalho global do sistema (RegisterHotKey) não aceita modificador sem outra tecla, então
// aqui uma thread olha o estado do teclado: vale o *toque* — apertar e soltar a tecla sem nenhuma outra
// tecla nem clique no meio (Ctrl+C não silencia ninguém). Teclas que já estavam apertadas antes (andar
// com W num jogo) não atrapalham.
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tauri::{AppHandle, Emitter};

/// Tecla (o `code` do navegador) → código virtual do Windows.
pub fn vk_of(code: &str) -> Option<i32> {
    Some(match code {
        "ControlLeft" => 0xA2,
        "ControlRight" => 0xA3,
        "ShiftLeft" => 0xA0,
        "ShiftRight" => 0xA1,
        "AltLeft" => 0xA4,
        "AltRight" => 0xA5,
        "MetaLeft" => 0x5B,
        "MetaRight" => 0x5C,
        _ => return None,
    })
}

/// Códigos que não contam como "outra tecla": os genéricos (Shift/Ctrl/Alt sem lado), que o Windows
/// marca junto com a tecla de cada lado.
fn ignored(vk: i32, watched: i32) -> bool {
    vk == watched
        || matches!(vk, 0x10 | 0x11 | 0x12)
        // AltGr (Alt direito no teclado brasileiro) também aperta um Ctrl esquerdo de mentira.
        || (watched == 0xA5 && vk == 0xA2)
}

#[derive(Default)]
pub struct SoloKeys {
    watched: Mutex<Vec<(String, i32)>>,
}

pub type Shared = Arc<SoloKeys>;

impl SoloKeys {
    pub fn set(&self, codes: Vec<String>) {
        *self.watched.lock().unwrap() = codes.into_iter().filter_map(|c| vk_of(&c).map(|vk| (c, vk))).collect();
    }
}

#[cfg(windows)]
fn snapshot() -> [bool; 256] {
    use windows::Win32::UI::Input::KeyboardAndMouse::GetAsyncKeyState;
    let mut down = [false; 256];
    for (vk, d) in down.iter_mut().enumerate().skip(1) {
        // SAFETY: só lê o estado da tecla.
        *d = unsafe { GetAsyncKeyState(vk as i32) } as u16 & 0x8000 != 0;
    }
    down
}

#[cfg(not(windows))]
fn snapshot() -> [bool; 256] {
    [false; 256]
}

/// Liga a thread que avisa a janela (`solo-key` com o código da tecla) a cada toque.
pub fn spawn(app: AppHandle) -> Shared {
    let shared: Shared = Arc::default();
    let me = shared.clone();
    std::thread::Builder::new()
        .name("teclas-sozinhas".into())
        .spawn(move || {
            let mut prev = [false; 256];
            // Tecla em toque: (código, vk, teclas já apertadas quando ela desceu, ainda limpo?).
            let mut tap: Option<(String, i32, [bool; 256], bool)> = None;
            loop {
                let watched = me.watched.lock().unwrap().clone();
                if watched.is_empty() {
                    tap = None;
                    std::thread::sleep(Duration::from_millis(150));
                    continue;
                }
                std::thread::sleep(Duration::from_millis(8));
                let now = snapshot();
                match &mut tap {
                    None => {
                        if let Some((code, vk)) = watched.iter().find(|(_, vk)| now[*vk as usize] && !prev[*vk as usize]) {
                            tap = Some((code.clone(), *vk, prev, true));
                        }
                    }
                    Some((code, vk, before, clean)) => {
                        // Outra tecla (ou botão do mouse) que desceu durante o toque: era uma combinação.
                        if (1..256).any(|k| now[k] && !before[k] && !ignored(k as i32, *vk)) {
                            *clean = false;
                        }
                        if !now[*vk as usize] {
                            if *clean {
                                let _ = app.emit("solo-key", code.clone());
                            }
                            tap = None;
                        }
                    }
                }
                prev = now;
            }
        })
        .expect("thread das teclas");
    shared
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn teclas_conhecidas() {
        assert_eq!(vk_of("ControlRight"), Some(0xA3));
        assert_eq!(vk_of("KeyM"), None);
        assert!(ignored(0x11, 0xA2));
        assert!(ignored(0xA2, 0xA5));
        assert!(!ignored(0x43, 0xA2));
    }
}
