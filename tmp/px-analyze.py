"""像素取证：把截图里"选区底色 / 标识符底色"的实际覆盖行数点出来。

用法：python tmp/px-analyze.py <png> <x_device_px> [--x2 N]
输出：每一段同色像素的行区间（图内 y，设备像素）+ 颜色。
"""
import sys
from PIL import Image

path = sys.argv[1]
img = Image.open(path).convert("RGB")
W, H = img.size
xs = [int(sys.argv[2])] if len(sys.argv) > 2 else []
i = 3
while i < len(sys.argv):
    if sys.argv[i] == "--x2":
        xs.append(int(sys.argv[i + 1]))
        i += 2
    else:
        i += 1
print(f"# {path} size={W}x{H} xs={xs}")
for x in xs:
    col = [img.getpixel((x, y)) for y in range(H)]
    runs = []
    start = 0
    for y in range(1, H + 1):
        if y == H or col[y] != col[start]:
            runs.append((start, y - 1, col[start]))
            start = y
    print(f"--- x={x} ---")
    for a, b, c in runs:
        if b - a >= 1:
            print(f"  y {a:4d}..{b:4d}  h={b - a + 1:3d}  rgb={c}")
