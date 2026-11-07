//! Carga do servidor principal: a CPU do processo, a memória do contêiner (cgroup v2) e a vazão do
//! proxy de música. Sobrecarregado, o principal passa o trabalho pesado para os nós de mídia (as músicas
//! novas vêm pelo nó, e as salas do SFU embutido vão para um nó remoto).
//!
//! Só no Linux (é onde o servidor roda em produção); no Windows nada é medido e nunca há sobrecarga.
use serde::Serialize;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use tokio_util::sync::CancellationToken;

const SAMPLE_EVERY: Duration = Duration::from_secs(2);
/// CPU acima disto por `HOT_FOR` (ou a memória acima de `MEM_HOT`): sobrecarregado.
const CPU_HOT: f64 = 85.0;
const HOT_FOR: Duration = Duration::from_secs(10);
const MEM_HOT: f64 = 90.0;
/// Para deixar de estar sobrecarregado: abaixo destes por `COOL_FOR`.
const CPU_COOL: f64 = 70.0;
const MEM_COOL: f64 = 85.0;
const COOL_FOR: Duration = Duration::from_secs(30);

/// Bytes de música servidos aos apps (somados pelo proxy de `music::stream`).
pub static MUSIC_BYTES: AtomicU64 = AtomicU64::new(0);

#[derive(Clone, Copy, Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Sample {
    /// % da CPU disponível ao processo (a cota do contêiner, ou os núcleos).
    pub cpu: Option<f64>,
    /// % da memória disponível ao contêiner.
    pub mem: Option<f64>,
    /// Música servida, em kbps.
    pub music_kbps: u64,
    pub overloaded: bool,
}

#[derive(Default)]
struct Inner {
    sample: Sample,
    hot_since: Option<Instant>,
    cool_since: Option<Instant>,
    prev_cpu: Option<(f64, Instant)>,
    prev_music: Option<(u64, Instant)>,
}

#[derive(Default)]
pub struct Load {
    inner: Mutex<Inner>,
}

impl Load {
    pub fn now(&self) -> Sample {
        self.inner.lock().unwrap().sample
    }

    pub fn overloaded(&self) -> bool {
        self.inner.lock().unwrap().sample.overloaded
    }

    /// Mede de tempos em tempos até o servidor parar.
    pub fn spawn(self: &Arc<Self>, shutdown: CancellationToken) {
        let load = self.clone();
        tokio::spawn(async move {
            let mut tick = tokio::time::interval(SAMPLE_EVERY);
            loop {
                tokio::select! {
                    _ = tick.tick() => load.sample(),
                    _ = shutdown.cancelled() => break,
                }
            }
        });
    }

    fn sample(&self) {
        let now = Instant::now();
        let mut s = self.inner.lock().unwrap();
        let cpu_secs = read("/proc/self/stat").and_then(|t| proc_cpu_seconds(&t));
        let cpu = match (cpu_secs, s.prev_cpu) {
            (Some(c), Some((pc, pt))) if now > pt => {
                let wall = (now - pt).as_secs_f64();
                Some(((c - pc) / wall / cores() * 100.0).clamp(0.0, 100.0))
            }
            _ => None,
        };
        if let Some(c) = cpu_secs {
            s.prev_cpu = Some((c, now));
        }
        let mem = memory_percent();
        let bytes = MUSIC_BYTES.load(Ordering::Relaxed);
        let music_kbps = match s.prev_music {
            Some((pb, pt)) if now > pt => ((bytes.saturating_sub(pb)) as f64 * 8.0 / 1000.0 / (now - pt).as_secs_f64()) as u64,
            _ => 0,
        };
        s.prev_music = Some((bytes, now));
        let hot = cpu.is_some_and(|c| c >= CPU_HOT) || mem.is_some_and(|m| m >= MEM_HOT);
        let cool = cpu.is_none_or(|c| c < CPU_COOL) && mem.is_none_or(|m| m < MEM_COOL);
        s.hot_since = if hot { s.hot_since.or(Some(now)) } else { None };
        s.cool_since = if cool { s.cool_since.or(Some(now)) } else { None };
        let mut overloaded = s.sample.overloaded;
        if !overloaded && (mem.is_some_and(|m| m >= MEM_HOT) || s.hot_since.is_some_and(|t| now - t >= HOT_FOR)) {
            overloaded = true;
        } else if overloaded && s.cool_since.is_some_and(|t| now - t >= COOL_FOR) {
            overloaded = false;
        }
        s.sample = Sample { cpu: cpu.map(round1), mem: mem.map(round1), music_kbps, overloaded };
    }
}

fn round1(v: f64) -> f64 {
    (v * 10.0).round() / 10.0
}

fn read(path: &str) -> Option<String> {
    std::fs::read_to_string(path).ok()
}

/// Segundos de CPU (usuário + sistema) do processo, de `/proc/self/stat`.
fn proc_cpu_seconds(stat: &str) -> Option<f64> {
    // O nome do processo vem entre parênteses e pode ter espaços: os campos começam depois do último `)`.
    let rest = &stat[stat.rfind(')')? + 1..];
    let fields: Vec<&str> = rest.split_whitespace().collect();
    // Depois do nome: estado (3) … utime (14) e stime (15) → posições 11 e 12 aqui.
    let utime: f64 = fields.get(11)?.parse().ok()?;
    let stime: f64 = fields.get(12)?.parse().ok()?;
    Some((utime + stime) / 100.0)
}

/// Núcleos disponíveis: a cota do cgroup (`cpu.max`), ou os núcleos da máquina.
fn cores() -> f64 {
    read("/sys/fs/cgroup/cpu.max").and_then(|t| cgroup_cpu_quota(&t)).unwrap_or_else(|| {
        std::thread::available_parallelism().map(|n| n.get() as f64).unwrap_or(1.0)
    })
}

fn cgroup_cpu_quota(text: &str) -> Option<f64> {
    let mut it = text.split_whitespace();
    let quota = it.next()?;
    let period: f64 = it.next()?.parse().ok()?;
    if quota == "max" || period <= 0.0 {
        return None;
    }
    Some((quota.parse::<f64>().ok()? / period).max(0.05))
}

/// % da memória do contêiner em uso (cgroup v2); sem limite, da máquina.
fn memory_percent() -> Option<f64> {
    let current: f64 = read("/sys/fs/cgroup/memory.current")?.trim().parse().ok()?;
    let limit = read("/sys/fs/cgroup/memory.max")
        .and_then(|t| t.trim().parse::<f64>().ok())
        .or_else(|| read("/proc/meminfo").and_then(|t| meminfo_total(&t)))?;
    (limit > 0.0).then(|| (current / limit * 100.0).clamp(0.0, 100.0))
}

fn meminfo_total(text: &str) -> Option<f64> {
    let line = text.lines().find(|l| l.starts_with("MemTotal:"))?;
    let kb: f64 = line.split_whitespace().nth(1)?.parse().ok()?;
    Some(kb * 1024.0)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn le_a_cpu_do_proc() {
        let stat = "1234 (padospeak server) S 1 1234 1234 0 -1 4194560 2000 0 0 0 250 150 0 0 20 0 9 0 100 0 0";
        assert_eq!(proc_cpu_seconds(stat), Some(4.0));
        assert_eq!(proc_cpu_seconds("lixo"), None);
    }

    #[test]
    fn le_a_cota_e_a_memoria() {
        assert_eq!(cgroup_cpu_quota("25000 100000\n"), Some(0.25));
        assert_eq!(cgroup_cpu_quota("max 100000"), None);
        assert_eq!(meminfo_total("MemTotal:        1000 kB\nMemFree: 1 kB"), Some(1_024_000.0));
    }
}
