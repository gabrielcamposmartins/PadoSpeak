#!/usr/bin/env bash
# Prepara uma máquina Linux (com Docker) para ser nó de mídia de um servidor do PadoSpeak e sobe o nó.
# Pode rodar de novo sem problema (não troca o código que já existe).
#
#   sudo ./setup.sh                 (nesta pasta, copiada para a máquina: ex. /srv/padospeak-media)
#   sudo ./setup.sh psm1.xxxxx      (já com o código do Painel → Mídia → Adicionar nó)
#
# O que faz:
#  1. /etc/padospeak-media/media.env com MEDIA_JOIN (o código do nó);
#  2. firewall (ufw, se houver): libera 3479/udp (as chamadas);
#  3. buffers UDP maiores (um quadro-chave de tela 1080p são centenas de pacotes de uma vez);
#  4. docker compose up -d (o nó e o provedor de token) e limpa as imagens velhas.
#
# Na nuvem, libere também a porta 3479/udp no firewall do provedor. Atrás de um roteador de casa,
# redirecione a porta 3479/udp para esta máquina.
set -euo pipefail

if [[ $EUID -ne 0 ]]; then
  echo "Rode como root: sudo $0" >&2
  exit 1
fi
cd "$(dirname "$0")"
command -v docker >/dev/null || { echo "Docker não encontrado." >&2; exit 1; }

ENV_DIR=/etc/padospeak-media
ENV_FILE=$ENV_DIR/media.env
echo "==> $ENV_FILE"
install -d -m 700 "$ENV_DIR"
[[ -f $ENV_FILE ]] || install -m 600 /dev/null "$ENV_FILE"
CODE="${1:-}"
if [[ -n $CODE ]]; then
  sed -i '/^MEDIA_JOIN=/d' "$ENV_FILE"
  echo "MEDIA_JOIN=$CODE" >>"$ENV_FILE"
  echo "   código salvo"
elif ! grep -qE '^MEDIA_JOIN=psm1\.' "$ENV_FILE"; then
  read -r -p "Código do nó (Painel → Mídia → Adicionar nó): " CODE
  [[ $CODE == psm1.* ]] || { echo "Código inválido." >&2; exit 1; }
  echo "MEDIA_JOIN=$CODE" >>"$ENV_FILE"
else
  echo "   mantido o código que já estava"
fi
chmod 600 "$ENV_FILE"

if command -v ufw >/dev/null && ufw status | grep -q 'Status: active'; then
  echo "==> firewall (ufw)"
  ufw allow 3479/udp comment 'PadoSpeak nó de mídia (SFU)' >/dev/null
fi

echo "==> buffers UDP (SFU)"
cat >/etc/sysctl.d/99-padospeak-media.conf <<'EOF'
# Nó de mídia do PadoSpeak: uma porta UDP recebe o áudio/vídeo de todos; buffers maiores evitam perda em rajadas.
net.core.rmem_max = 16777216
net.core.wmem_max = 16777216
net.core.rmem_default = 1048576
net.core.wmem_default = 1048576
EOF
sysctl -q --system

echo "==> subindo o nó"
timeout 300 docker compose pull
docker compose up -d
docker image prune -f >/dev/null

echo "==> esperando ligar ao servidor"
for _ in $(seq 30); do
  docker logs padospeak-media 2>&1 | grep -q 'Nó de mídia: ligado a' && break
  sleep 1
done
docker compose ps
docker logs --tail 5 padospeak-media 2>&1 | sed 's/^/   /'
echo
echo "Pronto. O nó aparece no Painel → Mídia do servidor."
echo "  Logs:      docker compose logs -f media"
echo "  Atualizar: sudo ./setup.sh"
