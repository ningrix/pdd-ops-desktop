'use strict';
/**
 * 资金复盘：在 cashier.pinduoduo.com 页面上执行的注入脚本。
 *
 * 为什么不能用 ops.js 那套：ops.js 走 window.__mms.fetch.sync，只存在于 mms 页面。
 * cashier 是独立域、独立请求模块，接口还带 Anti-Content 动态签名（回放无效）。
 * 所以这里全部走「读 DOM 表格」——表里显示的就是平台已经算好的数。
 */

/** 当前 cashier 页是哪个账号 */
function readAccount() {
  return `(async () => {
    const sleep = (ms) => new Promise(r => setTimeout(r, ms));
    for (let i = 0; i < 15; i++) {
      const t = (document.body.innerText || '').replace(/\\s+/g, ' ');
      const m = t.match(/返回商家后台\\s*(\\S+)\\s*退出/);
      if (m) return { ok: true, account: m[1], url: location.href };
      await sleep(600);
    }
    const t = (document.body.innerText || '').replace(/\\s+/g, ' ');
    return { ok: true, account: null, url: location.href, _head: t.slice(0, 160) };
  })()`;
}

/** 切到「月汇总」并读表 */
function readMonthSummary() {
  return `(async () => {
    const sleep = (ms) => new Promise(r => setTimeout(r, ms));
    // 点「月汇总」页签
    for (let i = 0; i < 20; i++) {
      const els = [...document.querySelectorAll('div,span')]
        .filter(e => (e.innerText || '').trim() === '月汇总');
      const tab = els.find(e => String(e.className).indexOf('TAB_') >= 0);
      if (tab) { tab.click(); break; }
      await sleep(400);
    }
    await sleep(2500);
    const t = document.querySelector('table');
    if (!t) return { ok: false, error: '没找到月汇总表' };
    const rows = [...t.querySelectorAll('tr')].slice(1)
      .map(tr => [...tr.querySelectorAll('td')].map(x => (x.innerText || '').replace(/\\s+/g, ' ').trim()))
      .filter(r => r.length >= 6 && /^\\d{4}-\\d{2}/.test(r[0] || ''));
    const num = (s) => {
      if (!s) return null;
      const v = String(s).replace(/[+,\\s]/g, '');
      if (!/^-?\\d+(\\.\\d+)?$/.test(v)) return null;
      return Math.round(parseFloat(v) * 100);   // 元 → 分
    };
    const cnt = (s) => { const n = parseInt(String(s || '').replace(/[^\\d]/g, ''), 10); return isNaN(n) ? 0 : n; };
    return {
      ok: true,
      months: rows.map(r => ({
        month: (r[0] || '').slice(0, 7),
        monthLabel: r[0],
        income: num(r[1]), incomeCount: cnt(r[2]),
        expense: num(r[3]), expenseCount: cnt(r[4]),
        profit: num(r[5]), beginBalance: num(r[6]), endBalance: num(r[7]),
      })),
    };
  })()`;
}

/** 读资金中心的四个余额（先等页面真正渲染出「货款账户」） */
function readBalance() {
  return `(async () => {
    const sleep = (ms) => new Promise(r => setTimeout(r, ms));
    // 财务页是 SPA，路由到了不代表渲染完。等锚点文字出现再读。
    let ready = false;
    for (let i = 0; i < 40; i++) {
      const t = (document.body.innerText || '');
      if (t.indexOf('货款账户') >= 0 && t.indexOf('店铺保证金') >= 0) { ready = true; break; }
      await sleep(500);
    }
    await sleep(600);
    const txt = (document.body.innerText || '').replace(/\\s+/g, ' ');
    const grab = (re) => { const m = txt.match(re); return m ? m[1] : null; };
    const num = (s) => {
      if (s == null) return null;
      const v = String(s).replace(/[,+\\s]/g, '');
      if (!/^-?\\d+(\\.\\d+)?$/.test(v)) return null;
      return Math.round(parseFloat(v) * 100);
    };
    return {
      ok: ready,
      cash: num(grab(/货款账户（元）[^0-9\\-+]{0,14}([\\d.,]+)/)),
      cashAvailable: num(grab(/含可用余额：([\\d.,]+)/)),
      market: num(grab(/营销账户（元）[^0-9\\-+]{0,14}([\\d.,]+)/)),
      marketAvailable: num(grab(/可提现余额：([\\d.,]+)/)),
      deposit: num(grab(/店铺保证金（元）[^0-9\\-+]{0,14}([\\d.,]+)/)),
      activityDeposit: num(grab(/活动保证金（元）[^0-9\\-+]{0,14}([\\d.,]+)/)),
      _raw: txt.slice(0, 240),
    };
  })()`;
}

/** 读当前页的货款明细（一页） */
function readDetailPage() {
  return `(() => {
    const t = document.querySelector('table');
    if (!t) return { ok: false, error: '没找到明细表' };
    const rows = [...t.querySelectorAll('tr')].slice(1)
      .map(tr => [...tr.querySelectorAll('td')].map(x => (x.innerText || '').replace(/\\s+/g, ' ').trim()))
      .filter(r => r.length >= 6 && /^\\d{4}-\\d{2}-\\d{2}/.test(r[0] || ''));
    const num = (s) => {
      if (s == null) return null;
      const v = String(s).replace(/[,+\\s]/g, '');
      if (!/^-?\\d+(\\.\\d+)?$/.test(v)) return null;
      return Math.round(parseFloat(v) * 100);
    };
    const body = (document.body.innerText || '').replace(/\\s+/g, ' ');
    const totalM = body.match(/共有\\s*(\\d+)\\s*条/);
    return {
      ok: true,
      total: totalM ? parseInt(totalM[1], 10) : null,
      rows: rows.map(r => ({
        time: r[0],
        orderSn: r[1] === '-' ? null : r[1],
        bizType: r[2],              // 退款 / 其他 / 其他服务 …
        amount: num(r[3]),
        remark: r[4],
        desc: r[5],                 // "0020002 | 交易退款-订单退款"
      })),
    };
  })()`;
}

/** 点「下一页」；返回是否还有下一页 */
function clickNextPage() {
  return `(() => {
    const btns = [...document.querySelectorAll('button,a,li,div,span')]
      .filter(e => /下一页|next/i.test((e.innerText || '').trim()) || /next/i.test(String(e.className)));
    const b = btns.find(e => {
      const r = e.getBoundingClientRect();
      const dis = e.disabled || /disabled/i.test(String(e.className));
      return r.width > 8 && !dis;
    });
    if (!b) return { ok: false, reason: 'no next' };
    b.click();
    return { ok: true };
  })()`;
}

/** 切到「货款明细」页签 */
function clickDetailTab() {
  return `(async () => {
    const sleep = (ms) => new Promise(r => setTimeout(r, ms));
    for (let i = 0; i < 20; i++) {
      const els = [...document.querySelectorAll('div,span')]
        .filter(e => (e.innerText || '').trim() === '货款明细');
      const tab = els.find(e => String(e.className).indexOf('TAB_') >= 0);
      if (tab) { tab.click(); await sleep(2500); return { ok: true }; }
      await sleep(400);
    }
    return { ok: false, error: '找不到货款明细页签' };
  })()`;
}

/** 读资金限制列表（/pg/restrict_list）—— 资金被限制的原因和金额 */
function readRestrictions() {
  return `(async () => {
    const sleep = (ms) => new Promise(r => setTimeout(r, ms));
    // 这个函数在 mms 域执行（不是 cashier），所以先等 mms 的 SPA 渲染完
    let found = false;
    for (let i = 0; i < 60; i++) {
      for (const tb of document.querySelectorAll('table')) {
        const heads = [...tb.querySelectorAll('th')].map(x => (x.innerText || '').trim());
        if (heads.some(h => h.indexOf('限制原因') >= 0)) { found = true; break; }
      }
      if (found) break;
      // __mms 可用说明 mms 页面已经加载完
      await sleep(500);
    }
    if (!found) {
      return { ok: false, error: '限制表未出现', url: location.href.slice(0, 100),
               _head: (document.body.innerText || '').replace(/\\s+/g, ' ').slice(0, 200) };
    }
    await sleep(400);

    const out = [];
    for (const tb of document.querySelectorAll('table')) {
      const heads = [...tb.querySelectorAll('th')].map(x => (x.innerText || '').trim());
      if (!heads.some(h => h.indexOf('限制原因') >= 0)) continue;
      const rows = [...tb.querySelectorAll('tr')].slice(1)
        .map(tr => [...tr.querySelectorAll('td')].map(x => (x.innerText || '').replace(/\\s+/g, ' ').trim()))
        .filter(r => r.length >= 3 && r[0]);
      for (const r of rows) {
        const idx = (kw) => heads.findIndex(h => h.indexOf(kw) >= 0);
        const pick = (kw) => { const i = idx(kw); return i >= 0 ? r[i] : null; };
        const amountRaw = pick('限制金额') || '';
        const amtM = String(amountRaw).match(/([\\d.]+)\\s*元/);
        out.push({
          reason: pick('限制原因') || r[0],
          amount: amtM ? Math.round(parseFloat(amtM[1]) * 100) : null,
          amountRaw: amountRaw || null,
          detail: pick('限制金额说明') || pick('说明') || null,
          releaseCond: pick('解除限制条件') || pick('解除') || null,
        });
      }
    }
    const body = (document.body.innerText || '').replace(/\\s+/g, ' ');
    const m = body.match(/共查询到\\s*(\\d+)\\s*条/);
    return { ok: true, total: m ? parseInt(m[1], 10) : out.length, items: out };
  })()`;
}

module.exports = { readAccount, readMonthSummary, readBalance,
                   readDetailPage, clickNextPage, clickDetailTab,
                   readRestrictions };

