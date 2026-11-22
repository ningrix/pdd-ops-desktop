# AGENTS.md

> 本工作区的工程约定。**任何 agent 在动代码前必须读完。**
> 与用户当次明示冲突时，以用户为准，事后回写本文档。
>
> 最后更新：2026-11-21 ｜ 对应应用版本：v0.4（采集箱 + 跨店上架 + 资金复盘数据中心 + 平台锁）

**关于定位方式**：本文档一律用**函数名 / 选择器**指位置，不写行号。`main.js` 曾在六小时内从 635 行涨到 1096 行，行号第二天就会失效。

**并行协作前必读**：本仓库已初始化 git（baseline commit `725600c`）。多 agent 并行前先读 `C:\Users\56587\.workbuddy\plans\协作分工_lead与workbuddy_2026-11-17.md`。

---

## 0. 这个工作区在做什么

两条业务线，共享一个 Electron 桌面应用 `app/`：

- **A 线 · 上货优化** —— 把商品采集进本地池，优化标题 / 价格 / 图片 / 属性，再上架到任意店铺。
- **B 线 · 售后对账** —— 售后单分诊、申诉举证、拼多多账单核对。（设计中：`app/lib/aftersale/` 有实现，未接 IPC；售后接口与后台入口已实测，见 §3 与 `research/售后助手_可行性调查_2026-11-22.md`）

业务背景：拼多多鞋类 / 服装卖家。品类决定两个高频痛点——退货率高（尺码问题）、仅退款多。

**沟通原则**：用户不看概念，只问「能不能落地、成本多少」。少铺垫、给结论、附证据。

---

## 1. 硬约束（违反即返工）

### 1.1 渲染层

1. **禁止 `type="module"` / `import` / `export`。** 页面由 `loadFile()` 以 `file://` 加载，ES module 会被 CORS 阻止；`main.js` 里 `Menu.setApplicationMenu(null)` 清空了应用菜单，DevTools 进不去。**加载失败是静默白屏，没有任何报错。**
2. 多文件时每个文件整体包 IIFE，只向 `window.UI` 挂一个对象。经典 script 共享同一全局词法环境，**重名 `const` 是解析期 SyntaxError，整个文件不执行**。末尾断言命名空间齐全。
3. **`#pane-browser` 的任何祖先元素不得使用** `transform` / `filter` / `perspective` / `will-change` / `contain:paint` / `backdrop-filter`。这些会建立新的 containing block，`getBoundingClientRect()` 返回值随之变化，`setBounds()` 会把原生浏览器视图贴到错误位置。
   另：`main.js` 顶部已 `disableHardwareAcceleration()`，毛玻璃在软件渲染下又慢又脏。
4. **原生视图可见性唯一由 `syncBounds()` 决定。** 目标是引入 `state.suspendDepth` 计数器，`>0` 时强制隐藏。当前实现靠 `withViewHidden()` 布尔挂起，`resize` 时会被绕过（见 §8）。
5. **任何浮层不得覆盖 `#pane-browser` 的矩形**（toast / 下拉 / tooltip 都会被原生层遮住）。全局提示放顶栏。
6. **视图可见性与弹窗 Promise 必须解耦。** 不得让「用户点关闭」成为恢复视图的唯一路径。
7. **原生视图摘掉后必须显式把键盘焦点还给 HTML 层。** `WebContentsView` 是原生子视图，被点过就持有原生键盘焦点；`removeChildView` 之后主窗口的 `webContents` **不会**自动重新获得焦点。症状：弹窗里 input 是 `document.activeElement`，但 `document.hasFocus() === false` —— 鼠标能点、**键盘打不进字、也删不掉字**。
   修法：`main.js` 的 `detachView()` 与 `view:toggle(false)` 里调用 `focusMainWindow()`；渲染层每次弹窗打开调 `window.pdd.focusWindow()`，并用 `focusInput()` 等两帧后重试 `focus + select`。已实测（`Input.insertText` 走真实输入路径、逐字符 `dispatchKeyEvent`、退格）：修复前 `hasFocus:false`，修复后 `hasFocus:true` 且能打中文/能删。
8. 需要重排时用 `ResizeObserver` 而不是手工调 `scheduleSync()`——新加的工具条、页签行高变化都不会触发 `window.resize`。
9. **窗口顶部即标题栏。** `main.js` 的 `BrowserWindow` 用 `titleBarStyle: 'hidden'`，**不使用 `titleBarOverlay`**；窗口按钮由渲染层 `.win-controls` 自绘，通过 `window:action` IPC 控制最小化/最大化/关闭。`.topbar` 高度为 `--topbar-h`（40px），`.topbar` 可拖拽，`.win-controls` 及其按钮必须 `-webkit-app-region: no-drag`。**新增任何顶栏可点元素都必须补 `-webkit-app-region: no-drag`**，否则点击会被当成拖拽、按钮点不动。

### 1.2 平台操作红线

1. **提交上架、申诉提交、批量拦截一律不得自动执行**，必须人工确认。上架不可逆，申诉有次数限制。
2. **同店复制默认必须拦截。** `ops:copy` 要求显式 `allowSameStore`，这是有意设计——同店复制会产生重复链接，触发平台重复铺货判定。不得为了方便把它改成默认放行。
3. 批量任务必须有**全局互斥锁 + 看门狗**。无锁队列等于没有队列。
4. 超时 / 异常导致的**状态未知**，只允许「去后台核对」，**绝不重试**——那一刻远端草稿往往已经建好，重试就是第二条。
5. **不得声称能突破 8% 加价。** 这是平台规则，不是软件开关。利润从单买价与券结构来。
6. **不得把「加个水印 / 换个色调」当作避重手段**，平台图像指纹判定不看这个。
7. 拦截前必须校验两件事：货值是否高于「拦截费 + 退回运费」，包裹是否仍在派件前。
8. 复制前必须按 `goods_id` 校正列表下标，复制后必须比对返回的 `source.goods_id`。列表在下标之间可能已移位。

### 1.2.1 测试纪律（2026-11-19 立）

**所有会产生远端副作用的测试，只用测试号 阿泽高端made（mall_mwnplj3dewn）。**

- 布丁2 与 阿泽made 是真实店铺，**不得**在其上做任何发布/克隆/提交实验。
- 踩过的代价：当晚反复测试都在真实店铺上跑，其中一条 dryRun 在 布丁2 生成了草稿（已删）。
- 每次测试后**必须**清空测试号的草稿（draftsList → draftsDelete({ids})，注意参数是 ids 数组）。
- 测试前先查三个店的草稿数与在售数，作为基线；测完复核，确认真实店铺没有变化。

**店铺处罚状态会导致所有写操作失败**，错误码 **600011 店铺处于二级惩罚，不可编辑**。
遇到它不要怀疑代码，先确认目标店是否被处罚。实测：同一套代码在 阿泽made 报 600011，
在 布丁2 同一操作成功。

---

### 1.3 事实与数据

1. 涉及**平台规则、费用、接口是否存在、审核门槛**，一律先查官方资料再回答。**禁止凭印象推断。**
2. **查不到就说「未确认」，不许给近似答案事后纠正。** 这两条是本工作区已经付出过代价的：曾把「小程序测试号不支持云开发」当成可行、把「分享受限」误判成备案问题、把尺码表当成提交硬门槛。
3. 未确认项在代码注释与本文档里显式标注 `未确认：`。
4. **不引入需要原生编译的依赖**（`better-sqlite3` 等）。无构建步骤是硬前提，存储用 JSON / NDJSON。
5. **金额一律用「分」为单位的整数**，不用浮点。
6. 布尔字段表示「未知」时用 `null`，不用 `false`。

---

## 2. 代码地图

| 路径 | 职责 | 可改性 |
| --- | --- | --- |
| `app/main.js` | 窗口、店铺视图池、剩余 IPC、改价抓包（CDP）、跨店上架编排、session flush | 需用户明示，**只做增量**，不动既有 IPC 签名 |
| `app/ipc/` | 按域拆出的 IPC 注册。每个文件导出 `register(ctx)`，**不 require electron**，依赖由 `main.js` 在 `app.whenReady` 前显式注入。已拆：`risk` / `aftersale`（含 appeal）/ `finance-extra`（退货清单·费用·成本） | 可改；**新增 IPC 一律写到这里的对应域，不要往 main.js 堆** |
| `app/preload.js` | `contextBridge` 暴露 `window.pdd` | 需用户明示，新增只加不改 |
| `app/lib/ops.js` | 注入拼多多页面执行的业务 JS（**已实测跑通**） | **禁止重构** |
| `app/lib/pool.js` | 采集箱本地存储（增删查）；**读取时对 gallery 去重** | 可改 |
| `app/lib/batch.js` | 批量队列（串行 + 间隔 + 失败分类 + 断点续跑） | 可改 |
| `app/lib/orders.js` | 订单/售后接口注入脚本：`recentOrderList`（订单分页）、`afterSales/queryList`（售后单）。走 `window.__mms.fetch.sync` | 可改 |
| `app/lib/cashier.js` | 资金中心注入脚本。**只能读 DOM 表格**：cashier 是独立域，接口带 Anti-Content 动态签名，回放无效 | 可改 |
| `app/lib/finance-core.js` | 资金纯计算层：订单分页的终止/`orderSn` 去重/截断判定。零依赖，可离线断言（`work\test-finance.mjs`） | 可改 |
| `app/lib/xlsx.js` | 极简 XLSX 生成器：零依赖、store 方式打 zip、inlineStr 存文本。只用于导出，不改任何已有数据 | 可改 |
| `app/lib/returns-export.js` | 退货跟进表 → 二维数组（表头/列宽/分转元/是否完成留空）。纯函数零依赖，可离线断言（`test/test-returns-export.mjs`，10 条） | 可改 |
| `app/lib/aftersale-detail.js` | 售后详情页文本解析 + 分诊建议（`parseDetail` / `triage`）。纯函数零依赖，可离线断言（`work\test-aftersale-detail.mjs`，20 条） | 可改 |
| `app/lib/aftersale/` | B 线售后对账的设计实现（`triage` / `reconcile` / `appeal` / `model` + `fixtures`）。**尚未接进 IPC 与界面**，是设计稿落地 | 可改 |
| `app/lib/inspect.js` | 商品检测·规则层（纯 Node 零依赖，不读图） | 可改 |
| `app/lib/imgtool.js` | imgtool 的 Node 封装：spawn Python、下载图、失败分类 | 可改 |
| `tools/imgtool/` | Python 图像工具包（超分/水印/图像检测），见下 | 可改 |
| `app/renderer/index.html` | 界面结构（左侧导航：商品列表 / 采集箱 / 采集会话 / 资金复盘 / 店铺后台；左下日志/原始结果抽屉） | 可改，守 §1.1 |
| `app/renderer/style.css` | 样式（无框架、无预处理器） | 可改，守 §1.1 |
| `app/renderer/app.js` | 界面逻辑（单文件，全局 `$` / `state`） | 可改，守 §1.1 |
| `app/data/size-templates.json` | 尺码表模板库（6 套） | 可改 |
| `app/userdata/` | `malls.json`、`pool.json`、`Partitions/` 登录态；`finance\` 资金快照与账本；`risk\` 商品检测分包；`appeal\templates.json` 申诉文案库 | **不得删除**，删了要重新扫码 |
| `tools/` | CDP 抓包与调试脚本（`cdp_capture.py`、`pdd.py`、`pdd_price.py`） | 可改 |
| `work/` | 实验脚本与中间产物 | 任意，可丢弃 |
| `research/` | 研究结论，**是事实来源** | 只追加不覆盖 |
| `交付/`、`交付样张/` | 已交付成品图（70+ 张） | 只读 |
| `assets/`、`putian-ref/`、`putian-shoe/` | 原始素材与视频工程 | 只读 |

### 两条上货路径（不要混淆）

| 路径 | 入口 | 机制 | 适用 |
| --- | --- | --- | --- |
| **A · 同店复制** | 商品列表 → 复制 | 在源店里克隆一条新的 | 极少用。会产生重复链接，默认被 `ops:copy` 拦截 |
| **B · 采集箱跨店** | 商品列表 → 采集 → 采集箱 → 上架到当前店 | 采集到本地池，再从池里上架到另一家店 | **主路径** |
| **C · 空白新建** | `/goods/category`（侧栏「发布新商品」） | 上传主图 + 标题 → 平台自动识别类目 → 在完整表单里填规格/价格 | **无骨架依赖、无 600102、尺码可自定义**。已实测跑通到完整表单，见 `research/空白新建路线打通_2026-11-18.md` |

**路径 C 的前置能力（已实现）**：
- `main.js` 的 `setFileInputFiles()` —— 用 CDP `DOM.setFileInputFiles` 把本地图喂给 `<input type="file">`。**页面 JS 做不到这件事**（安全限制），这是空白新建能自动化的唯一前提。
- IPC `img:fetchToLocal`（下载图到本地）+ `img:setFileInput`（喂给页面）+ `debug:eval`（在生产同源上下文执行任意 JS，排查用）。


路径 B 的实现（`pool:publish`）：
切到目标店 → 找**同品类**骨架 → 克隆骨架成草稿 → 打开发货草稿编辑页 → **滚动到「规格与库存」等懒渲染** → DOM 改颜色 → DOM 勾尺码 → **点页面「保存草稿」（让页面自己生成 spec_id）** → 抓最终载荷覆盖标题/主图/价格/库存 → 按源商品有无尺码表决定「沿用」或「置 0」 → 保存 → 提交。

**硬限制**：
- 目标店必须**已有同品类在售商品**才能当骨架。空店、或没有同品类商品，都无法跨店上架。
- 同一个骨架不能连续克隆：`600102 该商品已被新建过` 是时间性限流（实测成功后 1 分钟内再克隆必拒）。所以按「最久未用优先」轮换（`lib/skeleton.js`）。
- **尺码分两类，处理方式不同**：
  - **标准码**（36~45、S/M/L 这类）→ `ops.scanAllSizeSystems` 遍历 7 种码制，选覆盖源最全的那个再 `ops.setSizes` 勾选。
  - **自定义码**（`parent_id=1226`，值如 `2（90-100）` 自由文本）→ **不在任何标准码制里，遍历必然全缺**。目前**未实现**，需要找页面上的自定义尺码输入入口（线索：曾见过 placeholder 为 `未使用模板` 的文本框）。

### 渲染层三条关键机制

- **原生视图定位**：`#pane-browser` 的 `getBoundingClientRect()` → `window.pdd.setBounds()` → `main.js` 的 `view.setBounds()`。只在 `tab==='browser' && visible && 有店铺` 时显示。
- **弹窗必须先摘视图**：`WebContentsView` 是原生层，永远盖在 HTML 之上。
- **注入执行**：`view.webContents.executeJavaScript(ops.xxx())`，走页面自己的 `window.__mms.fetch.sync`，与页面请求同指纹。**永不包装 `window.fetch`**，平台指纹会识破。

---

## 3. 已验证的事实（不要重验，也不要推翻）

| 能力 | 证据 | 结论 |
| --- | --- | --- |
| 复制成草稿 | `research/复制上架实测记录_2026-11.md` | 调试浏览器直连同店 3/3 成功；链路 `create_by_sn → copyGoodsCommit → rename → detail` |
| 改价 | `research/改价接口打通_2026-11.md` | `action/edit` 载荷回放通过。**从零拼字段会报 4000000，不要走那条路** |
| 提交上架 | `research/提交门槛纠正_2026-11.md`、`research/提交上架打通_2026-11.md` | **接口已通，实测成功**（`提交(206438982955): ok`）。⚠️ **`17000001 满2件折扣` 是误导性错误**：库存为 0 时平台会用它伪装，把库存补到 50 后该错误消失。真门槛是尺码表 `10000014` |
| 跨店上架 | `research/跨店上架完全打通_2026-11-18.md` | **全链路已打通**（源标题+主图+颜色+尺码+价格+提交，实测 36 SKU 成功）。关键是 DOM 改规格 + 页面保存 + 清空继承尺码表。详见 §2「路径 B」 |
| 跨店规格搬运机制 | 同上 | `action/edit` **静默丢弃** skus 变更（返回 ok，重载后不变）。必须：DOM 改颜色/尺码 → 点页面「保存草稿」让页面生成 spec_id → 再抓载荷改价格。规格区是**懒渲染**，不滚到视口根本不渲染 |
| 尺码表（跨店） | 同上 | 源商品 `size_spec_id` 为空 = 该类目不要求尺码表。骨架继承的旧表在改码后会冲突，报 `10000014`。解法：把 `size_spec_id` / `size_parent_spec_id` / `is_size_spec_sync_detail` 全部置 0 |
| 参考价规则 | 同上 | `1000161 规格单买价格必须小于参考价格` —— `market_price` 必须**严格大于**所有 SKU 的最大单买价，相等也会被拒 |
| 删草稿接口 | 实测 | `POST /glide/v2/mms/edit/commit/delete`，参数 `{goods_commit_id, goods_id}`，成功返回 `true` |
| 草稿列表接口 | 实测 | `POST /glide/v2/mms/query/commit/list`，**必须传 `length` + `start`**（不传报 `3000000 参数校验失败: length不能为空 & start不能为空`）。返回 `{total, list[]}` |
| 空白新建第1步 | `research/浏览器操控方案与空白新建实测_2026-11-18.md` | `/goods/category` → `setInputFiles` 传图 → 填**源商品真实标题**（测试标题会导致「暂无推荐的分类」）→ 点「下一步」→ 平台自动识别类目并建 commit。**点按钮要用 JS `el.click()`**，Playwright `click()` 会被遮罩卡在"等待稳定" |
| 「自定义尺码」= 尺码表列定义 | 同上 | `placeholder="自定义尺码"` 的输入框输入后出现的是 `肩宽/胸围/臀围/身高/体重/腰围` —— 那是尺码表 `elements`（列），**不是尺码值**。空白新建页的尺码值**只能从标准码表勾选**，没有自由入口 |
| 「全部尺码表」跳转 | 同上 | 点击会导航到 `/goods/size/list?classId=1&leafClassId=7`（尺码表管理页），不是模板弹窗 |
| 空白新建草稿不落库 | 同上 | 空白新建 URL 里的 `id` 只是会话内 commit；不点「保存草稿」不会进草稿箱（实测查 600001）。所以**空白新建不污染草稿箱**；克隆骨架才会 |
| 浏览器自动化层 | `work/pw_*.js` | **Playwright `connectOverCDP('http://127.0.0.1:9333')` 可直接接管本应用的浏览器**（登录态复用、不用重扫码）。`playwright-core@1.65.1` 纯 JS 无编译。分工：**调接口用 `ops.js`（走 `__mms`），点页面用 Playwright** |
| 采集会话登录态必须 flush | `main.js` 的 `before-quit` | **踩过的坑**：退出时只 flush 了店铺分区，采集会话（`persist:collector`）的 cookie 没落盘，每次重启都掉买家登录态，导致网页补图静默失败（0 张图）。已修为同时 flush `COLLECTOR_PARTITION` |
| 安卓模拟器 | `research/MuMu打通_拼多多运行正常_2026-11-18.md` | **MuMu 12 可用，BlueStacks 不可用**。MuMu：Android 15 / `arm64-v8a` / 伪装三星 SM-A5260 / `ro.kernel.qemu` 空 / 自动装到 D 盘。BlueStacks 默认实例是 Android 7 32 位（无 arm64），PDD 启动即崩在 `libhoudini.so` |
| APK 的 ABI 决定成败 | 同上 | MuMu **没有 `/system/lib/arm`**，只认 `arm64-v8a`。应用宝直链给的是 `armeabi-v7a`（8.32.0）→ `INSTALL_FAILED_NO_MATCHING_ABIS`。**MuMu 应用中心分发的 7.94.0 是 arm64，装上就能跑**。结论：从 MuMu 应用中心装，别自己找 APK |
| 消费者端登录墙 | 实测 | 拼多多 **未登录时把所有商品显示为「商品已售罄」，颜色/尺码/价格全部隐藏**。这不是风控，是登录墙。所以采集必须登录买家账号 |
| 网页端价格与规格是服务端打码 | 实测 | 桌面 UA / iPhone UA / 微信 UA / 安卓 UA + `Emulation.setDeviceMetricsOverride` 全部试过，结果一致：`minGroupPrice:"0"`、`skuProperty:[]`。`oakData` 全量搜索 0 处规格。**与 UA/设备模拟无关，换真 App 才有完整数据** |
| 消费者端搜索会被拦 | 实测 | `mobile.yangkeduo.com/search_result.html` 会跳到 `psnl_verification.html`（安全验证）。所以只能「有链接才能读」，不能在站内搜 |
| ADB 真人化 | `tools/adb-human.js` | `input tap` 是瞬时、精确到像素、间隔固定的操作，本身就是机器人特征。工具提供：元素框内随机偏移（避开边缘 18%）、微距 `swipe` 代替 tap（60~130ms 按下时长）、坐标 ±6px 抖动、对数正态延时（中位 1.6s）、分段变速滑动。**只能伪装行为层，深层指纹改不了** |
| BlueStacks 卸载 | `tools/清理BlueStacks残留.bat` | `C:\Program Files\BlueStacks_nxt` 与 HKLM 注册表**需要管理员**，本会话无法提权。数据目录（D:\BlueStacksData）与用户级注册表已直接删除。**卸载前必须先 `rmdir` 掉 `C:\ProgramData\BlueStacks_nxt` 这个目录联接**，否则会误删目标 |
| 尺码表接口 | `research/尺码表接口打通_2026-11.md` | `POST /glide/forward/cabernet/mms/sizespec/action/post`。body = `{content:{meta:{groups:[{id:1}],elements:[{id:N}]},records:[{values:{...}}]},status:0,class_id:N}`，每调一次生成新 spec id。绑定靠编辑载荷的 `size_spec_id` + `size_parent_spec_id`(=1226) + `is_size_spec_sync_detail`(=1) |
| 尺码表 class_id | 实测（1~12 全扫） | 按类目而定。运动羽绒服（cat 12508）= **5**。判断依据：只有正确 class 才会告诉你「缺哪个参数」，错误的只会回 `10000013 请选择该类目下正确的尺码表类型` |
| 尺码表参数 id | 实测 | `10004` = 推荐身高。**`体重(kg)` 的 id 未知**（10000~10049 已排除）。一张表最多 5 个参数，重复列会报「内容不完整」 |
| 平台互斥锁 | `main.js` 的 `withPlatform()` | 所有 `runInMall` / `saveDraftAndResolve` / `captureEditBody` 强制串行排队 + 超时看门狗。理由：`loadURL` 会抢视图、`webContents.debugger` 不能两处同时 attach |
| 采集箱 | `main.js` `pool:*` + `lib/pool.js` + `ops.collectGoods` | 采集 → 本地池 → 跨店上架已接成闭环 |
| 尺码匹配 | `main.js` `size:match` + `app/data/size-templates.json` | 支持「按商品尺码标签」优先，类目关键词兜底；返回 `bySizes` 标明命中方式 |
| 登录态持久 | `main.js` `before-quit` → `flushStorageData()` | 必须走正常关窗，强杀丢登录态。**启动/重启一律用 `tools/restart-app.ps1`**：它先请窗口自己关闭、等 `flushStorageData()` 完成，超时才降级强杀并警告。已实测：`taskkill /F` 会让两个店铺同时掉登录、Cookies 文件退化成 80 字节空壳 |
| 图像管线 | `交付/` 70+ 张成品 | 去标 / 去水印 / 4x 超分 / 白底；Real-ESRGAN + LaMa + RapidOCR，CPU 15–25s/张 |
| 图像工具包 | `tools/imgtool/`（Python）+ `app/lib/imgtool.js`（Node 封装） | **已跑通**：`upscale`（手写 RRDBNet，加载 RealESRGAN 权重 missing=0/unexpected=0）、`watermark`（corner/tile/band 三模式 + 自适应深浅色）、`inspect`（尺寸/比例/白底/居中/文字覆盖）。CLI 只往 stdout 写一行 JSON |
| 商品检测 | `app/lib/inspect.js` | **已跑通**：规则层纯 Node 零依赖。检查标题长度/堆砌/重复、SKU 价格逻辑、`market_price` 严格大于最高单买价（实测规则 1000161）、主图数量/重复、尺码表、类目。分 error/warn/info 三级，无官方依据的项标 `unconfirmed:true` |
| 图集去重 | `ops.collectGoods` + `lib/pool.js` | **平台返回的 `galleries` 本身带重复**（实测 21 项只有 11 个唯一 URL）。采集侧去重，读取侧再兜一层（旧数据也生效）。不去重会导致加水印重复处理、上架后主图重复图位 |
| 尺码是「自定义」不是标准码制 | 实测源商品 SKU spec | **很多商品的尺码是商家自定义的**：`parent_id=1226`（尺码）、`spec_id` 是该商品私有的、值是 `2（90-100）` 这类自由文本，**不在「通用/中国码/欧码/英码/德码/美码/均码」任一标准码制里**。所以「遍历 7 种码制找覆盖最好」对这类商品永远失败（缺码 = 全部）。正确方向：找页面上的「自定义尺码」输入入口（曾观测到一个 placeholder 为 `未使用模板` 的文本框），**未验证** |
| 骨架频控 | `lib/skeleton.js` | `600102 该商品已被新建过` 是**时间性限流**，实测：同一骨架克隆成功后 1 分钟再克隆就被拒。窗口期平台未公开。对策：记录每个骨架最近使用时间、按最久未用优先轮换；全失败时把每个骨架的「X 分钟前用过」列出来 |
| **跨店上架全链路已上架成功** | `research/跨店上架全链路_零上传_已上架成功_2026-11-20.md` | **从采集箱到真正在售，全程零上传**。实测：草稿 14→13、在售 3→4、goods_id 1031888820455。配方：①克隆骨架得草稿（图走 CDN）②DOM 删多余颜色行后填源颜色 ③勾欧码 ④**抓 `POST /glide/mms/goodsCommit/action/edit` 的完整 body（含全部 64 行 skus）**，在主进程改 `multi_price`/**`multi_price_in_yuan`**/`price`/**`price_in_yuan`**/`quantity_delta`，并把 `size_spec_id`/`size_parent_spec_id`/`is_size_spec_sync_detail` 置 0，⑤用页面 fetch + 抓来的 `anti-content` 头回放，⑥`POST /glide/v2/mms/edit/commit/submit` |
| 多颜色 SKU 表格只渲染一组 | 同上 | 64 个 SKU 的表格**只渲染第一个颜色组的 16 行**，另外三个颜色的行不在 DOM 里（没有页签/下拉/分页，「全屏编辑」也一样）。所以页面上填价格库存只对第一个颜色生效。**正解是走请求体回放**，不是点页面 |
| `__mms.fetch.sync` 在编辑页不可用 | 同上 | `Object.keys(window.__mms.fetch)` 里有 `sync`，但值是 **undefined**。所以 `ops.applyEditBody` / `ops.submitDraft` 在 `goods_add` 编辑页跑不了。改用「抓真实请求头 + 页面 fetch 回放」 |
| 价格参数必须成对改 | 同上 | 只改 `multi_price`/`price` 会报 `2000000 价格参数不一致`。`multi_price_in_yuan`/`price_in_yuan` 两个字符串字段必须同步 |
| 跨店路线零上传 | 测试号实测（2026-11-19） | **跨店上架全程不需要上传图片**：galleries 直接写源商品的 CDN 地址（`https://img.pddpic.com/...`），平台认。实测草稿里 13 张图全是 CDN 地址。对比之下**空白新建**的第一步强制上传主图，才会卡在上传上。所以「不想每次传图」的正解是走跨店，不是修上传 |
| 空白新建上传受阻 | 同日实测 | 主图区已改版为三个按钮（图片空间上传 / 本地上传 / AI智能做图），不再是单一隐藏 input。点「本地上传」+ filechooser 能读到文件（产生 blob 请求），但上传管线静默中止，计数始终 (0/10)，无报错。**未确认是否与店铺处罚有关**，先在测试号复核 |
| 骨架预分配 | `lib/skeleton.js` 的 `plan()` + `main.js` 的 `preassignSkeletons()` | **采集完就把「能上架到哪些店、用哪个骨架」算好存进采集箱条目**（`skeletonPlans`），上架时直接用，不再现场拉 `listGoods`。三个好处：① 没骨架的问题从「上架时」提前到「采集时」；② 省掉每次几秒到几十秒的清单拉取；③ 批量不会再跑到第 N 个才炸。店铺商品清单缓存 10 分钟（`skeleton-cache.json`）。**类目来源**：App 端拿不到类目，网页端才有；但网页登录与模拟器登录互相踢，所以自己店之间搬家时**从源店的商品清单反查 `cat_id`**（`sourceMallId`+`sourceGoodsId` → `cat_id`）。界面「骨架」列显示 ✓可上 / ⏳冷却中 / ✗无同类骨架 |
| 骨架需有颜色规格 | `ops.listGoods` 的 `colors/colorCount` | 改颜色是在页面**已有的**颜色输入框里填值。骨架本身没有颜色规格时页面上没有输入框可填，颜色必然设不进去（实测：骨架 0 个颜色框 / 源 5 个颜色）。所以源有颜色时优先挑 `colorCount > 0` 的骨架 |
| 注入脚本语法校验 | `tools/check-injections.js` | `ops.js` 用模板字面量拼注入代码。拼错了 Electron 只回一句 "Script failed to execute"，看不出哪错。这个脚本用 `vm.Script` 编译全部注入脚本并打印出错行。**已踩过的坑**：在模板字面量里写注释，注释里的 `\n` 变成真实换行截断注释，后半句变成代码 → 整体语法错误 |
| 异常转文本 | `main.js` 的 `errText()` | Electron 的 `executeJavaScript` 在页面抛非 Error 值时 reject 出的是普通对象，`String(e)` 得到 `[object Object]`，真实原因全丢。必须用 `errText()` 递归取 `error`/`message`/`reason`/JSON |
| Python 环境 | 本机 | Pillow **必须 ≥ 11**：9.5.0 在这个环境下 `draw.text()` 直接崩 `0xC0000005`（ACCESS_VIOLATION）。`simple-lama-inpainting` 已卸载（它要求 pillow<10，会把版本拖回去；LaMa 预处理我们手写） |
| 三档定价 | `research/验证A_加价上限结论_2026-11.md` | 拼单价钳 1.08、单买价放开、市场价 > 单买价。多家厂商官方文档交叉印证 |
| 基础技术服务费 | 拼多多 2024 公告（媒体转述） | (实付 + 平台优惠) × 0.6%；先用后付同为 0.6%；2024-09-24 后退款订单自动退回 |
| 黑标技术服务费 | 同上 | 仅黑标商品，类目差异化费率（服饰 2.2%）；同单取最高费率不重复扣 |
| 物流拦截机制 | 官方《物流拦截技术支持服务规则》`mms.pinduoduo.com/other/rule?id=1616` | 仅派件前有效；到驿站/已签收必失败；拦截成功自动退款；退回运费商家承担；拦截账户余额**不可提现** |
| 错误码字典 | `app/renderer/app.js` 的 `runCopy` / `publishFromPool` | `600102` 已复制过 / `17000001` 满2件折扣 / `10000014` 尺码表 / `3000000` 参数不合法 / `600001` 编辑记录不存在 |
| 订单列表接口 | 实测（`app/lib/orders.js`） | `POST /mangkhut/mms/recentOrderList`，body 用 `orderType` / `afterSaleType` / `groupStartTime` / `groupEndTime` / `pageNumber` / `pageSize` / `sortType`。返回 `{totalItemNum, pageItems, hasMore}`。**`pageSize>20` 报 `1000 单页数据量过大或非法`**。字段：`order_sn` / `order_time` / `goods_id` / `goods_name` / `spec` / `goods_number` / `goods_price` / `order_amount` / `after_sales_status` / `order_status_str` / `tracking_number` |
| 订单筛选组合 | 实测 | `orderType=0 & afterSaleType=0` 才是「全部订单」（阿泽made 实测 180 单）。`orderType=2 & afterSaleType=1` 只给 12 单，会漏 |
| 售后列表接口 | 实测（`app/lib/orders.js`） | `POST /mercury/mms/afterSales/queryList`，body 用 `pageSize` / `pageNumber` / `quickSearchType` / `orderByCreatedAtDesc`。返回**裸对象** `{total, list}`，**没有 `success`/`result` 外壳**（与订单接口不同）。字段：`afterSalesType` / `afterSalesTypeName` / `afterSalesStatus` / `refundAmount` / `orderSn` / `goodsName` / `goodsNumber` / `afterSalesReasonDesc` / `reverseTrackingNumber` / `reverseShippingId` |
| 售后 `quickSearchType` 矩阵 | 实测（1~25 全扫） | 只有 `2` / `4` / `7` / `8` / `18` 有效，其余报 `2 参数校验失败`。且**只返回待处理售后**，拿不到已完成的历史退款单 |
| 已完成退款怎么判 | 实测 | 售后接口取不到，只能看订单的 `order_status_str` 是否含「退款成功」。实测 181 单，与 `after_sales_status=5` 一一对应 |
| 退货物流轨迹与签收 | 实测（`finance:returnTrace`） | **已完成售后也能查**。关键：`queryList` **不带 `quickSearchType`** 时返回全部售后（含 `afterSalesStatus=5` 已完成，阿泽made 实测 139 条，其中退货退款 83 条）；带 2/4/7/8/18 只是「待处理」筛选。拿到 `id` 后打开 `https://mms.pinduoduo.com/aftersales-ssr/detail?id=<afterSalesId>&orderSn=<orderSn>`，「物流轨迹 → 退货物流」区块含快递公司/退货单号/最新节点/签收措辞。**未发货退款、退款（非退货）本来就没有退货包裹，标「无需退货」，不算风险**。签收判据：已签收/已取件/已放入/已放在/已放至/已代收/代收点/本人签收/已投递/已送达/已妥投/经客户同意。实测 117 条退货退款：94 条有轨迹、32 条已签收、23 条无轨迹，约 7 秒/单 |
| 资金中心只能读 DOM | 实测（`app/lib/cashier.js`） | `cashier.pinduoduo.com` 是独立域，接口带 Anti-Content 动态签名，**回放无效**。只能读页面表格里平台已算好的数 |
| 资金采集不能劫持店铺视图 | 实测 | 布丁2 停在 `goods/goods_add` 编辑页时，`loadURL` 会被该页的 `beforeunload` 拦住（28 秒仍停在原页）。所以 `finance:collect` / `finance:orders` 都改用 `createHiddenMallWindow()` 独立隐藏窗口采集 |
| 退货率口径 | 实测 + 代码约定 | **退货率 = 退货事件单数 ÷ 成交单数**。分子按 `orderSn` 去重（`returnEvents`，一单只记一次，不得把「退款/在途/仅退款」三个计数器相加）；分母 = 全部订单 − 已取消。退货事件 = 退款成功 ∪ 在途退货退款 ∪ 仅退款 |
| 退款对获利的影响 | 实测 + 代码约定 | 退款 / 在途退货 / 取消 **不计实收、不计销量、不计拿货成本**（货退回可回收）；**仅退款计拿货成本**（货损）；换货正常计入并单独计数 |
| 账单平台费口径 | 实测 | 资金明细里的「技术服务费 / 其他服务」是真实扣费。但明细目前只覆盖账单里出现的日期（实测只有当天），**不能把 1 天的每单均值外推到 90 天**：账单日期内用账单均值，其余日期回退 `实收 × 0.6%` 估算，两者分别累加 |
| 商品检测接口 | 实测（`main.js` 的 `risk:goodsCheck`） | 打开发起店 `/kit/freebie`，再 `POST /bordeaux/mms/gift/query_event_goods_list`，body `{page, size}`。返回 `goods_display_info_list`；`can_enroll_event === 0` 即「被判定」。字段：`goods_id` / `goods_name` / `hd_thumb_url` / `quantity` / `cant_enroll_reason` |
| 商品检测结果落盘 | 实现约定 | **按店铺分包**：`app/userdata/risk/store-<mallId>.json` 每店一个商品包（含 `thumb` 图片地址），`index.json` 记 `lastRunAt` 与各店 `flaggedCount`。某店本次读失败时**保留旧包并标 `stale`**，不冲成空 |
| 售后三窗口 | research/申诉文案管理_调研_2026-11-21.md | 驳回申请 **36h** 内自主处理（2025-04 售后服务规则更新）；平台介入退款成功后 **48h** 维权申诉（客服考试题+黑猫被拒案例多源佐证；场景差异未确认，以页面提示为准）；处罚申诉走**站内信申诉链接**。`appeal.js` 只覆盖窗口②，驳回文案是最大缺口 |
| 申诉权监管 | 《网络交易平台规则监督管理办法》2026-02-01 施行（[新华网全文](https://app.xinhuanet.com/news/article.html?articleId=1edebf752c62b29b4263c2895cf2eb88)），第十九条保障商家申诉权、禁止强制仅退款；2026-10 海淀首例限制申诉权执法案 | 商家申诉权有法可依；申诉文案可引用规则名称与条款号（截图须含规则名/公示日/生效日） |
| 售后工作台路由有守卫 | 实测（`research/售后助手_可行性调查_2026-11-22.md`） | `loadURL('.../aftersales/aftersale_list')` 会被重定向到 `/aftersales/setup?tab=3`。必须先进 setup，再点「退款/售后」标签才落到列表。`?tab=N` 不是标签索引，别用 |
| 售后单详情深链 | 实测 | `https://mms.pinduoduo.com/aftersales-ssr/detail?id=<afterSalesId>&orderSn=<orderSn>` 能直接打开指定单。**必须在对应店铺的 partition 里打开**，否则只有壳没有数据 |
| 售后详情字段全集 | 实测（售后编码 23943351945178） | 售后编码 / 售后类型 / 退款金额 / 申请原因 / 发货物流公司+单号 / 退货快递单号 / 聊天图片 / 订单号+成团时间 / 退货包运费补偿 / 商品名+规格 / 共N件+共优惠+实收 / 收货信息（脱敏）/ 物流轨迹（发货·退货双 Tab）/ 售后状态 / **倒计时原文**（如「超过 5天10时33分32秒 则申请达成并自动为买家退款；若期间退货被签收则 24 小时内处理」）/ 协商详情时间轴 / 聊天记录 |
| 售后详情可用操作 | 实测 | 同意退款 / 驳回退款（`<span onclick>`，不是 `<a>`）/ 添加留言·上传凭证 / 在线联系消费者 / **一键申请平台保护**（本周剩余次数，如 3 次）/ 举报恶意售后 / 添加备注 |
| 售后申诉页 | 实测 | `/orders/appeals/aftersale/order`。6 个 Tab：可申诉订单 / 申诉记录 / 维权申诉 / 订单赔偿申诉 / 极速退款申诉 / 极速换货申诉。列含**申诉倒计时**。原文规则：申诉失败次数不限，但「利用插件、外挂或第三方工具发起批量无效申诉」可能被暂停申诉；**本月申诉复议权益 0/6**；有「不展示『暂不申诉』和『低通过率』订单」开关——**平台自己在做通过率预判**，分诊应复用这个信号 |
| 异常单申诉表单 | 实测 | `/orders/appeals/badOrder`。三种类型：异常订单不发货 / 延后发货 / 物流拦截并取消。字段：申诉类型 + 申诉原因（下拉）+ **凭证图片（最多 5 张，单张 ≤5M）** + 申诉描述。审核工作日 10:00–21:00，周期 24h。**所以申诉产出形态是「文本 + 图片清单」，不是纯文本** |
| 平台自带售后自动化 | 实测 | 侧栏有「售后小助手」（`/aftersales/aftersale_auto/home`）与「逾期自动同意退款」（站内信实测出现过「因逾期未处理已自动同意退款」）。我们的助手**不抢这些动作**，只做分诊 + 文案 + 倒计时 |
| 售后入口清单 | 实测（首页侧栏） | 售后工作台 `/aftersales/aftersale_list`、工单管理 `/aftersales/work_order/list`（待处理/2小时内将逾期/处理中/违规已处理）、商家举证 `/aftersales/merchant_appeal`（**重定向到 `/orders/list`**，非独立页）、极速退款 `/aftersales/speed_refund`、降退款督导 `/aftersales/supervisor`、拦截快递 `/orders/interceptExpress`、挽单工具 `/kit/retain-order` |
| 售后详情读取耗时 | 实测（`aftersale:detail`） | 隐藏窗口 + 深链，**约 1.8~2 秒/单**（比 `finance:returnTrace` 的 7 秒快，因为它只等「售后编码」出现，不等「退货物流」）。分诊 8 单约 16 秒 |
| 售后详情解析要点 | 实测（`lib/aftersale-detail.js`） | 倒计时原文「超过 5天10时33分32秒 则申请达成…」可解析成秒；「退货被签收则 N 小时内处理」可解析出 N；「本周剩余申请次数为 N 次」= 平台保护剩余。**售后状态必须只在「售后状态」标签之后匹配**，否则会先命中「售后类型：退货退款待商家处理」里的「待商家处理」 |
| 退货状态标签口径 | 实现约定 | `needReturn = /退货/.test(typeName)`。未发货退款 / 仅退款 / 换货 → **无退货包裹**（本来就没有退货，谈不上签收）；退货退款已签收 → **已签收 · 注意查收** + 附退货物流（快递公司 + 单号）；需退货但无轨迹 → 未签收；已完成但没抓过物流 → **未抓签收**（不猜） |
| 售后分诊优先级 | 实现约定（`triage()`） | ① 倒计时 ≤24h → 先处理；② 质量/破损/描述不符 → 需举证；③ 尺码/不喜欢/拍错 → 建议同意（驳回难赢，省复议额度）；④ 已签收 → 核对后同意；⑤ 需退货无轨迹 → 等物流；⑥ 待寄货 ≥3 天 → 催寄；⑦ 无退货包裹 → 按仅退款规则。**主观原因优先于物流状态**：驳回本来就赢不了，不该因为「没轨迹」而拖着 |
| 网页打单依赖本机打印组件 | 实测（2026-11-22） | 打单页 JS 里写死 `ws://localhost:5000`（首发）→ 失败后 `wss://localhost:18653`（重试）。**这两个端口没监听就弹「由于浏览器异常导致无法连接打印组件，请使用商家客户端」**。本机实测 5000 / 18653 均拒绝连接 → 网页打单不可用。与 UA、Electron 无关 |
| 打单页面路由 | 实测 | 打单中心 = `https://mms.pinduoduo.com/print/order/list`（待发货订单）；首页 `/print/home`。左侧导航「打单工具5 → /print/home」 |
| 商家客户端自带打印 | 实测 | 已装「拼多多商家工作台 3.7.4」（`C:\Program Files (x86)\pinduoduo\3.7.4.6\PddWorkbench.exe`，CEF 内核）自己打印，**不监听 5000/18653**。`PddService.exe` 监听 127.0.0.1:16482 / 16582，是客户端自己的 IPC，不是浏览器打印桥 |
| 改 UA 会踢登录 | 实测（2026-11-22） | 把内嵌视图 UA 写死成干净 Chrome（去掉 `Electron/` 与 `pdd-ops-desktop/`）后，**阿泽made 当场掉登录**，回滚 UA 也不会自动恢复——会话已被服务端作废。**UA 参与平台会话指纹，不要为了「看起来像真浏览器」去改它** |
| 退货导出用 xlsx 不用 CSV | 实现约定（2026-11-22） | 订单号是 18 位长数字，CSV 用 Excel 打开会被转成科学计数法（2.61111E+20），对账就没法用。xlsx 里按 inlineStr 存才能保住原样。生成器零依赖（`app/lib/xlsx.js`），不引入原生编译库。**「是否完成」列已完成写「是」，未完成必须留空**，不写「未完成」 |
| 导出不弹系统「另存为」 | 实测（2026-11-22） | 这台机器上文件对话框会在 Documents 报「你没有权限在此位置中保存文件」，但同一目录用 Python 写是成功的 —— 是对话框/系统保护在挡，不是文件系统。Electron 进程对 `~/Downloads`、`~/Documents` 的写探针也都失败。所以 `returns:export` **不弹对话框**：`pickExportDir()` 依次探测 `app.getPath('downloads')` → `~/Downloads` → `app/userdata/exports`，取第一个真能写的；写完后 `shell.showItemInFolder()` 打开文件夹 |

---

## 4. 明确的未知（不许当成已知）

| 未知项 | 影响什么 | 怎么验证 |
| --- | --- | --- |
| 1.08 钳制在「同店复制」通道是否生效 | 定价引擎是否必须内置钳制 | 跑 `work/pdd_price_probe.js`（只建草稿不提交） |
| 售后 / 拦截单 / 对账中心的 API 端点 | B 线是真自动还是半自动 | `tools/cdp_capture.py` 抓包 |
| `quantity_delta` 语义（增量还是绝对值） | 能否做改库存 | 抓包后看草稿态是否回显 |
| 图片上传接口 | 图片自动替换的工作量是否翻倍 | 抓编辑页上传请求 |
| 申诉次数限制的具体规则 | 申诉模块的护栏强度 | 官方文档未见，只能从实操累积 |
| 售后申诉入口表单字段（48h 时限已多源佐证，见 §3 售后三窗口） | 文案产出的形态（纯文本 or 文本+附件清单）；triage 倒计时精度 | 在本店售后详情页实测申诉入口（只看不提交） |
| **驳回退款表单字段** | 驳回文案能填多长、要不要选原因、能不能传图 | 详情页点「驳回退款」（实测是 `<span onclick>`，点后未出现 textarea/radio，可能需滚动到视口或走另一渲染通道）。**未拿到表单结构** |
| **添加留言/上传凭证表单字段** | 举证材料怎么提交 | 同上，未点开 |
| **售后工作台列表接口** | 能否不读 DOM 直接拿 16 条待处理 | 页面走客户端渲染，未抓到 XHR；目前只能读 DOM 或复用 `afterSales/queryList` |
| **申诉「低通过率」判定规则** | 分诊能否直接复用这个信号 | 平台未公开，只能观察哪些单被标 |
| **本月申诉复议 6 次的重置周期** | 复议额度会不会被月底清零 | 页面只显示「本月 0/6」 |
| **「售后小助手」自动化范围** | 是否已经自动处理了部分售后，我们该不该重复做 | 打开后只见同一套标签壳，未见配置项 |
| 处罚申诉统一时限 | 处罚申诉倒计时 | 以站内信处罚通知为准，实测累积 |
| 「申诉优赔」覆盖范围（平台主动赔付哪些异常退款） | 异常退款场景是否还需要商家写申诉文案 | 观察自己店的异常退款单是否被平台主动赔付（2025 新服务，见 research/申诉文案管理_调研_2026-11-21.md） |
| 跨店上架后平台是否判「搬运」 | 路径 B 的长期可行性 | 小批量试，观察是否限流 |

**降级路径**：端点抓不到就走「页面导出 Excel/CSV → 本地解析」。逻辑不变，只损失自动化，不损失分析能力。

---

## 5. 失败分类（写任务状态时必须遵守）

```
queued → running → done
                 ├→ failed_known    确定失败，可重试
                 └→ failed_unknown  状态未知，只允许人工核对
```

- **`failed_known`**：接口明确返回业务错误（`600102` / `3000000` 等），且失败发生在**创建之前**。
- **`failed_unknown`**：超时、异常、只走到一半。此时远端资产**可能已存在**。

> 把两者合并成一个 `failed`，批量任务就会自己造重复草稿。
> 这是本项目最贵的一条教训，不要重犯。

---

## 6. 数据结构约定

```js
// 采集箱条目（lib/pool.js，落盘 app/userdata/pool.json）
PoolItem {
  id, createdAt,
  title, catId, catNames[], price, sizes[],
  skus[], gallery[], thumb,
  sourceMallId, sourceMallName, sourceGoodsId
}
// 去重规则：同一 sourceMallId + sourceGoodsId 只保留一条，重复采集是覆盖不是新增

// 售后单（B 线，未实现）
AftersaleOrder {
  asn, orderSn, mallId, goodsId, goodsName, skuSpec,
  type: refund_only | return_refund | exchange,
  reason, amount,                  // 金额单位：分
  createdAt, deadlineAt,           // 分诊排序第一键
  status: pending_merchant | pending_buyer_ship | pending_receive
        | refunded | closed | appealing,
  refundedAt, serviceFeeRefunded,  // null = 未知，不是 false
  intercept: { state: none|requested|success|failed|unsupported, fee, at },
  returnShip: { company, trackingNo, shippedAt, signedAt, received },
  risk: money_goods_lost | in_transit | safe | closed,
  appeal: { state: none|drafted|submitted|won|lost, at, evidenceMissing[] }
}

// 对账条目（B 线，未实现）
BillEntry {
  date, orderSn, category, amount, traceable
  // base_tech_fee | black_label_fee | freight_insurance
  // | refund | coupon_seller | subsidy | ad_spend
  // ad_spend 的 traceable 恒为 false
}

// 批量任务（lib/batch.js，落盘 app/userdata/batch.json）—— 已实现
BatchTask {
  poolId, title, mallId,
  state: queued | running | done | failed_known | failed_unknown,
  attempts, errorCode, errorMsg,
  goodsId, commitId, startedAt, endedAt
}
// 商品检测结果（落盘 app/userdata/risk/，每店一个商品包）—— 已实现
RiskPackage {                      // risk/store-<mallId>.json
  mallId, mallName,
  at, lastTryAt,                   // at = 数据时间；lastTryAt = 最近一次尝试
  total,                           // 该店商品总数
  flagged: [{ goodsId, goodsName, thumb, quantity, reason }],
  error,                           // null = 本次读取成功
  stale                            // true = 本次没读到，保留的是旧包
}
RiskIndex {                        // risk/index.json
  version, lastRunAt,
  stores: [{ mallId, mallName, file, at, total, flaggedCount, error, stale }]
}
// 读取用 risk:last，形状与 risk:goodsCheck 一致，渲染层不分叉；
// 渲染层用 fromCache 区分「上次检测」与「检测于」。

// 申诉文案（app/userdata/appeal/templates.json，数组）—— 已实现
AppealTemplate {
  id, scene,                       // scene 见 main.js 的 APPEAL_SCENES（8 类）
  kind: reject | evidence | appeal, // 驳回退款 / 举证留言 / 维权申诉
  title, body,                     // body 支持占位符 {orderSn} {amount} {returnSn} {days}
  evidence: [string],              // 举证清单，一行一项
  builtin,                         // true = 内置骨架，可编辑不可当新建
  uses, won, lost,                 // 使用次数与结果回写，按胜率排序
  createdAt, updatedAt, lastUsedAt
}
// 文案库只产出文本，绝不自动提交。渲染层每组默认只渲染 3 条（一条 ≈80 DOM 节点）。

// 售后分诊（app/userdata/aftersale/triage.json）—— 已实现
TriageRow {
  mallId, mallName, afterSalesId, orderSn, goodsName, thumbUrl,
  typeName, platformStatus,          // 10 待消费者寄货 / 11 待商家确认收货
  refundAmount, days, needReturn,
  detailOk, detailError,             // 详情读没读到
  statusText, reason,                // 从详情页解析
  countdownSec,                      // 「超过 X 天X时X分X秒 则申请达成」→ 秒
  signedDeadlineHours,               // 「退货被签收则 N 小时内处理」
  protectLeft, hasChatImages, returnSn, shipCarrier,
  advice, adviceText, adviceLevel    // urgent | act | wait | skip
}
// 按 countdownSec 升序（null 排最后）。未读到的单也出行，advice=unknown，不藏。
// 三页签内容不同时留在 DOM：全渲染实测 1260 节点超预算，切走即清空、切回按 state 重建。
```

三条铁律：

1. **表示「未知」用 `null`，不要用 `false`。** 把「没发生」和「还不知道」混成一个值，对账必然算错。
2. **推广费（`ad_spend`）在平台账单里是日汇总，物理上无法追溯到单笔订单。** 任何声称能精确对到单的实现都是错的。只能按日分摊。
3. **金额单位一律是分。**

---

## 7. 改动前先问自己

| 想做的事 | 先确认 |
| --- | --- |
| 改 `main.js` / `preload.js` | 用户是否明示？只做增量，不动既有 IPC 签名 |
| 改 `lib/ops.js` | 是否有实测脚本能验证？没有就不要动 |
| 删 `app/userdata/` 下任何东西 | 会丢登录态与采集箱，需用户确认 |
| 加依赖 | 是否需要原生编译？需要则换方案 |
| 声称某个平台能力可行 | 官方资料在哪？没有就说「未确认」 |
| 加需要覆盖 `#pane-browser` 的 UI | 会被原生层遮住，换位置 |
| 把同店复制的拦截去掉 | 会产生重复链接，触平台重复铺货 |

---

## 8. 现存缺陷（截至本次核实）

**已修**：
- `openCopyDialog()` 会重置 `#copyPublish`；`#copyOk` 完成后 `onclick` 改为 `close`
- `#copyFactor` 加了 `input/change/keyup` 监听，改倍数时价格预览实时更新
- `copyGoods` / `collectGoods` 改为**按 `goods_id` 精确认商品**（`goodsId` 参数），不再依赖列表下标；找不到就明确报错
- 两个批量前置缺陷已清除，批量队列已启用
- `refreshStatus()` 改为并发检测 + 状态缓存：单店 IPC 异常不再中断整轮；`refreshMalls` 重绘时灯不再闪回灰色；页面导航/加载期间不会把健康店铺误报成红色离线
- 左侧导航收纳「商品列表/采集箱/采集会话/资金复盘/店铺后台」五个页签；顶栏只保留品牌和刷新/主题；原「显示浏览器」与「店铺后台」重复，已移除，店铺后台页签即控制原生视图
- 顶栏右侧控件只保留刷新与主题；主题切换改为瞬时切换（不再做整页颜色过渡），只在主题按钮内做小圆圈扩散，避免软渲染下的割裂/白屏
- 采集箱改为紧凑行（30px 缩略图、4px 行距、操作按钮单行），日志和原始结果一起收进左下角抽屉，`#log` / `#resultBox` 保留在 DOM 中供 agent 直接读取
- 左侧栏宽度 248px；店铺后台 `WebContentsView` 默认 `MALL_ZOOM = 0.7`（每次 `did-finish-load` 重新应用，避免跨子域失效）
- 桌面快捷方式与应用窗口使用 `app/assets/icons/app.ico`（图标源文件 `app-icon.svg`，多尺寸 ICO 由 `work/make_app_icon.py` 生成）
- **上架安全（2026-11-21）**：`poolPublishImpl` 抓不到最终载荷时不再继续 `submitDraft`，改报 `failed_unknown` 并停止 —— 否则会把骨架的标题/图/价格提交上架
- **失败分类（2026-11-21）**：编辑页打不开、颜色没设对、尺码没配齐三处改为先 `discardDraftOrUnknown()` 删掉刚克隆的草稿；删净报 `failed_known`、删不掉报 `failed_unknown` —— 避免批量重试再克隆一条
- **退货率（2026-11-21）**：分子改用 `returnEvents` 一单只记一次，不再把「退款/在途/仅退款」三个计数器相加；取消单不再算进有效单
- **时区（2026-11-21）**：新增 `financeMonth()`，资金快照与月度汇总不再用 `toISOString().slice(0,7)`（UTC 月份，每月 1 日 00:00–08:00 会算成上个月）
- **账单平台费（2026-11-21）**：按日期分段 —— 账单覆盖的日期用账单均值，其余日期回退费率估算，不再把 1 天的每单均值外推到 90 天
- **DOM 预算（2026-11-21）**：商品贡献表的折叠区改为懒渲染（收起时不建 DOM），资金页满数据从 2803 节点降到 1612
- **CSS 变量（2026-11-21）**：补上 `--panel2` / `--income` / `--loss`；浅色主题绿/红/小字/琥珀对比度从 2.00/3.32/3.48 提升到 5.37/5.44/5.73/5.27，全部过 WCAG AA

**仍在**：

| 缺陷 | 位置 | 后果 |
| --- | --- | --- |
| 复制完成后「再复制一条」按钮实际执行 `close` | `app.js` 的 `openCopyDialog` 内 `#copyOk.onclick` 尾段 | 文案与行为不符，点了只会关闭 |
| `withViewHidden()` 用局部布尔挂起视图，且 `finally` 无条件恢复 | `app.js` 与 `syncBounds` | 弹窗开着时拖窗口 / 切页签 → 原生视图压回弹窗上；快速双击「添加店铺」可使视图永久隐藏 |
| 删除店铺用 `window.confirm()` | `app.js` 的 `refreshMalls` 内点击处理 | 原生模态冻结界面，无法做输入店铺名确认 |
| `listGoods` 硬编码取 30 条，`total` 未显示 | `main.js` `ops:list` / `app.js` | 用户以为看到全部，实际只有前 30 条 |
| 日志时间戳源不一致 | `main.js` 的 `log()` 已改本地时间；`trace()` 仍是 UTC | 日志框正常，trace 文件里是 UTC |
| 上架库存默认 50 | `app.js` 调 `publish` / 批量参数 | 单件上架仍用 50；批量可在界面配置 |
| 跨店价格统一用源最低拼单价 | `main.js` 的 `pool:publish` 价格覆盖段 | 源的逐 SKU 差价没搬过来 |
| 跨店详情图未覆盖 | 同上 | 只换了主图（`galleries`），`decorationDetail` 仍是骨架的 |
| 采集箱里 6 条旧条目的 `sourceMallId` 指向已删除的旧店铺 | `app/userdata/pool.json` | 跨店判断时同店比较会失效；可手动移除这些条目 |

---

## 9. 文档维护

- 未确认项一旦验证，从 §4 移到 §3，并附证据文件路径。
- 代码改动触及 §1 / §5 / §6 时，**同一次改动内更新本文档**。
- 本文档只写**约束与事实**，不写计划、路线图、待办。计划放 `C:\Users\56587\.workbuddy\plans\`。
- 新增约束时写清楚「为什么」，否则下一个人会当成教条绕过它。
- **不要写行号。** 用函数名、选择器、IPC 通道名定位。
