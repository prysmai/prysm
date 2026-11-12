# Trace the PRYSM logo PNG into polygon contours (outer shapes and holes) for the Blender coin.
#   python3 trace_logo.py ../brand/logo-black.png logo.json
import sys, json, cv2
im = cv2.imread(sys.argv[1], cv2.IMREAD_UNCHANGED)
a = im[:, :, 3] if im.shape[2] == 4 else 255 - cv2.cvtColor(im, cv2.COLOR_BGR2GRAY)
g = cv2.cvtColor(im[:, :, :3], cv2.COLOR_BGR2GRAY)
ink = ((a > 127) & (g < 128)).astype("uint8") * 255
ink = cv2.GaussianBlur(ink, (5, 5), 0); _, ink = cv2.threshold(ink, 127, 255, cv2.THRESH_BINARY)
cs, hier = cv2.findContours(ink, cv2.RETR_CCOMP, cv2.CHAIN_APPROX_NONE)
h, w = ink.shape; s = max(w, h)
out = []
for c, hh in zip(cs, hier[0]):
    if cv2.contourArea(c) < 40: continue
    c = cv2.approxPolyDP(c, 1.2, True)[:, 0]
    out.append({"hole": bool(hh[3] != -1), "pts": [[float((x - w / 2) / s * 2), float(-(y - h / 2) / s * 2)] for x, y in c]})
json.dump(out, open(sys.argv[2], "w"))
print(len(out), "contours,", sum(len(o["pts"]) for o in out), "points")
