# Generates simple PNG app icons (dark rounded square, purple/red meter bars + white diamond).
from PIL import Image, ImageDraw
import os
out = os.path.join(os.path.dirname(__file__), '..', 'src', 'icons')
os.makedirs(out, exist_ok=True)
def icon(size, maskable=False, rounded=True):
    s = size * 4
    im = Image.new('RGBA', (s, s), (0, 0, 0, 0))
    d = ImageDraw.Draw(im)
    bg = (30, 30, 30, 255)
    if maskable or not rounded: d.rectangle([0, 0, s, s], fill=bg)
    else: d.rounded_rectangle([0, 0, s - 1, s - 1], radius=int(s * 0.22), fill=bg)
    pad = s * (0.2 if maskable else 0.1)
    inner = s - 2 * pad
    colors = [(124,58,237),(139,92,246),(167,139,250),(239,68,68),(220,38,38)]
    n = len(colors); bw = inner / (n * 1.5)
    heights = [0.45, 0.8, 0.6, 0.95, 0.5]
    for i,(c,hf) in enumerate(zip(colors, heights)):
        x0 = pad + i * bw * 1.5 + bw*0.25
        y1 = pad + inner
        y0 = y1 - inner * hf * 0.85
        d.rounded_rectangle([x0, y0, x0 + bw, y1], radius=int(bw*0.25), fill=c)
    cx, cy, r = pad + inner*0.5, pad + inner*0.2, inner*0.12
    d.polygon([(cx, cy-r), (cx+r, cy), (cx, cy+r), (cx-r, cy)], fill=(235,235,235,255))
    return im.resize((size, size), Image.LANCZOS)
icon(192).save(os.path.join(out, 'icon-192.png'))
icon(512).save(os.path.join(out, 'icon-512.png'))
icon(512, maskable=True).save(os.path.join(out, 'icon-maskable-512.png'))
icon(180, rounded=False).save(os.path.join(out, 'apple-touch-icon.png'))
icon(32).save(os.path.join(out, 'icon-32.png'))
print('icons ok')
