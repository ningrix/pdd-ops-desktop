#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""
pdd_price.py —— 改价 / 改库存（不依赖逆向请求体 schema）

流程：
  1. 打开该草稿的编辑页
  2. 程序点一次「保存草稿」，同时抓包，拿到这份草稿的真实 action/edit 请求体
  3. 在请求体上改价格 / 库存
  4. 回放 action/edit
  5. 回读 commit/detail 校验

用法:
  python tools/pdd_price.py --commit 206366952022 --goods 1030243408035 --factor 1.05
  python tools/pdd_price.py --commit 206366952022 --goods 1030243408035 --set-group 24000
  python tools/pdd_price.py --commit 206366952022 --goods 1030243408035 --factor 1.05 --qty 50
"""
import argparse
import json
import os
import sys
import time

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from cdp_capture import CDP, pick_page, _req  # noqa: E402

EDIT_URL = ('https://mms.pinduoduo.com/goods/goods_add/index'
            '?id={commit}&goods_id={goods}&type=edit')

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


def eval_in_page(ws_url, expression, timeout=120):
    cdp = CDP(ws_url)
    try:
        mid = cdp.send('Runtime.evaluate', {
            'expression': expression,
            'awaitPromise': True,
            'returnByValue': True,
            'userGesture': True,
        })
        deadline = time.time() + timeout
        while time.time() < deadline:
            cdp.ws.settimeout(max(0.5, deadline - time.time()))
            try:
                raw = cdp.ws.recv()
            except Exception:
                continue
            if not raw:
                continue
            msg = json.loads(raw)
            if msg.get('id') == mid:
                return msg
        return {'error': 'timeout'}
    finally:
        cdp.close()


def capture_save_body(ws_url, seconds=26):
    """点「保存草稿」并抓 action/edit 的请求体"""
    cdp = CDP(ws_url)
    try:
        cdp.send('Network.enable', {'maxTotalBufferSize': 80 * 1024 * 1024})
        cdp.send('Runtime.enable')
        # 等页面稳定
        time.sleep(4)
        js = (
            "(() => {"
            " const want='保存草稿';"
            " const els=[...document.querySelectorAll('button,a,span,div')]"
            "   .filter(e=>(e.innerText||'').replace(/\\s+/g,' ').trim()===want);"
            " if(!els.length) return {clicked:false};"
            " els[0].click(); return {clicked:true};"
            "})()"
        )
        cdp.send('Runtime.evaluate', {'expression': js, 'returnByValue': True, 'userGesture': True})

        reqs = {}
        body_found = None
        deadline = time.time() + seconds
        while time.time() < deadline:
            cdp.ws.settimeout(max(0.3, deadline - time.time()))
            try:
                raw = cdp.ws.recv()
            except Exception:
                continue
            if not raw:
                continue
            try:
                msg = json.loads(raw)
            except Exception:
                continue
            if msg.get('method') == 'Network.requestWillBeSent':
                p = msg.get('params') or {}
                req = p.get('request') or {}
                url = req.get('url') or ''
                if 'action/edit' in url and req.get('postData'):
                    body_found = req.get('postData')
                    break
        return body_found
    finally:
        cdp.close()


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--commit', type=int, required=True)
    ap.add_argument('--goods', type=int, required=True)
    ap.add_argument('--factor', type=float, default=None)
    ap.add_argument('--set-group', type=int, default=None, help='拼单价设为多少分')
    ap.add_argument('--qty', type=int, default=None)
    ap.add_argument('--dry-run', action='store_true', help='只抓请求体不回放')
    ap.add_argument('--keep-body', default='', help='把抓到的请求体另存到指定路径')
    args = ap.parse_args()

    if args.factor is None and args.set_group is None and args.qty is None:
        print('[ERR] 至少要给 --factor / --set-group / --qty 之一')
        return 2

    page = pick_page()
    if not page:
        print('[ERR] 没有 mms 页面')
        return 2
    ws = page['webSocketDebuggerUrl']

    # 1) 打开编辑页
    url = EDIT_URL.format(commit=args.commit, goods=args.goods)
    print('[..] 打开编辑页 ...')
    eval_in_page(ws, 'location.href = %s' % json.dumps(url))
    time.sleep(13)

    # 2) 点保存草稿并抓 body
    print('[..] 点「保存草稿」抓请求体 ...')
    raw_body = capture_save_body(ws)
    if not raw_body:
        print('[ERR] 没抓到 action/edit 请求体')
        return 1
    print('[OK] 抓到请求体 %d 字节' % len(raw_body))

    if args.keep_body:
        with open(args.keep_body, 'w', encoding='utf-8') as f:
            f.write(raw_body)
        print('[OK] 已另存:', args.keep_body)

    body = json.loads(raw_body)
    skus = body.get('skus') or []
    print('[..] commit=%s skus=%d' % (body.get('goods_commit_id'), len(skus)))

    # 3) 改
    if args.factor is not None or args.set_group is not None:
        for s in skus:
            og = int(s.get('multi_price') or 0)
            op = int(s.get('price') or 0)
            if args.set_group is not None:
                ng = int(args.set_group)
                np_ = max(ng + 100, op)
            else:
                ng = int(round(og * args.factor))
                np_ = int(round(op * args.factor))
                if np_ <= ng:
                    np_ = ng + 100
            s['multi_price'] = ng
            s['price'] = np_
            s['multi_price_in_yuan'] = '%.2f' % (ng / 100.0)
            s['price_in_yuan'] = '%.2f' % (np_ / 100.0)
        gs = [int(s['multi_price']) for s in skus]
        ss = [int(s['price']) for s in skus]
        body['market_price'] = max(int(body.get('market_price') or 0), max(ss) + 100)
        body['market_price_in_yuan'] = '%.2f' % (body['market_price'] / 100.0)
        if isinstance(body.get('groups'), dict):
            body['groups']['group_price'] = min(gs)
            body['groups']['single_price'] = max(ss)
        print('[..] 拼单价 %.2f ~ %.2f 元，市场价 %.2f 元' % (
            min(gs) / 100.0, max(gs) / 100.0, body['market_price'] / 100.0))

    if args.qty is not None:
        for s in skus:
            s['quantity_delta'] = int(args.qty)
        print('[..] quantity_delta 设为 %d' % args.qty)

    if args.dry_run:
        out = os.path.join(os.getcwd(), 'work', 'captured_body.json')
        with open(out, 'w', encoding='utf-8') as f:
            f.write(json.dumps(body, ensure_ascii=False, indent=2))
        print('[OK] dry-run，已存:', out)
        return 0

    # 4) 回放
    js = "(" + "async () => {" + PRELUDE + """
      const BODY = %s;
      const r = call('/glide/mms/goodsCommit/action/edit', BODY);
      const out = { save: { ok: r.ok, err: r.ok ? null : r.err } };
      const d = call('/glide/v2/mms/query/commit/detail', { goods_commit_id: %d });
      if (d.ok) {
        const g = d.data, sk = Array.isArray(g.sku) ? g.sku : [];
        out.after = {
          min_group_price: g.min_group_price,
          max_group_price: g.max_group_price,
          market_price: g.market_price,
          sku_count: sk.length,
          sku0: sk[0] ? { group: sk[0].multi_price, single: sk[0].price, qty: sk[0].quantity } : null,
          qty_sum: sk.reduce((a, s) => a + (Number(s.quantity) || 0), 0),
        };
      }
      out.ok = !!r.ok;
      return out;
    })()""" % (json.dumps(body, ensure_ascii=False), args.commit)

    print('[..] 回放 action/edit ...')
    res = eval_in_page(ws, js)
    if 'error' in res:
        print('[ERR]', json.dumps(res['error'], ensure_ascii=False))
        return 1
    r = res.get('result') or {}
    if 'exceptionDetails' in r:
        print('[ERR] JS 异常:', json.dumps(r['exceptionDetails'], ensure_ascii=False)[:1000])
        return 1
    val = (r.get('result') or {}).get('value')
    print(json.dumps(val, ensure_ascii=False, indent=2))
    return 0 if isinstance(val, dict) and val.get('ok') else 1


if __name__ == '__main__':
    sys.exit(main())
