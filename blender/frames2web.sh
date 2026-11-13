#!/usr/bin/env bash
# Rendered morph frames → the site's two webp sets: d (900 x 1055) and m (540 x 633), blacks lifted to the page colour.
#   ./frames2web.sh renders/anim-hd                      (morph, into site/media/morph)
#   ./frames2web.sh renders/loop-a ../site/media/loop/a  (idle loop)
set -euo pipefail
cd "$(dirname "$0")"
OUT="${2:-../site/media/morph}"
python3 - "$1" "$OUT" <<'PY'
import sys, glob, os
from PIL import Image, ImageChops
src, out = sys.argv[1], sys.argv[2]
for d in ("d", "m"): os.makedirs(f"{out}/{d}", exist_ok=True)
fs = sorted(glob.glob(f"{src}/f*.png")); bg = None
for f in fs:
    im = Image.open(f).convert("RGB")
    bg = bg or Image.new("RGB", im.size, (14, 12, 15))
    im = ImageChops.lighter(im, bg); n = os.path.basename(f)[:-4]
    im.resize((900, 1055), Image.LANCZOS).save(f"{out}/d/{n}.webp", quality=74, method=5)
    im.resize((540, 633), Image.LANCZOS).save(f"{out}/m/{n}.webp", quality=72, method=5)
print(len(fs), "frames")
PY
du -sh "$OUT/d" "$OUT/m"
