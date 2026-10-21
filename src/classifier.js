'use strict';

/**
 * 用「决策模型」（System One / Jev 风格接口）给失败原因分类。
 *
 * 为什么用这类模型而不是普通 chat 模型：
 *   - 输出是校准过的概率分布，不用解析生成文本，不会出现格式错误
 *   - 一次请求几十毫秒
 *   - 对从没见过的报错文案也能归类（这是它相对硬编码正则的核心价值）
 *
 * 接口约定（OpenAI 无关，任何兼容 /v1/systemone 的服务都行）：
 *   POST {url}
 *   { model, state, questions: { action:{type:"choice",instructions,criteria}, ... } }
 *   → { answers: { action: { choice, probabilities, confidence } } }
 *
 * 拿不准时返回 null，由引擎降级到规则判定 —— 绝不因为分类器挂了就停摆。
 */

const http = require('http');
const https = require('https');

const STANDARD_ACTIONS = {
  switch_node: 'The problem is specific to this egress node (its IP is blocked, or the node is broken). Switching to another node will help.',
  wait_retry: 'The upstream is globally slow, queued, rate-limited or overloaded. Switching nodes will not help because every node sees the same thing. Wait and retry later.',
  alert_only: 'Needs human action: credentials, quotas, client requirements, removed models or server misconfiguration. Do not switch nodes.',
  retry_same: 'A transient network blip or truncated connection on an otherwise healthy node. Retry the same node.',
};

function createClassifier(cfg, profile, log) {
  const c = cfg.classifier;
  const hints = profile.classify || {};

  const enabled = !!(c.enabled && c.url && c.model && c.apiKey);
  if (c.enabled && !enabled) {
    log.warn('分类器已启用但 url/model/apiKey 不全，实际关闭');
  }

  function buildBody(obs) {
    return JSON.stringify({
      model: c.model,
      state: {
        http_status: obs.status,
        response_body: String(obs.body || '').slice(0, 600),
        ttfb_ms: obs.ttfbMs,
        node: obs.node,
        consecutive_failures: obs.failures || 0,
      },
      questions: {
        action: {
          type: 'choice',
          instructions:
            hints.context ||
            'A request through an egress proxy node failed or was very slow. What should the node guardian do?',
          criteria: { ...STANDARD_ACTIONS, ...(hints.actions || {}) },
        },
        node_specific: {
          type: 'noul',
          instructions: 'This failure is specific to this egress node rather than a global upstream problem',
        },
      },
    });
  }

  function classify(obs) {
    if (!enabled) return Promise.resolve(null);

    return new Promise((resolve) => {
      let u;
      try {
        u = new URL(c.url);
      } catch {
        log.warn('分类器 url 非法');
        return resolve(null);
      }
      const payload = buildBody(obs);
      const lib = u.protocol === 'http:' ? http : https;
      const req = lib.request(
        {
          host: u.hostname,
          port: u.port || (u.protocol === 'http:' ? 80 : 443),
          path: u.pathname + u.search,
          method: 'POST',
          timeout: c.timeoutMs,
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${c.apiKey}`,
            'Content-Length': Buffer.byteLength(payload),
          },
        },
        (res) => {
          let buf = '';
          res.on('data', (d) => (buf += d));
          res.on('end', () => {
            try {
              const d = JSON.parse(buf);
              const a = d.answers?.action;
              if (!a?.choice) {
                log.warn('分类器返回不含 action：' + buf.slice(0, 120));
                return resolve(null);
              }
              resolve({
                choice: a.choice,
                confidence: a.confidence ?? 0,
                nodeSpecific: d.answers?.node_specific?.noul ?? null,
              });
            } catch {
              log.warn('分类器返回无法解析：' + buf.slice(0, 120));
              resolve(null);
            }
          });
        }
      );
      req.on('error', (e) => {
        log.warn('分类器调用失败：' + e.message);
        resolve(null);
      });
      req.on('timeout', () => {
        req.destroy();
        log.warn('分类器超时');
        resolve(null);
      });
      req.write(payload);
      req.end();
    });
  }

  return { enabled, classify };
}

module.exports = { createClassifier, STANDARD_ACTIONS };
