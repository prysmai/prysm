#!/usr/bin/env bash
# renders the three idle loops (resumes: frames that exist are skipped), then converts them for the site
cd "$(dirname "$0")"
for k in a b c; do
  until [ "$(ls renders/loop-$k 2>/dev/null | wc -l)" -ge 120 ]; do
    blender -b -P scene.py -- --loop $k --out-dir renders/loop-$k --n 120 --res 900x1055 --samples 48 >> renders/loop-$k.log 2>&1 || sleep 5
  done
  echo "loop $k: 120 frames"
done
