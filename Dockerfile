# ---------- 1) Cliente web (React) ----------
FROM node:22-bookworm-slim AS client
WORKDIR /app
COPY package.json package-lock.json ./
COPY client/package.json client/
RUN npm ci --workspace client --include-workspace-root=false
COPY client client
RUN npm run build --workspace client

# ---------- 2) Servidor Rust (com o cliente embutido) ----------
FROM rust:1-bookworm AS server
WORKDIR /app
COPY Cargo.toml Cargo.lock ./
COPY server server
# O crate desktop só precisa existir para o workspace resolver; ele não é compilado aqui.
COPY desktop/src-tauri desktop/src-tauri
COPY --from=client /app/client/dist client/dist
RUN cargo build --release --locked -p padospeak-server

# ---------- 3) Ferramentas de música: Deno (runtime JS exigido pelo yt-dlp no YouTube) ----------
FROM denoland/deno:bin AS deno

# ---------- 4) yt-dlp já descompactado ----------
# A versão "um arquivo só" se descompacta inteira (80 MB) a cada execução: 3 s a mais por música e o
# disco e a memória da VM pequena ocupados à toa. Esta vem descompactada e é conferida pelo SHA-256 publicado.
FROM debian:bookworm-slim AS ytdlp
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates curl unzip  && rm -rf /var/lib/apt/lists/*
RUN set -eu; base=https://github.com/yt-dlp/yt-dlp/releases/latest/download;     curl -fsSL -o /tmp/yt-dlp_linux.zip "$base/yt-dlp_linux.zip";     curl -fsSL -o /tmp/SHA2-256SUMS "$base/SHA2-256SUMS";     cd /tmp && grep ' yt-dlp_linux.zip$' SHA2-256SUMS | sha256sum -c -;     unzip -q /tmp/yt-dlp_linux.zip -d /opt/yt-dlp; chmod 755 /opt/yt-dlp/yt-dlp_linux

# ---------- 5) Imagem final ----------
FROM debian:bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates \
 && rm -rf /var/lib/apt/lists/* \
 && useradd --system --home /data padospeak && mkdir -p /data && chown padospeak /data
COPY --from=server /app/target/release/padospeak-server /usr/local/bin/padospeak-server
COPY --from=deno /deno /usr/local/bin/deno
COPY --from=ytdlp /opt/yt-dlp /opt/yt-dlp
USER padospeak
ENV DATA_DIR=/data
# O servidor também consegue baixar um yt-dlp sozinho para DATA_DIR/bin se este faltar.
ENV YTDLP_PATH=/opt/yt-dlp/yt-dlp_linux
VOLUME /data
EXPOSE 3000 3001
CMD ["padospeak-server", "--headless"]
