#!/usr/bin/env bash
# Instala o PadoSpeak como serviço systemd em uma VM Debian/Ubuntu, compilando a partir do código.
# Uso (na pasta do projeto):  sudo ./deploy/install-vm.sh
set -euo pipefail

if [[ $EUID -ne 0 ]]; then
  echo "Rode como root: sudo $0" >&2
  exit 1
fi
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
BUILD_USER="${SUDO_USER:-root}"

echo "==> Dependências do sistema"
apt-get update
apt-get install -y --no-install-recommends curl ca-certificates build-essential pkg-config

if ! command -v node >/dev/null || [[ "$(node -v | cut -d. -f1 | tr -d v)" -lt 20 ]]; then
  echo "==> Node.js 22"
  curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
  apt-get install -y nodejs
fi

if ! sudo -u "$BUILD_USER" bash -lc 'command -v cargo' >/dev/null; then
  echo "==> Rust (rustup) para $BUILD_USER"
  sudo -u "$BUILD_USER" bash -lc 'curl --proto "=https" --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y --profile minimal'
fi

echo "==> Compilando cliente e servidor"
sudo -u "$BUILD_USER" bash -lc "cd '$ROOT' && npm ci --workspace client --include-workspace-root=false && npm run build --workspace client && cargo build --release --locked -p padospeak-server"

echo "==> Instalando"
install -m 0755 "$ROOT/target/release/padospeak-server" /usr/local/bin/padospeak-server
id padospeak >/dev/null 2>&1 || useradd --system --home /var/lib/padospeak --shell /usr/sbin/nologin padospeak
install -d -o padospeak -g padospeak -m 0750 /var/lib/padospeak
install -d -m 0755 /etc/padospeak
[[ -f /etc/padospeak/padospeak.env ]] || install -m 0640 -g padospeak "$ROOT/deploy/padospeak.env.example" /etc/padospeak/padospeak.env
install -m 0644 "$ROOT/deploy/padospeak.service" /etc/systemd/system/padospeak.service

systemctl daemon-reload
systemctl enable --now padospeak
sleep 1
systemctl --no-pager status padospeak | head -n 5 || true

PORT="$(grep -E '^PORT=' /etc/padospeak/padospeak.env | cut -d= -f2 || true)"
echo
echo "Pronto! PadoSpeak rodando na porta ${PORT:-3000}."
echo "  Configuração: /etc/padospeak/padospeak.env  (depois: systemctl restart padospeak)"
echo "  Logs:         journalctl -u padospeak -f"
echo "  Libere no firewall: ${PORT:-3000}/tcp (e 3478 + 49160-49200/udp se usar TURN)."
