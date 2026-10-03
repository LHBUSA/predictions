# Derivatives for the editorial art masters (scripts/brand/editorial-art.mjs). One master -> every crop, around a
# per-image focal point. Masters (SVG + PNG) are preserved in images/insights/_masters/.
#   python scripts/brand/editorial-derivatives.py
import os, random
from PIL import Image, ImageDraw

VERSION = 'v1'
FOCAL = {  # (x, y) as fractions of the master; crops keep this point in frame
    'lax-99': (0.70, 0.46), 'treasury-7y': (0.58, 0.44), 'two-guidance': (0.50, 0.50),
    'category-weather': (0.68, 0.42), 'category-rates': (0.55, 0.45), 'category-economics': (0.6, 0.6), 'category-science': (0.6, 0.55),
    'category-space': (0.5, 0.55), 'category-public-health': (0.55, 0.5), 'category-energy': (0.5, 0.5), 'category-business': (0.5, 0.6),
}

def grain(im, amount=5, seed=7):
    random.seed(seed)
    noise = Image.effect_noise(im.size, 18).convert('L')
    return Image.blend(im, Image.merge('RGB', (noise, noise, noise)), amount / 255 * 3)

def crop(im, ratio, focal):
    W, H = im.size
    if W / H > ratio:
        w, h = round(H * ratio), H
    else:
        w, h = W, round(W / ratio)
    x = min(max(0, round(focal[0] * W - w / 2)), W - w)
    y = min(max(0, round(focal[1] * H - h / 2)), H - h)
    return im.crop((x, y, x + w, y + h))

def save(img, base, width, fmts=('avif', 'webp')):
    h = round(img.height * width / img.width)
    r = img.resize((width, h), Image.LANCZOS)
    out = {}
    for f in fmts:
        p = f'{base}-{width}.{f}'
        if f == 'avif': r.save(p, 'AVIF', quality=60, speed=4)
        elif f == 'webp': r.save(p, 'WEBP', quality=80, method=6)
        else: r.save(p, 'JPEG', quality=86, optimize=True, progressive=True)
        out[f] = os.path.getsize(p)
    return out

for key, focal in FOCAL.items():
    src = f'images/insights/_masters/{key}.png'
    if not os.path.exists(src): continue
    m = grain(Image.open(src).convert('RGB'))
    d = f'images/insights/{key}/{VERSION}'
    os.makedirs(d, exist_ok=True)
    rep = {}
    hero = crop(m, 16 / 9, focal)
    for w in (800, 1200, 1600): rep[f'hero-{w}'] = save(hero, f'{d}/hero', w)
    rep['hero-1600.jpg'] = save(hero, f'{d}/hero', 1600, ('jpg',))
    card = crop(m, 4 / 3, focal)
    for w in (480, 720): rep[f'card-{w}'] = save(card, f'{d}/card', w)
    rep['card-1200.jpg'] = save(card, f'{d}/card', 1200, ('jpg',))
    sq = crop(m, 1, focal); rep['square-1080.jpg'] = save(sq, f'{d}/square', 1080, ('jpg',))
    mob = crop(m, 4 / 5, focal)
    for w in (640, 960): rep[f'mobile-{w}'] = save(mob, f'{d}/mobile', w)
    og = crop(m, 1200 / 630, focal).resize((1200, 630), Image.LANCZOS)
    og.save(f'{d}/og.jpg', 'JPEG', quality=86, optimize=True, progressive=True)
    # social-card background: same crop, darkened on the left where the card's frozen overlay text sits
    shade = Image.new('L', og.size, 0); dr = ImageDraw.Draw(shade)
    for x in range(og.width):
        t = min(1, max(0, (x - 420) / 520)); dr.line([(x, 0), (x, og.height)], fill=int(235 * (1 - t) ** 1.2) + 20)
    bg = Image.composite(Image.new('RGB', og.size, (2, 10, 22)), og, shade)
    bg.save(f'{d}/og-bg.jpg', 'JPEG', quality=80, optimize=True)
    print(key, {k: v for k, v in rep.items() if k.startswith('hero-1600') or k == 'card-720'}, 'og', os.path.getsize(f'{d}/og.jpg'))
