#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""
pdd.py —— 拼多多「复制上架」命令行工具（基于 CDP，复用已登录工作浏览器）

用法:
    python tools/pdd.py list
    python tools/pdd.py copy --index 0 --title "新标题" [--submit]
    python tools/pdd.py draft --commit 206366941330
    python tools/pdd.py submit --goods 1030242755844 --commit 206366941330

前提:
    tools\\启动拼多多工作浏览器.bat   （登录一次，之后常驻）
"""
import argparse
import json
import sys
import time
import urllib.parse
import urllib.request

try:
    import websocket
except ImportError:
    print("[ERR] python -m pip install websocket-client")
    sys.exit(1)

DEBUG_BASE = "http://127.0.0.1:9222"
MATCH = "mms.pinduoduo.com"


# ----------------------------------------------------------------- 基础设施
def _req(path, method="GET"):
    req = urllib.request.Request(DEBUG_BASE + path, method=method)
    with urllib.request.urlopen(req, timeout=8) as r:
        body = r.read().decode("utf-8", "replace").strip()
    return json.loads(body) if body[:1] in "{[" else body


def get_page():
    targets = _req("/json/list")
    pages = [t for t in targets if t.get("type") == "page" and MATCH in (t.get("url") or "")]
    if not pages:
        q = urllib.parse.quote("https://mms.pinduoduo.com/home/", safe="")
        for m in ("PUT", "GET"):
            try:
                t = _req("/json/new?url=" + q, method=m)
                if isinstance(t, dict) and t.get("webSocketDebuggerUrl"):
                    time.sleep(3)
                    return t
            except Exception:
                pass
        return None
    # 优先商品页（__mms 只在 MMS shell 里存在）
    pages.sort(key=lambda t: 0 if "/goods/" in (t.get("url") or "") or "/home" in (t.get("url") or "") else 1)
    return pages[0]


def evaluate(ws_url, expression, timeout=120):
    ws = websocket.create_connection(ws_url, timeout=timeout, suppress_origin=True)
    try:
        ws.send(json.dumps({
            "id": 1, "method": "Runtime.evaluate",
            "params": {"expression": expression, "awaitPromise": True,
                       "returnByValue": True, "userGesture": True}
        }))
        while True:
            raw = ws.recv()
            if not raw:
                continue
            msg = json.loads(raw)
            if msg.get("id") == 1:
                return msg
    finally:
        try:
            ws.close()
        except Exception:
            pass


def run_js(fn_body):
    page = get_page()
    if not page:
        print("[ERR] 找不到 mms 页面，先跑 启动拼多多工作浏览器.bat")
        sys.exit(2)
    msg = evaluate(page["webSocketDebuggerUrl"], fn_body)
    if "error" in msg:
        print("[ERR] CDP: " + json.dumps(msg["error"], ensure_ascii=False))
        sys.exit(1)
    res = msg.get("result") or {}
    if "exceptionDetails" in res:
        print("[ERR] JS 异常:")
        print(json.dumps(res["exceptionDetails"], ensure_ascii=False, indent=2)[:2500])
        sys.exit(1)
    return (res.get("result") or {}).get("value")


# ----------------------------------------------------------------- JS 片段
PRELUDE = r"""
  const mms = window.__mms && window.__mms.fetch && window.__mms.fetch.sync;
  if (typeof mms !== 'function') return { error: '__mms 不可用：页面不是 MMS shell，或未登录' };
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
  const pick = (o, ...ks) => {
    if (!o) return undefined;
    for (const k of ks) if (o[k] !== undefined && o[k] !== null) return o[k];
    return undefined;
  };
"""


def js_list(size=20):
    return "(" + "async () => {" + PRELUDE + """
  const r = call('/vodka/v2/mms/query/display/mall/goodsList',
    { page: 1, size: %d, is_onsale: 1, pre_sale_type: 4, shipment_time_type: 3, sold_out: 0 });
  if (!r.ok) return { ok: false, error: r.err };
  const arr = (r.data && r.data.goods_list) || [];
  return {
    ok: true, count: arr.length,
    items: arr.map((g, i) => ({
      idx: i,
      goods_id: g.id,
      title: g.goods_name,
      cat_id: g.cat_id,
      group_price: (g.sku_group_price || [])[0],
      single_price: (g.sku_price || [])[0],
      market_price: g.market_price,
      sku_count: g.sku_count,
      onsale: g.is_onsale,
      stock: g.quantity,
    }))
  };
})()""" % size


def js_copy(index, title, do_submit, set_stock=None):
    return "(" + "async () => {" + PRELUDE + """
  const INDEX = %d, TITLE = %s, DO_SUBMIT = %s, STOCK = %s;
  const R = { steps: [] };

  // ① 列商品取源
  const ls = call('/vodka/v2/mms/query/display/mall/goodsList',
    { page: 1, size: Math.max(INDEX + 1, 10), is_onsale: 1,
      pre_sale_type: 4, shipment_time_type: 3, sold_out: 0 });
  if (!ls.ok) return { ok: false, error: '列商品失败', detail: ls.err };
  const arr = (ls.data && ls.data.goods_list) || [];
  const g = arr[INDEX];
  if (!g) return { ok: false, error: '没有第 ' + INDEX + ' 个商品' };
  R.source = { goods_id: g.id, title: g.goods_name, sku_count: g.sku_count };
  R.steps.push('① 源 goods_id=' + g.id);

  // ② create_by_sn → source commit_id（这是之前缺的关键一步）
  const cbs = call('/glide/v2/mms/edit/commit/create_by_sn', { goods_id: g.id });
  const srcCommit = cbs.ok ? pick(cbs.data, 'goods_commit_id') : undefined;
  if (!srcCommit) return { ok: false, error: 'create_by_sn 没拿到 commit_id', detail: cbs.err };
  R.steps.push('② source commit_id=' + srcCommit);

  // ③ copyGoodsCommit → 新草稿（图/SKU/模板 全部继承）
  const cp = call('/glide/v2/mms/edit/commit/copyGoodsCommit',
    { goods_id: g.id, goods_commit_id: srcCommit });
  const newCommit = cp.ok ? pick(cp.data, 'goods_commit_id') : undefined;
  const newGoods  = cp.ok ? pick(cp.data, 'goods_id') : undefined;
  if (!newCommit) return { ok: false, error: 'copyGoodsCommit 失败', detail: cp.err };
  R.steps.push('③ 新草稿 commit=' + newCommit + ' goods_id=' + newGoods);

  // ④ 回读
  const d = call('/glide/v2/mms/query/commit/detail', { goods_commit_id: newCommit });
  if (!d.ok) return { ok: false, error: '草稿回读失败', detail: d.err };
  const catId = pick(d.data, 'cat_id');
  const sku = Array.isArray(d.data.sku) ? d.data.sku : [];
  R.inherited = {
    图片数: (d.data.galleries || []).length,
    SKU数: sku.length,
    运费模板: d.data.cost_template_id,
  };

  // ⑤ 改标题（必带 cat_id，禁止传 out_goods_sn）
  if (TITLE) {
    const b = { goods_commit_id: newCommit, goods_name: TITLE };
    if (catId) b.cat_id = catId;
    const up = call('/glide/mms/goodsCommit/action/update_goods_commit_info', b);
    R.steps.push('⑤ 改名: ' + (up.ok ? 'ok' : ('失败 ' + JSON.stringify(up.err))));
  }

  // ⑥ 回读确认
  const back = call('/glide/v2/mms/query/commit/detail', { goods_commit_id: newCommit });
  R.result = {
    goods_id: newGoods,
    commit_id: newCommit,
    标题: back.ok ? back.data.goods_name : null,
    是草稿: back.ok ? (back.data.is_shop === 0) : null,
    库存提醒: (Array.isArray(back.data.sku) && back.data.sku.every(s => !s.quantity))
              ? '所有 SKU 库存为 0，上架前必须补库存' : 'ok',
  };

  // ⑦ 可选提交
  if (DO_SUBMIT) {
    const sb = call('/glide/v2/mms/edit/commit/submit', { goods_commit_id: newCommit });
    R.submit = { ok: sb.ok, detail: sb.ok ? sb.data : sb.err };
    R.steps.push('⑦ submit: ' + (sb.ok ? 'ok' : '失败'));
  } else {
    R.steps.push('⑦ 停草稿（未提交）');
  }
  R.ok = true;
  return R;
})()""" % (index, json.dumps(title or "", ensure_ascii=False), "true" if do_submit else "false",
           json.dumps(set_stock))


def js_draft(commit):
    return "(" + "async () => {" + PRELUDE + """
  const C = %d;
  const d = call('/glide/v2/mms/query/commit/detail', { goods_commit_id: C });
  if (!d.ok) return { ok: false, error: d.err };
  const g = d.data, sku = Array.isArray(g.sku) ? g.sku : [];
  return {
    ok: true,
    goods_id: g.goods_id, commit_id: g.id, 标题: g.goods_name,
    cat_id: g.cat_id, is_shop: g.is_shop, is_draft: g.is_draft,
    拼单价: { min: g.min_group_price, max: g.max_group_price },
    市场价: g.market_price, 运费模板: g.cost_template_id,
    发货时效秒: g.shipment_limit_second,
    图片数: (g.galleries || []).length, SKU数: sku.length,
    SKU: sku.slice(0, 8).map(s => ({
      sku_id: s.sku_id, 单买价: s.price, 拼单价: s.multi_price, 库存: s.quantity
    })),
  };
})()""" % commit


def js_submit(goods, commit):
    return "(" + "async () => {" + PRELUDE + """
  const G = %d, C = %d;
  const sb = call('/glide/v2/mms/edit/commit/submit', { goods_commit_id: C });
  const rd = call('/vodka/v2/mms/query/display/mall/goodsListByGoodsId',
    { goods_id: G, is_onsale: 1, page: 1, size: 10 });
  return { ok: sb.ok, submit: sb.ok ? sb.data : sb.err, readback: rd.ok ? rd.data : rd.err };
})()""" % (goods, commit)


# ----------------------------------------------------------------- 入口
def main():
    ap = argparse.ArgumentParser(description="拼多多复制上架 CLI（CDP 版）")
    sub = ap.add_subparsers(dest="cmd", required=True)

    p = sub.add_parser("list", help="列出在售商品")
    p.add_argument("--size", type=int, default=20)

    p = sub.add_parser("copy", help="复制成草稿（加 --submit 才真上架）")
    p.add_argument("--index", type=int, default=0, help="list 里的序号")
    p.add_argument("--title", default="", help="新标题")
    p.add_argument("--submit", action="store_true", help="真上架（默认只到草稿）")

    p = sub.add_parser("draft", help="查草稿详情")
    p.add_argument("--commit", type=int, required=True)

    p = sub.add_parser("submit", help="提交已有草稿")
    p.add_argument("--goods", type=int, required=True)
    p.add_argument("--commit", type=int, required=True)

    args = ap.parse_args()

    if args.cmd == "list":
        js = js_list(args.size)
    elif args.cmd == "copy":
        js = js_copy(args.index, args.title, args.submit)
    elif args.cmd == "draft":
        js = js_draft(args.commit)
    else:
        js = js_submit(args.goods, args.commit)

    val = run_js(js)
    print(json.dumps(val, ensure_ascii=False, indent=2))
    if isinstance(val, dict) and val.get("ok") is False:
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
