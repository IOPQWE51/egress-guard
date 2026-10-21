'use strict';

/**
 * 运行状态持久化 + 指数退避调度。
 *
 * 核心思想：节点永远不从名单里剔除，只是「排队时间越来越长」。
 *   第 1 次失败 → cooldownBase（默认 20min）
 *   第 2 次      → 40min
 *   第 3 次      → 80min … 封顶 cooldownMax（默认 12h）
 * 任意一次成功 → 计数归零、冷却立即解除。
 */

const fs = require('fs');
const path = require('path');

function createStore(cfg, log, opts = {}) {
  const file = cfg.stateFile;
  fs.mkdirSync(path.dirname(file), { recursive: true });

  function load() {
    try {
      return JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch {
      return {
        current: null, cooldown: {}, fails: {}, lastSwitchAt: 0,
        allDeadUntil: 0, quietUntil: 0, nextRehabAt: 0,
        variant: null, variantSince: 0, globalFails: 0,
      };
    }
  }

  // readOnly 给 --dry-run 用：照常算冷却、照常打印，但一个字都不落盘。
  // 不加这个的时候，跑一次 --dry-run 演练会留下真实的 allDeadUntil，
  // 守护随后「全挂静默 30 分钟」—— 演练把生产给演练停了。
  function save(s) {
    if (opts.readOnly) return;
    fs.writeFileSync(file, JSON.stringify(s, null, 2));
  }

  function fail(state, node) {
    const n = (state.fails[node] = (state.fails[node] || 0) + 1);
    const wait = Math.min(cfg.schedule.cooldownBaseMs * Math.pow(2, n - 1), cfg.schedule.cooldownMaxMs);
    state.cooldown[node] = Date.now() + wait;
    log.info(`节点 "${node}" 第 ${n} 次失败，冷却 ${fmt(wait)}`);
    return wait;
  }

  function succeed(state, node) {
    if (state.fails[node]) {
      log.info(`节点 "${node}" 恢复，失败计数 ${state.fails[node]} → 0`);
      delete state.fails[node];
    }
    delete state.cooldown[node];
  }

  return { load, save, fail, succeed };
}

function fmt(ms) {
  const m = Math.round(ms / 60000);
  return m < 60 ? `${m}min` : `${(m / 60).toFixed(1).replace(/\.0$/, '')}h`;
}

module.exports = { createStore, fmt };
