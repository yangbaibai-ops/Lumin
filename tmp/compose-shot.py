"""把两张真机截图拼成一张验收图：上=块级形态，下=行内形态（都只看标识符底色）。"""
from PIL import Image, ImageDraw

block = Image.open(r"tmp\v105-block-nosel.png").convert("RGB")     # clip x=300,y=40,w=1000,h=260
inline = Image.open(r"tmp\v105-inline-nosel.png").convert("RGB")   # clip x=300,y=330,w=1000,h=320

# 块级：标识符底色 = 页 72..168.89 ⇒ 图 y 32..128.89；图片在 174.83..206.83 ⇒ 图 y 134.83..166.83
b = block.crop((0, 20, 960, 175))
# 行内：底色第 1 行 = 页 354.08..386.27 ⇒ 图 y 24.08..56.27；第 2 行 386.38..418.56 ⇒ 图 56.38..88.56
i = inline.crop((0, 12, 960, 210))

W = 960
SEP = 10
LBL = 14
H = LBL + b.height + SEP + LBL + i.height + 2
out = Image.new("RGB", (W, H), (255, 255, 255))
d = ImageDraw.Draw(out)
y = 0
d.text((4, 1), "BLOCK form: bg rect = 72.00..168.89 (h=96.89 = 3 x line box 32.30)", fill=(200, 0, 0))
y += LBL
out.paste(b, (0, y))
y += b.height
d.line((0, y + SEP // 2, W, y + SEP // 2), fill=(120, 120, 120))
y += SEP
d.text((4, y - 1), "INLINE form (line 15): bg = 354.08..386.27 (h=32.19) vs line box 354.67..386.97 (h=32.30)", fill=(200, 0, 0))
y += LBL
out.paste(i, (0, y))
out.save(r"tmp\ident-fullheight-bg.png")
print("saved tmp/ident-fullheight-bg.png", out.size)
