'use strict';

/**
 * 极简日志：结构化级别 + 时间戳，直接打 stdout（交给 systemd / docker 收）。
 */

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };
const threshold = LEVELS[process.env.LOG_LEVEL] || LEVELS.info;

function stamp() {
  return new Date().toISOString().replace('T', ' ').slice(0, 19);
}

function emit(level, msg) {
  if (LEVELS[level] < threshold) return;
  process.stdout.write(`[${stamp()}] ${level.toUpperCase().padEnd(5)} ${msg}\n`);
}

module.exports = {
  debug: (m) => emit('debug', m),
  info: (m) => emit('info', m),
  warn: (m) => emit('warn', m),
  error: (m) => emit('error', m),
};
