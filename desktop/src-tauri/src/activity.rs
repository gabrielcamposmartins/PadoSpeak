//! Jogo em foco ("Jogando Counter-Strike 2"): a cada 3 s olha a janela em foco e tenta reconhecer o
//! jogo pelo executável — lista de jogos conhecidos, ou pela pasta de instalação (Steam, Epic, Riot,
//! Xbox, GOG, Ubisoft, EA). O jogo continua valendo enquanto o processo existir (voltar para o PadoSpeak
//! no meio da partida não apaga o status); outro jogo em foco toma o lugar.
//! Também vale qualquer programa que a pessoa escolheu em Configurações (`activity_custom_set`).
//! Só o nome do jogo sai daqui: nada de títulos de janela ou outros programas.
use serde::{Deserialize, Serialize};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use tauri::{AppHandle, Emitter};

#[derive(Clone, Serialize, PartialEq, Debug)]
pub struct Activity {
    pub name: String,
    /// Quando o jogo apareceu em foco (ms desde 1970).
    pub since: i64,
    #[serde(skip)]
    pid: u32,
    #[serde(skip)]
    title: String,
}

/// Programa escolhido pela pessoa: o executável ("jogo.exe") e o nome que aparece no status.
#[derive(Clone, Serialize, Deserialize, Debug, PartialEq)]
pub struct Custom {
    pub exe: String,
    pub name: String,
}

#[derive(Default)]
pub struct Watcher {
    pub current: Mutex<Option<Activity>>,
    custom: Mutex<Vec<Custom>>,
    /// A lista mudou: reavalia o jogo atual e a janela em foco.
    reload: AtomicBool,
}

pub type Shared = Arc<Watcher>;

impl Watcher {
    pub fn set_custom(&self, list: Vec<Custom>) {
        let list = list
            .into_iter()
            .filter_map(|c| {
                let exe = file_name(&c.exe.to_lowercase().replace('/', "\\")).trim().to_string();
                let name: String = c.name.trim().chars().take(80).collect();
                (!exe.is_empty() && !name.is_empty()).then_some(Custom { exe, name })
            })
            .collect();
        *self.custom.lock().unwrap() = list;
        self.reload.store(true, Ordering::Relaxed);
    }
}

/// Executável → nome do jogo (em minúsculas). Jogos fora daqui ainda são reconhecidos pela pasta.
const KNOWN: &[(&str, &str)] = &[
    // Os jogos da casa: sempre reconhecidos (o teste `reconhece_jogos` garante).
    ("pokeru.exe", "Pokeru"),
    ("pokersoul.exe", "Pokeru"),
    ("speedoru.exe", "Speedoru"),
    ("speedoru.console.exe", "Speedoru"),
    ("cs2.exe", "Counter-Strike 2"),
    ("csgo.exe", "Counter-Strike: Global Offensive"),
    ("hl2.exe", "Half-Life 2"),
    ("league of legends.exe", "League of Legends"),
    ("leagueclientux.exe", "League of Legends"),
    ("valorant-win64-shipping.exe", "VALORANT"),
    ("fortniteclient-win64-shipping.exe", "Fortnite"),
    ("r5apex.exe", "Apex Legends"),
    ("r5apex_dx12.exe", "Apex Legends"),
    ("dota2.exe", "Dota 2"),
    ("gta5.exe", "Grand Theft Auto V"),
    ("gta5_enhanced.exe", "Grand Theft Auto V"),
    ("playgtav.exe", "Grand Theft Auto V"),
    ("rdr2.exe", "Red Dead Redemption 2"),
    ("minecraft.windows.exe", "Minecraft"),
    ("robloxplayerbeta.exe", "Roblox"),
    ("rocketleague.exe", "Rocket League"),
    ("overwatch.exe", "Overwatch 2"),
    ("tslgame.exe", "PUBG: BATTLEGROUNDS"),
    ("eldenring.exe", "ELDEN RING"),
    ("cod.exe", "Call of Duty"),
    ("cod24-cod.exe", "Call of Duty"),
    ("modernwarfare.exe", "Call of Duty: Modern Warfare"),
    ("deadbydaylight-win64-shipping.exe", "Dead by Daylight"),
    ("eurotrucks2.exe", "Euro Truck Simulator 2"),
    ("amtrucks.exe", "American Truck Simulator"),
    ("among us.exe", "Among Us"),
    ("terraria.exe", "Terraria"),
    ("stardew valley.exe", "Stardew Valley"),
    ("rainbowsix.exe", "Tom Clancy's Rainbow Six Siege"),
    ("rainbowsix_vulkan.exe", "Tom Clancy's Rainbow Six Siege"),
    ("rustclient.exe", "Rust"),
    ("destiny2.exe", "Destiny 2"),
    ("wow.exe", "World of Warcraft"),
    ("hearthstone.exe", "Hearthstone"),
    ("diablo iv.exe", "Diablo IV"),
    ("lostark.exe", "Lost Ark"),
    ("pathofexile_x64.exe", "Path of Exile"),
    ("pathofexile2.exe", "Path of Exile 2"),
    ("warframe.x64.exe", "Warframe"),
    ("witcher3.exe", "The Witcher 3: Wild Hunt"),
    ("cyberpunk2077.exe", "Cyberpunk 2077"),
    ("bg3.exe", "Baldur's Gate 3"),
    ("bg3_dx11.exe", "Baldur's Gate 3"),
    ("helldivers2.exe", "HELLDIVERS 2"),
    ("palworld-win64-shipping.exe", "Palworld"),
    ("marvel-win64-shipping.exe", "Marvel Rivals"),
    ("deadlock.exe", "Deadlock"),
    ("osu!.exe", "osu!"),
    ("geometrydash.exe", "Geometry Dash"),
    ("sotgame.exe", "Sea of Thieves"),
    ("forzahorizon5.exe", "Forza Horizon 5"),
    ("forzahorizon4.exe", "Forza Horizon 4"),
    ("fc25.exe", "EA SPORTS FC 25"),
    ("fc26.exe", "EA SPORTS FC 26"),
    ("pointblank.exe", "Point Blank"),
    ("crossfire.exe", "CrossFire"),
    ("brawlhalla.exe", "Brawlhalla"),
    ("fallguys_client_game.exe", "Fall Guys"),
    ("left4dead2.exe", "Left 4 Dead 2"),
    ("portal2.exe", "Portal 2"),
    ("tf_win64.exe", "Team Fortress 2"),
    ("hollow_knight.exe", "Hollow Knight"),
    ("hollow knight silksong.exe", "Hollow Knight: Silksong"),
    ("lethal company.exe", "Lethal Company"),
    ("phasmophobia.exe", "Phasmophobia"),
    ("repo.exe", "R.E.P.O."),
    ("peak.exe", "PEAK"),
    ("thefinals.exe", "THE FINALS"),
    ("escapefromtarkov.exe", "Escape from Tarkov"),
    ("arenabreakoutinfinite.exe", "Arena Breakout: Infinite"),
    ("genshinimpact.exe", "Genshin Impact"),
    ("starrail.exe", "Honkai: Star Rail"),
    ("zenlesszonezero.exe", "Zenless Zone Zero"),
    ("wutheringwaves.exe", "Wuthering Waves"),
    ("tibia.exe", "Tibia"),
    ("ragexe.exe", "Ragnarök Online"),
    ("main.exe", ""), // MU e outros usam "main.exe": só vale pela pasta
];

/// Pastas de lojas/launchers: o jogo é a pasta logo depois do marcador.
const STORE_DIRS: &[&str] = &[
    "\\epic games\\",
    "\\riot games\\",
    "\\xboxgames\\",
    "\\gog galaxy\\games\\",
    "\\gog games\\",
    "\\ubisoft game launcher\\games\\",
    "\\ea games\\",
    "\\electronic arts\\",
];

/// Pastas que ficam nas lojas mas não são jogos.
const NOT_GAMES: &[&str] = &[
    "launcher",
    "riot client",
    "directxredist",
    "steamvr",
    "steamworks shared",
    "steam controller configs",
    "wallpaper_engine",
    "wallpaper engine",
    "soundpad",
    "obs studio",
    "ea desktop",
    "ea app",
    "ubisoft connect",
];

pub fn spawn(app: AppHandle) -> Shared {
    let watcher: Shared = Arc::default();
    let shared = watcher.clone();
    std::thread::Builder::new()
        .name("atividade".into())
        .spawn(move || {
            let me = std::process::id();
            let mut last_fg: Option<(u32, Option<String>)> = None;
            loop {
                std::thread::sleep(std::time::Duration::from_secs(3));
                let mut changed = false;
                let mut cur = shared.current.lock().unwrap().clone();
                let custom = shared.custom.lock().unwrap().clone();
                // O jogo fechou: some do status.
                if cur.as_ref().is_some_and(|a| !win::alive(a.pid)) {
                    cur = None;
                    changed = true;
                }
                // A lista da pessoa mudou: o programa tirado da lista sai do status; o renomeado muda de nome.
                if shared.reload.swap(false, Ordering::Relaxed) {
                    last_fg = None;
                    if let Some(a) = cur.as_mut() {
                        match win::exe_of(a.pid).and_then(|exe| identify_with(&custom, &exe, &a.title)) {
                            None => {
                                cur = None;
                                changed = true;
                            }
                            Some(name) if name != a.name => {
                                a.name = name;
                                changed = true;
                            }
                            _ => {}
                        }
                    }
                }
                if let Some((pid, exe, title)) = win::foreground() {
                    if pid != me {
                        // Só reavalia quando a janela em foco muda de processo.
                        let game = match &last_fg {
                            Some((p, g)) if *p == pid => g.clone(),
                            _ => identify_with(&custom, &exe, &title),
                        };
                        last_fg = Some((pid, game.clone()));
                        if let Some(name) = game {
                            if cur.as_ref().is_none_or(|a| a.pid != pid) {
                                cur = Some(Activity { name, since: now_ms(), pid, title });
                                changed = true;
                            }
                        }
                    }
                }
                if changed {
                    *shared.current.lock().unwrap() = cur.clone();
                    let _ = app.emit("activity", cur);
                }
            }
        })
        .expect("thread da atividade");
    watcher
}

/// Caminho do executável de um processo.
pub fn exe_of(pid: u32) -> Option<String> {
    win::exe_of(pid)
}

/// Programa com janela aberta, para a pessoa escolher em Configurações.
#[derive(Serialize, Debug)]
pub struct Program {
    pub exe: String,
    pub path: String,
    pub title: String,
}

/// Programas com janela visível agora (um por executável, sem o PadoSpeak — nem outra cópia dele aberta).
pub fn programs() -> Vec<Program> {
    let me = std::process::id();
    let my_exe = std::env::current_exe()
        .ok()
        .and_then(|p| p.file_name().map(|f| f.to_string_lossy().to_lowercase()))
        .unwrap_or_default();
    let mut out: Vec<Program> = Vec::new();
    for (pid, title) in win::windows() {
        if pid == me || title.trim().is_empty() {
            continue;
        }
        let Some(path) = win::exe_of(pid) else { continue };
        let exe = file_name(&path.replace('/', "\\")).to_string();
        let lower = exe.to_lowercase();
        if lower == my_exe || SYSTEM_EXES.contains(&lower.as_str()) || out.iter().any(|p| p.exe.eq_ignore_ascii_case(&exe)) {
            continue;
        }
        out.push(Program { exe, path, title });
    }
    out.sort_by_key(|p| p.exe.to_lowercase());
    out
}

/// Janelas do próprio Windows que não fazem sentido na lista.
const SYSTEM_EXES: &[&str] = &[
    "explorer.exe",
    "applicationframehost.exe",
    "textinputhost.exe",
    "shellexperiencehost.exe",
    "startmenuexperiencehost.exe",
    "searchhost.exe",
    "systemsettings.exe",
    "lockapp.exe",
    "msedgewebview2.exe",
];

fn file_name(path: &str) -> &str {
    path.rsplit('\\').next().unwrap_or_default()
}

fn now_ms() -> i64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis() as i64).unwrap_or(0)
}

/// Como `identify`, mas os programas escolhidos pela pessoa vêm antes de tudo.
pub fn identify_with(custom: &[Custom], exe: &str, title: &str) -> Option<String> {
    let path = exe.to_lowercase().replace('/', "\\");
    if let Some(c) = custom.iter().find(|c| c.exe == file_name(&path)) {
        return Some(c.name.clone());
    }
    identify(exe, title)
}

/// Nome do jogo a partir do caminho do executável (e do título, para o Minecraft Java).
pub fn identify(exe: &str, title: &str) -> Option<String> {
    let path = exe.to_lowercase().replace('/', "\\");
    let file = file_name(&path);
    if (file == "javaw.exe" || file == "java.exe") && title.starts_with("Minecraft") {
        return Some("Minecraft".into());
    }
    if let Some((_, name)) = KNOWN.iter().find(|(f, _)| *f == file) {
        if !name.is_empty() {
            return Some((*name).to_string());
        }
    }
    // Steam: steamapps\common\<pasta>\… — o nome bonito vem do appmanifest da biblioteca.
    if let Some(i) = path.find("\\steamapps\\common\\") {
        let rest = &exe[i + "\\steamapps\\common\\".len()..];
        let folder = rest.split(['\\', '/']).next().unwrap_or_default();
        if folder.is_empty() || NOT_GAMES.contains(&folder.to_lowercase().as_str()) {
            return None;
        }
        let steamapps = &exe[..i + "\\steamapps".len()];
        return Some(steam_name(steamapps, folder).unwrap_or_else(|| pretty(folder)));
    }
    if path.contains("\\epic games\\") {
        if let Some(name) = epic_name(&path) {
            return Some(name);
        }
    }
    for marker in STORE_DIRS {
        if let Some(i) = path.find(marker) {
            let folder = exe[i + marker.len()..].split(['\\', '/']).next().unwrap_or_default();
            if !folder.is_empty() && !NOT_GAMES.contains(&folder.to_lowercase().as_str()) {
                return Some(pretty(folder));
            }
        }
    }
    None
}

fn pretty(folder: &str) -> String {
    folder.replace('_', " ").trim().to_string()
}

/// `"chave"\t\t"valor"` de um arquivo .acf da Steam.
fn acf_value(text: &str, key: &str) -> Option<String> {
    text.lines().find_map(|l| {
        let parts: Vec<&str> = l.split('"').map(str::trim).filter(|p| !p.is_empty()).collect();
        (parts.len() >= 2 && parts[0].eq_ignore_ascii_case(key)).then(|| parts[1].to_string())
    })
}

fn steam_name(steamapps: &str, folder: &str) -> Option<String> {
    for entry in std::fs::read_dir(steamapps).ok()?.flatten() {
        let name = entry.file_name().to_string_lossy().to_lowercase();
        if !name.starts_with("appmanifest_") || !name.ends_with(".acf") {
            continue;
        }
        let Ok(text) = std::fs::read_to_string(entry.path()) else { continue };
        if acf_value(&text, "installdir").is_some_and(|d| d.eq_ignore_ascii_case(folder)) {
            return acf_value(&text, "name");
        }
    }
    None
}

/// Epic: os manifestos dizem onde cada jogo foi instalado e o nome de exibição.
fn epic_name(path_lower: &str) -> Option<String> {
    let dir = std::env::var("ProgramData").unwrap_or_else(|_| r"C:\ProgramData".into());
    let manifests = std::path::Path::new(&dir).join(r"Epic\EpicGamesLauncher\Data\Manifests");
    for entry in std::fs::read_dir(manifests).ok()?.flatten() {
        if entry.path().extension().is_none_or(|e| e != "item") {
            continue;
        }
        let Ok(text) = std::fs::read_to_string(entry.path()) else { continue };
        let Ok(v) = serde_json::from_str::<serde_json::Value>(&text) else { continue };
        let loc = v["InstallLocation"].as_str().unwrap_or_default().to_lowercase().replace('/', "\\");
        if !loc.is_empty() && path_lower.starts_with(loc.trim_end_matches('\\')) {
            return v["DisplayName"].as_str().map(str::to_string);
        }
    }
    None
}

#[cfg(windows)]
mod win {
    use windows::core::PWSTR;
    use windows::Win32::Foundation::{CloseHandle, STILL_ACTIVE};
    use windows::Win32::System::Threading::{
        GetExitCodeProcess, OpenProcess, QueryFullProcessImageNameW, PROCESS_NAME_WIN32, PROCESS_QUERY_LIMITED_INFORMATION,
    };
    use windows::core::BOOL;
    use windows::Win32::Foundation::{HWND, LPARAM};
    use windows::Win32::UI::WindowsAndMessaging::{
        EnumWindows, GetForegroundWindow, GetWindow, GetWindowTextW, GetWindowThreadProcessId, IsWindowVisible, GW_OWNER,
    };

    /// Janelas principais visíveis: (processo, título).
    pub fn windows() -> Vec<(u32, String)> {
        unsafe extern "system" fn each(hwnd: HWND, l: LPARAM) -> BOOL {
            let out = &mut *(l.0 as *mut Vec<(u32, String)>);
            if IsWindowVisible(hwnd).as_bool() && GetWindow(hwnd, GW_OWNER).is_err() {
                let mut pid = 0u32;
                GetWindowThreadProcessId(hwnd, Some(&mut pid));
                let mut title = [0u16; 256];
                let n = GetWindowTextW(hwnd, &mut title).max(0) as usize;
                if pid != 0 && n > 0 {
                    out.push((pid, String::from_utf16_lossy(&title[..n])));
                }
            }
            true.into()
        }
        let mut out: Vec<(u32, String)> = Vec::new();
        unsafe {
            let _ = EnumWindows(Some(each), LPARAM(&mut out as *mut _ as isize));
        }
        out
    }

    /// Processo, executável e título da janela em foco.
    pub fn foreground() -> Option<(u32, String, String)> {
        unsafe {
            let hwnd = GetForegroundWindow();
            if hwnd.is_invalid() {
                return None;
            }
            let mut pid = 0u32;
            GetWindowThreadProcessId(hwnd, Some(&mut pid));
            if pid == 0 {
                return None;
            }
            let mut title = [0u16; 256];
            let n = GetWindowTextW(hwnd, &mut title).max(0) as usize;
            Some((pid, exe_of(pid)?, String::from_utf16_lossy(&title[..n])))
        }
    }

    pub fn exe_of(pid: u32) -> Option<String> {
        unsafe {
            let h = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid).ok()?;
            let mut buf = [0u16; 1024];
            let mut len = buf.len() as u32;
            let ok = QueryFullProcessImageNameW(h, PROCESS_NAME_WIN32, PWSTR(buf.as_mut_ptr()), &mut len).is_ok();
            let _ = CloseHandle(h);
            ok.then(|| String::from_utf16_lossy(&buf[..len as usize]))
        }
    }

    pub fn alive(pid: u32) -> bool {
        unsafe {
            let Ok(h) = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid) else { return false };
            let mut code = 0u32;
            let ok = GetExitCodeProcess(h, &mut code).is_ok();
            let _ = CloseHandle(h);
            ok && code == STILL_ACTIVE.0 as u32
        }
    }
}

#[cfg(not(windows))]
mod win {
    pub fn windows() -> Vec<(u32, String)> {
        Vec::new()
    }
    pub fn foreground() -> Option<(u32, String, String)> {
        None
    }
    pub fn alive(_pid: u32) -> bool {
        false
    }
    pub fn exe_of(_pid: u32) -> Option<String> {
        None
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reconhece_jogos() {
        let id = |p: &str| identify(p, "");
        assert_eq!(id(r"C:\Program Files (x86)\Steam\steamapps\common\Counter-Strike Global Offensive\game\bin\win64\cs2.exe").as_deref(), Some("Counter-Strike 2"));
        assert_eq!(id(r"C:\Riot Games\League of Legends\Game\League of Legends.exe").as_deref(), Some("League of Legends"));
        assert_eq!(id(r"D:\Riot Games\VALORANT\live\ShooterGame\Binaries\Win64\VALORANT-Win64-Shipping.exe").as_deref(), Some("VALORANT"));
        // Pasta da Steam sem appmanifest (pasta inexistente): o nome da pasta.
        assert_eq!(id(r"E:\SteamLibrary\steamapps\common\Some_Indie Game\game.exe").as_deref(), Some("Some Indie Game"));
        assert_eq!(id(r"C:\XboxGames\Forza Motorsport\Content\fm.exe").as_deref(), Some("Forza Motorsport"));
        assert_eq!(identify(r"C:\Program Files\Java\bin\javaw.exe", "Minecraft 1.21.4").as_deref(), Some("Minecraft"));
        // Os jogos da casa, em qualquer pasta.
        assert_eq!(id(r"C:\Users\ana\AppData\Local\Pokeru\pokeru.exe").as_deref(), Some("Pokeru"));
        assert_eq!(id(r"D:\Jogos\PokerSoul\pokersoul.exe").as_deref(), Some("Pokeru"));
        assert_eq!(id(r"C:\Users\ana\AppData\Local\Programs\Speedoru\Speedoru.exe").as_deref(), Some("Speedoru"));
        assert_eq!(id(r"C:\Users\ana\AppData\Local\Programs\Speedoru\Speedoru.console.exe").as_deref(), Some("Speedoru"));
        // Não são jogos.
        assert_eq!(id(r"C:\Program Files\Google\Chrome\Application\chrome.exe"), None);
        assert_eq!(id(r"C:\Riot Games\Riot Client\RiotClientUx.exe"), None);
        assert_eq!(id(r"C:\Program Files (x86)\Steam\steamapps\common\wallpaper_engine\wallpaper64.exe"), None);
        assert_eq!(id(r"C:\Program Files\MU\main.exe"), None);
    }

    #[test]
    fn programas_escolhidos() {
        let w = Watcher::default();
        w.set_custom(vec![
            Custom { exe: r"C:\Ferramentas\Aseprite.EXE".into(), name: "  Aseprite ".into() },
            Custom { exe: "chrome.exe".into(), name: "Navegando".into() },
            Custom { exe: "".into(), name: "sem exe".into() },
            Custom { exe: "x.exe".into(), name: "  ".into() },
        ]);
        let custom = w.custom.lock().unwrap().clone();
        assert_eq!(custom.len(), 2);
        assert_eq!(custom[0], Custom { exe: "aseprite.exe".into(), name: "Aseprite".into() });
        assert!(w.reload.load(Ordering::Relaxed));
        let id = |p: &str| identify_with(&custom, p, "");
        assert_eq!(id(r"C:\Ferramentas\aseprite.exe").as_deref(), Some("Aseprite"));
        // Vale mesmo para o que não seria jogo, e passa na frente da lista conhecida.
        assert_eq!(id(r"C:\Program Files\Google\Chrome\Application\chrome.exe").as_deref(), Some("Navegando"));
        assert_eq!(id(r"C:\Riot Games\League of Legends\Game\League of Legends.exe").as_deref(), Some("League of Legends"));
        assert_eq!(id(r"C:\Windows\notepad.exe"), None);
    }

    #[test]
    fn le_o_appmanifest() {
        let acf = "\"AppState\"\n{\n\t\"appid\"\t\t\"730\"\n\t\"name\"\t\t\"Counter-Strike 2\"\n\t\"installdir\"\t\t\"Counter-Strike Global Offensive\"\n}";
        assert_eq!(acf_value(acf, "name").as_deref(), Some("Counter-Strike 2"));
        assert_eq!(acf_value(acf, "installdir").as_deref(), Some("Counter-Strike Global Offensive"));
    }
}
