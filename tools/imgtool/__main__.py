# -*- coding: utf-8 -*-
"""imgtool CLI。所有子命令支持 --json，JSON 到 stdout、日志到 stderr。"""
import sys
import json
import time
import argparse
import traceback

MODELS_DIR = 'work/models'
ESRGAN = MODELS_DIR + '/RealESRGAN_x4plus.pth'
LAMA = MODELS_DIR + '/big-lama-torchscript.pt'


def _emit(obj):
    sys.stdout.write(json.dumps(obj, ensure_ascii=False) + '\n')
    sys.stdout.flush()


def cmd_upscale(a):
    from . import upscale
    t0 = time.time()
    r = upscale.run(a.inp, a.out, a.model, scale=a.scale, tile=a.tile,
                    max_side=a.max_side, denoise=a.denoise)
    r.update(ok=True, ms=int((time.time() - t0) * 1000), out=a.out)
    return r


def cmd_watermark(a):
    from . import watermark
    t0 = time.time()
    r = watermark.run(a.inp, a.out, a.text, mode=a.mode, opacity=a.opacity,
                      pos=a.pos, size_ratio=a.size, where=a.where)
    r.update(ok=True, ms=int((time.time() - t0) * 1000), out=a.out)
    return r


def cmd_clean(a):
    from . import clean
    t0 = time.time()
    r = clean.run(a.inp, a.out, a.model, box=a.box, auto_text=a.auto_text,
                  pad=a.pad)
    r.update(ok=True, ms=int((time.time() - t0) * 1000), out=a.out)
    return r


def cmd_inspect(a):
    from . import inspect_img
    t0 = time.time()
    r = inspect_img.run(a.inp, ocr=a.ocr)
    r.update(ok=True, ms=int((time.time() - t0) * 1000))
    return r


def main(argv=None):
    p = argparse.ArgumentParser(prog='imgtool')
    # --json 是默认行为（输出永远是 JSON），这里保留开关只为兼容两种写法：
    #   imgtool --json inspect ...   和   imgtool inspect ... --json
    common = argparse.ArgumentParser(add_help=False)
    common.add_argument('--json', action='store_true', default=True)
    p.add_argument('--json', action='store_true', default=True)
    sub = p.add_subparsers(dest='cmd', required=True)

    u = sub.add_parser('upscale', parents=[common])
    u.add_argument('--in', dest='inp', required=True)
    u.add_argument('--out', required=True)
    u.add_argument('--model', default=ESRGAN)
    u.add_argument('--scale', type=int, default=4)
    u.add_argument('--tile', type=int, default=512)
    u.add_argument('--max-side', type=int, default=0)
    u.add_argument('--denoise', type=float, default=0.0)
    u.set_defaults(fn=cmd_upscale)

    w = sub.add_parser('watermark', parents=[common])
    w.add_argument('--in', dest='inp', required=True)
    w.add_argument('--out', required=True)
    w.add_argument('--text', required=True)
    w.add_argument('--mode', default='corner', choices=['corner', 'tile', 'band'])
    w.add_argument('--pos', default='br', choices=['br', 'bl', 'tr', 'tl'])
    w.add_argument('--opacity', type=float, default=None)
    w.add_argument('--size', type=float, default=None)
    w.add_argument('--where', default='bottom', choices=['bottom', 'top'])
    w.set_defaults(fn=cmd_watermark)

    c = sub.add_parser('clean', parents=[common])
    c.add_argument('--in', dest='inp', required=True)
    c.add_argument('--out', required=True)
    c.add_argument('--model', default=LAMA)
    c.add_argument('--box', default='', help='x0,y0,x1,y1 可多个用分号隔开')
    c.add_argument('--auto-text', action='store_true')
    c.add_argument('--pad', type=int, default=4)
    c.set_defaults(fn=cmd_clean)

    i = sub.add_parser('inspect', parents=[common])
    i.add_argument('--in', dest='inp', required=True)
    i.add_argument('--ocr', action='store_true', help='同时做文字覆盖检测（需 rapidocr）')
    i.set_defaults(fn=cmd_inspect)

    a = p.parse_args(argv)
    try:
        r = a.fn(a)
        _emit(r)
        return 0 if r.get('ok') else 2
    except Exception as e:
        _emit({
            'ok': False,
            'failed': 'failed_known',
            'error': '%s: %s' % (type(e).__name__, e),
            'trace': traceback.format_exc()[-1200:],
        })
        return 1


if __name__ == '__main__':
    sys.exit(main())
