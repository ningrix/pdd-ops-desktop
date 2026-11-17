#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""
pdd_edit.py —— 用「抓到的 action/edit 完整请求体」做改价/改库存
思路：编辑页保存时 POST 的是完整商品对象，我们拿到这份对象后改字段再回放。

用法:
  python tools/pdd_edit.py replay            # 原样回放，验证通道
  python tools/pdd_edit.py price --factor 1.05
  python tools/pdd_edit.py stock --qty 50
  python tools/pdd_edit.py price --factor 1.05 --stock 50
"""
import argparse
import json
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from cdp_eval import CDP, check_debug_port, find_page  # noqa: E402

BODY_FILE = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))),
                         'work', 'action_edit_body.json')

PRELUDE = r"""
  const mms = window.__mms && window.__mms.fetch && window.__mms.fetch.sync;
  if (typeof mms !== 'function') return { __blocked: true };
  const safe = (e) => {
    if (!e) return null;
    if (typeof e === 'string') return e;
    const o = {};
    for (const k of ['message','error_msg','errorMsg','error_code','errorCode','success','reason']) {
      if (e[k] !== undefined) o[k] = e[k];
    }
    return Object.keys(o).length ? o : String(e);
  };
  const call = (url, body) => {
    const full = url.startsWith('http') ? url : location.origin + url;
    try {
      const r = mms('POST', full, body || {});
      return { ok: true, data: (r && r.result !== undefined) ? r.result : r };
    } catch (e) { return { ok: false, err: safe(e) }; }
  };
"""


def build_js(payload, do_verify=True):
    body_literal = json.dumps(payload, ensure_ascii=False)
    commit = payload.get('goods_commit_id')
    return "(" + "async () => {" + PRELUDE + """
  const BODY = %s;
  const out = { steps: [] };

  const r = call('/glide/mms/goodsCommit/action/edit', BODY);
  out.save = { ok: r.ok, err: r.ok ? null : r.err,
               keys: r.ok && r.data && typeof r.data === 'object' ? Object.keys(r.data) : null };
  out.steps.push('save: ' + (r.ok ? 'ok' : 'failed'));

  if (%s) {
    const d = call('/glide/v2/mms/query/commit/detail', { goods_commit_id: %s });
    if (d.ok) {
      const g = d.data, sku = Array.isArray(g.sku) ? g.sku : [];
      out.after = {
        goods_name: g.goods_name,
        min_group_price: g.min_group_price,
        max_group_price: g.max_group_price,
        market_price: g.market_price,
        sku_count: sku.length,
        sku0: sku[0] ? { sku_id: sku[0].sku_id, group: sku[0].multi_price,
                         single: sku[0].price, qty: sku[0].quantity } : null,
        qty_sum: sku.reduce((a, s) => a + (Number(s.quantity) || 0), 0),
        price_min: sku.length ? Math.min.apply(null, sku.map(s => Number(s.multi_price) || 0).filter(Boolean)) : null,
        price_max: sku.length ? Math.max.apply(null, sku.map(s => Number(s.multi_price) || 0)) : null,
      };
      out.steps.push('verify: ok');
    } else {
      out.steps.push('verify failed');
    }
  }
  out.ok = r.ok;
  return out;
})()""" % (body_literal, "true" if do_verify else "false", json.dumps(commit))


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('action', choices=['replay', 'price', 'stock'])
    ap.add_argument('--factor', type=float, default=None, help='拼单价倍数，例如 1.05')
    ap.add_argument('--set-group', type=int, default=None, help='拼单价直接设为多少分')
    ap.add_argument('--qty', type=int, default=None, help='每个 SKU 库存设为多少件')
    ap.add_argument('--body', default=BODY_FILE)
    args = ap.parse_args()

    if not os.path.exists(args.body):
        print('[ERR] 找不到请求体文件: %s' % args.body)
        return 2

    payload = json.load(open(args.body, encoding='utf-8'))
    skus = payload.get('skus') or []
    print('[..] commit=%s goods=%s skus=%d 名称=%s' % (
        payload.get('goods_commit_id'), payload.get('goods_id'), len(skus),
        payload.get('goods_name')))

    changed = []

    if args.action in ('price',) or args.factor is not None or args.set_group is not None:
        if args.factor is None and args.set_group is None:
            print('[ERR] price 需要 --factor 或 --set-group')
            return 2
        for s in skus:
            old_g = int(s.get('multi_price') or 0)
            old_p = int(s.get('price') or 0)
            if args.set_group is not None:
                new_g = args.set_group
                new_p = max(new_g + 100, old_p)
            else:
                new_g = int(round(old_g * args.factor))
                new_p = int(round(old_p * args.factor))
                if new_p <= new_g:
                    new_p = new_g + 100
            s['multi_price'] = new_g
            s['price'] = new_p
            s['multi_price_in_yuan'] = '%.2f' % (new_g / 100.0)
            s['price_in_yuan'] = '%.2f' % (new_p / 100.0)
            changed.append((s.get('sku_id'), old_g, new_g))

        if changed:
            gmin = min(c[2] for c in changed)
            gmax = max(c[2] for c in changed)
            smax = max(int(s.get('price') or 0) for s in skus)
            payload['market_price'] = max(int(payload.get('market_price') or 0), smax + 100)
            payload['market_price_in_yuan'] = '%.2f' % (payload['market_price'] / 100.0)
            print('[..] 拼单价区间: %.2f ~ %.2f 元；市场价 -> %.2f 元' % (
                gmin / 100.0, gmax / 100.0, payload['market_price'] / 100.0))

    if args.qty is not None:
        for s in skus:
            s['quantity_delta'] = int(args.qty)
            s['quantity'] = int(args.qty)
        print('[..] 库存设为 %d（同时写 quantity 与 quantity_delta）' % args.qty)

    payload['is_auto_save'] = 1

    if not check_debug_port():
        return 2
    target = find_page('mms.pinduoduo.com')
    if not target:
        print('[ERR] 没有 mms 页面')
        return 2

    cdp = CDP(target['webSocketDebuggerUrl'])
    try:
        cdp.send('Runtime.enable')
        res = cdp.evaluate(build_js(payload))
    finally:
        cdp.close()

    if 'error' in res:
        print('[ERR]', json.dumps(res['error'], ensure_ascii=False))
        return 1
    r = res.get('result') or {}
    if 'exceptionDetails' in r:
        print('[ERR] JS 异常:', json.dumps(r['exceptionDetails'], ensure_ascii=False)[:1200])
        return 1
    val = (r.get('result') or {}).get('value')
    print(json.dumps(val, ensure_ascii=False, indent=2))
    return 0 if isinstance(val, dict) and val.get('ok') else 1


if __name__ == '__main__':
    sys.exit(main())
