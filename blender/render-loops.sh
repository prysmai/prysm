#!/usr/bin/env bash
# renders the four idle loops (the coin turning in its own plane; resumes: frames that exist are skipped)
#   then: for k in a r b c; do ./frames2web.sh renders/spin-$k ../site/media/loop/$k; done
cd "$(dirname "$0")"
for k in a r b c; do
  until [ "$(ls renders/spin-$k 2>/dev/null | wc -l)" -ge 120 ]; do
    blender -b -P scene.py -- --loop $k --out-dir renders/spin-$k --n 120 --res 900x1055 --samples 48 >> renders/spin-$k.log 2>&1 || sleep 5
  done
  echo "spin $k: 120 frames"
done
