#!/usr/bin/env bash
# Liga o relay das chamadas (TURN) na VM, sem abrir portas novas: o coturn fica atrás do nginx de borda
# na porta 443 (veja turn/compose.yml e edge/stream.d/443.conf). Pode rodar de novo sem problema.
#
#   bash ~/padospeak-deploy/setup-turn.sh      (com a pasta deploy/vm copiada para ~/padospeak-deploy)
#
# O que faz:
#  1. /srv/turn: coturn com senha gerada aqui (vai também para TURN_SECRET em /etc/padospeak/server.env);
#  2. nginx de borda: a 443 passa a ser um roteador (stream) que manda o TURN para o coturn e o resto
#     para os sites, agora em 127.0.0.1:8443 com PROXY protocol (o IP real continua chegando).
#     Antes de trocar, a configuração nova é testada num contêiner à parte; se falhar, nada muda.
set -euo pipefail
SRC="$(cd "$(dirname "$0")" && pwd)"
STAMP="$(date +%Y%m%d-%H%M%S)"

echo "== coturn"
sudo mkdir -p /srv/turn
sudo cp "$SRC/turn/compose.yml" /srv/turn/compose.yml
if ! sudo test -f /srv/turn/turnserver.conf; then
  SECRET="$(openssl rand -hex 32)"
  sed "s/__SECRET__/$SECRET/" "$SRC/turn/turnserver.conf.template" | sudo tee /srv/turn/turnserver.conf >/dev/null
  # o coturn roda como nobody:nogroup
  sudo chown root:65533 /srv/turn/turnserver.conf
  sudo chmod 640 /srv/turn/turnserver.conf
  sudo sed -i '/^TURN_/d' /etc/padospeak/server.env
  printf 'TURN_URLS=turns:padospeak.padoru.org:443?transport=tcp\nTURN_SECRET=%s\n' "$SECRET" | sudo tee -a /etc/padospeak/server.env >/dev/null
  unset SECRET
  echo "senha do TURN gerada (em /srv/turn/turnserver.conf e /etc/padospeak/server.env)"
fi
(cd /srv/turn && sudo docker compose up -d)

echo "== nginx de borda"
cd /srv/edge
NG=nginx
if ! sudo test -f $NG/nginx.conf || ! sudo grep -q 'stream {' $NG/nginx.conf; then
  sudo docker exec edge-nginx-1 cat /etc/nginx/nginx.conf >/tmp/nginx.conf.base
  {
    cat /tmp/nginx.conf.base
    printf '\n# Porta 443: roteador TLS (TURN das chamadas x sites). Veja stream.d/443.conf.\nstream {\n    include /etc/nginx/stream.d/*.conf;\n}\n'
  } | sudo tee $NG/nginx.conf.new >/dev/null
else
  sudo cp $NG/nginx.conf $NG/nginx.conf.new
fi
sudo mkdir -p $NG/stream.d.new $NG/conf.d.new
sudo cp "$SRC/edge/stream.d/443.conf" $NG/stream.d.new/443.conf
sudo cp -a $NG/conf.d/. $NG/conf.d.new/
sudo cp "$SRC/edge/01-realip.conf" $NG/conf.d.new/01-realip.conf
for f in $NG/conf.d.new/*.conf; do
  sudo sed -i -E 's/^([[:space:]]*)listen 443 ssl;/\1listen 127.0.0.1:8443 ssl proxy_protocol;/' "$f"
done

echo "-- testando a configuração nova num contêiner à parte"
sudo docker run --rm --network edge \
  -v /srv/edge/$NG/nginx.conf.new:/etc/nginx/nginx.conf:ro \
  -v /srv/edge/$NG/conf.d.new:/etc/nginx/conf.d:ro \
  -v /srv/edge/$NG/stream.d.new:/etc/nginx/stream.d:ro \
  -v /srv/edge/certbot/www:/var/www/certbot:ro \
  -v /srv/edge/certbot/conf:/etc/letsencrypt:ro \
  nginx:stable-alpine nginx -t

echo "-- trocando (backup em $NG/backup-$STAMP)"
sudo mkdir -p $NG/backup-$STAMP
sudo cp -a $NG/conf.d $NG/backup-$STAMP/conf.d
sudo cp compose.yml $NG/backup-$STAMP/compose.yml
sudo test -f $NG/nginx.conf && sudo cp $NG/nginx.conf $NG/backup-$STAMP/nginx.conf
sudo test -d $NG/stream.d && sudo cp -a $NG/stream.d $NG/backup-$STAMP/stream.d
sudo rm -rf $NG/conf.d $NG/stream.d
sudo mv $NG/conf.d.new $NG/conf.d
sudo mv $NG/stream.d.new $NG/stream.d
sudo mv $NG/nginx.conf.new $NG/nginx.conf
if ! grep -q 'stream.d' compose.yml; then
  sudo sed -i 's#^\([[:space:]]*\)- ./nginx/conf.d:/etc/nginx/conf.d:ro#&\n\1- ./nginx/nginx.conf:/etc/nginx/nginx.conf:ro\n\1- ./nginx/stream.d:/etc/nginx/stream.d:ro#' compose.yml
fi
sudo docker compose up -d nginx
sleep 2
for site in padospeak pokeru speedoru; do
  printf '%s: ' $site
  curl -s -o /dev/null -w '%{http_code}\n' --max-time 10 "https://$site.padoru.org/" || echo falhou
done
echo "Para desfazer: copie $NG/backup-$STAMP de volta (conf.d e compose.yml) e rode: sudo docker compose up -d nginx"
