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
fn key_down(vk: i32) -> bool {
    use windows::Win32::UI::Input::KeyboardAndMouse::GetAsyncKeyState;
    // SAFETY: só lê o estado da tecla.
    unsafe { GetAsyncKeyState(vk) as u16 & 0x8000 != 0 }
}

#[cfg(not(windows))]
fn key_down(_vk: i32) -> bool {
    false
}

fn snapshot() -> [bool; 256] {
    let mut down = [false; 256];
    for (vk, d) in down.iter_mut().enumerate().skip(1) {
        *d = key_down(vk as i32);
    }
    down
}

/// Em repouso, o teclado inteiro é lido só a cada tantas voltas (~100 ms) e, nas outras, só as teclas
/// vigiadas: ler as 255 teclas a cada 8 ms eram uns 32 mil GetAsyncKeyState por segundo, o tempo todo.
const FULL_EVERY: u32 = 12;

/// Teclas que já estavam apertadas quando um toque começou: descidas na última leitura completa e agora.
/// (Apertadas depois daquela leitura e ainda descidas contam como parte de uma combinação.)
fn held_before(last_full: &[bool; 256], now: &[bool; 256]) -> [bool; 256] {
    std::array::from_fn(|k| last_full[k] && now[k])
}

/// Liga a thread que avisa a janela (`solo-key` com o código da tecla) a cada toque.
pub fn spawn(app: AppHandle) -> Shared {
    let shared: Shared = Arc::default();
    let me = shared.clone();
    std::thread::Builder::new()
        .name("teclas-sozinhas".into())
        .spawn(move || {
            // Última leitura do teclado inteiro e o estado de cada tecla vigiada na volta anterior.
            let mut last_full = [false; 256];
            let mut prev = [false; 256];
            let mut idle: u32 = 0;
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
                match &mut tap {
                    None => {
                        idle = idle.wrapping_add(1);
                        if idle % FULL_EVERY == 0 {
                            last_full = snapshot();
                        }
                        let mut started = None;
                        for (code, vk) in &watched {
                            let down = key_down(*vk);
                            if down && !prev[*vk as usize] && started.is_none() {
                                started = Some((code.clone(), *vk));
                            }
                            prev[*vk as usize] = down;
                        }
                        if let Some((code, vk)) = started {
                            tap = Some((code, vk, held_before(&last_full, &snapshot()), true));
                        }
                    }
                    Some((code, vk, before, clean)) => {
                        let now = snapshot();
                        for k in 1..256 {
                            // Outra tecla (ou botão do mouse) que desceu durante o toque: era uma combinação.
                            if now[k] && !before[k] && !ignored(k as i32, *vk) {
                                *clean = false;
                            }
                            // Soltou uma que já estava apertada: se descer de novo, também é combinação.
                            if !now[k] {
                                before[k] = false;
                            }
                        }
                        if !now[*vk as usize] {
                            if *clean {
                                let _ = app.emit("solo-key", code.clone());
                            }
                            tap = None;
                            idle = 0;
                            last_full = now;
                            for (_, w) in &watched {
                                prev[*w as usize] = now[*w as usize];
                            }
                        }
                    }
                }
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

    #[test]
    fn apertadas_antes_do_toque() {
        let mut last_full = [false; 256];
        let mut now = [false; 256];
        // W segurado desde antes (andando num jogo): já estava apertado.
        last_full[0x57] = true;
        now[0x57] = true;
        // C soltado depois da última leitura: não conta como apertado.
        last_full[0x43] = true;
        // Shift apertado depois da última leitura e ainda descido: parte de uma combinação.
        now[0xA0] = true;
        let before = held_before(&last_full, &now);
        assert!(before[0x57]);
        assert!(!before[0x43]);
        assert!(!before[0xA0]);
    }
}
