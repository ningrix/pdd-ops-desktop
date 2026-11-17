# -*- coding: utf-8 -*-
"""
主图检测（图像层）。

检查项：
  尺寸 / 比例 / 文件体积 / 白底纯度 / 主体占比 / 主体居中 / 文字覆盖（可选）

设计原则：
  只报「客观测量值 + 明确阈值」，不做主观判断。
  阈值标注了依据来源；没有官方依据的标 unconfirmed。
"""
import os
import numpy as np
from PIL import Image

# 依据：拼多多官方 goods.add 字段说明「尺寸长宽比 1:1 且不低于 480px」
MIN_SIDE = 480
# 依据：同上「图片大小最高 1MB」
MAX_BYTES = 1024 * 1024

# 白底判定：像素三通道都 >= 该值算「白」
WHITE_PIXEL = 245
# 未确认：平台没有公开「白底占比」的硬阈值，这是经验值（行业普遍做法）
WHITE_RATIO_GOOD = 0.55


def _load(path):
    im = Image.open(path)
    im.load()
    return im


def analyze(path, ocr=False):
    if not os.path.exists(path):
        raise FileNotFoundError(path)

    im = _load(path)
    W, H = im.size
    bytes_ = os.path.getsize(path)

    # 统一白底/主体分析用的小图，避免大图算得慢
    small = im.convert('RGB')
    sw, sh = small.size
    if max(sw, sh) > 512:
        r = 512.0 / max(sw, sh)
        small = small.resize((max(1, int(sw * r)), max(1, int(sh * r))), Image.BILINEAR)
    a = np.asarray(small, dtype=np.uint8)
    h, w = a.shape[:2]

    # ---- 白底 / 主体 ----
    is_white = np.all(a >= WHITE_PIXEL, axis=2)
    white_ratio = float(is_white.mean())

    # 边缘带（外框 8%）里的白占比 —— 白底图这一项应接近 1
    bw = max(1, int(min(h, w) * 0.08))
    mask_edge = np.zeros((h, w), dtype=bool)
    mask_edge[:bw, :] = True
    mask_edge[-bw:, :] = True
    mask_edge[:, :bw] = True
    mask_edge[:, -bw:] = True
    edge_white = float(is_white[mask_edge].mean()) if mask_edge.any() else 0.0

    # ---- 主体包围盒 / 居中 ----
    fg = ~is_white
    bbox = None
    center_off = None
    fg_ratio = float(fg.mean())
    if fg.any():
        ys, xs = np.where(fg)
        x0, x1 = int(xs.min()), int(xs.max())
        y0, y1 = int(ys.min()), int(ys.max())
        bbox = [round(x0 / w, 4), round(y0 / h, 4), round(x1 / w, 4), round(y1 / h, 4)]
        cx = (x0 + x1) / 2.0 / w
        cy = (y0 + y1) / 2.0 / h
        # 归一化偏离中心距离（0 = 正中）
        center_off = round(float(np.hypot(cx - 0.5, cy - 0.5)), 4)

    # ---- 文字覆盖（可选，需要 rapidocr）----
    text_ratio = None
    text_boxes = None
    text_note = None
    if ocr:
        try:
            from rapidocr_onnxruntime import RapidOCR
            engine = RapidOCR()
            arr = np.asarray(im.convert('RGB'))[:, :, ::-1].copy()  # RGB->BGR
            res, _ = engine(arr)
            if res:
                area = 0.0
                boxes = []
                for box, txt, score in res:
                    pts = np.asarray(box, dtype=np.float64)
                    bx0, by0 = pts[:, 0].min(), pts[:, 1].min()
                    bx1, by1 = pts[:, 0].max(), pts[:, 1].max()
                    area += max(0.0, bx1 - bx0) * max(0.0, by1 - by0)
                    boxes.append({
                        'text': str(txt)[:40],
                        'score': round(float(score), 3),
                        'box': [int(bx0), int(by0), int(bx1), int(by1)],
                    })
                text_ratio = round(min(1.0, area / float(W * H)), 4)
                text_boxes = boxes[:20]
            else:
                text_ratio = 0.0
                text_boxes = []
        except ImportError:
            text_note = '未安装 rapidocr-onnxruntime，跳过文字检测'
        except Exception as e:
            text_note = 'OCR 失败：%s: %s' % (type(e).__name__, e)

    # ---- 结论 ----
    issues = []
    if min(W, H) < MIN_SIDE:
        issues.append({
            'code': 'IMG_SMALL', 'level': 'warn',
            'msg': '短边 %dpx，低于平台建议的 %dpx' % (min(W, H), MIN_SIDE),
            'fix': '用超分放大，或换更大的源图',
        })
    if bytes_ > MAX_BYTES:
        issues.append({
            'code': 'IMG_HEAVY', 'level': 'warn',
            'msg': '文件 %.2fMB，超过 1MB 上限（压缩后可能损失画质）' % (bytes_ / 1048576.0),
            'fix': '降质量重存或降分辨率',
        })
    ratio = round(W / float(H), 4) if H else None
    if ratio is not None and abs(ratio - 1.0) > 0.02:
        issues.append({
            'code': 'IMG_NOT_SQUARE', 'level': 'info',
            'msg': '比例 %s，不是 1:1' % ratio,
            'fix': '主图一般用 1:1；其他比例可用但有裁切风险',
            'unconfirmed': True,
        })
    if edge_white < WHITE_RATIO_GOOD:
        issues.append({
            'code': 'IMG_NOT_WHITE', 'level': 'info',
            'msg': '边缘白占比 %.0f%%，背景不是纯白' % (edge_white * 100),
            'fix': '白底不是硬性违规，但白底主图在平台更稳妥',
            'unconfirmed': True,
        })
    if center_off is not None and center_off > 0.12:
        issues.append({
            'code': 'IMG_OFF_CENTER', 'level': 'info',
            'msg': '主体偏离画面中心（偏移 %.0f%%）' % (center_off * 100),
            'fix': '居中构图通常转化更好，可考虑裁剪调整',
            'unconfirmed': True,
        })
    if text_ratio is not None and text_ratio > 0.15:
        issues.append({
            'code': 'IMG_TEXT_HEAVY', 'level': 'warn',
            'msg': '文字占画面 %.0f%%，可能遮挡商品主体' % (text_ratio * 100),
            'fix': '精简文案，主图文字面积建议控制在 15% 以内',
            'unconfirmed': True,
        })

    level = 'error'
    if not any(x['level'] == 'error' for x in issues):
        level = 'warn' if any(x['level'] == 'warn' for x in issues) else 'ok'

    return {
        'path': path,
        'w': W, 'h': H,
        'bytes': bytes_,
        'ratio': ratio,
        'whiteRatio': round(white_ratio, 4),
        'edgeWhite': round(edge_white, 4),
        'fgRatio': round(fg_ratio, 4),
        'bbox': bbox,
        'centerOffset': center_off,
        'textRatio': text_ratio,
        'textBoxes': text_boxes,
        'textNote': text_note,
        'level': level,
        'issues': issues,
    }


def run(path, ocr=False):
    return analyze(path, ocr=ocr)
