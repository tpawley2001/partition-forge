#!/usr/bin/env bash
# Launches the app against the sample topology under a virtual display and
# captures the window, so the UI can be reviewed without Windows hardware.
set -u
OUT="${1:-/tmp/pf-shots}"
WAIT="${2:-9}"
mkdir -p "$OUT"
export PF_MOCK=1
xvfb-run -a -s "-screen 0 1400x900x24" bash -c "
  npx electron . --no-sandbox --disable-gpu >/tmp/electron.log 2>&1 &
  EPID=\$!
  sleep $WAIT
  import -window root '$OUT/app.png' 2>/dev/null || xwd -root | convert xwd:- '$OUT/app.png'
  kill \$EPID 2>/dev/null
  wait \$EPID 2>/dev/null
"
ls -l "$OUT"
