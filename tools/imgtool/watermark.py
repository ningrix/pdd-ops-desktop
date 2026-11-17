# -*- coding: utf-8 -*-
"""
主图水印。三种模式：corner（角标）/ tile（平铺）/ band（卖点条）。

⚠️ 用途边界（AGENTS.md §1.2.6）：
   水印**不能**用来规避平台的重复铺货判定 —— 平台算的是感知哈希，
   加一行字不改变哈希。水印的正当用途是：品牌标、卖点角标、遮挡友商 logo。
"""
import os
import math
from PIL import Image, ImageDraw, ImageFont

# 常见中文字体候选（Windows 优先）
_FONT_CANDIDATES = [
    r'C:\Windows\Fonts\msyhbd.ttc',   # 微软雅黑 Bold
    r'C:\Windows\Fonts\msyh.ttc',     # 微软雅黑
    r'C:\Windows\Fonts\simhei.ttf',   # 黑体
    r'C:\Windows\Fonts\Deng.ttf',     # 等线
]


def load_font(size):
    for p in _FONT_CANDIDATES:
        if os.path.exists(p):
            try:
                return ImageFont.truetype(p, size)
            except Exception:
                continue
    return ImageFont.load_default()


def _text_size(draw, text, font):
    box = draw.textbbox((0, 0), text, font=font)
    return box[2] - box[0], box[3] - box[1]


def _luma_mean(img, box):
    """算某个矩形区域的平均亮度（0~255）。"""
    x0, y0, x1, y1 = [int(v) for v in box]
    x0 = max(0, x0); y0 = max(0, y0)
    x1 = min(img.width, x1); y1 = min(img.height, y1)
    if x1 <= x0 or y1 <= y0:
        return 255.0
    small = img.crop((x0, y0, x1, y1)).convert('L')
    small = small.resize((min(32, small.width) or 1, min(32, small.height) or 1))
    px = list(small.getdata())
    return sum(px) / float(len(px))


def auto_color(img, box, light=(255, 255, 255), dark=(28, 28, 30), threshold=150):
    """
    按背景亮度自动选文字颜色。

    为什么必须做：拼多多主图基本都是白底，白色水印压上去几乎看不见
    （这是第一版演示暴露出来的真问题）。白底用深色，深底用白色。
    """
    return dark if _luma_mean(img, box) >= threshold else light


def _put(base, layer):
    """把 RGBA 层合成到 base 上。"""
    return Image.alpha_composite(base.convert('RGBA'), layer)


def watermark_corner(img, text, pos='br', opacity=0.32, size_ratio=0.042,
                     color=None, pad_ratio=0.025, shadow=True):
    """角标：单条文字放四角之一。color=None 时按背景自动选深/浅。"""
    W, H = img.size
    layer = Image.new('RGBA', (W, H), (0, 0, 0, 0))
    d = ImageDraw.Draw(layer)
    fs = max(14, int(W * size_ratio))
    font = load_font(fs)
    tw, th = _text_size(d, text, font)
    pad = int(W * pad_ratio)

    if pos == 'br':
        x, y = W - tw - pad, H - th - pad - int(fs * 0.25)
    elif pos == 'bl':
        x, y = pad, H - th - pad - int(fs * 0.25)
    elif pos == 'tr':
        x, y = W - tw - pad, pad
    else:  # tl
        x, y = pad, pad

    # 自动取色：看文字背后那块的平均亮度
    if color is None:
        color = auto_color(img, (x, y, x + tw, y + th))

    a = int(255 * opacity)
    if shadow:
        sh = (0, 0, 0) if sum(color) > 380 else (255, 255, 255)
        d.text((x + max(1, fs // 16), y + max(1, fs // 16)), text,
               font=font, fill=(sh[0], sh[1], sh[2], int(a * 0.45)))
    d.text((x, y), text, font=font, fill=(color[0], color[1], color[2], a))
    return _put(img, layer)


def watermark_tile(img, text, opacity=0.14, size_ratio=0.034, angle=28, color=None):
    """平铺：旋转后重复，防盗图。"""
    W, H = img.size
    fs = max(12, int(W * size_ratio))
    font = load_font(fs)
    probe = Image.new('RGBA', (10, 10))
    pd = ImageDraw.Draw(probe)
    tw, th = _text_size(pd, text, font)

    if color is None:
        # 平铺覆盖面大，取全图平均亮度决定
        color = auto_color(img, (0, 0, W, H))

    step_x = int(tw * 1.7) + 40
    step_y = int(th * 3.2) + 40

    canvas = Image.new('RGBA', (W + step_x * 2, H + step_y * 2), (0, 0, 0, 0))
    d = ImageDraw.Draw(canvas)
    a = int(255 * opacity)
    row = 0
    y = 0
    while y < canvas.height:
        offset = (row % 2) * (step_x // 2)
        x = -step_x + offset
        while x < canvas.width:
            d.text((x, y), text, font=font,
                   fill=(color[0], color[1], color[2], a))
            x += step_x
        y += step_y
        row += 1

    canvas = canvas.rotate(angle, expand=False, resample=Image.BICUBIC)
    crop = canvas.crop((step_x, step_y, step_x + W, step_y + H))
    return _put(img, crop)


def watermark_band(img, text, where='bottom', opacity=0.5,
                   height_ratio=0.065, bg=(0, 0, 0), fg=(255, 255, 255),
                   hairline=True):
    """
    卖点条：底部/顶部半透明色带 + 居中文字。

    注意：色带是**覆盖**在原图上的，会挡住该区域的画面内容。
    默认只取 6.5% 高度 + 50% 透明度，尽量少挡；真挡到了就把 where 换成 'top'。
    """
    W, H = img.size
    layer = Image.new('RGBA', (W, H), (0, 0, 0, 0))
    d = ImageDraw.Draw(layer)
    bh = max(24, int(H * height_ratio))
    y0 = H - bh if where == 'bottom' else 0
    d.rectangle([0, y0, W, y0 + bh], fill=(bg[0], bg[1], bg[2], int(255 * opacity)))

    # 一条 1px 细线，让色带边界清楚（否则半透明色带糊在原图上很脏）
    if hairline:
        ly = y0 if where == 'bottom' else (y0 + bh - 1)
        d.line([(0, ly), (W, ly)], fill=(255, 255, 255, 46), width=1)

    fs = max(13, int(bh * 0.50))
    font = load_font(fs)
    tw, th = _text_size(d, text, font)
    tx = (W - tw) // 2
    ty = y0 + (bh - th) // 2 - int(fs * 0.14)
    # 加一点阴影，低透明度下也读得清
    d.text((tx + 1, ty + 1), text, font=font, fill=(0, 0, 0, int(255 * 0.35)))
    d.text((tx, ty), text, font=font, fill=(fg[0], fg[1], fg[2], 255))
    return _put(img, layer)


def run(in_path, out_path, text, mode='corner', opacity=None, pos='br',
        size_ratio=None, where='bottom', color=None):
    img = Image.open(in_path)
    if mode == 'tile':
        out = watermark_tile(img, text, opacity=opacity if opacity is not None else 0.14,
                             size_ratio=size_ratio or 0.034, color=color)
    elif mode == 'band':
        out = watermark_band(img, text, where=where,
                             opacity=opacity if opacity is not None else 0.5,
                             height_ratio=size_ratio or 0.065)
    else:
        out = watermark_corner(img, text, pos=pos,
                               opacity=opacity if opacity is not None else 0.32,
                               size_ratio=size_ratio or 0.042, color=color)

    os.makedirs(os.path.dirname(os.path.abspath(out_path)) or '.', exist_ok=True)
    ext = os.path.splitext(out_path)[1].lower()
    if ext in ('.jpg', '.jpeg'):
        out.convert('RGB').save(out_path, quality=95, subsampling=0)
    else:
        out.save(out_path)
    return {'size': [out.width, out.height], 'mode': mode}
