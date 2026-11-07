#!/bin/bash
# Instalador do Discordia para Mac: baixa a última versão, verifica, instala em Aplicativos e abre.
#   curl -fsSL https://raw.githubusercontent.com/webdevpls/discordia/main/install.sh | bash
set -euo pipefail

REPO="webdevpls/discordia"
BASE="https://github.com/$REPO/releases/latest/download"
CURL=(curl --proto '=https' --tlsv1.2 -fsSL)

fail() { echo "✗ $1" >&2; exit 1; }

[ "$(uname -s)" = "Darwin" ] || fail "Este instalador é para macOS. No Windows e no Linux, use o Discordia pelo navegador."

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

echo "→ Baixando o Discordia…"
"${CURL[@]}" "$BASE/Discordia.zip" -o "$TMP/Discordia.zip" || fail "Não consegui baixar. Veja https://github.com/$REPO/releases"
"${CURL[@]}" "$BASE/SHA256SUMS.txt" -o "$TMP/SHA256SUMS.txt" || fail "Não consegui baixar a soma de verificação."

echo "→ Verificando a integridade do arquivo…"
EXPECTED="$(awk '$2 == "Discordia.zip" { print $1 }' "$TMP/SHA256SUMS.txt")"
ACTUAL="$(shasum -a 256 "$TMP/Discordia.zip" | awk '{ print $1 }')"
[ -n "$EXPECTED" ] && [ "$EXPECTED" = "$ACTUAL" ] || fail "A soma SHA-256 não confere. O download pode estar corrompido; nada foi instalado."

ditto -x -k "$TMP/Discordia.zip" "$TMP"
APP="$TMP/Discordia.app"
[ -d "$APP" ] || fail "O pacote baixado não contém o Discordia.app."

echo "→ Verificando a assinatura do app…"
codesign --verify --deep --strict "$APP" 2>/dev/null || fail "A assinatura do app é inválida; nada foi instalado."
[ "$(defaults read "$APP/Contents/Info" CFBundleIdentifier 2>/dev/null)" = "com.visiontech.discordia" ] || fail "O app baixado não é o Discordia."

DEST="${DISCORDIA_INSTALL_DIR:-/Applications}"
[ -w "$DEST" ] || DEST="$HOME/Applications"
mkdir -p "$DEST"

pkill -f "$DEST/Discordia.app/Contents/MacOS/" 2>/dev/null || true
rm -rf "$DEST/Discordia.app"
ditto "$APP" "$DEST/Discordia.app"
xattr -dr com.apple.quarantine "$DEST/Discordia.app" 2>/dev/null || true

# A assinatura é ad-hoc, então cada versão nova é um "app diferente" para o macOS:
# a permissão antiga de gravação de tela fica inválida e o app não lista as telas.
# Zerar faz o macOS perguntar de novo, limpo, na primeira vez que for preciso.
for service in ScreenCapture Camera Microphone AudioCapture; do
  tccutil reset "$service" com.visiontech.discordia >/dev/null 2>&1 || true
done

echo "✓ Discordia instalado em $DEST."
if [ -z "${DISCORDIA_NO_OPEN:-}" ]; then
  echo "  Abrindo… O macOS vai pedir de novo o microfone, a câmera e a gravação de tela: é só permitir."
  open "$DEST/Discordia.app"
fi
