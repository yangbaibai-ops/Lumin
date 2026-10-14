"""像素取证（分类版）：把某几列的像素按参考色分类，输出 y 方向的同色段。

参考色（本主题 light）：
  paper        (255,255,255)  纸面
  edge         (228,230,234)  标识符底色 --edge
  sel-paper    (229,230,231)  --sel 叠在纸面上（原生选区高亮）
  sel-edge     (205,208,212)  --sel 叠在 --edge 上
用法：python tmp/px-class.py <png> <x1> [x2 ...]
"""
import sys
from PIL import Image

REFS = {
    "P": (255, 255, 255),
    "E": (228, 230, 234),
    "S": (229, 230, 231),
    "X": (205, 208, 212),
}
TOL = 3


def classify(px):
    r, g, b = px
    if r >= 248 and g >= 248 and b >= 248:
        return "P"
    best, bestd = "?", 1e9
    for k, (rr, gg, bb) in REFS.items():
        d = abs(r - rr) + abs(g - gg) + abs(b - bb)
        if d < bestd:
            best, bestd = k, d
    if bestd <= TOL * 3:
        return best
    return "#"


def main():
    path = sys.argv[1]
    img = Image.open(path).convert("RGB")
    W, H = img.size
    print(f"# {path} {W}x{H}")
    for xa in sys.argv[2:]:
        x = int(xa)
        if x >= W:
            print(f"--- x={x} OUT-OF-RANGE (W={W})")
            continue
        col = [classify(img.getpixel((x, y))) for y in range(H)]
        runs = []
        start = 0
        for y in range(1, H + 1):
            if y == H or col[y] != col[start]:
                runs.append((start, y - 1, col[start]))
                start = y
        print(f"--- x={x} ---")
        for a, b, c in runs:
            print(f"  y {a:4d}..{b:4d} h={b - a + 1:3d}  {c}")
    print()
    print("图例: P=纸面  E=--edge(标识符底色)  S=--sel叠纸(原生选区)  X=--sel叠edge  #=其它(文字/图片)")


main()
