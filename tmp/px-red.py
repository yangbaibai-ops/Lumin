"""找纯红像素的包围盒（验 Custom Highlight 是否真的画出来了）。"""
import sys
from PIL import Image

for path in sys.argv[1:]:
    im = Image.open(path).convert("RGB")
    W, H = im.size
    pts = [(x, y) for y in range(H) for x in range(W)
           if im.getpixel((x, y))[0] > 200 and im.getpixel((x, y))[1] < 90 and im.getpixel((x, y))[2] < 90]
    if pts:
        xs = [p[0] for p in pts]
        ys = [p[1] for p in pts]
        print(f"{path}: {len(pts)} red px  x {min(xs)}..{max(xs)}  y {min(ys)}..{max(ys)}  h={max(ys)-min(ys)+1}")
    else:
        print(f"{path}: NO red pixels")
