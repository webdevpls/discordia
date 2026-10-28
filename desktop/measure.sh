#!/bin/bash
# Mede CPU e RAM do Discordia numa chamada: app Tauri x janela dedicada do Chrome.
#
#   ./measure.sh tauri    abre o app e mede
#   ./measure.sh chrome   abre uma janela separada do Chrome (perfil próprio) e mede
#
# Depois de abrir, você tem ESPERA segundos para entrar na chamada (ligue a câmera
# se quiser comparar vídeo); aí ele mede por DURACAO segundos. Faça as duas medições
# nas mesmas condições (mesmas pessoas na chamada, câmeras iguais).
set -u

URL="${DISCORDIA_URL:-https://discordia.visionstds.com.br}"
ESPERA="${ESPERA:-45}"
DURACAO="${DURACAO:-60}"
APP="$(cd "$(dirname "$0")" && pwd)/src-tauri/target/release/bundle/macos/Discordia.app"
PERFIL="${TMPDIR:-/tmp}/discordia-chrome-medicao"

webkit_pids() { pgrep -f 'WebKit.framework/Versions/A/XPCServices/com.apple.WebKit\.' | sort; }

case "${1:-}" in
  tauri)
    pkill -f "$APP/Contents/MacOS/discordia" 2>/dev/null || true
    sleep 1
    antes="$(webkit_pids)"
    open "$APP"
    sleep 3
    alvo() {
      pgrep -f "$APP/Contents/MacOS/discordia"
      # Processos do WebKit que surgiram depois de abrir o app são dele.
      comm -13 <(echo "$antes") <(webkit_pids)
    }
    ;;
  chrome)
    open -na "Google Chrome" --args --user-data-dir="$PERFIL" --app="$URL" --no-first-run --no-default-browser-check
    sleep 3
    alvo() { pgrep -f -- "--user-data-dir=$PERFIL"; }
    ;;
  *)
    echo "uso: $0 tauri|chrome" >&2
    exit 1
    ;;
esac

segundos_cpu() { # soma do tempo de CPU (s) dos pids
  [ -z "$1" ] && { echo 0; return; }
  ps -o time= -p "$1" 2>/dev/null | awk -F: '{ t = 0; for (i = 1; i <= NF; i++) t = t * 60 + $i; s += t } END { printf "%.2f", s }'
}
ram_mb() {
  [ -z "$1" ] && { echo 0; return; }
  ps -o rss= -p "$1" 2>/dev/null | awk '{ s += $1 } END { printf "%.0f", s / 1024 }'
}

echo "Entre na chamada agora. A medição começa em ${ESPERA}s…"
for ((i = ESPERA; i > 0; i -= 5)); do printf '\r  %3ss ' "$i"; sleep 5; done
echo

pids="$(alvo | sort -u | paste -sd, -)"
echo "Medindo ${DURACAO}s nos processos: $pids"
c0="$(segundos_cpu "$pids")"
t0=$(date +%s)
soma=0; pico=0; n=0
while [ $(( $(date +%s) - t0 )) -lt "$DURACAO" ]; do
  pids="$(alvo | sort -u | paste -sd, -)"
  r="$(ram_mb "$pids")"
  soma=$((soma + r)); n=$((n + 1)); [ "$r" -gt "$pico" ] && pico=$r
  sleep 2
done
c1="$(segundos_cpu "$pids")"
dt=$(( $(date +%s) - t0 ))

cpu="$(awk -v a="$c0" -v b="$c1" -v d="$dt" 'BEGIN { printf "%.1f", (b - a) / d * 100 }')"
echo
echo "== $1 =="
echo "CPU média: ${cpu}% de 1 núcleo"
echo "RAM média: $((soma / n)) MB · pico: ${pico} MB"
