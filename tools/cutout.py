"""从玻璃牛表情包里抠出主角（去背景），输出带 alpha 的 PNG。

思路：背景都是饱和的绿草/蓝天，牛是白/黑/粉。
1) 按 HSV 圈出"肯定不是牛"的像素（绿、蓝）；
2) 从四边做连通生长，只删掉和边框连着的背景；
3) 取最大前景连通块、填洞、羽化 1.5px、裁到包围盒。
"""
import os
import numpy as np
from PIL import Image, ImageFilter

SRC = r"path\to\glasscow"  # 原始表情包目录
OUT = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "assets", "cow")


def hsv_layers(rgb):
    im = Image.fromarray(rgb, "RGB").convert("HSV")
    return np.asarray(im).astype(np.int16)


def background_mask(rgb):
    hsv = hsv_layers(rgb)
    h, s, v = hsv[..., 0], hsv[..., 1], hsv[..., 2]
    green = (h >= 30) & (h <= 130) & (s > 55) & (v > 40)
    blue = (h >= 135) & (h <= 195) & (s > 45) & (v > 60)
    return green | blue


def flood_from_border(mask):
    """保留与边框相连的背景，返回 'connected to border' 掩码。"""
    h, w = mask.shape
    seen = np.zeros_like(mask, dtype=bool)
    stack = []
    for x in range(w):
        for y in (0, h - 1):
            if mask[y, x]:
                stack.append((y, x))
    for y in range(h):
        for x in (0, w - 1):
            if mask[y, x]:
                stack.append((y, x))
    while stack:
        y, x = stack.pop()
        if seen[y, x] or not mask[y, x]:
            continue
        seen[y, x] = True
        for dy, dx in ((1, 0), (-1, 0), (0, 1), (0, -1)):
            ny, nx = y + dy, x + dx
            if 0 <= ny < h and 0 <= nx < w and mask[ny, nx] and not seen[ny, nx]:
                stack.append((ny, nx))
    return seen


def largest_component(fg):
    from collections import deque
    h, w = fg.shape
    seen = np.zeros_like(fg, dtype=bool)
    best = np.zeros_like(fg, dtype=bool)
    for y0 in range(0, h, 3):
        for x0 in range(0, w, 3):
            if not fg[y0, x0] or seen[y0, x0]:
                continue
            q = deque([(y0, x0)])
            seen[y0, x0] = True
            cells = []
            while q:
                y, x = q.popleft()
                cells.append((y, x))
                for dy, dx in ((1, 0), (-1, 0), (0, 1), (0, -1)):
                    ny, nx = y + dy, x + dx
                    if 0 <= ny < h and 0 <= nx < w and fg[ny, nx] and not seen[ny, nx]:
                        seen[ny, nx] = True
                        q.append((ny, nx))
            if len(cells) > best.sum():
                best = np.zeros_like(fg, dtype=bool)
                ys = np.array([c[0] for c in cells])
                xs = np.array([c[1] for c in cells])
                best[ys, xs] = True
    return best


def fill_holes(mask):
    inv = ~mask
    border_reach = flood_from_border(inv)
    holes = inv & ~border_reach
    return mask | holes


TOP_CROP = {'2.jpg': 0.20}


def cut(path, out_path):
    im = Image.open(path).convert("RGB")
    frac = TOP_CROP.get(os.path.basename(path), 0)
    if frac:
        im = im.crop((0, int(im.height * frac), im.width, im.height))
    rgb = np.asarray(im)
    bg_seed = background_mask(rgb)
    bg = flood_from_border(bg_seed)
    fg = ~bg
    fg = largest_component(fg)
    fg = fill_holes(fg)

    alpha = Image.fromarray((fg * 255).astype(np.uint8), "L")
    alpha = alpha.filter(ImageFilter.MaxFilter(5))       # 稍微外扩，避免吃边
    alpha = alpha.filter(ImageFilter.GaussianBlur(1.6))  # 羽化
    # 外扩后再压回去，避免把已有背景吃回来
    alpha_arr = np.asarray(alpha).astype(np.float32) * fg
    alpha = Image.fromarray(alpha_arr.clip(0, 255).astype(np.uint8), "L")

    out = im.convert("RGBA")
    out.putalpha(alpha)
    bbox = alpha.point(lambda p: 255 if p > 24 else 0).getbbox()
    if bbox:
        out = out.crop(bbox)
    out.save(out_path)
    return out.size


def main():
    os.makedirs(OUT, exist_ok=True)
    for name in sorted(os.listdir(SRC)):
        if not name.lower().endswith((".jpg", ".png", ".webp", ".jpeg")):
            continue
        dst = os.path.join(OUT, os.path.splitext(name)[0] + ".png")
        try:
            size = cut(os.path.join(SRC, name), dst)
            print(f"{name} -> {os.path.basename(dst)} {size}")
        except Exception as exc:  # noqa: BLE001
            print(f"{name} FAILED {exc!r}")


if __name__ == "__main__":
    main()
