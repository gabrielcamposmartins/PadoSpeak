//! Os provedores de IA do assistente (veja `crate::agent`): a Anthropic, pela API dela, e os outros pelo formato da
//! OpenAI (`/chat/completions`), que DeepSeek, Qwen, Mistral, Gemini, xAI, Groq, OpenRouter, Kimi, GLM e Together
//! também aceitam.
//!
//! A conversa fica guardada sempre no formato da Anthropic (blocos `text`, `tool_use` e `tool_result`). Para os outros
//! provedores, cada pedido é traduzido na ida (`to_openai`) e a resposta na volta (`from_openai`), e o resto do
//! assistente (confirmações, histórico, tarefas agendadas) não muda. Dá para trocar de provedor no meio da conversa:
//! o que só um provedor entende (o pensamento assinado da Anthropic, o raciocínio do DeepSeek, a assinatura do
//! Gemini) só volta para ele.
//!
//! A lista de modelos vem do próprio provedor, com a chave (`models`). A pesquisa na internet é da Anthropic: com
//! os outros, o assistente fica sem ela.
use serde_json::{json, Map, Value};
use std::time::Duration;

/// `ANTHROPIC_BASE_URL` troca o endereço da API da Anthropic (um proxy da empresa, ou um servidor de teste).
pub fn anthropic_base() -> String {
    std::env::var("ANTHROPIC_BASE_URL").ok().map(|u| u.trim().trim_end_matches('/').to_string()).filter(|u| !u.is_empty()).unwrap_or_else(|| "https://api.anthropic.com".into())
}
pub const API_VERSION: &str = "2026-10-21";
/// Recusa do modelo: a API tenta de novo no modelo que a Anthropic recomenda para o motivo (`fallbacks: "default"`).
const FALLBACK_BETA: &str = "server-side-fallback-2026-07-01";

pub const ANTHROPIC: &str = "anthropic";
/// Qualquer outro serviço no formato da OpenAI, no endereço que o dono do app digitar (um Ollama, um vLLM, um proxy).
pub const CUSTOM: &str = "custom";

#[derive(Clone, Copy, PartialEq, Debug)]
pub enum Kind {
    Anthropic,
    OpenAi,
}

/// Um provedor pronto para escolher.
pub struct Preset {
    pub id: &'static str,
    pub name: &'static str,
    pub kind: Kind,
    /// O endereço da API (sem a barra no fim). Vazio: o da Anthropic (`anthropic_base`) ou o digitado (`custom`).
    pub base: &'static str,
    /// Onde a pessoa cria a chave.
    pub console: &'static str,
    /// Como a chave começa (o exemplo no campo).
    pub placeholder: &'static str,
    /// Outro endereço para a lista de modelos, quando o formato da OpenAI não tem `/models`.
    pub models_alt: &'static str,
    /// Campos a mais em todo pedido (JSON).
    pub extra: &'static str,
    /// O provedor quer de volta o raciocínio (`reasoning_content`) das respostas com ferramentas, dentro do mesmo pedido.
    pub echo_reasoning: bool,
}

const fn openai(id: &'static str, name: &'static str, base: &'static str, console: &'static str, placeholder: &'static str) -> Preset {
    Preset { id, name, kind: Kind::OpenAi, base, console, placeholder, models_alt: "", extra: "", echo_reasoning: false }
}

pub const PRESETS: &[Preset] = &[
    Preset {
        id: ANTHROPIC,
        name: "Anthropic (Claude)",
        kind: Kind::Anthropic,
        base: "",
        console: "console.anthropic.com, em API Keys",
        placeholder: "sk-ant-…",
        models_alt: "",
        extra: "",
        echo_reasoning: false,
    },
    openai("openai", "OpenAI (GPT)", "https://api.openai.com/v1", "platform.openai.com, em API keys", "sk-…"),
    openai("google", "Google (Gemini)", "https://generativelanguage.googleapis.com/v1beta/openai", "aistudio.google.com, em Get API key", "AIza…"),
    Preset { echo_reasoning: true, ..openai("deepseek", "DeepSeek", "https://api.deepseek.com", "platform.deepseek.com, em API keys", "sk-…") },
    Preset {
        models_alt: "https://dashscope-intl.aliyuncs.com/api/v1/models",
        // os Qwen3 abertos pensam por padrão, e pensar exige resposta em partes (stream): sem isso, recusam
        extra: r#"{"enable_thinking":false}"#,
        ..openai("qwen", "Qwen (Alibaba Cloud)", "https://dashscope-intl.aliyuncs.com/compatible-mode/v1", "Model Studio da Alibaba Cloud, em API Key", "sk-…")
    },
    openai("mistral", "Mistral", "https://api.mistral.ai/v1", "console.mistral.ai, em API Keys", ""),
    openai("xai", "xAI (Grok)", "https://api.x.ai/v1", "console.x.ai, em API Keys", "xai-…"),
    Preset { echo_reasoning: true, ..openai("moonshot", "Moonshot (Kimi)", "https://api.moonshot.ai/v1", "platform.moonshot.ai, em API Keys", "sk-…") },
    openai("zhipu", "Z.ai (GLM)", "https://api.z.ai/api/paas/v4", "z.ai, em API Keys", ""),
    openai("groq", "Groq", "https://api.groq.com/openai/v1", "console.groq.com, em API Keys", "gsk_…"),
    openai("openrouter", "OpenRouter", "https://openrouter.ai/api/v1", "openrouter.ai, em Keys", "sk-or-…"),
    openai("together", "Together AI", "https://api.together.xyz/v1", "api.together.ai, em API Keys", ""),
    openai(CUSTOM, "Outro (compatível com a OpenAI)", "", "o painel do serviço", ""),
];

pub fn preset(id: &str) -> Option<&'static Preset> {
    PRESETS.iter().find(|p| p.id == id)
}

/// O nome para mostrar (de um provedor que sumiu da lista, o próprio id).
pub fn name_of(id: &str) -> String {
    preset(id).map_or_else(|| id.to_string(), |p| p.name.to_string())
}

/// A lista que o app mostra para escolher. `custom` só para o dono do app: o endereço é digitado, e numa chave de
/// qualquer pessoa ele faria o servidor pedir a endereços da rede interna.
pub fn presets_view(with_custom: bool) -> Value {
    Value::Array(
        PRESETS
            .iter()
            .filter(|p| with_custom || p.id != CUSTOM)
            .map(|p| json!({ "id": p.id, "name": p.name, "console": p.console, "placeholder": p.placeholder, "custom": p.id == CUSTOM, "webSearch": p.kind == Kind::Anthropic }))
            .collect(),
    )
}

/// Um endereço digitado para o provedor `custom`: http(s), sem espaços e sem a barra no fim.
pub fn clean_base(url: &str) -> Result<String, String> {
    let u = url.trim().trim_end_matches('/');
    let ok = (u.starts_with("https://") || u.starts_with("http://")) && u.len() <= 200 && u.len() > 10 && !u.chars().any(|c| c.is_whitespace() || c.is_control());
    if ok {
        Ok(u.to_string())
    } else {
        Err("Digite o endereço da API inteiro (por exemplo, http://localhost:11434/v1)".into())
    }
}

/// Uma chave plausível (os formatos mudam de um provedor para outro: só o tamanho e nada de espaços).
pub fn clean_key(key: &str) -> Result<String, String> {
    let k = key.trim();
    if k.len() < 8 || k.len() > 400 || k.chars().any(|c| c.is_whitespace() || c.is_control()) {
        return Err("Cole a chave inteira, sem espaços".into());
    }
    Ok(k.to_string())
}

/// A chave, o modelo e o provedor de um pedido.
#[derive(Clone)]
pub struct Resolved {
    pub key: String,
    pub model: String,
    /// A chave é da própria pessoa (os avisos de chave recusada mudam).
    pub own: bool,
    pub provider: String,
    /// O endereço da API, já resolvido.
    pub base: String,
}

impl Resolved {
    pub fn kind(&self) -> Kind {
        preset(&self.provider).map_or(Kind::OpenAi, |p| p.kind)
    }
}

/// O endereço da API de um provedor (`custom` usa o guardado com a chave).
pub fn base_of(provider: &str, custom: &str) -> String {
    match preset(provider) {
        Some(p) if p.kind == Kind::Anthropic => anthropic_base(),
        Some(p) if !p.base.is_empty() => p.base.to_string(),
        _ => custom.trim_end_matches('/').to_string(),
    }
}

/// Um pedido à API que não deu certo: o código, o motivo que a API deu e o que mostrar à pessoa.
pub struct Failure {
    pub status: u16,
    pub detail: String,
    pub message: String,
}

impl Failure {
    pub fn plain(message: &str) -> Self {
        Failure { status: 0, detail: String::new(), message: message.into() }
    }
}

/// O motivo de um erro, nos formatos que os provedores usam.
fn error_detail(v: &Value) -> String {
    let e = &v["error"];
    let s = e["message"].as_str().or_else(|| e.as_str()).or_else(|| v["message"].as_str()).or_else(|| v["detail"].as_str());
    s.unwrap_or_default().chars().take(400).collect()
}

/// Manda um pedido (no formato da Anthropic) ao provedor e devolve a resposta no formato da Anthropic.
pub async fn call(http: &reqwest::Client, using: &Resolved, body: &Value) -> Result<Value, Failure> {
    let kind = using.kind();
    let req = match kind {
        Kind::Anthropic => {
            let mut body = body.clone();
            if let Some(m) = body.get_mut("messages").and_then(Value::as_array_mut) {
                *m = for_anthropic(m);
            }
            http.post(format!("{}/v1/messages", using.base))
                .header("x-api-key", &using.key)
                .header("anthropic-version", API_VERSION)
                .header("anthropic-beta", FALLBACK_BETA)
                .header("content-type", "application/json")
                .body(body.to_string())
        }
        Kind::OpenAi => http
            .post(format!("{}/chat/completions", using.base))
            .bearer_auth(&using.key)
            .header("content-type", "application/json")
            .body(to_openai(body, &using.provider).to_string()),
    };
    let res = req
        .send()
        .await
        .map_err(|e| Failure::plain(if e.is_timeout() { "O assistente demorou demais para responder." } else { "Não deu para falar com o assistente agora. Tente de novo." }))?;
    let status = res.status();
    let bytes = res.bytes().await.map_err(|_| Failure::plain("A resposta do assistente chegou incompleta."))?;
    let v: Value = serde_json::from_slice(&bytes).unwrap_or(Value::Null);
    if status.is_success() {
        return match kind {
            Kind::Anthropic => Ok(v),
            Kind::OpenAi if v["choices"].is_array() => Ok(from_openai(&v, &using.provider)),
            Kind::OpenAi => {
                eprintln!("assistente: resposta sem choices de {}: {}", using.provider, error_detail(&v));
                Err(Failure::plain("O assistente não conseguiu responder (a resposta veio vazia)."))
            }
        };
    }
    let detail = error_detail(&v);
    eprintln!("assistente: a API ({}) respondeu {status}: {detail}", using.provider);
    let name = name_of(&using.provider);
    let message = match status.as_u16() {
        401 | 403 if using.own => format!("{name} recusou a sua chave da API. Troque em Configurações → Assistente."),
        401 | 403 => "A chave da API do assistente foi recusada. Avise o dono do app.".into(),
        402 => format!("A conta da chave em {name} está sem saldo."),
        404 => format!("O modelo {} não existe ou esta chave não tem acesso a ele.", using.model),
        429 => "O assistente está com muitos pedidos agora. Tente de novo em instantes.".into(),
        529 | 500..=599 => "O serviço do assistente está instável agora. Tente de novo em instantes.".into(),
        _ => format!("O assistente não conseguiu responder (erro {status})."),
    };
    Err(Failure { status: status.as_u16(), detail, message })
}

// ---------- Lista de modelos ----------

/// Modelos que não conversam (imagens, voz, embeddings…) e que não servem ao assistente.
const NOT_CHAT: [&str; 18] = [
    "embed", "tts", "whisper", "dall-e", "gpt-image", "davinci", "babbage", "moderation", "realtime", "transcribe", "speech", "rerank", "imagen", "veo",
    "aqa", "-audio", "guard", "ocr",
];

/// Os modelos de chat que a chave alcança. `Err` só quando a chave foi recusada ou o provedor não respondeu; um
/// provedor sem lista de modelos devolve uma lista vazia (a pessoa digita o nome).
pub async fn models(provider: &str, base: &str, key: &str) -> Result<Vec<Value>, String> {
    let name = name_of(provider);
    let http = reqwest::Client::builder().timeout(Duration::from_secs(15)).build().map_err(|e| e.to_string())?;
    let p = preset(provider);
    let anthropic = p.is_some_and(|p| p.kind == Kind::Anthropic);
    let get = |url: String| {
        let req = http.get(url);
        if anthropic {
            req.header("x-api-key", key).header("anthropic-version", API_VERSION)
        } else {
            req.bearer_auth(key)
        }
    };
    let url = if anthropic { format!("{base}/v1/models?limit=100") } else { format!("{base}/models") };
    let mut res = get(url).send().await.map_err(|_| format!("Não deu para falar com {name} agora. Tente de novo."))?;
    if res.status().as_u16() == 404 {
        if let Some(alt) = p.map(|p| p.models_alt).filter(|a| !a.is_empty()) {
            res = get(alt.to_string()).send().await.map_err(|_| format!("Não deu para falar com {name} agora. Tente de novo."))?;
        }
    }
    let status = res.status().as_u16();
    if matches!(status, 401 | 403) {
        return Err(format!("{name} recusou esta chave"));
    }
    if status == 402 {
        return Err(format!("A conta desta chave em {name} está sem saldo"));
    }
    if !(200..300).contains(&status) {
        // sem a lista (o serviço não tem `/models`): a chave fica sem conferir, e o modelo é digitado
        eprintln!("assistente: a lista de modelos de {provider} respondeu {status}");
        return Ok(Vec::new());
    }
    let v: Value = res.json().await.unwrap_or(Value::Null);
    Ok(parse_models(&v, anthropic))
}

/// A lista de modelos nos formatos que os provedores usam (`data`, a lista solta ou `output.models`), só os de chat.
pub fn parse_models(v: &Value, keep_order: bool) -> Vec<Value> {
    let list = v["data"]
        .as_array()
        .or_else(|| v.as_array())
        .or_else(|| v["output"]["models"].as_array())
        .or_else(|| v["models"].as_array())
        .cloned()
        .unwrap_or_default();
    let mut out: Vec<(i64, String, String)> = Vec::new();
    for m in &list {
        let Some(raw) = m["id"].as_str().or_else(|| m["model"].as_str()).or_else(|| m["name"].as_str()) else { continue };
        // o Gemini dá "models/gemini-…"; no pedido vai sem o prefixo
        let id = raw.strip_prefix("models/").unwrap_or(raw).to_string();
        let low = id.to_lowercase();
        if id.is_empty() || id.len() > 120 || NOT_CHAT.iter().any(|w| low.contains(w)) {
            continue;
        }
        // a Mistral diz o que cada modelo faz; o OpenRouter, que parâmetros aceita; o Together, o tipo
        let caps = &m["capabilities"];
        if caps["completion_chat"] == false || caps["function_calling"] == false {
            continue;
        }
        if m["supported_parameters"].as_array().is_some_and(|p| !p.iter().any(|x| x == "tools")) {
            continue;
        }
        if m["type"].as_str().is_some_and(|t| t != "chat" && t != "model" && t != "language") {
            continue;
        }
        if out.iter().any(|(_, i, _)| *i == id) {
            continue;
        }
        let name = m["display_name"].as_str().or_else(|| m["name"].as_str().filter(|n| *n != raw)).unwrap_or(&id).to_string();
        out.push((m["created"].as_i64().unwrap_or(0), id, name));
    }
    if !keep_order {
        // os mais novos primeiro (quem diz a data); o resto em ordem alfabética
        out.sort_by(|a, b| b.0.cmp(&a.0).then_with(|| a.1.cmp(&b.1)));
    }
    out.into_iter().take(300).map(|(_, id, name)| json!({ "id": id, "name": name })).collect()
}

// ---------- Tradução para o formato da OpenAI ----------

/// O histórico para a Anthropic: sem o que só os outros provedores entendem.
pub fn for_anthropic(messages: &[Value]) -> Vec<Value> {
    let mut out = Vec::new();
    for m in messages {
        let Some(blocks) = m["content"].as_array() else {
            out.push(m.clone());
            continue;
        };
        let kept: Vec<Value> = blocks
            .iter()
            .filter(|b| b["type"] != "oa_reasoning")
            .map(|b| {
                let mut b = b.clone();
                if let Some(o) = b.as_object_mut() {
                    o.remove("oa_extra");
                    o.remove("oa_provider");
                }
                b
            })
            .collect();
        if !kept.is_empty() {
            out.push(json!({ "role": m["role"], "content": kept }));
        }
    }
    out
}

/// Um id de chamada que todo provedor aceita (a Mistral só aceita 9 letras e números): o mesmo id de origem vira
/// sempre o mesmo, então a chamada e a resposta continuam ligadas.
pub fn short_id(id: &str) -> String {
    let mut h: u64 = 0xcbf2_9ce4_8422_2325;
    for b in id.bytes() {
        h ^= u64::from(b);
        h = h.wrapping_mul(0x0100_0000_01b3);
    }
    const ABC: &[u8] = b"abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
    (0..9)
        .map(|_| {
            let c = ABC[(h % ABC.len() as u64) as usize] as char;
            h /= ABC.len() as u64;
            c
        })
        .collect()
}

fn text_of(content: &Value) -> String {
    match content {
        Value::String(s) => s.clone(),
        Value::Array(a) => a.iter().filter_map(|b| b["text"].as_str()).collect::<Vec<_>>().join("\n\n"),
        _ => String::new(),
    }
}

/// Um pedido no formato da Anthropic, no formato da OpenAI.
pub fn to_openai(body: &Value, provider: &str) -> Value {
    let p = preset(provider);
    let echo = p.is_some_and(|p| p.echo_reasoning);
    let messages = body["messages"].as_array().cloned().unwrap_or_default();
    // o pedido atual começa na última mensagem com texto da pessoa (não uma resposta de ferramenta)
    let is_person = |m: &Value| m["role"] == "user" && (m["content"].is_string() || m["content"].as_array().is_some_and(|a| a.iter().any(|b| b["type"] == "text")));
    let current = messages.iter().rposition(is_person).unwrap_or(0);
    let mut out = Vec::new();
    let system = text_of(&body["system"]);
    if !system.is_empty() {
        out.push(json!({ "role": "system", "content": system }));
    }
    for (i, m) in messages.iter().enumerate() {
        let blocks: Vec<Value> = match &m["content"] {
            Value::String(s) => vec![json!({ "type": "text", "text": s })],
            Value::Array(a) => a.clone(),
            _ => continue,
        };
        if m["role"] == "user" {
            let mut texts = Vec::new();
            for b in &blocks {
                match b["type"].as_str() {
                    Some("tool_result") => {
                        let mut text = text_of(&b["content"]);
                        if b["is_error"] == true {
                            text = format!("Erro: {text}");
                        }
                        out.push(json!({ "role": "tool", "tool_call_id": short_id(b["tool_use_id"].as_str().unwrap_or_default()), "content": text }));
                    }
                    Some("text") => texts.push(b["text"].as_str().unwrap_or_default().to_string()),
                    _ => {}
                }
            }
            if !texts.is_empty() {
                out.push(json!({ "role": "user", "content": texts.join("\n\n") }));
            }
            continue;
        }
        let mut text = String::new();
        let mut reasoning = String::new();
        let mut calls = Vec::new();
        for b in &blocks {
            match b["type"].as_str() {
                Some("text") => {
                    if !text.is_empty() {
                        text.push_str("\n\n");
                    }
                    text.push_str(b["text"].as_str().unwrap_or_default());
                }
                Some("oa_reasoning") if echo && i > current && b["provider"] == provider => reasoning.push_str(b["text"].as_str().unwrap_or_default()),
                Some("tool_use") => {
                    let id = b["id"].as_str().unwrap_or_default();
                    let mut call = json!({
                        "id": short_id(id),
                        "type": "function",
                        "function": { "name": b["name"], "arguments": b["input"].to_string() },
                    });
                    if b["oa_provider"] == provider && b["oa_extra"].is_object() {
                        call["extra_content"] = b["oa_extra"].clone();
                    } else if provider == "google" && i > current {
                        // o Gemini 3 exige a assinatura do raciocínio nas chamadas do pedido atual; uma chamada feita por
                        // outro provedor não tem, e este valor é o que o Google aceita no lugar
                        call["extra_content"] = json!({ "google": { "thought_signature": "skip_thought_signature_validator" } });
                    }
                    calls.push(call);
                }
                // o pensamento da Anthropic, a pesquisa na internet e o resto não têm equivalente
                _ => {}
            }
        }
        if text.is_empty() && calls.is_empty() {
            continue;
        }
        let mut msg = json!({ "role": "assistant" });
        if !text.is_empty() {
            msg["content"] = json!(text);
        }
        if !calls.is_empty() {
            msg["tool_calls"] = json!(calls);
        }
        if !reasoning.is_empty() {
            msg["reasoning_content"] = json!(reasoning);
        }
        out.push(msg);
    }
    let tools: Vec<Value> = body["tools"]
        .as_array()
        .into_iter()
        .flatten()
        // as ferramentas que rodam no servidor da Anthropic (têm `type`) ficam de fora
        .filter(|t| t.get("type").is_none() && t["name"].is_string())
        .map(|t| json!({ "type": "function", "function": { "name": t["name"], "description": t["description"], "parameters": t["input_schema"] } }))
        .collect();
    let mut req = json!({ "model": body["model"], "messages": out });
    if !tools.is_empty() {
        req["tools"] = json!(tools);
    }
    if let Some(Value::Object(extra)) = p.map(|p| p.extra).filter(|e| !e.is_empty()).and_then(|e| serde_json::from_str(e).ok()) {
        for (k, v) in extra {
            req[k.as_str()] = v;
        }
    }
    req
}

/// Tira o raciocínio que alguns modelos abertos escrevem no começo do texto, entre `<think>` e `</think>`.
fn strip_think(text: &str) -> (String, String) {
    let t = text.trim_start();
    if let Some(rest) = t.strip_prefix("<think>") {
        if let Some(end) = rest.find("</think>") {
            return (rest[end + 8..].trim().to_string(), rest[..end].trim().to_string());
        }
    }
    (text.trim().to_string(), String::new())
}

/// Um id de chamada que a Anthropic também aceita (letras, números, `_` e `-`), para a conversa poder voltar a ela.
fn clean_call_id(id: Option<&str>, n: usize) -> String {
    let id: String = id.unwrap_or_default().chars().filter(|c| c.is_ascii_alphanumeric() || *c == '_' || *c == '-').take(64).collect();
    if id.is_empty() {
        format!("call_{}_{n}", uuid::Uuid::new_v4().simple())
    } else {
        id
    }
}

/// Uma resposta no formato da OpenAI, no formato da Anthropic (`content`, `stop_reason` e `usage`).
pub fn from_openai(res: &Value, provider: &str) -> Value {
    let choice = &res["choices"][0];
    let msg = &choice["message"];
    let mut content = Vec::new();
    let raw = match &msg["content"] {
        Value::String(s) => s.clone(),
        Value::Array(a) => a.iter().filter_map(|b| b["text"].as_str()).collect::<String>(),
        _ => String::new(),
    };
    let (text, think) = strip_think(&raw);
    let reasoning = msg["reasoning_content"].as_str().or_else(|| msg["reasoning"].as_str()).map(str::to_string).unwrap_or(think);
    if !reasoning.trim().is_empty() && preset(provider).is_some_and(|p| p.echo_reasoning) {
        content.push(json!({ "type": "oa_reasoning", "provider": provider, "text": reasoning }));
    }
    if !text.is_empty() {
        content.push(json!({ "type": "text", "text": text }));
    }
    let mut calls = 0;
    for (n, tc) in msg["tool_calls"].as_array().into_iter().flatten().enumerate() {
        let f = &tc["function"];
        let Some(name) = f["name"].as_str().filter(|n| !n.is_empty()) else { continue };
        let input = match &f["arguments"] {
            Value::String(s) => serde_json::from_str::<Value>(s).ok(),
            Value::Object(_) => Some(f["arguments"].clone()),
            _ => None,
        };
        let input = input.filter(Value::is_object).unwrap_or_else(|| Value::Object(Map::new()));
        let mut block = json!({ "type": "tool_use", "id": clean_call_id(tc["id"].as_str(), n), "name": name, "input": input });
        if tc["extra_content"].is_object() {
            block["oa_extra"] = tc["extra_content"].clone();
            block["oa_provider"] = json!(provider);
        }
        content.push(block);
        calls += 1;
    }
    let stop = match choice["finish_reason"].as_str().unwrap_or_default() {
        _ if calls > 0 => "tool_use",
        "length" => "max_tokens",
        "content_filter" if text.is_empty() => "refusal",
        _ => "end_turn",
    };
    let u = &res["usage"];
    let n = |v: &Value| v.as_i64().unwrap_or(0).max(0);
    let cached = n(&u["prompt_tokens_details"]["cached_tokens"]).max(n(&u["prompt_cache_hit_tokens"]));
    json!({
        "content": content,
        "stop_reason": stop,
        "usage": {
            "input_tokens": (n(&u["prompt_tokens"]) - cached).max(0),
            "output_tokens": n(&u["completion_tokens"]),
            "cache_read_input_tokens": cached,
            "cache_creation_input_tokens": 0,
        },
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn convo() -> Value {
        json!({
            "model": "m",
            "system": "Você é o assistente.",
            "tools": [
                { "name": "send_message", "description": "Manda", "input_schema": { "type": "object", "properties": {} } },
                { "type": "web_search_20260209", "name": "web_search", "max_uses": 5 },
            ],
            "messages": [
                { "role": "user", "content": [{ "type": "text", "text": "<contexto>x</contexto>" }, { "type": "text", "text": "oi" }] },
                { "role": "assistant", "content": [
                    { "type": "thinking", "thinking": "hmm", "signature": "s" },
                    { "type": "text", "text": "Vou mandar." },
                    { "type": "tool_use", "id": "toolu_01ABC", "name": "send_message", "input": { "text": "olá" } },
                ] },
                { "role": "user", "content": [{ "type": "tool_result", "tool_use_id": "toolu_01ABC", "content": "ok" }] },
            ],
        })
    }

    #[test]
    fn traduz_para_openai() {
        let r = to_openai(&convo(), "mistral");
        let m = r["messages"].as_array().unwrap();
        assert_eq!(m[0], json!({ "role": "system", "content": "Você é o assistente." }));
        assert_eq!(m[1]["content"], "<contexto>x</contexto>\n\noi");
        assert_eq!(m[2]["content"], "Vou mandar.");
        let id = m[2]["tool_calls"][0]["id"].as_str().unwrap();
        assert_eq!(id.len(), 9);
        assert!(id.chars().all(|c| c.is_ascii_alphanumeric()));
        assert_eq!(m[2]["tool_calls"][0]["function"]["arguments"], r#"{"text":"olá"}"#);
        assert_eq!(m[3], json!({ "role": "tool", "tool_call_id": id, "content": "ok" }));
        // a pesquisa da Anthropic fica de fora
        assert_eq!(r["tools"].as_array().unwrap().len(), 1);
        assert_eq!(r["tools"][0]["function"]["parameters"]["type"], "object");
        assert!(r.get("max_tokens").is_none());
    }

    #[test]
    fn qwen_sem_pensar_e_gemini_com_assinatura() {
        let r = to_openai(&convo(), "qwen");
        assert_eq!(r["enable_thinking"], false);
        let g = to_openai(&convo(), "google");
        assert_eq!(g["messages"][2]["tool_calls"][0]["extra_content"]["google"]["thought_signature"], "skip_thought_signature_validator");
    }

    #[test]
    fn traduz_a_resposta() {
        let res = json!({
            "choices": [{ "finish_reason": "tool_calls", "message": {
                "content": null,
                "reasoning_content": "pensando",
                "tool_calls": [{ "id": "call_9", "type": "function", "function": { "name": "send_message", "arguments": "{\"text\":\"a\"}" } }],
            } }],
            "usage": { "prompt_tokens": 100, "completion_tokens": 20, "prompt_cache_hit_tokens": 60 },
        });
        let v = from_openai(&res, "deepseek");
        assert_eq!(v["stop_reason"], "tool_use");
        assert_eq!(v["content"][0], json!({ "type": "oa_reasoning", "provider": "deepseek", "text": "pensando" }));
        assert_eq!(v["content"][1]["type"], "tool_use");
        assert_eq!(v["content"][1]["id"], "call_9");
        assert_eq!(v["content"][1]["input"]["text"], "a");
        assert_eq!(v["usage"]["input_tokens"], 40);
        assert_eq!(v["usage"]["cache_read_input_tokens"], 60);
        assert_eq!(v["usage"]["output_tokens"], 20);
        // o raciocínio volta ao DeepSeek só no pedido atual, e nunca vai para a Anthropic
        let mut c = convo();
        c["messages"].as_array_mut().unwrap().push(json!({ "role": "assistant", "content": v["content"] }));
        let r = to_openai(&c, "deepseek");
        assert_eq!(r["messages"].as_array().unwrap().last().unwrap()["reasoning_content"], "pensando");
        let a = for_anthropic(c["messages"].as_array().unwrap());
        assert!(a.last().unwrap()["content"].as_array().unwrap().iter().all(|b| b["type"] != "oa_reasoning"));
        let r = to_openai(&c, "openai");
        assert!(r["messages"].as_array().unwrap().last().unwrap().get("reasoning_content").is_none());
    }

    #[test]
    fn texto_simples_e_pensamento_no_texto() {
        let res = json!({ "choices": [{ "finish_reason": "stop", "message": { "content": "<think>a</think>\n\nOlá!" } }] });
        let v = from_openai(&res, "groq");
        assert_eq!(v["stop_reason"], "end_turn");
        assert_eq!(v["content"], json!([{ "type": "text", "text": "Olá!" }]));
        let cut = from_openai(&json!({ "choices": [{ "finish_reason": "length", "message": { "content": "meio" } }] }), "openai");
        assert_eq!(cut["stop_reason"], "max_tokens");
    }

    #[test]
    fn assinatura_do_gemini_volta_so_para_ele() {
        let res = json!({ "choices": [{ "finish_reason": "tool_calls", "message": { "tool_calls": [
            { "id": "", "function": { "name": "x", "arguments": "{}" }, "extra_content": { "google": { "thought_signature": "SIG" } } },
        ] } }] });
        let v = from_openai(&res, "google");
        let b = &v["content"][0];
        assert!(b["id"].as_str().unwrap().starts_with("call_"));
        let msgs = vec![json!({ "role": "user", "content": "oi" }), json!({ "role": "assistant", "content": v["content"] })];
        let g = to_openai(&json!({ "model": "g", "messages": msgs }), "google");
        assert_eq!(g["messages"][1]["tool_calls"][0]["extra_content"]["google"]["thought_signature"], "SIG");
        let a = for_anthropic(&msgs);
        assert!(a[1]["content"][0].get("oa_extra").is_none());
    }

    #[test]
    fn lista_de_modelos() {
        let openai = json!({ "data": [
            { "id": "text-embedding-3-small", "created": 5 },
            { "id": "gpt-x", "created": 10 },
            { "id": "gpt-y", "created": 20 },
            { "id": "whisper-1", "created": 30 },
        ] });
        let ids: Vec<_> = parse_models(&openai, false).iter().map(|m| m["id"].as_str().unwrap().to_string()).collect();
        assert_eq!(ids, ["gpt-y", "gpt-x"]);
        let gemini = json!({ "data": [{ "id": "models/gemini-pro", "display_name": "Gemini Pro" }] });
        assert_eq!(parse_models(&gemini, false)[0], json!({ "id": "gemini-pro", "name": "Gemini Pro" }));
        let mistral = json!({ "data": [
            { "id": "a", "capabilities": { "completion_chat": true, "function_calling": false } },
            { "id": "b", "capabilities": { "completion_chat": true, "function_calling": true } },
        ] });
        assert_eq!(parse_models(&mistral, false).len(), 1);
        let together = json!([{ "id": "t1", "type": "chat" }, { "id": "t2", "type": "image" }]);
        assert_eq!(parse_models(&together, false).len(), 1);
        let dashscope = json!({ "output": { "models": [{ "model": "qwen-plus" }] } });
        assert_eq!(parse_models(&dashscope, false)[0]["id"], "qwen-plus");
        let anthropic = json!({ "data": [{ "id": "claude-b", "display_name": "B" }, { "id": "claude-a", "display_name": "A" }] });
        assert_eq!(parse_models(&anthropic, true)[0]["id"], "claude-b");
    }

    #[test]
    fn enderecos_e_chaves() {
        assert!(clean_base("http://localhost:11434/v1/").is_ok_and(|u| u == "http://localhost:11434/v1"));
        assert!(clean_base("ftp://x").is_err());
        assert!(clean_key("AIzaSyD-abc_123").is_ok());
        assert!(clean_key("sk ant").is_err());
        assert_eq!(base_of("deepseek", ""), "https://api.deepseek.com");
        assert_eq!(base_of(CUSTOM, "http://x:1/v1/"), "http://x:1/v1");
        assert_eq!(short_id("toolu_01ABC"), short_id("toolu_01ABC"));
        assert_ne!(short_id("toolu_01ABC"), short_id("toolu_01ABD"));
    }
}
