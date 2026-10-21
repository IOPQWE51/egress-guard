'use strict';

/**
 * 探针小工具：发一个 HTTP 请求，返回 { status, body, ttfbMs, headers }。
 * profile 里直接复用，免得每个站点都手写一遍 http.request。
 */

const http = require('http');
const https = require('https');

function request({ url, method = 'POST', headers = {}, body = null, timeoutMs = 45000, label = 'probe' }) {
  return new Promise((resolve, reject) => {
    let u;
    try {
      u = new URL(url);
    } catch (e) {
      return reject(new Error(`非法 URL: ${url}`));
    }
    const lib = u.protocol === 'http:' ? http : https;
    const started = Date.now();
    let firstByteAt = null;

    const payload =
      body == null ? null : typeof body === 'string' ? body : JSON.stringify(body);

    const req = lib.request(
      {
        host: u.hostname,
        port: u.port || (u.protocol === 'http:' ? 80 : 443),
        path: u.pathname + u.search,
        method,
        timeout: timeoutMs,
        headers: {
          ...(payload ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) } : {}),
          ...headers,
        },
      },
      (res) => {
        let buf = '';
        res.on('data', (d) => {
          if (firstByteAt === null) firstByteAt = Date.now();
          buf += d;
          if (buf.length > 65536) {
            // 探针只需要看到错误正文，别把整条流读进内存
            res.destroy();
          }
        });
        res.on('end', () =>
          resolve({
            status: res.statusCode,
            body: buf,
            headers: res.headers,
            ttfbMs: firstByteAt ? firstByteAt - started : Date.now() - started,
            totalMs: Date.now() - started,
          })
        );
        res.on('close', () => {
          resolve({
            status: res.statusCode,
            body: buf,
            headers: res.headers,
            ttfbMs: firstByteAt ? firstByteAt - started : Date.now() - started,
            totalMs: Date.now() - started,
          });
        });
        res.on('error', (e) => reject(e));
      }
    );

    req.on('error', reject);
    req.on('timeout', () => {
      req.destroy();
      reject(new Error(`${label} timeout after ${timeoutMs}ms`));
    });
    if (payload) req.write(payload);
    req.end();
  });
}

module.exports = { request };
