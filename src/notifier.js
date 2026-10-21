'use strict';

/**
 * 通知：飞书自定义机器人 webhook（text 消息）。
 *
 * 之所以先只做飞书：自定义机器人有「自定义关键词」模式，
 * 把关键词设成机器人名字就能白名单放行，不用管 IP、不用签名。
 * 所有消息都以 config 里的 notify.keyword（默认 [egress-guard]）开头。
 *
 * 要接别家（Slack / Discord / TG / 通用 webhook）：
 * 在 send() 里按 cfg.notify.format 分支即可，其余代码不用动。
 */

const http = require('http');
const https = require('https');

function createNotifier(cfg, log) {
  const { enabled, webhook, keyword = '[egress-guard]' } = cfg.notify;

  function send(text, { dryRun = false } = {}) {
    const body = `${keyword} ${text}`;
    if (!enabled || !webhook) {
      log.info('通知未启用或未配置 webhook，跳过');
      return Promise.resolve(false);
    }
    if (dryRun) {
      log.info(`[dry-run] 本应推送：${body.replace(/\n/g, ' | ')}`);
      return Promise.resolve(true);
    }

    return new Promise((resolve) => {
      let u;
      try {
        u = new URL(webhook);
      } catch {
        log.error('webhook URL 非法');
        return resolve(false);
      }
      const payload = JSON.stringify({ msg_type: 'text', content: { text: body } });
      const lib = u.protocol === 'http:' ? http : https;
      const req = lib.request(
        {
          host: u.hostname,
          port: u.port || (u.protocol === 'http:' ? 80 : 443),
          path: u.pathname + u.search,
          method: 'POST',
          timeout: 10000,
          headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) },
        },
        (res) => {
          let buf = '';
          res.on('data', (d) => (buf += d));
          res.on('end', () => {
            let code = null;
            try {
              code = JSON.parse(buf).code;
            } catch {
              /* 非飞书返回体，忽略 */
            }
            const ok = res.statusCode === 200 && (code === 0 || code === null);
            if (ok) log.info('通知已推送');
            else log.error(`通知推送失败 status=${res.statusCode} body=${buf.slice(0, 160)}`);
            resolve(ok);
          });
        }
      );
      req.on('error', (e) => {
        log.error('通知推送异常：' + e.message);
        resolve(false);
      });
      req.on('timeout', () => {
        req.destroy();
        log.error('通知推送超时');
        resolve(false);
      });
      req.write(payload);
      req.end();
    });
  }

  return { send };
}

module.exports = { createNotifier };
