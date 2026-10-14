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

# ---------- 4) Imagem final ----------
FROM debian:bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates \
 && rm -rf /var/lib/apt/lists/* \
 && useradd --system --home /data padospeak && mkdir -p /data && chown padospeak /data
COPY --from=server /app/target/release/padospeak-server /usr/local/bin/padospeak-server
COPY --from=deno /deno /usr/local/bin/deno
# yt-dlp autocontido; o servidor também consegue baixá-lo sozinho para DATA_DIR/bin se faltar.
ADD --chmod=755 https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp_linux /usr/local/bin/yt-dlp
USER padospeak
ENV DATA_DIR=/data
VOLUME /data
EXPOSE 3000 3001
CMD ["padospeak-server", "--headless"]
