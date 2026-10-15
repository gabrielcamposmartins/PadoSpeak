#!/bin/bash
# Atualiza o servidor de comunidade do PadoSpeak na VM (Compose em /srv/padospeak).
#
# Rode na VM com compose.yml e padospeak.conf ao lado:   bash deploy-vm.sh
#
# O TLS fica no nginx de borda (/srv/edge, Let's Encrypt); o servidor roda em HTTP na rede "edge".
set -euo pipefail

DIR=/srv/padospeak
HERE=$(cd "$(dirname "$0")" && pwd)
IMG=us-central1-docker.pkg.dev/gen-lang-client-0425635607/padospeak/server:latest

echo "=== compose em $DIR ==="
sudo mkdir -p "$DIR"
sudo install -m 644 "$HERE/compose.yml" "$DIR/compose.yml"

echo "=== chave das mensagens (/etc/padospeak/server.env) ==="
if ! sudo test -f /etc/padospeak/server.env; then
  sudo mkdir -p /etc/padospeak
  echo "MESSAGE_KEY=$(openssl rand -base64 32)" | sudo tee /etc/padospeak/server.env >/dev/null
  sudo chmod 600 /etc/padospeak/server.env
  echo "chave nova criada — guarde uma cópia de /etc/padospeak/server.env"
else
  echo "mantida a chave existente"
fi

echo "=== rede do proxy ==="
sudo docker network inspect edge >/dev/null 2>&1 || sudo docker network create edge

echo "=== baixando a imagem ==="
cd "$DIR"
sudo docker compose pull -q
sudo docker image inspect "$IMG" --format 'imagem {{.Id}} criada {{.Created}}'

echo "=== subindo ==="
sudo docker compose up -d
# Nenhuma imagem sem uso fica guardada na VM (o disco é pequeno e dividido com outros projetos).
sudo docker image prune -a -f

echo "=== esperando o servidor ==="
for i in $(seq 40); do
  sudo docker logs padospeak-server 2>&1 | grep -q ' no ar em ' && break
  sleep 1
done

echo "=== nginx de borda ==="
sudo install -m 644 "$HERE/padospeak.conf" /srv/edge/nginx/conf.d/padospeak.conf
cd /srv/edge
sudo docker compose exec -T nginx nginx -t
sudo docker compose exec -T nginx nginx -s reload

echo "=== pelo domínio ==="
sleep 2
curl -s -m 8 https://padospeak.padoru.org/api/config; echo
curl -s -m 8 https://padospeak.padoru.org/ | grep -o '<title>[^<]*</title>' || echo 'a raiz não devolveu o cliente'

echo "=== log ==="
sudo docker logs padospeak-server 2>&1 | tail -8
