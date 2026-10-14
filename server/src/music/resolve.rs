//! Converte links do YouTube e do Spotify em faixas para a fila.
use super::tools::Tools;
use super::{Source, Track};
use serde_json::Value;
use std::time::Duration;

/// Máximo de faixas importadas de uma playlist/álbum de uma vez.
pub const MAX_IMPORT: usize = 100;

#[derive(Debug, PartialEq)]
pub enum Link {
    YoutubeVideo(String),
    YoutubePlaylist(String),
    Spotify { kind: String, id: String },
}

/// Reconhece links do YouTube (vídeo, shorts, playlist) e do Spotify (faixa, álbum, playlist).
pub fn classify(raw: &str) -> Option<Link> {
    let raw = raw.trim();
    if let Some(rest) = raw.strip_prefix("spotify:") {
        let (kind, id) = rest.split_once(':')?;
        return spotify_link(kind, id);
    }
    let without_scheme = raw.split_once("://").map_or(raw, |(_, r)| r);
    let (host, rest) = without_scheme.split_once('/').unwrap_or((without_scheme, ""));
    let host = host.to_lowercase();
    let host = host.trim_start_matches("www.").trim_start_matches("m.");
    let (path, query) = rest.split_once('?').unwrap_or((rest, ""));
    let query = query.split('#').next().unwrap_or("");
    let param = |name: &str| {
        query.split('&').find_map(|kv| kv.split_once('=').filter(|(k, _)| *k == name).map(|(_, v)| v.to_string()))
    };
    let segments: Vec<&str> = path.split('/').filter(|s| !s.is_empty()).collect();

    match host {
        "youtu.be" => segments.first().map(|id| Link::YoutubeVideo(format!("https://www.youtube.com/watch?v={id}"))),
        "youtube.com" | "music.youtube.com" => match segments.as_slice() {
            ["watch"] => param("v").map(|v| Link::YoutubeVideo(format!("https://www.youtube.com/watch?v={v}"))),
            ["playlist"] => param("list").map(|l| Link::YoutubePlaylist(format!("https://www.youtube.com/playlist?list={l}"))),
            ["shorts" | "live" | "embed", id, ..] => Some(Link::YoutubeVideo(format!("https://www.youtube.com/watch?v={id}"))),
            _ => None,
        },
        "open.spotify.com" => {
            // Aceita /track/ID, /intl-pt/track/ID e /embed/track/ID.
            let segs: Vec<&str> =
                segments.into_iter().filter(|s| !s.starts_with("intl-") && *s != "embed").collect();
            match segs.as_slice() {
                [kind, id, ..] => spotify_link(kind, id),
                _ => None,
            }
        }
        _ => None,
    }
}

fn spotify_link(kind: &str, id: &str) -> Option<Link> {
    let ok_id = !id.is_empty() && id.chars().all(|c| c.is_ascii_alphanumeric());
    (matches!(kind, "track" | "album" | "playlist") && ok_id).then(|| Link::Spotify { kind: kind.into(), id: id.into() })
}

fn new_id() -> String {
    uuid::Uuid::new_v4().simple().to_string()
}

fn yt_thumb(id: &str) -> String {
    format!("https://i.ytimg.com/vi/{id}/mqdefault.jpg")
}

fn secs_to_ms(v: &Value) -> Option<u64> {
    v.as_f64().filter(|s| *s > 0.0).map(|s| (s * 1000.0) as u64)
}

// ---------- YouTube ----------

fn youtube_track(v: &Value) -> Option<Track> {
    let id = v["id"].as_str()?;
    let title = v["title"].as_str()?;
    // Itens indisponíveis aparecem na playlist como "[Private video]" / "[Deleted video]".
    if title.starts_with("[Private") || title.starts_with("[Deleted") {
        return None;
    }
    let url = format!("https://www.youtube.com/watch?v={id}");
    Some(Track {
        id: new_id(),
        title: title.to_string(),
        artist: v["channel"].as_str().or(v["uploader"].as_str()).map(String::from),
        duration_ms: secs_to_ms(&v["duration"]),
        thumbnail: Some(yt_thumb(id)),
        page_url: url.clone(),
        added_by: None,
        source: Source::Youtube(url),
    })
}

pub fn parse_youtube_json(json: &Value) -> Vec<Track> {
    if json["_type"].as_str() == Some("playlist") {
        json["entries"].as_array().into_iter().flatten().filter_map(youtube_track).take(MAX_IMPORT).collect()
    } else {
        youtube_track(json).into_iter().collect()
    }
}

async fn youtube(tools: &Tools, url: &str, playlist: bool) -> Result<Vec<Track>, String> {
    let end = MAX_IMPORT.to_string();
    let mut args = vec!["-J", "--flat-playlist", "--playlist-end", &end];
    if !playlist {
        args.push("--no-playlist");
    }
    args.push(url);
    let stdout = tools.run(&args, Duration::from_secs(90)).await.map_err(|e| format!("YouTube: {e}"))?;
    let json: Value = serde_json::from_slice(&stdout).map_err(|e| format!("yt-dlp devolveu JSON inválido: {e}"))?;
    Ok(parse_youtube_json(&json))
}

// ---------- Spotify (página pública de embed, sem credenciais) ----------

fn spotify_cover(entity: &Value) -> Option<String> {
    let images = entity["visualIdentity"]["image"].as_array().or(entity["coverArt"]["sources"].as_array())?;
    // A maior imagem até 640px.
    images
        .iter()
        .filter(|i| i["maxWidth"].as_u64().or(i["width"].as_u64()).unwrap_or(0) <= 640)
        .max_by_key(|i| i["maxWidth"].as_u64().or(i["width"].as_u64()).unwrap_or(0))
        .and_then(|i| i["url"].as_str())
        .map(String::from)
}

fn spotify_track_url(uri: Option<&str>) -> Option<String> {
    uri?.strip_prefix("spotify:track:").map(|id| format!("https://open.spotify.com/track/{id}"))
}

fn spotify_track(title: &str, artist: &str, duration: Option<u64>, cover: Option<String>, page: String) -> Track {
    let query = if artist.is_empty() { title.to_string() } else { format!("{artist} - {title}") };
    Track {
        id: new_id(),
        title: title.to_string(),
        artist: (!artist.is_empty()).then(|| artist.to_string()),
        duration_ms: duration,
        thumbnail: cover,
        page_url: page,
        added_by: None,
        source: Source::Search(query),
    }
}

/// Lê o JSON `__NEXT_DATA__` da página de embed do Spotify.
pub fn parse_spotify_embed(html: &str, kind: &str, id: &str) -> Result<Vec<Track>, String> {
    const START: &str = r#"<script id="__NEXT_DATA__" type="application/json">"#;
    let start = html.find(START).ok_or("Spotify: página sem dados (o formato pode ter mudado)")? + START.len();
    let end = html[start..].find("</script>").ok_or("Spotify: dados incompletos")? + start;
    let data: Value = serde_json::from_str(&html[start..end]).map_err(|e| format!("Spotify: {e}"))?;
    let entity = &data["props"]["pageProps"]["state"]["data"]["entity"];
    if entity.is_null() {
        return Err("Spotify: conteúdo não encontrado (link privado ou inexistente?)".into());
    }
    let cover = spotify_cover(entity);
    let page = format!("https://open.spotify.com/{kind}/{id}");

    if let Some(list) = entity["trackList"].as_array() {
        // Na playlist cada faixa tem capa própria, que o embed não informa: não repetimos a da playlist.
        let item_cover = if kind == "album" { cover } else { None };
        return Ok(list
            .iter()
            .filter(|t| t["isPlayable"].as_bool() != Some(false))
            .filter_map(|t| {
                let title = t["title"].as_str()?;
                let artist = t["subtitle"].as_str().unwrap_or("");
                let url = spotify_track_url(t["uri"].as_str()).unwrap_or_else(|| page.clone());
                Some(spotify_track(title, artist, t["duration"].as_u64(), item_cover.clone(), url))
            })
            .take(MAX_IMPORT)
            .collect());
    }

    let title = entity["title"].as_str().or(entity["name"].as_str()).ok_or("Spotify: faixa sem título")?;
    let artist = entity["artists"]
        .as_array()
        .map(|a| a.iter().filter_map(|x| x["name"].as_str()).collect::<Vec<_>>().join(", "))
        .unwrap_or_default();
    Ok(vec![spotify_track(title, &artist, entity["duration"].as_u64(), cover, page)])
}

async fn fetch_spotify(http: &reqwest::Client, kind: &str, id: &str) -> Result<Vec<Track>, String> {
    let url = format!("https://open.spotify.com/embed/{kind}/{id}");
    let res = http
        .get(&url)
        .header("user-agent", "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/155.0.0.0 Safari/537.36")
        .header("accept-language", "pt-BR,pt;q=0.9,en;q=0.8")
        .timeout(Duration::from_secs(20))
        .send()
        .await
        .map_err(|e| format!("Spotify: {e}"))?;
    if !res.status().is_success() {
        return Err(format!("Spotify respondeu {}", res.status()));
    }
    let html = res.text().await.map_err(|e| format!("Spotify: {e}"))?;
    parse_spotify_embed(&html, kind, id)
}

/// Resolve um link em faixas (sem o áudio — ele é buscado só na hora de tocar).
pub async fn resolve(tools: &Tools, http: &reqwest::Client, raw: &str) -> Result<Vec<Track>, String> {
    let tracks = match classify(raw).ok_or("Link não suportado — use um link do YouTube ou do Spotify")? {
        Link::YoutubeVideo(url) => youtube(tools, &url, false).await?,
        Link::YoutubePlaylist(url) => youtube(tools, &url, true).await?,
        Link::Spotify { kind, id } => fetch_spotify(http, &kind, &id).await?,
    };
    if tracks.is_empty() {
        return Err("Nenhuma música disponível nesse link".into());
    }
    Ok(tracks)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn classifica_links() {
        let v = |id: &str| Some(Link::YoutubeVideo(format!("https://www.youtube.com/watch?v={id}")));
        assert_eq!(classify("https://www.youtube.com/watch?v=abc123&list=PLx&t=3"), v("abc123"));
        assert_eq!(classify("youtu.be/abc123?si=x"), v("abc123"));
        assert_eq!(classify("https://m.youtube.com/shorts/abc123"), v("abc123"));
        assert_eq!(classify("https://music.youtube.com/watch?v=abc123"), v("abc123"));
        assert_eq!(
            classify("https://www.youtube.com/playlist?list=PL123"),
            Some(Link::YoutubePlaylist("https://www.youtube.com/playlist?list=PL123".into()))
        );
        let s = |k: &str, id: &str| Some(Link::Spotify { kind: k.into(), id: id.into() });
        assert_eq!(classify("https://open.spotify.com/intl-pt/track/4cOdK2wGLETKBW3PvgPWqT?si=1"), s("track", "4cOdK2wGLETKBW3PvgPWqT"));
        assert_eq!(classify("https://open.spotify.com/playlist/37i9dQZF1DXcBWIGoYBM5M"), s("playlist", "37i9dQZF1DXcBWIGoYBM5M"));
        assert_eq!(classify("spotify:album:6XzZ5pg9buAKNYg293KOQ8"), s("album", "6XzZ5pg9buAKNYg293KOQ8"));
        assert_eq!(classify("https://open.spotify.com/artist/0gxy"), None);
        assert_eq!(classify("https://example.com/watch?v=1"), None);
    }

    #[test]
    fn spotify_faixa() {
        let t = parse_spotify_embed(include_str!("fixtures/track.html"), "track", "4cOdK2wGLETKBW3PvgPWqT").unwrap();
        assert_eq!(t.len(), 1);
        assert_eq!(t[0].title, "Never Gonna Give You Up");
        assert_eq!(t[0].artist.as_deref(), Some("Rick Astley"));
        assert_eq!(t[0].source, Source::Search("Rick Astley - Never Gonna Give You Up".into()));
        assert!(t[0].duration_ms.unwrap() > 200_000);
        assert!(t[0].thumbnail.as_deref().unwrap().starts_with("https://"));
    }

    #[test]
    fn spotify_album_e_playlist() {
        let album = parse_spotify_embed(include_str!("fixtures/album.html"), "album", "x").unwrap();
        assert_eq!(album.len(), 3);
        assert_eq!(album[0].title, "Sun It Rises");
        assert_eq!(album[0].artist.as_deref(), Some("Fleet Foxes"));
        assert!(album[0].thumbnail.is_some(), "faixas do álbum usam a capa do álbum");
        assert!(album[0].page_url.starts_with("https://open.spotify.com/track/"));

        let pl = parse_spotify_embed(include_str!("fixtures/playlist.html"), "playlist", "x").unwrap();
        assert_eq!(pl.len(), 3);
        assert!(pl.iter().all(|t| matches!(t.source, Source::Search(_)) && t.thumbnail.is_none()));
    }

    #[test]
    fn spotify_formato_desconhecido() {
        assert!(parse_spotify_embed("<html>nada</html>", "track", "x").is_err());
    }

    #[test]
    fn youtube_playlist_ignora_privados() {
        let json = serde_json::json!({
            "_type": "playlist",
            "entries": [
                { "id": "a1", "title": "Música A", "duration": 200.0, "channel": "Canal" },
                { "id": "b2", "title": "[Private video]", "duration": null },
                { "id": "c3", "title": "Música C", "uploader": "Outro" }
            ]
        });
        let t = parse_youtube_json(&json);
        assert_eq!(t.iter().map(|t| t.title.as_str()).collect::<Vec<_>>(), ["Música A", "Música C"]);
        assert_eq!(t[0].duration_ms, Some(200_000));
        assert_eq!(t[1].artist.as_deref(), Some("Outro"));
        assert_eq!(t[0].source, Source::Youtube("https://www.youtube.com/watch?v=a1".into()));
    }
}
