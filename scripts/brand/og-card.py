# Default social card og/predictions-card.jpg (1200x630): approved hero artwork + Predictions wordmark + tagline.
# Static brand art only — no probabilities. Run from the repo root after `npm run brand`.
from PIL import Image, ImageDraw, ImageFont

art = Image.open('images/predictions/predictions-global-intelligence-hero.png').convert('RGB')
W, H = 1200, 630
bg = Image.new('RGB', (W, H), (2, 10, 22))
w = round(art.width * H / art.height)
bg.paste(art.resize((w, H), Image.LANCZOS), (W - w + 300, 0))
mask = Image.new('L', (W, H), 0)
md = ImageDraw.Draw(mask)
for x in range(W):
    t = min(1, max(0, (x - 560) / 300))
    md.line([(x, 0), (x, H)], fill=int(255 * (1 - t) ** 1.4))
bg = Image.composite(Image.new('RGB', (W, H), (2, 10, 22)), bg, mask)
d = ImageDraw.Draw(bg)
wm = Image.open('brand/predictions-wordmark-dark.png').convert('RGBA')
wm = wm.resize((round(wm.width * 0.42), round(wm.height * 0.42)), Image.LANCZOS)
bg.paste(wm, (64, 56), wm)
f = lambda wt, s: ImageFont.truetype(f'brand/fonts/inter-{wt}.ttf', s)
d.text((64, 196), 'The world has a price.', font=f(800, 54), fill=(255, 255, 255))
d.text((64, 260), 'We measure the', font=f(800, 54), fill=(121, 180, 255))
d.text((64, 324), 'probability.', font=f(800, 54), fill=(121, 180, 255))
d.text((64, 414), 'Independent model probabilities for real-world', font=f(500, 22), fill=(185, 200, 217))
d.text((64, 445), 'events, compared with live prediction markets.', font=f(500, 22), fill=(185, 200, 217))
d.text((64, 540), 'WEATHER · RATES · SCIENCE · SPACE · BUSINESS · HEALTH · ENERGY', font=f(700, 14), fill=(111, 178, 255))
d.text((64, 568), 'predictions.propbetedge.ai', font=f(700, 18), fill=(232, 240, 250))
bg.save('og/predictions-card.jpg', 'JPEG', quality=88, optimize=True, progressive=True)
print('og/predictions-card.jpg written')
