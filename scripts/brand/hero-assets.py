# Hero artwork derivatives (approved Image #9). Original preserved byte-for-byte; derivatives never upscale.
#   python scripts/brand/hero-assets.py "<path to original png>"
import os, shutil, sys
from PIL import Image

SRC = sys.argv[1]
OUT = 'images/predictions'
os.makedirs(OUT, exist_ok=True)
orig = os.path.join(OUT, 'predictions-global-intelligence-hero.png')
shutil.copyfile(SRC, orig)
im = Image.open(orig).convert('RGB')
W, H = im.size

def save(img, stem):
    sizes = {}
    a = os.path.join(OUT, stem + '.avif'); img.save(a, 'AVIF', quality=62, speed=4); sizes['avif'] = os.path.getsize(a)
    w = os.path.join(OUT, stem + '.webp'); img.save(w, 'WEBP', quality=82, method=6); sizes['webp'] = os.path.getsize(w)
    return sizes

report = {}
# desktop: full composition
for width in (960, 1280, W):
    h = round(H * width / W)
    report[f'hero-{width}'] = (width, h, save(im.resize((width, h), Image.LANCZOS) if width != W else im, f'hero-{width}'))
# mobile: art-directed crop around the globe and the forecasting panels (right ~69% of the artwork)
crop = im.crop((520, 0, W, H))
cw, ch = crop.size
for width in (480, 800, cw):
    h = round(ch * width / cw)
    report[f'hero-mobile-{width}'] = (width, h, save(crop.resize((width, h), Image.LANCZOS) if width != cw else crop, f'hero-mobile-{width}'))
# Open Graph 1.91:1 candidate from the full artwork
og = im.resize((1200, round(H * 1200 / W)), Image.LANCZOS)
top = (og.size[1] - 630) // 2
og = og.crop((0, top, 1200, top + 630))
os.makedirs('og', exist_ok=True)
og.save('og/home.jpg', 'JPEG', quality=86, optimize=True, progressive=True)
report['og/home.jpg'] = (1200, 630, {'jpg': os.path.getsize('og/home.jpg')})
for k, (w, h, s) in report.items():
    print(f'{k:22} {w}x{h} ' + ' '.join(f'{f}={v // 1024}KB' for f, v in s.items()))
print('original', os.path.getsize(orig) // 1024, 'KB', W, 'x', H, '| mobile crop', cw, 'x', ch)
