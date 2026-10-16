# PadoSpeak — clone do Discord self-hosted (Rust + Turso)

Chat em tempo real, servidores com convites, canais de texto e de voz, **chamadas de voz e vídeo** e
**compartilhamento de tela em 1080p** (30 ou 60 fps). O servidor é escrito em **Rust** e usa **Turso/libSQL**
como banco — por padrão um arquivo local, sem nada para instalar.

```
┌──────────────────────────────┐       REST + WebSocket        ┌──────────────────────────────┐
│ Cliente (React)              │ ────────────────────────────▶ │ padospeak-server (Rust · axum)    │
│ · navegador                  │   chat, presença, sinalização │ · API REST / WebSocket       │
│ · app desktop Tauri          │                               │ · cliente web embutido       │
│   (com servidor embutido)    │ ◀──── WebRTC P2P (malha) ───▶ │ · banco Turso/libSQL         │
└──────────────────────────────┘   voz · câmera · tela 1080p   └──────────────────────────────┘
```

| Pasta                | O que é                                                                                  |
| -------------------- | ---------------------------------------------------------------------------------------- |
| `server/`            | Crate `padospeak-server`: biblioteca (`HostManager`) + binário headless/VM                     |
| `client/`            | Interface React (Vite), usada no navegador, no app desktop e no painel de hospedagem      |
| `desktop/src-tauri/` | App desktop Tauri que embute o servidor — a página **Hostear** liga/desliga ele           |
| `deploy/`            | Serviço systemd, `.env` de exemplo e script de instalação em VM                           |

## App desktop: perfil local, rede local e servidor de comunidade

- **Perfil local (offline).** O login do app é um perfil que fica no próprio PC, num servidor embutido
  (o *nó local*, porta 47821) que só aceita login do próprio computador. Funciona sem internet.
- **Rede local (LAN).** Cada app anuncia os perfis online por broadcast UDP (porta 47822) e mostra os outros
  com a tag **LAN**. Conversa, chamadas, stickers e “chamar atenção” vão direto entre os PCs: a conversa
  fica no nó de quem tem o menor id, e o outro entra lá como convidado — a primeira conexão fixa a chave
  secreta do PC dele, então outro PC não consegue se passar por ele. Quem está hospedando um servidor
  aparece com o botão para entrar nele.
- **Servidor de comunidade.** Depois do login, o app tenta em silêncio `padospeak.padoru.org` (ou o endereço
  escolhido em **Hostear → Servidor de comunidade**) com o usuário e a senha do perfil local. Guilds e
  amigos moram lá. Se a conta for a mesma, nome, foto, mensagem pessoal e cores são copiados do perfil
  local; se o token expirar, o app pede login de novo sem sair do perfil local.
- O Windows pede permissão de rede na primeira vez: libere em **redes privadas** para os outros PCs te verem.

## Celular e tablet (PWA)

Em https://padospeak.padoru.org o PadoSpeak se ajusta à tela: no celular, abas embaixo (Conversas, Amigos,
Servidores, Eu) e conversa, canal e chamada em tela cheia; no tablet na vertical, conversas e servidores numa
gaveta; no iPad na horizontal, o layout completo.

- **Instalar:** Android, Chrome e Edge mostram o botão "Instalar". No iPhone e no iPad, Safari →
  Compartilhar → "Adicionar à Tela de Início" (o app mostra o passo a passo).
- **Notificações push:** com o app fechado ou em segundo plano, chegam mensagens diretas, chamadas, "chamar
  atenção" e pedidos de amizade (Web Push com VAPID; no iPhone/iPad, iOS 16.4+ com o app instalado). O
  servidor só envia quando a pessoa não está com o PadoSpeak na tela.

## Página “Hostear”

A mesma página aparece em dois lugares:

- **App desktop** (depois de entrar): ícone de servidor na barra lateral. O botão **Hostear** sobe um
  servidor de comunidade dentro do próprio app; **Entrar neste servidor** passa a usá-lo. É também ali que
  fica o endereço do servidor de comunidade.
- **Binário `padospeak-server`** (VM/servidor): painel em `http://127.0.0.1:3001`.

Nela você escolhe nome, porta, interface de rede, HTTPS, cadastro aberto e servidores STUN/TURN, vê os
endereços para compartilhar, estatísticas (online, em voz, contas, mensagens), o banco em uso e o log.
A configuração fica salva no próprio banco.

## Requisitos

- Rust 1.85+ (`rustup`) e Node.js 20+
- App desktop: pré-requisitos do Tauri 2 (Windows: WebView2, já presente no Windows 10/11)

## Rodando

```bash
npm install

# Desenvolvimento no navegador: servidor (3000) + painel (3001) + Vite (5173)
npm run dev                # abra http://localhost:5173  ·  painel: http://localhost:5173/host

# App desktop (cliente + servidor embutido)
npm run desktop:dev
npm run installer          # instalador: target/release/bundle/nsis/PadoSpeak_<versão>_x64-setup.exe
npm run desktop:build      # target/release/padospeak-desktop.exe + instalador
                           # (o .exe em target/debug só funciona junto com `desktop:dev`)

# Binário único para produção (cliente web embutido)
npm run build              # gera target/release/padospeak-server
./target/release/padospeak-server            # painel em 127.0.0.1:3001 com o botão Hostear
./target/release/padospeak-server --host     # painel + servidor já no ar
./target/release/padospeak-server --headless # só o servidor (VM/Docker)
```

## Versões e atualização automática

O app desktop se atualiza sozinho (plugin updater do Tauri): ao abrir, consulta
`https://github.com/gabrielcamposmartins/PadoSpeak/releases/latest/download/latest.json`, baixa, confere a
assinatura e instala em modo silencioso.

```bash
npm run version:set 1.2.0      # troca a versão em todos os arquivos
git commit -am "v1.2.0" && git tag v1.2.0 && git push --follow-tags
```

A tag dispara `.github/workflows/release.yml`, que testa, compila, assina e publica a release com o
instalador, o `.sig`, o `latest.json` e o `PadoSpeak-setup.exe` (link fixo). Para assinar, configure nos
segredos do repositório `TAURI_SIGNING_PRIVATE_KEY` (conteúdo de `~/.tauri/padospeak-updater.key`) e
`TAURI_SIGNING_PRIVATE_KEY_PASSWORD` (vazio). Sem eles, a action só compila e deixa o instalador como artefato.

## Hospedando

### Docker

```bash
docker compose up -d --build                   # https://SEU_IP:3000 (certificado autoassinado)
docker compose --profile turn up -d --build    # + coturn para chamadas entre redes diferentes
```

### VM (Debian/Ubuntu, systemd)

```bash
sudo ./deploy/install-vm.sh          # compila, instala /usr/local/bin/padospeak-server e ativa o serviço
sudo nano /etc/padospeak/padospeak.env         # porta, HTTPS, TURN, banco…
sudo systemctl restart padospeak && journalctl -u padospeak -f
```

### Servidor de comunidade oficial (padospeak.padoru.org)

O servidor padrão do app desktop roda na VM de Iowa pelo Compose de `deploy/vm/`: o `padospeak-server`
e um banco Turso/libSQL (sqld) próprio, atrás do nginx de borda da VM, que termina o TLS (Let's Encrypt,
renovado pelo timer `edge-certbot` do systemd).

```bash
docker build -t us-central1-docker.pkg.dev/gen-lang-client-0425635607/padospeak/server:latest .
docker push us-central1-docker.pkg.dev/gen-lang-client-0425635607/padospeak/server:latest
gcloud compute scp deploy/vm/{compose.yml,padospeak.conf,deploy-vm.sh} instance-20260920-143727:padospeak-deploy/ --zone us-central1-a
gcloud compute ssh instance-20260920-143727 --zone us-central1-a --command "bash padospeak-deploy/deploy-vm.sh"
```

A chave das mensagens fica em `/etc/padospeak/server.env` (só o root lê). **Guarde uma cópia**: sem ela,
as mensagens guardadas não podem ser lidas.

**Relay das chamadas (TURN)** sem abrir portas: `deploy/vm/setup-turn.sh` sobe o coturn (`deploy/vm/turn/`) e
transforma a porta 443 do nginx de borda num roteador TLS (`deploy/vm/edge/stream.d/443.conf`): conexões para
`padospeak.padoru.org` **sem ALPN HTTP** (o TURN dos navegadores e do app) vão para o coturn, com o mesmo
certificado do site; o resto segue para os sites, agora em `127.0.0.1:8443` com PROXY protocol (o IP real de
quem acessa continua chegando). O relay entre duas pessoas acontece dentro do contêiner do coturn, por isso
nenhuma porta UDP fica aberta. Limites: 1,5 Mbps por sessão e 20 Mbps no total.

```bash
gcloud compute scp --recurse deploy/vm/turn deploy/vm/edge deploy/vm/setup-turn.sh instance-20260920-143727:padospeak-deploy/ --zone us-central1-a
gcloud compute ssh instance-20260920-143727 --zone us-central1-a --command "bash padospeak-deploy/setup-turn.sh"
```

### Variáveis de ambiente

Valores definidos por variável de ambiente prevalecem sobre o painel (lá aparecem como travados).

| Variável                                         | Padrão              | Descrição                                                  |
| ------------------------------------------------ | ------------------- | ---------------------------------------------------------- |
| `DATA_DIR`                                       | `./data`            | Banco local, certificados                                  |
| `DATABASE_URL`                                   | `file:<DATA_DIR>/padospeak.db` | `libsql://…` (Turso Cloud) ou `http://127.0.0.1:8080` (`turso dev`) |
| `TURSO_AUTH_TOKEN`                               | —                   | Token do Turso Cloud                                       |
| `TURSO_SYNC_URL`                                 | —                   | Réplica embarcada: arquivo local sincronizado com a nuvem  |
| `SERVER_NAME` / `PORT` / `HOST`                  | `PadoSpeak` / `3000` / `0.0.0.0` |                                                    |
| `HTTPS`                                          | `off`               | `off`, `self-signed` ou `custom` (+ `TLS_CERT`, `TLS_KEY`) |
| `MESSAGE_KEY`                                    | arquivo `chave-mensagens.key` | Chave AES-256 (base64 de 32 bytes) das mensagens guardadas |
| `ALLOW_REGISTRATION`                             | `true`              | Permite criar contas                                       |
| `ICE_SERVERS`                                    | STUN do Google      | Lista JSON de `RTCIceServer` (STUN/TURN)                   |
| `TURN_URLS` / `TURN_SECRET`                      | —                   | Relay das chamadas com senha temporária por usuário (coturn `use-auth-secret`), ex.: `turns:exemplo.org:443?transport=tcp` |
| `SMTP_URL` / `MAIL_FROM`                         | —                   | E-mail da conta (código de confirmação e de "esqueci a senha"), ex.: `smtps://usuario:senha-de-app@smtp.gmail.com:465` e `PadoSpeak <voce@gmail.com>`. Na VM: `smtp://mail-relay:25` e `PadoSpeak <noreply@padoru.org>` (o relay de `/srv/mail-relay`, que assina o DKIM e entrega pelo Gmail) |
| `MAIL_DAILY_LIMIT`                               | `100`               | Teto de e-mails por dia (o Gmail aceita uns 500 por dia por conta; passar disso pode suspendê-la). Cada conta pede no máximo 5 códigos de confirmação por dia |
| `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET`      | —                   | "Entrar com o Google" (cliente OAuth do tipo *Aplicativo da Web*). Voltando por outro navegador (o do sistema, no app do Windows), a página mostra um código que a pessoa digita no app |
| `PUBLIC_URL`                                     | o endereço do acesso | Endereço público do servidor; o Google volta para `PUBLIC_URL/api/auth/google/callback` |
| `AUTO_HOST`                                      | `false`             | Sobe o servidor ao iniciar (igual a `--host`)              |
| `PANEL` / `PANEL_HOST` / `PANEL_PORT` / `PANEL_PASSWORD` | ligado / `127.0.0.1` / `3001` / — | Painel; fora de loopback exige senha (HTTP Basic) |

## Voz, vídeo e tela

- WebRTC em **malha P2P** com *perfect negotiation*; o servidor só repassa a sinalização entre quem está no
  mesmo canal de voz. Áudio com cancelamento de eco/ruído, indicador de quem está falando, volume por pessoa,
  mudo/ensurdecer e escolha de microfone, câmera e saída.
- **Tela em 1080p**: captura limitada a 1920×1080, `contentHint` adequado e bitrate alvo por preset —
  1080p30 (6 Mbps, prioriza nitidez), 1080p60 (9 Mbps, prioriza fluidez) ou 720p30. A qualidade pode ser trocada
  durante a transmissão; o selo no vídeo mostra a resolução e o fps recebidos de verdade.
- Na malha, quem transmite envia uma cópia para cada participante: uma tela 1080p30 para 4 pessoas usa ~24 Mbps
  de upload. Para salas grandes, o caminho natural é trocar a malha por um SFU (ex.: LiveKit).
- **HTTPS**: navegadores só liberam microfone, câmera e captura de tela em `localhost` ou HTTPS. Para acessar
  pelo IP da rede no navegador, use `HTTPS=self-signed` (aceite o aviso do certificado) ou um certificado real.
  O **app desktop não precisa** disso.
- **TURN**: entre redes diferentes com NAT restritivo (CGNAT, 4G, redes de empresa/faculdade) o P2P pode falhar
  só entre algumas pessoas — cada uma ouve as outras, menos aquela. Com `TURN_URLS` + `TURN_SECRET`, cada login
  recebe no `ready` do WebSocket uma senha do TURN válida por 24 h (formato *TURN REST API* do coturn; nunca no
  `/api/config`, que é público). Sem isso, dá para pôr um TURN fixo em “Servidores ICE”.
- **Reconexão por par**: quem fica sem conexão com alguém por 6 s tem o ICE reiniciado (só um lado, para não
  colidir); depois de 15 s a conexão inteira é refeita, mantendo volume e o que se estava assistindo. Na tela,
  a pessoa aparece com o ícone de “sem conexão”, e o **Diagnóstico da chamada** mostra, por pessoa, o caminho
  (direto ou relay), a voz recebida/enviada (kbps, perdas, jitter, nível), o estado do áudio local e o histórico
  de quedas.
- **Som da transmissão**: no navegador, `restrictOwnAudio` tira o som da própria página (as vozes da chamada) e
  `windowAudio: "window"` oferece o som só da janela escolhida (Chrome 141+). No **app do Windows** o som vem do
  próprio Windows (WASAPI *process loopback*, Windows 10 2004+): janela → só o som do programa dela; tela
  inteira → o sistema todo menos o PadoSpeak (o processo `msedgewebview2.exe` do app, de onde sai o som dele).
- **Jogando …**: o app do Windows olha a janela em foco a cada 3 s e reconhece o jogo (lista de executáveis
  conhecidos e as pastas da Steam — com o nome do `appmanifest` —, Epic, Riot, Xbox, GOG, Ubisoft e EA). O
  status mostra “Jogando X” enquanto o jogo estiver aberto; só o nome do jogo sai do PC, e dá para desligar
  em Configurações → Funcionalidade → Atividade. Pokeru e Speedoru são sempre reconhecidos; outro programa
  qualquer entra pelo “Adicione-o” da mesma tela (lista dos programas abertos, com o nome escolhido). Quem
  está num canal privado não tem o canal no status.

## Música

O botão de fila (🎵) no topo da lista de canais abre a **fila de música** do canal de voz em que você está.
Arraste (ou cole) links do **YouTube** (vídeo, shorts, playlist) ou do **Spotify** (faixa, álbum, playlist):
todos no canal ouvem a mesma música, em sincronia, mesmo que quem adicionou saia. Quando o canal esvazia, a fila
é descartada. Qualquer pessoa no canal pode pausar, pular, remover e limpar; o volume da música é individual.

- **Como funciona:** o servidor resolve os links com o [yt-dlp](https://github.com/yt-dlp/yt-dlp) e entrega o
  áudio por proxy (`/api/music/stream/…`, com Range); cada cliente toca na posição ditada pelo relógio do servidor.
  O áudio sai pela banda do host: ~130 kbps por ouvinte.
- **Dependências automáticas:** na primeira vez o servidor procura `yt-dlp` e um runtime JavaScript (Deno ou Node,
  exigido pelo YouTube) e, se faltarem, baixa para `DATA_DIR/bin`: yt-dlp do GitHub (ou do PyPI, se o GitHub estiver
  bloqueado e houver Python) e Deno do pacote oficial no npm. Também dá para apontar `YTDLP_PATH` /
  `YTDLP_JS_RUNTIME` (ex.: `node`).
- **Spotify:** os metadados vêm da página pública de embed (sem login) e cada faixa toca pela versão equivalente
  do YouTube. Playlists via embed trazem até 50 faixas; se o Spotify mudar essa página, o import pode quebrar.
- **"Confirme que você não é um robô":** o YouTube às vezes bloqueia o IP do servidor. O PadoSpeak tenta
  automaticamente outras variantes (IPv6/IPv4, cliente `web_embedded`); se persistir, configure cookies de uma conta
  logada em **Hostear → Música** (navegador ou arquivo `cookies.txt`) ou pelas variáveis `YTDLP_COOKIES` /
  `YTDLP_COOKIES_FROM_BROWSER`.

## Banco de dados

O `padospeak-server` usa o crate oficial `libsql` (Turso). Tabelas: `users`, `sessions`, `guilds`,
`guild_members`, `channels`, `messages` e `settings` (configuração do host). As migrações rodam ao iniciar.

O texto das mensagens (canais e conversas diretas) é guardado cifrado com AES-256-GCM
(`enc1:…`). A chave vem de `MESSAGE_KEY` ou do arquivo `chave-mensagens.key` na pasta de dados, criado na
primeira vez. Mensagens antigas são cifradas ao iniciar, sem perder nenhuma. Se a chave mudar, o log avisa
e as mensagens cifradas com a chave antiga aparecem como protegidas até ela ser restaurada.
