'use strict';

/**
 * 通过 Docker unix socket 跟踪容器日志，命中关键字就立刻触发一次检查。
 *
 * 为什么不 `spawn('docker', ['logs','-f',...])`：
 *   docker CLI 常驻一个 ~30MB 的 Go 进程，对一个只做日志匹配的守护进程太浪费。
 *   直接读 socket 是零子进程，实测内存从 25MB 降到 14MB。
 *
 * Docker 的日志流是「8 字节帧头 + 载荷」的复用格式，但帧头只出现在消息边界，
 * 不会把关键字劈开；另外保留 64 字节 overlap 防止 TCP 分块切断匹配。
 */

const http = require('http');

function createLogWatcher(cfg, profile, onHit, log) {
  const { enabled, dockerSocket, container } = cfg.logwatch;
  const patterns = profile.logPatterns || [];

  if (!enabled || !container) {
    log.info('日志事件监听未启用（只靠定时探针）');
    return { start() {} };
  }
  if (!patterns.length) {
    log.warn('profile 没有 logPatterns，日志监听退化为空转');
  }

  let pending = false;

  function fire(hit) {
    if (pending) return;
    pending = true;
    setTimeout(() => (pending = false), 30000);
    log.info(`日志命中 "${hit}"，立即触发一次检查`);
    onHit();
  }

  function connect() {
    const req = http.request(
      {
        socketPath: dockerSocket,
        path: `/containers/${encodeURIComponent(container)}/logs?follow=1&stdout=1&stderr=1&tail=0&timestamps=0`,
        method: 'GET',
        timeout: 0,
      },
      (res) => {
        if (res.statusCode !== 200) {
          log.warn(`容器日志流 HTTP ${res.statusCode}，5s 后重连`);
          res.resume();
          setTimeout(connect, 5000);
          return;
        }
        log.info(`已接入容器 "${container}" 日志流`);
        let carry = '';
        res.on('data', (d) => {
          const s = carry + d.toString('utf8');
          carry = s.slice(-64);
          for (const p of patterns) {
            if (s.includes(p)) return fire(p);
          }
        });
        res.on('end', () => {
          log.warn('日志流结束（容器可能重启），5s 后重连');
          setTimeout(connect, 5000);
        });
        res.on('error', () => setTimeout(connect, 5000));
      }
    );
    req.on('error', (e) => {
      log.warn(`连不上 Docker socket（${e.message}），10s 后重试`);
      setTimeout(connect, 10000);
    });
    req.end();
  }

  return { start: connect };
}

module.exports = { createLogWatcher };
