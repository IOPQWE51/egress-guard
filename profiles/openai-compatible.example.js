'use strict';

/**
 * 示例 profile：一个标准的 OpenAI 兼容接口（带 API Key）。
 *
 * profile 是「站点专属」的那一小块，引擎其余部分完全通用。
 * 新增一个站点，通常只需要复制本文件、改 probe() 和 rules[]。
 *
 * ─── profile 可选字段 ────────────────────────────────────────────────
 *   id            本 profile 的名字
 *   group         要操作的 mihomo select 组名（会覆盖 config.mihomo.group）
 *   priority      节点优先级（按名字），省略则用组内顺序
 *   probe(ctx)    必填。返回 { status, body, ttfbMs }
 *   isOk(obs)     可选。默认 status === 200
 *   rules[]       必填。按顺序匹配，命中即定论
 *                 { name, when(obs) => bool, action, reason }
 *   actionMap     可选。分类器输出 → 引擎动作 的映射
 *   classify      可选。给决策模型的上下文
 *                 { context: "...", actions: { switch_node: "..." } }
 *   logPatterns[] 可选。容器日志里出现即触发检查
 *   selftest()    可选。返回 [{name, obs, expect}] 供 --selftest 用
 * ────────────────────────────────────────────────────────────────────
 */

const { request } = require('../src/probe');

const MODEL = process.env.EXAMPLE_MODEL || 'your-model-id';
const ENDPOINT = process.env.EXAMPLE_ENDPOINT || 'https://api.example.com/v1/chat/completions';
const API_KEY = process.env.EXAMPLE_API_KEY || '';

function obs({ status = 0, body = '', ttfbMs = 0 }) {
  return { status, body, ttfbMs, ok: status === 200 };
}

module.exports = {
  id: 'openai-compatible.example',
  group: 'proxy-pool',

  // 可选：固定优先级。省掉就用 mihomo 组内的顺序
  priority: [],

  async probe({ cfg }) {
    if (!API_KEY) throw new Error('缺少 EXAMPLE_API_KEY 环境变量');
    const r = await request({
      url: ENDPOINT,
      method: 'POST',
      timeoutMs: cfg.probe.timeoutMs,
      headers: { Authorization: `Bearer ${API_KEY}` },
      body: {
        model: MODEL,
        messages: [{ role: 'user', content: 'ping' }],
        max_tokens: 4,
      },
    });
    return { status: r.status, body: r.body, ttfbMs: r.ttfbMs };
  },

  rules: [
    {
      name: 'rate-limit',
      when: (o) => o.status === 429,
      action: 'switch',
      reason: '按出口 IP 限流，换节点可解',
    },
    {
      name: 'quota',
      when: (o) => o.status === 402 || /insufficient.?(quota|balance)/i.test(o.body),
      action: 'alert',
      reason: '账户余额/配额问题，换节点无用',
    },
    {
      name: 'unknown-model',
      when: (o) => o.status === 404 && /model.*not found/i.test(o.body),
      action: 'alert',
      reason: '模型不存在，与节点无关',
    },
    {
      name: 'ip-blocked',
      when: (o) => o.status === 403 && /(blocked|banned|abusive|not available from your)/i.test(o.body),
      action: 'switch',
      reason: '该出口 IP 被上游拒绝',
    },
    {
      name: 'transient-empty',
      when: (o) => o.status === 0 && o.ttfbMs < 2000,
      action: 'retry',
      reason: '极快空响应，判定为传输抖动',
    },
    {
      name: 'server-error',
      when: (o) => o.status >= 500,
      action: 'wait',
      reason: '上游 5xx，通常是全局问题',
    },
  ],

  classify: {
    context:
      'A request to an OpenAI-compatible LLM API went through an egress proxy node and failed or was very slow. ' +
      'What should the node guardian do?',
  },

  logPatterns: ['ERROR 429', 'ERROR 403', 'rate limit'],

  selftest() {
    return [
      { name: '限流 429', obs: obs({ status: 429, body: '{"error":"rate limit"}', ttfbMs: 300 }), expect: 'switch' },
      { name: '配额 402', obs: obs({ status: 402, body: '{"error":"insufficient quota"}', ttfbMs: 400 }), expect: 'alert' },
      { name: '模型 404', obs: obs({ status: 404, body: '{"error":"model x not found"}', ttfbMs: 200 }), expect: 'alert' },
      { name: 'IP 被封 403', obs: obs({ status: 403, body: '{"error":"blocked from your network"}', ttfbMs: 500 }), expect: 'switch' },
      { name: '极快空响应', obs: obs({ status: 0, body: '', ttfbMs: 120 }), expect: 'retry' },
      { name: '上游 502', obs: obs({ status: 502, body: '{"error":"bad gateway"}', ttfbMs: 900 }), expect: 'wait' },
      { name: '正常 200', obs: obs({ status: 200, body: '{"ok":true}', ttfbMs: 800 }), expect: 'ok' },
    ];
  },
};
