//! Fila por canal de voz e o relógio de cada faixa.
use super::stream::{resolve_audio, Audio, AUDIO_TTL};
use super::tools::{self, Tools};
use super::{Source, Track};
use crate::hub::Hub;
use crate::logs::Logs;
use crate::models::User;
use serde_json::{json, Value};
use std::collections::{HashMap, VecDeque};
use std::net::{IpAddr, Ipv4Addr, Ipv6Addr};
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tokio::sync::mpsc::UnboundedReceiver;

/// Tamanho máximo da fila de um canal.
pub const MAX_QUEUE: usize = 500;
/// Quantas músicas já tocadas o canal lembra (para "voltar" e para a lista de tocadas).
pub const MAX_HISTORY: usize = 30;
/// Folga entre resolver o áudio e começar a tocar, para os clientes carregarem o stream.
const START_LEAD_MS: i64 = 1200;

// ---------- Estado puro (testável sem rede) ----------

#[derive(Clone, Debug)]
pub struct Playing {
    pub track: Track,
    /// `None` enquanto o áudio está sendo resolvido.
    pub started_at: Option<i64>,
    pub paused_at: Option<i64>,
}

#[derive(Debug, Default)]
pub struct ChannelMusic {
    pub guild_id: String,
    pub queue: VecDeque<Track>,
    pub current: Option<Playing>,
    /// Últimas músicas que tocaram (a mais recente no fim).
    pub history: VecDeque<Track>,
    /// Muda a cada troca de faixa/pausa; invalida temporizadores e carregamentos antigos.
    pub generation: u64,
}

#[derive(Debug, PartialEq)]
pub enum Removed {
    FromQueue,
    Current,
    NotFound,
}

impl ChannelMusic {
    /// Passa para a próxima faixa (ou para nada); a atual vai para o histórico.
    /// Devolve a faixa que precisa ser carregada.
    pub fn advance(&mut self) -> Option<Track> {
        if let Some(p) = self.current.take() {
            self.remember(p.track);
        }
        self.advance_dropping()
    }

    /// Como `advance`, mas descarta a atual (removida da fila ou que não deu para tocar).
    pub fn advance_dropping(&mut self) -> Option<Track> {
        self.generation += 1;
        self.current = self.queue.pop_front().map(Self::fresh);
        self.current.as_ref().map(|p| p.track.clone())
    }

    /// Volta para a última música do histórico; a atual volta para o começo da fila.
    pub fn previous(&mut self) -> Option<Track> {
        let prev = self.history.pop_back()?;
        if let Some(p) = self.current.take() {
            self.queue.push_front(p.track);
        }
        self.generation += 1;
        self.current = Some(Self::fresh(prev));
        self.current.as_ref().map(|p| p.track.clone())
    }

    /// Recomeça a música atual do início (pausada continua pausada, já no começo).
    pub fn restart(&mut self, now: i64) -> bool {
        let Some(p) = &mut self.current else { return false };
        if p.started_at.is_none() {
            return false; // ainda carregando: já vai começar do início
        }
        p.started_at = Some(p.paused_at.unwrap_or(now));
        self.generation += 1;
        true
    }

    fn fresh(track: Track) -> Playing {
        Playing { track, started_at: None, paused_at: None }
    }

    fn remember(&mut self, track: Track) {
        self.history.push_back(track);
        while self.history.len() > MAX_HISTORY {
            self.history.pop_front();
        }
    }

    /// Canal de voz esvaziou: para tudo, mas lembra o que tocou.
    pub fn stop(&mut self) {
        self.queue.clear();
        if let Some(p) = self.current.take() {
            self.remember(p.track);
        }
        self.generation += 1;
    }

    /// Áudio pronto: começa a tocar daqui a `START_LEAD_MS`.
    pub fn start(&mut self, now: i64, duration_ms: Option<u64>) {
        self.generation += 1;
        if let Some(p) = &mut self.current {
            p.started_at = Some(now + START_LEAD_MS);
            p.paused_at = None;
            if p.track.duration_ms.is_none() {
                p.track.duration_ms = duration_ms;
            }
        }
    }

    pub fn pause(&mut self, now: i64) -> bool {
        match &mut self.current {
            Some(p) if p.started_at.is_some() && p.paused_at.is_none() => {
                p.paused_at = Some(now);
                self.generation += 1;
                true
            }
            _ => false,
        }
    }

    pub fn resume(&mut self, now: i64) -> bool {
        let Some(p) = &mut self.current else { return false };
        let (Some(start), Some(paused)) = (p.started_at, p.paused_at) else { return false };
        // Empurra o início para frente pelo tempo pausado: a posição continua de onde parou.
        p.started_at = Some(start + now - paused);
        p.paused_at = None;
        self.generation += 1;
        true
    }

    pub fn remove(&mut self, track_id: &str) -> Removed {
        if self.current.as_ref().is_some_and(|p| p.track.id == track_id) {
            return Removed::Current;
        }
        let before = self.queue.len();
        self.queue.retain(|t| t.id != track_id);
        if self.queue.len() < before {
            Removed::FromQueue
        } else {
            Removed::NotFound
        }
    }

    /// Quando a faixa atual termina (se estiver tocando e com duração conhecida).
    pub fn end_at(&self) -> Option<i64> {
        let p = self.current.as_ref()?;
        if p.paused_at.is_some() {
            return None;
        }
        Some(p.started_at? + p.track.duration_ms? as i64)
    }

    pub fn is_idle(&self) -> bool {
        self.current.is_none() && self.queue.is_empty()
    }

    pub fn payload(&self, channel_id: &str, now: i64) -> Value {
        json!({
            "channelId": channel_id,
            "guildId": self.guild_id,
            "serverTime": now,
            "current": self.current.as_ref().map(|p| json!({
                "track": p.track,
                "startedAt": p.started_at,
                "pausedAt": p.paused_at,
            })),
            "queue": self.queue,
            // A mais recente primeiro.
            "history": self.history.iter().rev().collect::<Vec<_>>(),
        })
    }
}

// ---------- Orquestração ----------

pub struct MusicManager {
    hub: Arc<Hub>,
    logs: Logs,
    data_dir: PathBuf,
    /// Cliente HTTP geral (Spotify, downloads de ferramentas).
    pub http: reqwest::Client,
    /// Clientes presos a IPv4/IPv6, para o proxy sair pela mesma família da URL do áudio.
    http_v4: reqwest::Client,
    http_v6: reqwest::Client,
    cookies: (String, String),
    tools: tokio::sync::Mutex<Option<Tools>>,
    channels: Mutex<HashMap<String, ChannelMusic>>,
    audio: Mutex<HashMap<String, Audio>>,
    /// Uma resolução por faixa de cada vez (o carregamento e o proxy podem pedir ao mesmo tempo).
    resolving: Mutex<HashMap<String, Arc<tokio::sync::Mutex<()>>>>,
}

impl MusicManager {
    /// `cookies`: (arquivo cookies.txt, navegador) configurados pelo host para o YouTube.
    pub fn new(
        hub: Arc<Hub>,
        logs: Logs,
        data_dir: PathBuf,
        cookies: (String, String),
        voice_empty: UnboundedReceiver<String>,
    ) -> Arc<Self> {
        let client = |local: Option<IpAddr>| {
            reqwest::Client::builder().local_address(local).connect_timeout(Duration::from_secs(15)).build().expect("cliente HTTP")
        };
        let me = Arc::new(Self {
            hub,
            logs,
            data_dir,
            http: client(None),
            http_v4: client(Some(IpAddr::V4(Ipv4Addr::UNSPECIFIED))),
            http_v6: client(Some(IpAddr::V6(Ipv6Addr::UNSPECIFIED))),
            cookies,
            tools: tokio::sync::Mutex::new(None),
            channels: Mutex::new(HashMap::new()),
            audio: Mutex::new(HashMap::new()),
            resolving: Mutex::new(HashMap::new()),
        });
        me.clone().listen_voice_empty(voice_empty);
        me
    }

    /// Prepara yt-dlp/runtime JS em segundo plano assim que o servidor sobe.
    pub fn warm_up(self: &Arc<Self>) {
        let me = self.clone();
        tokio::spawn(async move {
            let _ = me.tools().await;
        });
    }

    /// Cliente HTTP adequado à URL do áudio (mesma família de IP com que ela foi gerada).
    pub fn http_for(&self, url: &str) -> &reqwest::Client {
        match super::stream::locked_ip_is_v6(url) {
            Some(true) => &self.http_v6,
            Some(false) => &self.http_v4,
            None => &self.http,
        }
    }

    async fn tools(&self) -> Result<Tools, String> {
        let mut guard = self.tools.lock().await;
        if let Some(t) = guard.as_ref() {
            return Ok(t.clone());
        }
        match tools::provision(&self.http, &self.data_dir, &self.logs).await {
            Ok(mut t) => {
                t.set_cookies(&self.cookies.0, &self.cookies.1);
                *guard = Some(t.clone());
                Ok(t)
            }
            Err(e) => {
                self.logs.error(format!("Música indisponível: {e}"));
                Err(e)
            }
        }
    }

    /// Canal de voz esvaziou: a música para e a fila é descartada.
    fn listen_voice_empty(self: Arc<Self>, mut rx: UnboundedReceiver<String>) {
        let shutdown = self.hub.shutdown.clone();
        tokio::spawn(async move {
            loop {
                tokio::select! {
                    msg = rx.recv() => match msg {
                        Some(channel_id) => self.clear(&channel_id),
                        None => break,
                    },
                    _ = shutdown.cancelled() => break,
                }
            }
        });
    }

    fn broadcast(&self, channel_id: &str) {
        let payload = {
            let channels = self.channels.lock().unwrap();
            match channels.get(channel_id) {
                Some(c) => Some((c.guild_id.clone(), c.payload(channel_id, crate::now_ms()))),
                None => None,
            }
        };
        if let Some((guild_id, p)) = payload {
            self.hub.to_guild(&guild_id, "music:state", p);
        }
    }

    fn notice(&self, guild_id: &str, channel_id: &str, text: String) {
        self.hub.to_guild(guild_id, "music:notice", json!({ "channelId": channel_id, "text": text }));
    }

    /// Estados das filas ativas nas guilds informadas (para o `ready` do WebSocket).
    pub fn states_for(&self, guilds: &std::collections::HashSet<String>) -> Vec<Value> {
        let now = crate::now_ms();
        let channels = self.channels.lock().unwrap();
        channels.iter().filter(|(_, c)| guilds.contains(&c.guild_id)).map(|(id, c)| c.payload(id, now)).collect()
    }

    /// Adiciona as músicas de um link à fila do canal de voz de quem enviou.
    pub async fn add(self: &Arc<Self>, channel_id: &str, guild_id: &str, user: &User, url: &str) -> Result<Value, String> {
        let tools = self.tools().await?;
        let mut tracks = super::resolve::resolve(&tools, &self.http, url).await?;
        for t in &mut tracks {
            t.added_by = Some(user.clone());
        }
        // Resolver o link leva alguns segundos: o canal pode ter esvaziado nesse meio-tempo.
        if !self.hub.voice_has_people(channel_id) {
            return Err("O canal de voz ficou vazio antes de a música carregar".into());
        }
        let (count, first_title, to_load) = {
            let mut channels = self.channels.lock().unwrap();
            let chan = channels.entry(channel_id.to_string()).or_default();
            chan.guild_id = guild_id.to_string();
            let room = MAX_QUEUE.saturating_sub(chan.queue.len());
            if room == 0 {
                return Err(format!("A fila está cheia ({MAX_QUEUE} músicas)"));
            }
            tracks.truncate(room);
            let count = tracks.len();
            let first = tracks[0].title.clone();
            chan.queue.extend(tracks);
            let to_load = if chan.current.is_none() { chan.advance().map(|t| (t, chan.generation)) } else { None };
            (count, first, to_load)
        };
        if let Some((track, generation)) = to_load {
            self.spawn_load(channel_id.to_string(), track, generation);
        }
        self.broadcast(channel_id);
        Ok(json!({ "added": count, "title": first_title }))
    }

    /// Resolve o áudio da faixa atual e começa a tocar; se falhar, pula para a próxima.
    fn spawn_load(self: &Arc<Self>, channel_id: String, track: Track, generation: u64) {
        let me = self.clone();
        tokio::spawn(async move {
            let result = match me.tools().await {
                Ok(tools) => me.cached_or_resolve(&tools, &track.id, &track.source, false).await,
                Err(e) => Err(e),
            };
            let mut next_to_load = None;
            let mut failure = None;
            {
                let mut channels = me.channels.lock().unwrap();
                let Some(chan) = channels.get_mut(&channel_id) else { return };
                if chan.generation != generation || chan.current.as_ref().map(|p| &p.track.id) != Some(&track.id) {
                    return; // fila mudou enquanto carregava
                }
                match result {
                    Ok(audio) => chan.start(crate::now_ms(), audio.duration_ms),
                    Err(e) => {
                        failure = Some((chan.guild_id.clone(), format!("Não foi possível tocar \"{}\": {e}", track.title)));
                        next_to_load = chan.advance_dropping().map(|t| (t, chan.generation));
                    }
                }
            }
            if let Some((guild_id, text)) = failure {
                me.logs.warn(&text);
                me.notice(&guild_id, &channel_id, text);
            }
            if let Some((t, g)) = next_to_load {
                me.spawn_load(channel_id.clone(), t, g);
            }
            me.schedule_end(&channel_id);
            me.prefetch_next(&channel_id);
            me.broadcast(&channel_id);
        });
    }

    /// Agenda a troca para a próxima faixa quando a atual terminar.
    fn schedule_end(self: &Arc<Self>, channel_id: &str) {
        let (end_at, generation) = {
            let channels = self.channels.lock().unwrap();
            match channels.get(channel_id) {
                Some(c) => (c.end_at(), c.generation),
                None => return,
            }
        };
        let Some(end_at) = end_at else { return };
        let me = self.clone();
        let channel_id = channel_id.to_string();
        tokio::spawn(async move {
            let wait = (end_at - crate::now_ms()).max(0) as u64;
            tokio::time::sleep(Duration::from_millis(wait)).await;
            let to_load = {
                let mut channels = me.channels.lock().unwrap();
                let Some(chan) = channels.get_mut(&channel_id) else { return };
                if chan.generation != generation {
                    return;
                }
                chan.advance().map(|t| (t, chan.generation))
            };
            if let Some((t, g)) = to_load {
                me.spawn_load(channel_id.clone(), t, g);
            }
            me.broadcast(&channel_id);
        });
    }

    /// Resolve antes o áudio da próxima faixa, para a troca ser imediata.
    fn prefetch_next(self: &Arc<Self>, channel_id: &str) {
        let next = self.channels.lock().unwrap().get(channel_id).and_then(|c| c.queue.front().cloned());
        let Some(next) = next else { return };
        let me = self.clone();
        tokio::spawn(async move {
            if let Ok(tools) = me.tools().await {
                let _ = me.cached_or_resolve(&tools, &next.id, &next.source, false).await;
            }
        });
    }

    async fn cached_or_resolve(&self, tools: &Tools, track_id: &str, source: &Source, force: bool) -> Result<Audio, String> {
        let cached = || self.audio.lock().unwrap().get(track_id).filter(|a| a.fetched.elapsed() < AUDIO_TTL).cloned();
        if !force {
            if let Some(a) = cached() {
                return Ok(a);
            }
        }
        let lock = self.resolving.lock().unwrap().entry(track_id.to_string()).or_default().clone();
        let _guard = lock.lock().await;
        // Outra chamada pode ter resolvido enquanto esperávamos.
        if let Some(a) = cached().filter(|a| !force || a.fetched.elapsed() < Duration::from_secs(30)) {
            return Ok(a);
        }
        let result = resolve_audio(tools, source).await;
        self.resolving.lock().unwrap().retain(|_, l| Arc::strong_count(l) > 1);
        let audio = result?;
        let mut cache = self.audio.lock().unwrap();
        cache.retain(|_, a| a.fetched.elapsed() < AUDIO_TTL);
        cache.insert(track_id.to_string(), audio.clone());
        Ok(audio)
    }

    /// URL direta do áudio de uma faixa que está na fila (usada pelo proxy).
    pub async fn audio_url(&self, track_id: &str, force: bool) -> Result<String, String> {
        let source = {
            let channels = self.channels.lock().unwrap();
            channels.values().find_map(|c| {
                c.current
                    .iter()
                    .map(|p| &p.track)
                    .chain(c.queue.iter())
                    .chain(c.history.iter())
                    .find(|t| t.id == track_id)
                    .map(|t| t.source.clone())
            })
        };
        let source = source.ok_or("faixa não está em nenhuma fila")?;
        let tools = self.tools().await?;
        Ok(self.cached_or_resolve(&tools, track_id, &source, force).await?.url)
    }

    /// Pausar, retomar, pular, voltar, recomeçar, remover ou limpar — sempre no canal de quem pediu.
    pub fn control(self: &Arc<Self>, channel_id: &str, op: &str, track_id: Option<&str>) -> Result<(), String> {
        let now = crate::now_ms();
        let mut to_load = None;
        {
            let mut channels = self.channels.lock().unwrap();
            let chan = channels.get_mut(channel_id).ok_or("Nada tocando neste canal")?;
            match op {
                "music:pause" => {
                    chan.pause(now);
                }
                "music:resume" => {
                    chan.resume(now);
                }
                "music:skip" => to_load = chan.advance().map(|t| (t, chan.generation)),
                "music:previous" => match chan.previous() {
                    Some(t) => to_load = Some((t, chan.generation)),
                    None => return Err("Nenhuma música tocou antes desta".into()),
                },
                "music:restart" => {
                    if !chan.restart(now) {
                        return Err("A música ainda está carregando".into());
                    }
                }
                "music:remove" => {
                    let id = track_id.ok_or("Faixa não informada")?;
                    match chan.remove(id) {
                        Removed::Current => to_load = chan.advance_dropping().map(|t| (t, chan.generation)),
                        Removed::FromQueue => {}
                        Removed::NotFound => return Err("Essa música não está mais na fila".into()),
                    }
                }
                "music:clear" => {
                    chan.queue.clear();
                    chan.advance();
                }
                _ => return Err("Operação desconhecida".into()),
            }
        }
        if let Some((t, g)) = to_load {
            self.spawn_load(channel_id.to_string(), t, g);
        }
        self.schedule_end(channel_id);
        self.broadcast(channel_id);
        Ok(())
    }

    /// Canal de voz vazio: a música para e a fila é descartada (o histórico continua).
    pub fn clear(&self, channel_id: &str) {
        let was_playing = {
            let mut channels = self.channels.lock().unwrap();
            let Some(chan) = channels.get_mut(channel_id) else { return };
            let was_playing = !chan.is_idle();
            chan.stop();
            if chan.history.is_empty() {
                channels.remove(channel_id);
            }
            was_playing
        };
        if was_playing {
            self.broadcast(channel_id);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn track(id: &str, dur: Option<u64>) -> Track {
        Track {
            id: id.into(),
            title: format!("Música {id}"),
            artist: None,
            duration_ms: dur,
            thumbnail: None,
            page_url: String::new(),
            added_by: None,
            source: Source::Search(id.into()),
        }
    }

    fn chan(ids: &[&str]) -> ChannelMusic {
        let mut c = ChannelMusic::default();
        c.queue.extend(ids.iter().map(|id| track(id, Some(10_000))));
        c
    }

    #[test]
    fn avanca_e_comeca_com_folga() {
        let mut c = chan(&["a", "b"]);
        assert_eq!(c.advance().unwrap().id, "a");
        assert_eq!(c.current.as_ref().unwrap().started_at, None, "carregando até o áudio ser resolvido");
        assert_eq!(c.end_at(), None);
        c.start(1_000, None);
        assert_eq!(c.current.as_ref().unwrap().started_at, Some(1_000 + START_LEAD_MS));
        assert_eq!(c.end_at(), Some(1_000 + START_LEAD_MS + 10_000));
        assert_eq!(c.queue.len(), 1);
    }

    #[test]
    fn pausa_preserva_a_posicao() {
        let mut c = chan(&["a"]);
        c.advance();
        c.start(0, None);
        let start = START_LEAD_MS;
        assert!(c.pause(start + 3_000));
        assert_eq!(c.end_at(), None, "pausada não termina sozinha");
        assert!(!c.pause(start + 4_000), "pausar duas vezes não muda nada");
        assert!(c.resume(start + 8_000));
        // Ficou 5 s pausada: termina 5 s depois do previsto.
        assert_eq!(c.end_at(), Some(start + 10_000 + 5_000));
    }

    #[test]
    fn duracao_vem_do_audio_quando_desconhecida() {
        let mut c = ChannelMusic::default();
        c.queue.push_back(track("x", None));
        c.advance();
        c.start(0, Some(42_000));
        assert_eq!(c.current.as_ref().unwrap().track.duration_ms, Some(42_000));
    }

    #[test]
    fn remover_da_fila_ou_atual() {
        let mut c = chan(&["a", "b", "c"]);
        c.advance();
        assert_eq!(c.remove("b"), Removed::FromQueue);
        assert_eq!(c.queue.iter().map(|t| t.id.as_str()).collect::<Vec<_>>(), ["c"]);
        assert_eq!(c.remove("a"), Removed::Current);
        assert_eq!(c.remove("zzz"), Removed::NotFound);
    }

    #[test]
    fn historico_voltar_e_recomecar() {
        let mut c = chan(&["a", "b", "c"]);
        c.advance();
        c.start(0, None);
        assert!(c.previous().is_none(), "nada tocou antes");
        c.advance(); // a → histórico, toca b
        c.start(20_000, None);
        assert_eq!(c.history.iter().map(|t| t.id.as_str()).collect::<Vec<_>>(), ["a"]);
        // Voltar: a toca de novo e b volta para o começo da fila.
        assert_eq!(c.previous().unwrap().id, "a");
        assert_eq!(c.current.as_ref().unwrap().started_at, None, "precisa carregar de novo");
        assert_eq!(c.queue.iter().map(|t| t.id.as_str()).collect::<Vec<_>>(), ["b", "c"]);
        assert!(c.history.is_empty());

        // Recomeçar tocando e pausada.
        c.start(50_000, None);
        let g = c.generation;
        assert!(c.restart(60_000));
        assert_eq!(c.current.as_ref().unwrap().started_at, Some(60_000));
        assert_ne!(c.generation, g, "invalida o fim agendado");
        c.pause(65_000);
        assert!(c.restart(70_000));
        let p = c.current.as_ref().unwrap();
        assert_eq!(p.started_at, p.paused_at, "pausada no começo");

        // Removida ou com erro não entra no histórico.
        assert_eq!(c.remove("a"), Removed::Current);
        c.advance_dropping();
        assert!(c.history.is_empty());
    }

    #[test]
    fn historico_guarda_so_as_ultimas() {
        let ids: Vec<String> = (0..40).map(|i| i.to_string()).collect();
        let mut c = chan(&ids.iter().map(String::as_str).collect::<Vec<_>>());
        for _ in 0..40 {
            c.advance();
        }
        c.advance();
        assert_eq!(c.history.len(), MAX_HISTORY);
        assert_eq!(c.history.back().unwrap().id, "39");
        assert_eq!(c.history.front().unwrap().id, "10");
        c.stop();
        assert_eq!(c.history.len(), MAX_HISTORY);
        assert!(c.is_idle());
    }

    #[test]
    fn geracao_invalida_temporizadores_antigos() {
        let mut c = chan(&["a", "b"]);
        c.advance();
        c.start(0, None);
        let g = c.generation;
        c.advance(); // pulou
        assert_ne!(c.generation, g);
        assert_eq!(c.current.as_ref().unwrap().track.id, "b");
        c.advance();
        assert!(c.is_idle());
    }
}
