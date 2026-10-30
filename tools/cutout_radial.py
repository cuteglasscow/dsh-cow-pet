# -*- coding: utf-8 -*-
"""用红笔描边做径向采样，得到一条闭合轮廓，再拿 3.jpg 取色。

手画线在图像边缘会断（不是闭合曲线），按顺序串点容易串错。换个稳的：
从描边的重心向四周发射 720 条射线，每条取**最远的红点**作为边界点；
断口处用相邻角度插值补上。得到的多边形天然闭合、顺序正确，
再缩 2px 去掉红线本身，颜色从没画过线的 3.jpg 里取。
"""

import os
import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
from PIL import Image, ImageDraw, ImageFilter

SRC_LINE = r"path\to\3gai.jpeg"   # 用户用红笔描过轮廓的那张
SRC_COLOR = r"path\to\3.jpg"      # 同一张的干净版本，用来取颜色
DST = os.path.join(HERE, "..", "assets", "cow", "smug.png")
PREVIEW = os.path.join(HERE, "..", "_cut_preview.png")
LONG_SIDE = 460
RAYS = 720


def red_mask(rgb):
    r = rgb[..., 0].astype(np.int16)
    g = rgb[..., 1].astype(np.int16)
    b = rgb[..., 2].astype(np.int16)
    return (r > 105) & (r - g > 45) & (r - b > 40)


def main():
    line_img = Image.open(SRC_LINE).convert("RGB")
    color_img = Image.open(SRC_COLOR).convert("RGB")
    if color_img.size != line_img.size:
        color_img = color_img.resize(line_img.size, Image.LANCZOS)
    line_rgb = np.asarray(line_img)
    rgb = np.asarray(color_img)
    h, w = line_rgb.shape[:2]

    red = red_mask(line_rgb)
    ys, xs = np.nonzero(red)
    print("red px", len(ys))
    cy, cx = ys.mean(), xs.mean()
    print("centroid", round(float(cy), 1), round(float(cx), 1))

    # 每条射线取最远红点
    rad = np.zeros(RAYS)
    found = np.zeros(RAYS, bool)
    yc, xc = int(round(cy)), int(round(cx))
    maxr = int(np.hypot(h, w)) + 2
    for s in range(RAYS):
        th = 2 * np.pi * s / RAYS
        dy, dx = -np.cos(th), np.sin(th)  # y 轴朝下，从正上方开始顺时针
        last = None
        for r in range(6, maxr):
            y = int(round(yc + dy * r))
            x = int(round(xc + dx * r))
            if not (0 <= y < h and 0 <= x < w):
                break
            if red[y, x]:
                last = r
        if last is not None:
            rad[s] = last
            found[s] = True

    print("rays with hit", int(found.sum()), "of", RAYS)
    # 断口插值（线性）
    if found.sum() < RAYS * 0.7:
        raise SystemExit("too few rays hit the stroke")
    idx = np.arange(RAYS)
    good = np.where(found)[0]
    rad_full = np.interp(idx, good, rad[good], period=RAYS)

    # 半径做一次环形滑动平均，去掉射线采样的锯齿
    win = 7
    k = np.ones(win) / win
    rad_smooth = np.convolve(np.r_[rad_full[-win:], rad_full, rad_full[:win]], k, mode="same")[win:-win]

    poly = []
    for s in range(0, RAYS, 2):
        th = 2 * np.pi * s / RAYS
        r = rad_smooth[s]
        y = yc - np.cos(th) * r
        x = xc + np.sin(th) * r
        poly.append((x, y))

    mask = Image.new("L", (w, h), 0)
    ImageDraw.Draw(mask).polygon(poly, fill=255)
    m = np.asarray(mask) > 127
    print("polygon area", int(m.sum()))
    assert 80000 < int(m.sum()) < 320000

    def dilate(a, n=1):
        out = a.copy()
        for _ in range(n):
            out = out | np.roll(out, 1, 0) | np.roll(out, -1, 0) | np.roll(out, 1, 1) | np.roll(out, -1, 1)
        return out

    def erode(a, n=1):
        return ~dilate(~a, n)

    # 射线打到的本来就是笔触**外缘**，所以直接往里收，不能外扩，否则边缘会带一圈草绿
    # 两套掩码：颜色从更靠里的一圈取（避开牛边缘那圈被草染绿的像素），alpha 用外圈
    red_band = dilate(red, 4)
    m2 = m & ~red_band          # 红线本身和它周围几像素一律不算牛
    color_base = erode(m2, 11)
    alpha_base = erode(m2, 5)
    if color_base.sum() < 20000:
        raise SystemExit("mask collapsed")

    cmask = Image.fromarray((color_base * 255).astype(np.uint8), "L")
    a = np.asarray(cmask.filter(ImageFilter.GaussianBlur(3.0))).astype(np.float32) / 255.0
    src_f = rgb.astype(np.float32)
    wimg = Image.fromarray(np.clip(src_f * a[..., None], 0, 255).astype(np.uint8), "RGB")
    w_blur = np.asarray(wimg.filter(ImageFilter.GaussianBlur(3.0))).astype(np.float32)
    rgb_out = np.clip(np.where(a[..., None] > 1e-3, w_blur / np.maximum(a[..., None], 1e-3), src_f), 0, 255)

    mask_img = Image.fromarray((alpha_base * 255).astype(np.uint8), "L")

    # 半透明边缘再压一下绿通道（草是黄的，混进来会发黄绿）
    edge = (a > 0.02) & (a < 0.98)
    g_cap = (rgb_out[..., 0] + rgb_out[..., 2]) / 2 + 6
    rgb_out[..., 1] = np.where(edge & (rgb_out[..., 1] > g_cap), g_cap, rgb_out[..., 1])

    alpha = np.asarray(mask_img.filter(ImageFilter.GaussianBlur(0.9))).astype(np.float32) / 255.0
    alpha = np.clip((alpha - 0.14) / 0.86, 0, 1)

    im = Image.fromarray(np.dstack([rgb_out, alpha * 255.0]).astype(np.uint8), "RGBA")
    arr = np.asarray(im).astype(np.int16)
    print("residual red px", int(((arr[..., 0] > 110) & (arr[..., 0] - arr[..., 1] > 40) & (arr[..., 3] > 40)).sum()))

    bbox = im.getbbox()
    im = im.crop((max(0, bbox[0] - 2), max(0, bbox[1] - 2), min(im.width, bbox[2] + 2), min(im.height, bbox[3] + 2)))
    scale = LONG_SIDE / max(im.size)
    if scale < 1:
        im = im.resize((max(1, round(im.width * scale)), max(1, round(im.height * scale))), Image.LANCZOS)
    im.save(DST, optimize=True)
    print("saved", DST, im.size)

    prev = Image.new("RGBA", (im.width * 2 + 30, im.height + 20), (24, 26, 32, 255))
    prev.alpha_composite(im, (10, 10))
    prev.convert("RGB").save(PREVIEW)
    print("preview", PREVIEW)


if __name__ == "__main__":
    main()
