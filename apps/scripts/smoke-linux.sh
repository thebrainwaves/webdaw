#!/usr/bin/env bash
# Headless smoke test of the Linux desktop build: launches the built binary on a
# virtual X display, captures the web app's console, takes screenshots, clicks Start.
# Usage: scripts/smoke-linux.sh [path/to/binary] [outdir]
set -u
APP=${1:-src-tauri/target/release/auduio}
OUT=${2:-screenshots}
mkdir -p "$OUT"
export DISPLAY=:97
Xvfb :97 -screen 0 1440x900x24 >/dev/null 2>&1 & XV=$!
sleep 1
AUDUIO_CONSOLE=1 "$APP" > "$OUT/console.log" 2>&1 & AP=$!
# wait (up to 60 s) for the window
WID=""
for i in $(seq 60); do WID=$(xdotool search --onlyvisible --name '^Auduio$' 2>/dev/null | tail -1); [ -n "$WID" ] && break; sleep 1; done
echo "window after ${i}s"
sleep 8
import -window root "$OUT/linux-desktop-launch.png"
echo "window id: ${WID:-none}"
[ -n "$WID" ] && xdotool getwindowgeometry "$WID"
# The start overlay's primary button sits in the centre of the window.
if [ -n "$WID" ]; then
  eval "$(xdotool getwindowgeometry --shell "$WID")"
  xdotool mousemove $((X + WIDTH / 2)) $((Y + HEIGHT * 55 / 100)) click 1
  sleep 8
  import -window root "$OUT/linux-desktop-after-start.png"
fi
kill $AP 2>/dev/null; sleep 1; pkill -x auduio 2>/dev/null; kill $XV 2>/dev/null
echo "alive-check done"; wc -l "$OUT/console.log"
