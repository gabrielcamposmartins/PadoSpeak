//! Pesquisa na internet do próprio app, para os modelos que não têm a da Anthropic (OpenAI, Gemini, DeepSeek,
//! Qwen…): duas ferramentas comuns que o servidor executa, `search_internet` (num serviço de pesquisa escolhido
//! no painel) e `open_page` (lê o texto de uma página).
//!
//! - Serviços: DuckDuckGo (sem chave), Brave Search, Tavily, Exa, Serper (resultados do Google) e um SearXNG
//!   próprio (o endereço, só o dono do app escolhe).
//! - O DuckDuckGo bloqueia endereços de datacenter, então a pesquisa sem chave vai em cascata, cada passo só se
//!   o anterior não der: (1) o app do Windows de quem pediu, pela internet do computador dela (evento
//!   `agent:web-search`, resposta em `POST /api/agent/web-search/{id}`); (2) um nó de mídia (o computador de
//!   alguém em casa, `media/node.rs`, op `web.search`); (3) direto daqui. O navegador não serve para o passo 1:
//!   o DuckDuckGo não libera a leitura por outra origem (CORS).
//! - `open_page` só abre endereços públicos: o nome é resolvido aqui e qualquer IP da rede interna, do próprio
//!   servidor ou de metadados da nuvem é recusado, em cada redirecionamento também. Lê até 3 MB e devolve só o
//!   texto.

use serde_json::{json, Value};
use std::net::{IpAddr, Ipv4Addr, SocketAddr};
use std::sync::Mutex;
use std::time::Duration;

pub const SEARCH_TOOL: &str = "search_internet";
pub const PAGE_TOOL: &str = "open_page";
/// Por pedido (como o `max_uses` da pesquisa da Anthropic).
pub const MAX_SEARCHES: u32 = 5;
pub const MAX_PAGES: u32 = 8;
const RESULTS: usize = 8;
/// O texto de uma página que vai para o modelo de uma vez (o resto ele pede com `start`).
const PAGE_CHARS: usize = 12_000;
const MAX_BODY: usize = 3 * 1024 * 1024;
const UA: &str = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36";

pub const SETTING_ENGINE: &str = "agent_search";
pub const SETTING_BASE: &str = "agent_search_base";
/// A chave de cada serviço fica guardada (cifrada) à parte: trocar de serviço e voltar não pede a chave de novo.
pub fn setting_key(engine: &str) -> String {
    format!("agent_search_key_{engine}")
}

pub const DUCKDUCKGO: &str = "duckduckgo";
pub const SEARXNG: &str = "searxng";
pub const OFF: &str = "off";
/// Sem nada escolhido no painel.
pub const DEFAULT_ENGINE: &str = DUCKDUCKGO;

pub struct Engine {
    pub id: &'static str,
    pub name: &'static str,
    pub keyed: bool,
    pub console: &'static str,
    pub note: &'static str,
}

pub const ENGINES: &[Engine] = &[
    Engine {
        id: DUCKDUCKGO,
        name: "DuckDuckGo (sem chave)",
        keyed: false,
        console: "",
        note: "Grátis e sem chave. Vai pelo app do Windows de quem pede; sem ele (navegador, celular, tarefa agendada), pelo nó de mídia (um computador em casa); sem nó, direto deste servidor, e o DuckDuckGo costuma bloquear servidores em datacenter (nuvem).",
    },
    Engine { id: "brave", name: "Brave Search", keyed: true, console: "https://api-dashboard.search.brave.com", note: "" },
    Engine { id: "tavily", name: "Tavily", keyed: true, console: "https://app.tavily.com", note: "" },
    Engine { id: "exa", name: "Exa", keyed: true, console: "https://dashboard.exa.ai", note: "" },
    Engine { id: "serper", name: "Serper (Google)", keyed: true, console: "https://serper.dev", note: "" },
    Engine {
        id: SEARXNG,
        name: "SearXNG (endereço próprio)",
        keyed: false,
        console: "",
        note: "O endereço de uma instância sua, com o formato JSON ligado (search.formats: json).",
    },
    Engine { id: OFF, name: "Desligada", keyed: false, console: "", note: "" },
];

pub fn engine(id: &str) -> Option<&'static Engine> {
    ENGINES.iter().find(|e| e.id == id)
}

pub fn engines_view() -> Value {
    Value::Array(
        ENGINES
            .iter()
            .map(|e| json!({ "id": e.id, "name": e.name, "keyed": e.keyed, "console": e.console, "note": e.note, "url": e.id == SEARXNG }))
            .collect(),
    )
}

#[derive(Clone, Default)]
pub struct Config {
    pub engine: String,
    pub key: String,
    pub base: String,
    /// O nó de mídia que pesquisa no DuckDuckGo pela internet dele (veja o começo do arquivo).
    pub relay: Option<Relay>,
    /// O app do Windows de quem pediu, que pesquisa pela internet do computador dele.
    pub device: Option<Device>,
}

#[derive(Clone)]
pub struct Device {
    pub hub: std::sync::Arc<crate::hub::Hub>,
    pub user_id: String,
}

/// Pesquisas pedidas a um app, esperando a resposta: id → (de quem, para onde vai o resultado).
type Waiting = std::collections::HashMap<String, (String, tokio::sync::oneshot::Sender<Result<Vec<Value>, String>>)>;
static WAITING: Mutex<Option<Waiting>> = Mutex::new(None);
/// Quanto esperar pelo app antes de passar ao próximo passo.
const DEVICE_WAIT: Duration = Duration::from_secs(12);

/// Pede a pesquisa ao app do Windows de quem pediu. `None`: não há app que pesquise, ou ele não respondeu a tempo.
async fn device_search(d: &Device, q: &str) -> Option<Result<Vec<Value>, String>> {
    let conn = d.hub.search_conn(&d.user_id)?;
    let id = uuid::Uuid::new_v4().simple().to_string();
    let (tx, rx) = tokio::sync::oneshot::channel();
    WAITING.lock().unwrap().get_or_insert_with(Default::default).insert(id.clone(), (d.user_id.clone(), tx));
    let sent = d.hub.to_conn(&conn, "agent:web-search", json!({ "id": id, "q": q }));
    let got = if sent { tokio::time::timeout(DEVICE_WAIT, rx).await.ok().and_then(Result::ok) } else { None };
    WAITING.lock().unwrap().get_or_insert_with(Default::default).remove(&id);
    // o que vem do app passa pela mesma limpeza dos outros serviços
    got.map(|r| {
        r.map(|list| {
            list.iter()
                .map(|x| hit(s(x, "title"), s(x, "url"), s(x, "snippet")))
                .filter(|h| h["url"].as_str().is_some_and(|u| u.starts_with("https://") || u.starts_with("http://")))
                .take(RESULTS)
                .collect()
        })
    })
}

/// A resposta do app a uma pesquisa (só vale para quem foi pedida). `false`: id desconhecido ou já vencido.
pub fn deliver(user_id: &str, id: &str, result: Result<Vec<Value>, String>) -> bool {
    let mut w = WAITING.lock().unwrap();
    let Some(map) = w.as_mut() else { return false };
    if map.get(id).is_none_or(|(u, _)| u != user_id) {
        return false;
    }
    let (_, tx) = map.remove(id).expect("conferido acima");
    tx.send(result).is_ok()
}

#[derive(Clone)]
pub struct Relay {
    pub registry: std::sync::Arc<crate::media::registry::Registry>,
    pub node: String,
}

impl Config {
    pub fn usable(&self) -> bool {
        match engine(&self.engine) {
            None => false,
            Some(e) if e.id == OFF => false,
            Some(e) if e.keyed => !self.key.is_empty(),
            Some(e) if e.id == SEARXNG => !self.base.is_empty(),
            Some(e) if e.id == DUCKDUCKGO && (self.relay.is_some() || self.device.as_ref().is_some_and(|d| d.hub.search_conn(&d.user_id).is_some())) => true,
            Some(_) => !blocked(&self.engine),
        }
    }
}

/// Serviço sem chave que recusou o servidor (o DuckDuckGo com endereços de datacenter): fica de fora por um
/// tempo, para o modelo não gastar passos com uma ferramenta que não responde.
static BLOCKED: Mutex<Option<(String, std::time::Instant)>> = Mutex::new(None);
const BLOCK_FOR: Duration = Duration::from_secs(30 * 60);

pub fn blocked(engine: &str) -> bool {
    BLOCKED.lock().unwrap().as_ref().is_some_and(|(e, at)| e == engine && at.elapsed() < BLOCK_FOR)
}

fn block(engine: &str) {
    *BLOCKED.lock().unwrap() = Some((engine.to_string(), std::time::Instant::now()));
}

pub fn unblock() {
    *BLOCKED.lock().unwrap() = None;
}

pub fn is_tool(name: &str) -> bool {
    name == SEARCH_TOOL || name == PAGE_TOOL
}

pub fn tool_defs() -> Vec<Value> {
    vec![
        json!({
            "name": SEARCH_TOOL,
            "description": "Pesquisa na internet (notícias, documentação, preços, como fazer algo). Devolve título, endereço e \
                            um trecho de cada resultado. Para ler um resultado inteiro, use open_page. Até 5 pesquisas por pedido.",
            "input_schema": {
                "type": "object",
                "properties": { "query": { "type": "string", "description": "O que pesquisar, em poucas palavras" } },
                "required": ["query"],
            },
        }),
        json!({
            "name": PAGE_TOOL,
            "description": "Lê o texto de uma página da internet (http ou https). Páginas longas vêm em partes: para continuar, \
                            passe start com o número que veio em next.",
            "input_schema": {
                "type": "object",
                "properties": {
                    "url": { "type": "string" },
                    "start": { "type": "integer", "description": "De que caractere do texto continuar (padrão 0)" },
                },
                "required": ["url"],
            },
        }),
    ]
}

/// As pesquisas e páginas de um pedido.
pub struct Session {
    cfg: Config,
    searches: u32,
    pages: u32,
}

impl Session {
    pub fn new(cfg: Config) -> Self {
        Session { cfg, searches: 0, pages: 0 }
    }

    /// Roda uma das duas ferramentas. `Ok((resultado, pesquisou))`.
    pub async fn run(&mut self, name: &str, input: &Value) -> Result<(Value, bool), String> {
        match name {
            SEARCH_TOOL => {
                let q = input["query"].as_str().unwrap_or_default().trim();
                if q.is_empty() {
                    return Err("Diga o que pesquisar (query)".into());
                }
                if self.searches >= MAX_SEARCHES {
                    return Err("Limite de pesquisas deste pedido atingido: responda com o que já encontrou.".into());
                }
                self.searches += 1;
                let q: String = q.chars().take(300).collect();
                let hits = search(&self.cfg, &q).await?;
                if hits.is_empty() {
                    return Ok((json!({ "query": q, "results": [], "note": "Nenhum resultado. Tente outras palavras." }), true));
                }
                Ok((json!({ "query": q, "results": hits }), true))
            }
            PAGE_TOOL => {
                if self.pages >= MAX_PAGES {
                    return Err("Limite de páginas deste pedido atingido: responda com o que já leu.".into());
                }
                self.pages += 1;
                let url = input["url"].as_str().unwrap_or_default().trim();
                let start = input["start"].as_u64().unwrap_or(0) as usize;
                Ok((open_page(url, start).await?, false))
            }
            _ => Err("Ferramenta desconhecida".into()),
        }
    }
}

/// Um endereço com os parâmetros (`query` do reqwest é um recurso desligado aqui).
fn with_params(base: &str, params: &[(&str, &str)]) -> Result<reqwest::Url, String> {
    reqwest::Url::parse_with_params(base, params).map_err(|_| "Endereço do serviço de pesquisa inválido".to_string())
}

fn client(timeout: u64) -> Result<reqwest::Client, String> {
    reqwest::Client::builder()
        .timeout(Duration::from_secs(timeout))
        .user_agent(UA)
        .build()
        .map_err(|e| e.to_string())
}

fn hit(title: &str, url: &str, snippet: &str) -> Value {
    let clip = |s: &str, n: usize| -> String {
        let s = collapse(&decode_entities(&strip_tags(s)));
        if s.chars().count() > n {
            s.chars().take(n).collect::<String>() + "…"
        } else {
            s
        }
    };
    json!({ "title": clip(title, 200), "url": url, "snippet": clip(snippet, 400) })
}

/// Pesquisa no serviço configurado.
pub async fn search(cfg: &Config, q: &str) -> Result<Vec<Value>, String> {
    let http = client(20)?;
    let e = engine(&cfg.engine).ok_or("Pesquisa na internet não configurada")?;
    let fail = |status: reqwest::StatusCode| -> String {
        match status.as_u16() {
            // o Brave responde 422 a uma chave que não existe
            401 | 403 | 422 => format!("O {} recusou a chave da pesquisa (o administrador do app precisa conferir).", e.name),
            402 => format!("A conta do {} está sem créditos.", e.name),
            429 => format!("O {} limitou as pesquisas agora. Tente daqui a pouco.", e.name),
            s => format!("O {} respondeu com erro {s}.", e.name),
        }
    };
    let net = |err: reqwest::Error| format!("Não deu para falar com o {}: {}", e.name, if err.is_timeout() { "demorou demais".into() } else { err.to_string() });
    let json_of = |r: reqwest::Response| async move { r.json::<Value>().await.map_err(|_| format!("O {} mandou uma resposta que não deu para ler.", e.name)) };
    let arr = |v: &Value, k: &str| v[k].as_array().cloned().unwrap_or_default();
    let hits: Vec<Value> = match e.id {
        DUCKDUCKGO => {
            if let Some(d) = &cfg.device {
                match device_search(d, q).await {
                    Some(Ok(hits)) => return Ok(hits),
                    Some(Err(err)) => eprintln!("pesquisa: o app de quem pediu não pesquisou ({err}); tentando o próximo"),
                    None => {}
                }
            }
            if let Some(r) = &cfg.relay {
                match r.registry.request_for(&r.node, "web.search", json!({ "q": q }), Duration::from_secs(25)).await {
                    Ok(v) if v["results"].is_array() => return Ok(arr(&v, "results").into_iter().take(RESULTS).collect()),
                    // o nó falhou (ou também foi bloqueado): tenta daqui
                    Ok(v) => eprintln!("pesquisa: o nó de mídia não pesquisou ({}); tentando direto", v["error"].as_str().unwrap_or("?")),
                    Err(err) => eprintln!("pesquisa: o nó de mídia não respondeu ({err}); tentando direto"),
                }
            }
            let hits = duckduckgo(q).await?;
            return Ok(hits.into_iter().filter(|h| h["url"].as_str().is_some_and(|u| u.starts_with("http"))).take(RESULTS).collect());
        }
        "brave" => {
            let r = http
                .get(with_params("https://api.search.brave.com/res/v1/web/search", &[("q", q), ("count", &RESULTS.to_string())])?)
                .header("Accept", "application/json")
                .header("X-Subscription-Token", &cfg.key)
                .send()
                .await
                .map_err(net)?;
            if !r.status().is_success() {
                return Err(fail(r.status()));
            }
            let v = json_of(r).await?;
            arr(&v["web"], "results").iter().map(|x| hit(s(x, "title"), s(x, "url"), s(x, "description"))).collect()
        }
        "tavily" => {
            let r = http
                .post("https://api.tavily.com/search")
                .bearer_auth(&cfg.key)
                .json(&json!({ "query": q, "max_results": RESULTS, "search_depth": "basic" }))
                .send()
                .await
                .map_err(net)?;
            if !r.status().is_success() {
                return Err(fail(r.status()));
            }
            let v = json_of(r).await?;
            arr(&v, "results").iter().map(|x| hit(s(x, "title"), s(x, "url"), s(x, "content"))).collect()
        }
        "exa" => {
            let r = http
                .post("https://api.exa.ai/search")
                .header("x-api-key", &cfg.key)
                .json(&json!({ "query": q, "numResults": RESULTS, "contents": { "text": { "maxCharacters": 500 } } }))
                .send()
                .await
                .map_err(net)?;
            if !r.status().is_success() {
                return Err(fail(r.status()));
            }
            let v = json_of(r).await?;
            arr(&v, "results").iter().map(|x| hit(s(x, "title"), s(x, "url"), s(x, "text"))).collect()
        }
        "serper" => {
            let r = http
                .post("https://google.serper.dev/search")
                .header("X-API-KEY", &cfg.key)
                .json(&json!({ "q": q, "num": RESULTS, "hl": "pt-br" }))
                .send()
                .await
                .map_err(net)?;
            if !r.status().is_success() {
                return Err(fail(r.status()));
            }
            let v = json_of(r).await?;
            arr(&v, "organic").iter().map(|x| hit(s(x, "title"), s(x, "link"), s(x, "snippet"))).collect()
        }
        SEARXNG => {
            let r = http
                .get(with_params(&format!("{}/search", cfg.base.trim_end_matches('/')), &[("q", q), ("format", "json")])?)
                .send()
                .await
                .map_err(net)?;
            if r.status().as_u16() == 403 {
                return Err("O SearXNG recusou o formato JSON: ligue `json` em search.formats no settings.yml dele.".into());
            }
            if !r.status().is_success() {
                return Err(fail(r.status()));
            }
            let v = json_of(r).await?;
            arr(&v, "results").iter().map(|x| hit(s(x, "title"), s(x, "url"), s(x, "content"))).collect()
        }
        _ => return Err("A pesquisa na internet está desligada".into()),
    };
    Ok(hits.into_iter().filter(|h| h["url"].as_str().is_some_and(|u| u.starts_with("http"))).take(RESULTS).collect())
}

/// Pesquisa no DuckDuckGo daqui (no servidor principal ou, pelo `web.search`, num nó de mídia). Vai por POST,
/// como o formulário do próprio DuckDuckGo (o GET é recusado bem antes); se a página HTML recusar, tenta a
/// versão "lite".
pub async fn duckduckgo(q: &str) -> Result<Vec<Value>, String> {
    let http = client(20)?;
    // o corpo do formulário, codificado como a parte de pesquisa de um endereço (`form` do reqwest está desligado)
    let form = with_params("https://x/", &[("q", q), ("kl", "br-pt")])?.query().unwrap_or_default().to_string();
    let mut refused = false;
    for (url, lite) in [("https://html.duckduckgo.com/html/", false), ("https://lite.duckduckgo.com/lite/", true)] {
        let r = http
            .post(url)
            .header("Content-Type", "application/x-www-form-urlencoded")
            .header("Accept-Language", "pt-BR,pt;q=0.9,en;q=0.8")
            .header("Referer", url)
            .body(form.clone())
            .send()
            .await
            .map_err(|e| format!("Não deu para falar com o DuckDuckGo: {}", if e.is_timeout() { "demorou demais".into() } else { e.to_string() }))?;
        let status = r.status();
        let html = r.text().await.unwrap_or_default();
        let marker = if lite { "result-link" } else { "result__a" };
        // 202 (ou a página de "anomalia" com 200): o DuckDuckGo recusou este endereço
        if status.as_u16() == 202 || (status.is_success() && !html.contains(marker) && html.contains("anomaly")) {
            refused = true;
            continue;
        }
        if !status.is_success() {
            return Err(format!("O DuckDuckGo respondeu com erro {}.", status.as_u16()));
        }
        return Ok(if lite { parse_duckduckgo_lite(&html) } else { parse_duckduckgo(&html) });
    }
    if refused {
        block(DUCKDUCKGO);
    }
    Err("O DuckDuckGo bloqueou as pesquisas deste servidor. Diga à pessoa que o administrador do app pode          ligar um nó de mídia (um computador em casa) ou escolher outro serviço de pesquisa no painel          (Assistente → Pesquisa na internet)."
        .into())
}

/// Os resultados da versão "lite": `<a href="…" class='result-link'>título</a>` e o trecho em `result-snippet`.
fn parse_duckduckgo_lite(html: &str) -> Vec<Value> {
    let mut out = Vec::new();
    let mut from = 0;
    while let Some(i) = html[from..].find("class='result-link'") {
        let at = from + i;
        from = at + 1;
        let Some(open) = html[..at].rfind("<a ") else { continue };
        let Some(href) = attr(&html[open..at], "href") else { continue };
        let url = match href.split_once("uddg=") {
            Some((_, rest)) => percent_decode(rest.split('&').next().unwrap_or_default()),
            None => decode_entities(href),
        };
        if url.contains("duckduckgo.com/y.js") || !url.starts_with("http") {
            continue;
        }
        let title = html[at..].split_once('>').map(|(_, r)| r.split("</a>").next().unwrap_or_default()).unwrap_or_default();
        let next = html[at + 1..].find("class='result-link'").map_or(html.len(), |n| at + 1 + n);
        let snippet = html[at..next]
            .split_once("result-snippet")
            .and_then(|(_, r)| r.split_once('>'))
            .map(|(_, r)| r.split("</td>").next().unwrap_or_default())
            .unwrap_or_default();
        out.push(hit(title, &url, snippet));
        if out.len() >= RESULTS {
            break;
        }
    }
    out
}

fn s<'a>(v: &'a Value, k: &str) -> &'a str {
    v[k].as_str().unwrap_or_default()
}

/// Os resultados da página HTML do DuckDuckGo (os anúncios ficam de fora).
fn parse_duckduckgo(html: &str) -> Vec<Value> {
    let mut out = Vec::new();
    for part in html.split("class=\"result__a\"").skip(1) {
        let Some(href) = attr(part, "href") else { continue };
        let url = match href.split_once("uddg=") {
            Some((_, rest)) => percent_decode(rest.split('&').next().unwrap_or_default()),
            None => decode_entities(href),
        };
        if url.contains("duckduckgo.com/y.js") || !url.starts_with("http") {
            continue;
        }
        let title = part.split_once('>').map(|(_, r)| r.split("</a>").next().unwrap_or_default()).unwrap_or_default();
        let snippet = part
            .split_once("result__snippet")
            .and_then(|(_, r)| r.split_once('>'))
            .map(|(_, r)| r.split("</a>").next().unwrap_or_default())
            .unwrap_or_default();
        out.push(hit(title, &url, snippet));
        if out.len() >= RESULTS {
            break;
        }
    }
    out
}

fn attr<'a>(tag: &'a str, name: &str) -> Option<&'a str> {
    let i = tag.find(&format!("{name}=\""))? + name.len() + 2;
    let end = tag[i..].find('"')?;
    Some(&tag[i..i + end])
}

fn percent_decode(s: &str) -> String {
    let b = s.as_bytes();
    let mut out = Vec::with_capacity(b.len());
    let mut i = 0;
    while i < b.len() {
        if b[i] == b'%' && i + 2 < b.len() && b[i + 1].is_ascii_hexdigit() && b[i + 2].is_ascii_hexdigit() {
            let hex = |c: u8| (c as char).to_digit(16).unwrap_or(0) as u8;
            out.push(hex(b[i + 1]) * 16 + hex(b[i + 2]));
            i += 3;
            continue;
        }
        out.push(if b[i] == b'+' { b' ' } else { b[i] });
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

// ---------- Ler uma página ----------

/// Endereços que se alcançam pela internet: nada da rede interna, do próprio aparelho, de metadados da nuvem,
/// de documentação ou reservado.
pub fn public_ip(ip: IpAddr) -> bool {
    match ip {
        IpAddr::V4(v) => public_v4(v),
        IpAddr::V6(v) => {
            if let Some(v4) = v.to_ipv4_mapped() {
                return public_v4(v4);
            }
            let s = v.segments();
            // NAT64 (64:ff9b::/96) leva a um IPv4: vale o que ele for
            if s[0] == 0x64 && s[1] == 0xff9b && s[2..6] == [0, 0, 0, 0] {
                return public_v4(Ipv4Addr::new((s[6] >> 8) as u8, s[6] as u8, (s[7] >> 8) as u8, s[7] as u8));
            }
            !(v.is_loopback()
                || v.is_unspecified()
                || v.is_multicast()
                || (s[0] & 0xfe00) == 0xfc00 // fc00::/7 (rede local)
                || (s[0] & 0xffc0) == 0xfe80 // fe80::/10 (link local)
                || (s[0] & 0xffc0) == 0xfec0 // fec0::/10 (site local, antigo)
                || (s[0] == 0x2001 && s[1] == 0x0db8) // documentação
                || s[0] == 0x0100 && s[1..4] == [0, 0, 0] // descarte
                || s[0] == 0x2002) // 6to4 (embute um IPv4 qualquer)
        }
    }
}

fn public_v4(v: Ipv4Addr) -> bool {
    let o = v.octets();
    !(v.is_private()
        || v.is_loopback()
        || v.is_link_local()
        || v.is_broadcast()
        || v.is_documentation()
        || v.is_unspecified()
        || v.is_multicast()
        || o[0] == 0
        || (o[0] == 100 && (o[1] & 0xc0) == 64) // 100.64.0.0/10 (CGNAT)
        || (o[0] == 192 && o[1] == 0 && o[2] == 0) // 192.0.0.0/24
        || (o[0] == 198 && (o[1] & 0xfe) == 18) // 198.18.0.0/15
        || o[0] >= 240)
}

/// Resolve o nome aqui e só entrega endereços públicos à conexão (vale para cada redirecionamento, e o IP
/// conferido é o mesmo que a conexão usa).
struct PublicOnly;

impl reqwest::dns::Resolve for PublicOnly {
    fn resolve(&self, name: reqwest::dns::Name) -> reqwest::dns::Resolving {
        let host = name.as_str().to_string();
        Box::pin(async move {
            let all: Vec<SocketAddr> = tokio::net::lookup_host((host.as_str(), 0)).await?.collect();
            let ok: Vec<SocketAddr> = all.into_iter().filter(|a| public_ip(a.ip())).collect();
            if ok.is_empty() {
                return Err("endereço fora da internet pública".into());
            }
            Ok(Box::new(ok.into_iter()) as reqwest::dns::Addrs)
        })
    }
}

/// Só http/https nas portas padrão, sem usuário e senha no endereço, e um IP escrito direto só se for público.
fn allowed(url: &reqwest::Url) -> Result<(), &'static str> {
    if !matches!(url.scheme(), "http" | "https") {
        return Err("Só dá para abrir endereços http ou https");
    }
    if !url.username().is_empty() || url.password().is_some() {
        return Err("Endereço com usuário e senha não é aberto");
    }
    if !matches!(url.port_or_known_default(), Some(80 | 443)) {
        return Err("Só dá para abrir páginas nas portas padrão (80 e 443)");
    }
    let host = url.host_str().unwrap_or_default();
    // o `Url` já normaliza IPs escritos de outros jeitos (decimal, octal) para a forma comum
    if let Ok(ip) = host.trim_start_matches('[').trim_end_matches(']').parse::<IpAddr>() {
        return if public_ip(ip) { Ok(()) } else { Err("Esse endereço não é da internet pública") };
    }
    let d = host.trim_end_matches('.').to_ascii_lowercase();
    if d.is_empty() || d == "localhost" || d.ends_with(".localhost") || d.ends_with(".local") || d.ends_with(".internal") || !d.contains('.') {
        return Err("Esse endereço não é da internet pública");
    }
    Ok(())
}

fn page_client() -> Result<reqwest::Client, String> {
    reqwest::Client::builder()
        .timeout(Duration::from_secs(20))
        .connect_timeout(Duration::from_secs(8))
        .user_agent(UA)
        .no_proxy()
        .dns_resolver(PublicOnly)
        .redirect(reqwest::redirect::Policy::custom(|attempt| {
            if attempt.previous().len() >= 5 {
                return attempt.error("redirecionamentos demais");
            }
            match allowed(attempt.url()) {
                Ok(()) => attempt.follow(),
                Err(e) => attempt.error(e),
            }
        }))
        .build()
        .map_err(|e| e.to_string())
}

pub async fn open_page(raw: &str, start: usize) -> Result<Value, String> {
    let url = reqwest::Url::parse(raw).map_err(|_| "Endereço inválido".to_string())?;
    allowed(&url).map_err(str::to_string)?;
    let http = page_client()?;
    let mut r = http
        .get(url.clone())
        .header("Accept", "text/html,application/xhtml+xml,text/plain;q=0.9,application/json;q=0.8,*/*;q=0.5")
        .header("Accept-Language", "pt-BR,pt;q=0.9,en;q=0.8")
        .send()
        .await
        .map_err(|e| {
            let mut msg = e.to_string();
            let mut src = std::error::Error::source(&e);
            while let Some(s) = src {
                msg.push_str(&s.to_string());
                src = s.source();
            }
            if msg.contains("fora da internet pública") || msg.contains("não é da internet") || msg.contains("portas padrão") {
                "Esse endereço não é da internet pública".to_string()
            } else if e.is_timeout() {
                "A página demorou demais para responder".to_string()
            } else {
                "Não deu para abrir a página".to_string()
            }
        })?;
    let status = r.status();
    if !status.is_success() {
        return Err(format!("A página respondeu com erro {}", status.as_u16()));
    }
    let final_url = r.url().to_string();
    let ctype = r.headers().get("content-type").and_then(|v| v.to_str().ok()).unwrap_or_default().to_ascii_lowercase();
    let kind = ctype.split(';').next().unwrap_or_default().trim().to_string();
    let textual = kind.is_empty() || kind.starts_with("text/") || kind.contains("html") || kind.contains("xml") || kind.contains("json");
    if !textual {
        return Err(format!("A página não é texto ({kind}); só dá para ler páginas e textos"));
    }
    let mut body = Vec::new();
    while let Some(chunk) = r.chunk().await.map_err(|_| "A página parou no meio".to_string())? {
        body.extend_from_slice(&chunk);
        if body.len() >= MAX_BODY {
            body.truncate(MAX_BODY);
            break;
        }
    }
    let latin1 = ["iso-8859-1", "latin1", "windows-1252", "cp1252"].iter().any(|c| ctype.contains(c));
    let raw_text = if latin1 { body.iter().map(|&b| b as char).collect() } else { String::from_utf8_lossy(&body).into_owned() };
    let html = kind.contains("html") || (kind.is_empty() && raw_text.trim_start().starts_with('<'));
    let (title, description, text) = if html { html_to_text(&raw_text) } else { (String::new(), String::new(), raw_text) };
    let chars: Vec<char> = text.chars().collect();
    let start = start.min(chars.len());
    let end = (start + PAGE_CHARS).min(chars.len());
    let mut out = json!({ "url": final_url, "text": chars[start..end].iter().collect::<String>() });
    if !title.is_empty() {
        out["title"] = json!(title);
    }
    if !description.is_empty() && start == 0 {
        out["description"] = json!(description);
    }
    if end < chars.len() {
        out["next"] = json!(end);
        out["total"] = json!(chars.len());
    }
    Ok(out)
}

// ---------- HTML para texto ----------

/// Partes que não são texto da página (scripts, menus, formulários…): somem com o conteúdo.
const SKIP: [&str; 12] = ["script", "style", "noscript", "svg", "template", "iframe", "nav", "aside", "form", "select", "button", "canvas"];
/// (O `li` abre a linha com "- "; fechar não pula outra.)
const BLOCK: [&str; 23] = [
    "p", "div", "br", "ul", "ol", "tr", "table", "section", "article", "header", "footer", "main", "blockquote", "pre",
    "h1", "h2", "h3", "h4", "h5", "h6", "dt", "dd", "figcaption",
];

/// (título, descrição, texto). Se a página tem `<main>` ou `<article>` com texto bastante, só ele.
pub fn html_to_text(html: &str) -> (String, String, String) {
    let lower = html.to_ascii_lowercase();
    let title = between(html, &lower, "<title", "</title>").map(|t| collapse(&decode_entities(&strip_tags(t)))).unwrap_or_default();
    let description = meta_description(html, &lower);
    let whole = render(html, &lower);
    for tag in ["<main", "<article"] {
        if let Some(i) = lower.find(tag) {
            let close = format!("</{}>", &tag[1..]);
            let end = lower[i..].rfind(&close).map_or(html.len(), |e| i + e + close.len());
            let part = render(&html[i..end], &lower[i..end]);
            if part.chars().count() >= 400 {
                return (title, description, part);
            }
        }
    }
    (title, description, whole)
}

fn between<'a>(html: &'a str, lower: &str, open: &str, close: &str) -> Option<&'a str> {
    let i = lower.find(open)?;
    let gt = lower[i..].find('>')? + i + 1;
    let end = lower[gt..].find(close)? + gt;
    Some(&html[gt..end])
}

fn meta_description(html: &str, lower: &str) -> String {
    let mut from = 0;
    while let Some(i) = lower[from..].find("<meta") {
        let i = from + i;
        let end = lower[i..].find('>').map_or(lower.len(), |e| i + e);
        let tag_l = &lower[i..end];
        if tag_l.contains("name=\"description\"") || tag_l.contains("property=\"og:description\"") {
            if let Some(c) = attr(&html[i..end], "content") {
                return collapse(&decode_entities(c)).chars().take(400).collect();
            }
        }
        from = end;
    }
    String::new()
}

fn render(html: &str, lower: &str) -> String {
    let b = html.as_bytes();
    let mut out = String::with_capacity(html.len() / 3);
    let mut i = 0;
    let mut text_from = 0;
    while i < b.len() {
        if b[i] != b'<' {
            i += 1;
            continue;
        }
        out.push_str(&decode_entities(&html[text_from..i]));
        text_from = i;
        if lower[i..].starts_with("<!--") {
            i = lower[i..].find("-->").map_or(b.len(), |e| i + e + 3);
            text_from = i;
            continue;
        }
        let Some(gt) = lower[i..].find('>').map(|e| i + e) else { break };
        let end = gt + 1;
        let tag = &lower[i + 1..gt];
        let closing = tag.starts_with('/');
        let name: String = tag.trim_start_matches('/').chars().take_while(|c| c.is_ascii_alphanumeric()).collect();
        i = end;
        if !closing && SKIP.contains(&name.as_str()) && !tag.ends_with('/') {
            let close = format!("</{name}");
            i = lower[i..].find(&close).map_or(b.len(), |e| {
                let j = i + e;
                lower[j..].find('>').map_or(b.len(), |g| j + g + 1)
            });
        } else if name == "title" && !closing {
            i = lower[i..].find("</title").map_or(b.len(), |e| i + e);
        } else if name == "li" && !closing {
            out.push_str("\n- ");
        } else if BLOCK.contains(&name.as_str()) {
            out.push('\n');
        } else if matches!(name.as_str(), "td" | "th") && !closing {
            out.push_str(" | ");
        } else {
            out.push(' ');
        }
        text_from = i;
    }
    if text_from < b.len() {
        out.push_str(&decode_entities(&html[text_from..]));
    }
    tidy(&out)
}

fn strip_tags(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    let mut inside = false;
    for c in s.chars() {
        match c {
            '<' => inside = true,
            '>' if inside => inside = false,
            _ if !inside => out.push(c),
            _ => {}
        }
    }
    out
}

fn decode_entities(s: &str) -> String {
    if !s.contains('&') {
        return s.to_string();
    }
    let mut out = String::with_capacity(s.len());
    let mut rest = s;
    while let Some(i) = rest.find('&') {
        out.push_str(&rest[..i]);
        rest = &rest[i..];
        let end = rest[1..].find(|c: char| c == ';' || c == '&' || c.is_whitespace()).map(|e| e + 1);
        let Some(end) = end.filter(|&e| e <= 12 && rest.as_bytes()[e] == b';') else {
            out.push('&');
            rest = &rest[1..];
            continue;
        };
        let name = &rest[1..end];
        let ch = if let Some(n) = name.strip_prefix("#x").or_else(|| name.strip_prefix("#X")) {
            u32::from_str_radix(n, 16).ok().and_then(char::from_u32)
        } else if let Some(n) = name.strip_prefix('#') {
            n.parse::<u32>().ok().and_then(char::from_u32)
        } else {
            match name {
                "amp" => Some('&'),
                "lt" => Some('<'),
                "gt" => Some('>'),
                "quot" => Some('"'),
                "apos" => Some('\''),
                "nbsp" => Some(' '),
                "ndash" => Some('–'),
                "mdash" => Some('—'),
                "hellip" => Some('…'),
                "laquo" => Some('«'),
                "raquo" => Some('»'),
                "copy" => Some('©'),
                "reg" => Some('®'),
                "deg" => Some('°'),
                "euro" => Some('€'),
                "rsquo" | "lsquo" => Some('\''),
                "rdquo" | "ldquo" => Some('"'),
                "middot" => Some('·'),
                _ => None,
            }
        };
        match ch {
            Some(c) => {
                out.push(c);
                rest = &rest[end + 1..];
            }
            None => {
                out.push('&');
                rest = &rest[1..];
            }
        }
    }
    out.push_str(rest);
    out
}

fn collapse(s: &str) -> String {
    s.split_whitespace().collect::<Vec<_>>().join(" ")
}

/// Uma linha por bloco, sem espaços repetidos e no máximo uma linha em branco seguida.
fn tidy(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    let mut blank = 0;
    for line in s.lines() {
        let line = collapse(line);
        if line.is_empty() || line == "-" || line == "|" {
            blank += 1;
            continue;
        }
        if !out.is_empty() {
            out.push_str(if blank > 0 { "\n\n" } else { "\n" });
        }
        out.push_str(line.trim_matches(|c| c == '|' || c == ' '));
        blank = 0;
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn so_enderecos_publicos() {
        for bad in ["127.0.0.1", "10.0.0.5", "192.168.0.16", "172.20.1.1", "169.254.169.254", "100.64.1.1", "0.0.0.0", "::1", "fd00::1", "fe80::1", "::ffff:10.0.0.1", "64:ff9b::a00:1", "240.0.0.1"] {
            assert!(!public_ip(bad.parse().unwrap()), "{bad}");
        }
        for ok in ["8.8.8.8", "1.1.1.1", "2606:4700:4700::1111", "::ffff:8.8.8.8"] {
            assert!(public_ip(ok.parse().unwrap()), "{ok}");
        }
        let u = |s: &str| allowed(&reqwest::Url::parse(s).unwrap());
        assert!(u("https://example.com/a").is_ok());
        assert!(u("http://example.com:8080/").is_err());
        assert!(u("http://localhost/").is_err());
        assert!(u("http://intranet/").is_err());
        assert!(u("http://metadata.google.internal/").is_err());
        assert!(u("http://169.254.169.254/latest/").is_err());
        assert!(u("http://[::1]/").is_err());
        assert!(u("http://user:pw@example.com/").is_err());
        assert!(u("file:///etc/passwd").is_err());
        assert!(u("http://8.8.8.8/").is_ok());
    }

    #[test]
    fn html_vira_texto() {
        let html = r#"<html><head><title>Notícia &amp; mais</title><meta name="description" content="Resumo &quot;bom&quot;">
            <style>.a{}</style><script>var x = "<p>não</p>";</script></head><body><nav><a>Início</a> <a>Menu</a></nav>
            <h1>Título</h1><p>Primeiro   parágrafo com <b>negrito</b> e&nbsp;espaço.</p><!-- oculto --><ul><li>um</li><li>dois</li></ul>
            <table><tr><td>a</td><td>b</td></tr></table><p>Fim &#8212; &#x41;.</p></body></html>"#;
        let (t, d, text) = html_to_text(html);
        assert_eq!(t, "Notícia & mais");
        assert_eq!(d, "Resumo \"bom\"");
        assert!(!text.contains("não") && !text.contains("Menu") && !text.contains("oculto") && !text.contains(".a{}"), "{text}");
        assert!(text.contains("Título\n\nPrimeiro parágrafo com negrito e espaço."), "{text}");
        assert!(text.contains("- um\n- dois"), "{text}");
        assert!(text.contains("a | b"), "{text}");
        assert!(text.contains("Fim — A."), "{text}");
        // com <article> grande, só ele
        let long = "palavra ".repeat(80);
        let (_, _, only) = html_to_text(&format!("<body><p>rodapé de fora</p><article><p>{long}</p></article></body>"));
        assert!(!only.contains("rodapé") && only.starts_with("palavra"));
    }

    #[test]
    fn resultados_do_duckduckgo() {
        let html = r#"<div class="result results_links"><h2><a rel="nofollow" class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fdocs.rs%2Faxum%2Flatest%2F&amp;rut=abc">Axum &mdash; <b>docs</b></a></h2>
            <a class="result__snippet" href="x">Um <b>framework</b> web.</a></div>
            <div><a class="result__a" href="https://duckduckgo.com/y.js?ad=1">Anúncio</a></div>
            <div><a class="result__a" href="https://github.com/tokio-rs/axum">GitHub</a><a class="result__snippet">Código</a></div>"#;
        let r = parse_duckduckgo(html);
        assert_eq!(r.len(), 2);
        assert_eq!(r[0]["url"], "https://docs.rs/axum/latest/");
        assert_eq!(r[0]["title"], "Axum — docs");
        assert_eq!(r[0]["snippet"], "Um framework web.");
        assert_eq!(r[1]["url"], "https://github.com/tokio-rs/axum");
        assert_eq!(percent_decode("a%20b+c%C3%A9"), "a b cé");
        let lite = r#"<tr><td><a rel="nofollow" href="https://docs.rs/axum/latest/axum/" class='result-link'>axum - Rust &amp; Docs</a></td></tr>
            <tr><td class='result-snippet'>Um <b>framework</b> web.</td></tr>
            <tr><td><a rel="nofollow" href="https://duckduckgo.com/y.js?ad=1" class='result-link'>Anúncio</a></td></tr>
            <tr><td><a rel="nofollow" href="https://github.com/tokio-rs/axum" class='result-link'>GitHub</a></td></tr>"#;
        let r = parse_duckduckgo_lite(lite);
        assert_eq!(r.len(), 2);
        assert_eq!(r[0]["title"], "axum - Rust & Docs");
        assert_eq!(r[0]["snippet"], "Um framework web.");
        assert_eq!(r[1]["url"], "https://github.com/tokio-rs/axum");
        assert_eq!(r[1]["snippet"], "");
    }
}
