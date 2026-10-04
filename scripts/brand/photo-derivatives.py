# Derivatives for the Insights real-photo registry (scripts/brand/photo-registry.mjs). Same crops / sizes / file names
# as the editorial art (hero 800/1200/1600, mobile 640/960, card 480/720/1200, square 1080, og + og-bg), so the
# article/desk markup and its fixed width/height (zero CLS) are unchanged. A restrained navy grade (slight
# desaturation + navy multiply + gentle contrast) keeps the family consistent and white article text readable.
# Run from the repo root:  python scripts/brand/photo-derivatives.py [key ...]
import json, os, sys
from PIL import Image, ImageDraw, ImageEnhance

REG = json.load(open('workers/pbe-predictions/src/insights/photo-registry.json', encoding='utf-8'))
NAVY = (8, 20, 40)

def grade(im):
    im = ImageEnhance.Color(im).enhance(0.82)
    im = ImageEnhance.Contrast(im).enhance(1.06)
    tint = Image.new('RGB', im.size, NAVY)
    return Image.blend(im, Image.composite(tint, im, Image.new('L', im.size, 70)), 0.55)

def focal_xy(f):
    x, y = [float(v.strip('%')) / 100 for v in f.split()]
    return x, y

def crop(im, ratio, focal):
    W, H = im.size
    if W / H > ratio: h = H; w = round(H * ratio)
    else: w = W; h = round(W / ratio)
    x = min(max(0, round(focal[0] * W - w / 2)), W - w)
    y = min(max(0, round(focal[1] * H - h / 2)), H - h)
    return im.crop((x, y, x + w, y + h))

def save(img, base, width, fmts=('avif', 'webp')):
    h = round(img.height * width / img.width)
    r = img.resize((width, h), Image.LANCZOS)
    for f in fmts:
        p = f'{base}-{width}.{f}'
        if f == 'avif': r.save(p, 'AVIF', quality=50, speed=5)
        elif f == 'webp': r.save(p, 'WEBP', quality=72, method=6)
        else: r.save(p, 'JPEG', quality=80, optimize=True, progressive=True)

only = set(sys.argv[1:])
for city, s in REG['subjects'].items():
    if only and city not in only and s['key'] not in only: continue
    src = f'images/insights/_masters/photos/{city}.jpg'
    if not os.path.exists(src): print('missing master', city); continue
    with Image.open(src) as raw:
        m = grade(raw.convert('RGB'))
    focal = focal_xy(s['focal'])
    d = f"images/insights/{s['key']}/{s['version']}"
    os.makedirs(d, exist_ok=True)
    hero = crop(m, 16 / 9, focal)
    for w in (800, 1200, 1600): save(hero, f'{d}/hero', w)
    save(hero, f'{d}/hero', 1600, ('jpg',))
    card = crop(m, 4 / 3, focal)
    for w in (480, 720): save(card, f'{d}/card', w)
    save(card, f'{d}/card', 1200, ('jpg',))
    save(crop(m, 1, focal), f'{d}/square', 1080, ('jpg',))
    mob = crop(m, 4 / 5, focal)
    for w in (640, 960): save(mob, f'{d}/mobile', w)
    og = crop(m, 1200 / 630, focal).resize((1200, 630), Image.LANCZOS)
    og.save(f'{d}/og.jpg', 'JPEG', quality=82, optimize=True, progressive=True)
    shade = Image.new('L', og.size, 0); dr = ImageDraw.Draw(shade)
    for x in range(og.width):
        t = min(1, max(0, (x - 420) / 520)); dr.line([(x, 0), (x, og.height)], fill=int(235 * (1 - t) ** 1.2) + 20)
    Image.composite(Image.new('RGB', og.size, (2, 10, 22)), og, shade).save(f'{d}/og-bg.jpg', 'JPEG', quality=80, optimize=True)
    size = sum(os.path.getsize(os.path.join(d, f)) for f in os.listdir(d))
    print(s['key'], f'{size / 1024:.0f} KB')
    del m, hero, card, mob, og
