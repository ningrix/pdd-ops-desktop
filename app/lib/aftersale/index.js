'use strict';
/**
 * B 线 · 售后对账 — 统一出口
 *
 * 定位：纯逻辑库。不含 IO、不含 IPC、不碰平台接口。
 * 接入方式（由 lead 决定何时做）：主进程新增 IPC 通道 → 本目录模块，渲染层只管展示。
 *
 * 建议的 IPC 通道名（只声明，不实现）：
 *   aftersale:sync      拉取并归一化售后单
 *   aftersale:triage    分诊排序
 *   aftersale:appeal    生成申诉包（人工提交，绝不自动）
 *   aftersale:reconcile 账单对账
 */

module.exports = {
  model: require('./model'),
  triage: require('./triage'),
  appeal: require('./appeal'),
  reconcile: require('./reconcile'),
};
