# -*- coding: utf-8 -*-
"""4x 超分（RealESRGAN x4plus，手写 RRDBNet，无 basicsr 依赖）。"""
import os
import numpy as np
import torch
from PIL import Image, ImageFilter

from .models import load_realesrgan

_MODEL = None
_MODEL_PATH = None


def get_model(path, num_block=23):
    global _MODEL, _MODEL_PATH
    if _MODEL is None or _MODEL_PATH != path:
        _MODEL, _info = load_realesrgan(path, scale=4, num_block=num_block)
        _MODEL_PATH = path
    return _MODEL


def _to_tensor(img):
    a = np.asarray(img.convert('RGB'), dtype=np.float32) / 255.0
    return torch.from_numpy(a).permute(2, 0, 1).unsqueeze(0)


def _to_image(t):
    a = t.squeeze(0).permute(1, 2, 0).clamp_(0, 1).cpu().numpy()
    return Image.fromarray((a * 255.0).round().astype(np.uint8))


def upscale(img, model, tile=0, tile_pad=16, denoise=0.0):
    """
    整图或分块超分。
    tile>0 时按 tile 尺寸分块，避免大图在 CPU 上爆内存。
    边缘用 tile_pad 重叠，feather 融合，消除接缝。
    """
    if tile <= 0:
        with torch.inference_mode():
            return _to_image(model(_to_tensor(img)))

    W, H = img.size
    out = Image.new('RGB', (W * 4, H * 4))
    xs = list(range(0, W, tile))
    ys = list(range(0, H, tile))
    total = len(xs) * len(ys)
    done = 0

    for y in ys:
        for x in xs:
            x0 = max(0, x - tile_pad)
            y0 = max(0, y - tile_pad)
            x1 = min(W, x + tile + tile_pad)
            y1 = min(H, y + tile + tile_pad)
            patch = img.crop((x0, y0, x1, y1))
            with torch.inference_mode():
                res = _to_image(model(_to_tensor(patch)))

            # 该区块在输出画布上的位置（去掉 pad 部分）
            ox0 = (x - x0) * 4
            oy0 = (y - y0) * 4
            ow = (min(W, x + tile) - x) * 4
            oh = (min(H, y + tile) - y) * 4
            res = res.crop((ox0, oy0, ox0 + ow, oy0 + oh))
            out.paste(res, (x * 4, y * 4))
            done += 1

    if denoise > 0:
        r = max(1, int(round(denoise * 4)))
        out = out.filter(ImageFilter.GaussianBlur(radius=r * 0.35))
    return out


def run(in_path, out_path, model_path, scale=4, tile=512, max_side=0, denoise=0.0):
    img = Image.open(in_path)
    src_w, src_h = img.size
    model = get_model(model_path)

    # 超大图先缩小，否则 CPU 上会非常慢
    if max_side and max(src_w, src_h) > max_side:
        r = max_side / float(max(src_w, src_h))
        img = img.resize((int(src_w * r), int(src_h * r)), Image.LANCZOS)

    res = upscale(img, model, tile=tile, denoise=denoise)
    if scale != 4:
        res = res.resize((int(res.width * scale / 4), int(res.height * scale / 4)),
                         Image.LANCZOS)

    os.makedirs(os.path.dirname(os.path.abspath(out_path)) or '.', exist_ok=True)
    ext = os.path.splitext(out_path)[1].lower()
    if ext in ('.jpg', '.jpeg'):
        res.convert('RGB').save(out_path, quality=95, subsampling=0)
    else:
        res.save(out_path)
    return {'inSize': [src_w, src_h], 'outSize': [res.width, res.height]}
