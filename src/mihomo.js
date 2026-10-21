'use strict';

/**
 * mihomo 控制面客户端（external-controller API）。
 * 只用最少的几个端点：读当前节点、读组内全部节点、切换节点。
 */

const http = require('http');

function createMihomo(cfg, log) {
  const { host, port, auth } = cfg.mihomo;

  function request(method, apiPath, body) {
    return new Promise((resolve) => {
      const payload = body ? JSON.stringify(body) : null;
      const headers = payload
        ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) }
        : {};
      if (auth) headers.Authorization = `Bearer ${auth}`;

      const req = http.request(
        { host, port, method, path: apiPath, timeout: 8000, headers },
        (res) => {
          let buf = '';
          res.on('data', (d) => (buf += d));
          res.on('end', () => resolve({ status: res.statusCode, body: buf }));
        }
      );
      req.on('error', (e) => resolve({ status: 0, body: 'ERR ' + e.message }));
      req.on('timeout', () => {
        req.destroy();
        resolve({ status: 0, body: 'TIMEOUT' });
      });
      if (payload) req.write(payload);
      req.end();
    });
  }

  const groupPath = () => `/proxies/${encodeURIComponent(cfg.mihomo.group)}`;

  async function readGroup() {
    const r = await request('GET', groupPath());
    if (r.status !== 200) {
      log?.warn?.(`读取 mihomo 组 ${cfg.mihomo.group} 失败：HTTP ${r.status} ${r.body.slice(0, 120)}`);
      return null;
    }
    try {
      const j = JSON.parse(r.body);
      return { now: j.now || null, all: Array.isArray(j.all) ? j.all : [] };
    } catch {
      return null;
    }
  }

  async function selectNode(name) {
    const r = await request('PUT', groupPath(), { name });
    if (r.status >= 200 && r.status < 300) return true;
    // 常见：节点被机场改名/下架 → 400 proxy not exist
    log?.warn?.(`切换到 "${name}" 失败：HTTP ${r.status} ${r.body.slice(0, 100)}`);
    return false;
  }

  return { request, readGroup, selectNode };
}

module.exports = { createMihomo };
