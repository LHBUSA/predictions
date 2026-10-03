# Branded default Open Graph card (1200x630) for predictions.propbetedge.ai. Static brand art only: no probabilities.
#   python scripts/brand/og-default.py  -> og/default.png
from PIL import Image, ImageDraw, ImageFont
import os

W, H = 1200, 630
NAVY, INK, BLUE, MUTED, LINE = (14, 33, 58), (16, 32, 51), (63, 140, 255), (120, 141, 163), (221, 230, 241)
img = Image.new('RGB', (W, H), (245, 248, 253))
d = ImageDraw.Draw(img)
F = 'C:/Windows/Fonts/'
bold = lambda s: ImageFont.truetype(F + 'segoeuib.ttf', s)
reg = lambda s: ImageFont.truetype(F + 'segoeui.ttf', s)
semi = lambda s: ImageFont.truetype(F + 'seguisb.ttf', s) if os.path.exists(F + 'seguisb.ttf') else bold(s)

# left panel
d.rounded_rectangle((64, 64, 120, 120), radius=14, fill=NAVY)
d.text((92, 92), 'P', font=bold(34), fill=(255, 255, 255), anchor='mm')
d.text((138, 70), 'PropBetEdge', font=bold(28), fill=INK)
d.text((138, 102), 'PREDICTIONS', font=semi(16), fill=MUTED)
d.text((64, 190), 'The world has a price.', font=bold(62), fill=INK)
d.text((64, 262), 'We measure the probability.', font=bold(62), fill=(77, 135, 199))
d.text((64, 352), 'Independent model probabilities vs live prediction-market prices,', font=reg(26), fill=MUTED)
d.text((64, 388), 'with evidence, exact resolution rules and a scored record.', font=reg(26), fill=MUTED)

# schematic comparison bars (illustrative brand graphic, unlabeled values)
x0, y0 = 64, 470
for i, (label, w_pbe, w_mkt) in enumerate([('PBE MODEL', 420, 0), ('MARKET', 0, 300)]):
    y = y0 + i * 52
    d.text((x0, y), label, font=semi(18), fill=MUTED)
    d.rounded_rectangle((x0 + 150, y + 4, x0 + 150 + 520, y + 22), radius=9, fill=LINE)
    width = w_pbe or w_mkt
    d.rounded_rectangle((x0 + 150, y + 4, x0 + 150 + width, y + 22), radius=9, fill=BLUE if w_pbe else (155, 173, 191))
d.text((W - 64, H - 48), 'predictions.propbetedge.ai', font=semi(22), fill=NAVY, anchor='rm')
d.line((64, H - 70, W - 64, H - 70), fill=LINE, width=2)

os.makedirs('og', exist_ok=True)
img.save('og/default.png', optimize=True)
print('og/default.png', os.path.getsize('og/default.png'))
