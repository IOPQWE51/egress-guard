'use strict';

/**
 * 配置加载：把「非敏感设置」和「密钥」彻底分开。
 *
 *   config/config.json   非敏感配置，可以提交（仓库里是 config.example.json）
 *   secrets.json         密钥：apiKey / webhook，绝不提交（已进 .gitignore）
 *   环境变量             优先级最高，适合容器/systemd Environment=
 *
 * 优先顺序：环境变量 > secrets.json > config/config.json > 内置默认值
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');

const DEFAULTS = {
  mihomo: {
    host: '127.0.0.1',
    port: 9095,
    group: 'auto',            // 要操作的 select 组名
    auth: '',                 // mihomo 配了 secret 就填
  },
  probe: {
    intervalMs: 180000,       // 定时探针间隔
    timeoutMs: 45000,         // 单次探针超时（宁可长，别把排队当故障）
    retryFastMs: 3000,        // 失败太快（< 该值）视为传输抖动，重探一次
  },
  schedule: {
    cooldownBaseMs: 1200000,  // 首次失败冷却 20min
    cooldownMaxMs: 43200000,  // 指数退避上限 12h
    allDeadMs: 600000,        // 全部不可用后静默 10min
    quietMs: 600000,          // 「等待类」结论后的静默
    switchDebounceMs: 60000,  // 两次切换最小间隔
    rehabIntervalMs: 1800000, // 冷却中的节点多久康复探测一次
    maxCandidates: 3,
  },
  classifier: {
    enabled: false,
    url: '',
    model: '',
    apiKey: '',
    timeoutMs: 8000,
    minConfidence: 0.65,
  },
  notify: {
    enabled: false,
    webhook: '',
  },
  logwatch: {
    enabled: false,
    dockerSocket: '/var/run/docker.sock',
    container: '',
  },
  stateFile: 'state/state.json',
};

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

function deepMerge(base, extra) {
  if (!extra || typeof extra !== 'object') return base;
  const out = Array.isArray(base) ? base.slice() : { ...base };
  for (const [k, v] of Object.entries(extra)) {
    out[k] = v && typeof v === 'object' && !Array.isArray(v) ? deepMerge(out[k] || {}, v) : v;
  }
  return out;
}

function envOverrides() {
  const e = process.env;
  const o = {};
  const set = (pathArr, val) => {
    if (val === undefined || val === '') return;
    let cur = o;
    pathArr.slice(0, -1).forEach((p) => (cur = cur[p] = cur[p] || {}));
    cur[pathArr[pathArr.length - 1]] = val;
  };
  set(['mihomo', 'host'], e.MIHOMO_HOST);
  set(['mihomo', 'port'], e.MIHOMO_PORT ? Number(e.MIHOMO_PORT) : undefined);
  set(['mihomo', 'group'], e.MIHOMO_GROUP);
  set(['mihomo', 'auth'], e.MIHOMO_SECRET);
  set(['classifier', 'apiKey'], e.CLASSIFIER_API_KEY);
  set(['classifier', 'url'], e.CLASSIFIER_URL);
  set(['classifier', 'model'], e.CLASSIFIER_MODEL);
  set(['notify', 'webhook'], e.NOTIFY_WEBHOOK);
  return o;
}

function load(overrides = {}) {
  const configFile = path.join(ROOT, 'config', 'config.json');
  const secretsFile = path.join(ROOT, 'secrets.json');

  const fileCfg = readJson(configFile) || {};
  const secrets = readJson(secretsFile) || {};

  // 密钥统一从 secrets.json 提升到对应位置，避免散落在各处
  const secretPatch = {};
  if (secrets.classifierApiKey) secretPatch.classifier = { apiKey: secrets.classifierApiKey };
  if (secrets.notifyWebhook) secretPatch.notify = { webhook: secrets.notifyWebhook };

  const cfg = deepMerge(
    deepMerge(deepMerge(deepMerge(DEFAULTS, fileCfg), secretPatch), envOverrides()),
    overrides
  );

  cfg.root = ROOT;
  cfg.stateFile = path.isAbsolute(cfg.stateFile) ? cfg.stateFile : path.join(ROOT, cfg.stateFile);
  return cfg;
}

module.exports = { load, ROOT, DEFAULTS };
