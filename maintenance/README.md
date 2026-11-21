# 维护台账

## 为什么有这个目录

这个项目的自动化点全部依赖拼多多页面的 DOM 结构和请求形状。平台改版一次，
对应的注入函数就失效一次 —— 这不是意外，是这类代码的**常态成本**。

之前只有一句「上传区改版后 6 小时失效」的散点，给不出任何频率数字。
想回答「我们多久要修一次」「平均修多久」「哪块最脆」，只能记账。

## 记什么

每失效一次记一行，追加到 `log.jsonl`。**不追求全，只要求真** ——
不确定的字段填 `null`，不要估。

```json
{"date":"2026-11-21","domain":"finance","target":"lib/cashier.js · readDailySummary",
 "symptom":"日汇总的日期列只有 MM-DD，跨年时年份错",
 "cause":"platform-change","detectedBy":"manual","fixMin":25,"commit":null,
 "note":"用「选择月份」输入框补年份"}
```

| 字段 | 取值 | 说明 |
| --- | --- | --- |
| `date` | `YYYY-MM-DD` | 发现失效的日期 |
| `domain` | `upload` / `publish` / `collect` / `cashier` / `orders` / `aftersale` / `login` / `ui` / `tooling` | 归属域 |
| `target` | `文件 · 函数名或选择器` | 定位到具体自动化点，**不写行号** |
| `symptom` | 一句话 | 看到的现象，不是猜测 |
| `cause` | `platform-change` / `own-bug` / `env` / `unknown` | 根因分类 |
| `detectedBy` | `manual` / `log` / `user-report` / `test` | 怎么发现的 |
| `fixMin` | 整数分钟，或 `null` | 从发现到验证通过 |
| `commit` | 短 sha 或 `null` | 修复提交 |
| `note` | 可空 | 关键线索 |

## 怎么用

```bash
node tools/maintenance-log.mjs add            # 交互式追加一条
node tools/maintenance-log.mjs add --json '{"date":"...","domain":"..."}'
node tools/maintenance-log.mjs stats          # 出统计
node tools/maintenance-log.mjs stats --since 2026-11-01
```

`stats` 会给出：

- 总条数、按域分布、按根因分布
- `platform-change` 的平均间隔（**这才是真正的 MTBF**）
- 平均修复耗时（只统计 `fixMin` 非 null 的）
- 最脆的三个域

## 什么时候才算有数字

- 少于 10 条：只能看个案，不能算频率
- 10~30 条：能看出哪块最脆，间隔仍不可靠
- 30 条以上：间隔和耗时才值得引用

**在达到 10 条之前，任何「我们多久坏一次」的说法都是编的。**
