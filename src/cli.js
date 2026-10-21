#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');

const { load, ROOT } = require('./config');
const logger = require('./logger');
const { createMihomo } = require('./mihomo');
const { createStore } = require('./state');
const { createNotifier } = require('./notifier');
const { createClassifier } = require('./classifier');
const { createEngine } = require('./engine');
const { createLogWatcher } = require('./logwatch');

const LOCK = path.join(ROOT, 'state', 'guard.pid');

// ---------- 参数 ----------

const argv = process.argv.slice(2);
const has = (f) => argv.includes(f);
const argOf = (f) => {
  const i = argv.indexOf(f);
  return i >= 0 ? argv[i + 1] : undefined;
};

// ---------- profile ----------

function loadProfile(name) {
  const candidates = [
    path.join(ROOT, 'profiles', `${name}.js`),
    path.join(ROOT, 'profiles', `${name}`),
    name,
  ];
  for (const p of candidates) {
    try {
      if (p.startsWith('/') || p.endsWith('.js')) {
        if (fs.existsSync(p) && p.startsWith('/')) return { module: require(p), file: p };
        if (fs.existsSync(p)) return { module: require(p), file: p };
      }
    } catch (e) {
      throw new Error(`加载 profile "${name}" 失败：${e.message}`);
    }
  }
  throw new Error(
    `找不到 profile "${name}"。\n` +
      `  公开示例：profiles/openai-compatible.example.js\n` +
      `  自定义放在：<repo>/profiles/<name>.js（已在 .gitignore 里，不会误提交）`
  );
}

// ---------- 单实例锁 ----------

function acquireLock() {
  fs.mkdirSync(path.dirname(LOCK), { recursive: true });
  try {
    const pid = parseInt(fs.readFileSync(LOCK, 'utf8').trim(), 10);
    if (pid > 0) {
      try {
        process.kill(pid, 0);
        console.error(`已有实例在跑（pid=${pid}），退出`);
        process.exit(1);
      } catch {
        /* 陈旧锁，覆盖 */
      }
    }
  } catch {
    /* 没有锁文件 */
  }
  fs.writeFileSync(LOCK, String(process.pid));
  const cleanup = () => {
    try {
      if (parseInt(fs.readFileSync(LOCK, 'utf8').trim(), 10) === process.pid) fs.unlinkSync(LOCK);
    } catch {
      /* ignore */
    }
  };
  process.on('exit', cleanup);
  process.on('SIGINT', () => process.exit(0));
  process.on('SIGTERM', () => process.exit(0));
}

// ---------- 装配 ----------

function build() {
  const cfg = load();
  const profileName = argOf('--profile') || cfg.profile || 'openai-compatible.example';
  const { module: profile } = loadProfile(profileName);
  // --group 显式指定时用指定的；否则用 profile 声明的组名；都没有就落回配置里的值。
  // 旧写法是 `if (profile.group && !argOf('--group'))` —— 传了 --group 反而两边都不生效，
  // 参数被静默丢弃，留着配置里的默认值。这个 bug 藏得挺好：不传参时一切正常。
  const groupOverride = argOf('--group');
  if (groupOverride) cfg.mihomo.group = groupOverride;
  else if (profile.group) cfg.mihomo.group = profile.group;

  const mihomo = createMihomo(cfg, logger);
  const store = createStore(cfg, logger, { readOnly: has('--dry-run') });
  const notifier = createNotifier(cfg, logger);
  const classifier = createClassifier(cfg, profile, logger);
  const engine = createEngine({ cfg, profile, log: logger, mihomo, store, classifier, notifier });
  return { cfg, profile, profileName, mihomo, store, notifier, classifier, engine };
}

function nextRotationIn(state) {
  const r = CFG_ROTATION;
  if (!r?.enabled) return null;
  const due = (state.rotatedAt || 0) + (r.intervalMs || 0);
  return Math.max(0, Math.round((due - Date.now()) / 1000));
}

let CFG_ROTATION = null;

// ---------- 命令 ----------

async function main() {
  if (has('--help') || has('-h')) {
    console.log(
      [
        'egress-guard — 代理节点守护',
        '',
        '用法：node src/cli.js <命令> [--profile <名>]',
        '',
        '命令：',
        '  --loop           常驻（systemd 用这个）',
        '  --once           探一次并给出完整处置决定',
        '  --dry-run        跑完整流程但不真的切节点、不推送',
        '  --simulate       假定探针失败，演练切换',
        '  --status         打印生效配置 + 运行状态',
        '  --nodes          列出组内节点与冷却情况',
        '  --selftest       规则层自测（不联网）',
        '  --test-notify    测试通知通道',
        '  --rotate         立刻轮换到「最久没用过」的节点（额度摊开用）',
        '',
        '选项：',
        '  --profile <名>   指定 profiles/ 下的 profile（默认取 config 里的 profile）',
        '  --group <名>     覆盖 mihomo 组名',
      ].join('\n')
    );
    return;
  }

  // 没给任何命令时默认 --once（试跑最常用），别直接报"未知命令"
  const COMMANDS = ['--loop', '--once', '--dry-run', '--simulate', '--status', '--nodes', '--selftest', '--test-notify', '--rotate'];
  if (!COMMANDS.some((c) => has(c))) {
    argv.push('--once');
  }

  const { cfg, profile, profileName, mihomo, store, notifier, classifier, engine } = build();
  CFG_ROTATION = cfg.schedule.rotation || null;

  if (has('--test-notify')) {
    const ok = await notifier.send('✅ 通知通道连通性测试');
    console.log('结果：', ok);
    return;
  }

  if (has('--rotate')) {
    const r = await engine.rotateNow({ dryRun: has('--dry-run') });
    console.log('RESULT:', JSON.stringify(r));
    return;
  }

  if (has('--status')) {
    const state = store.load();
    const group = await mihomo.readGroup();
    console.log(
      JSON.stringify(
        {
          profile: profileName,
          group: cfg.mihomo.group,
          mihomoNow: group?.now || null,
          nodesInGroup: group?.all?.length || 0,
          effective: {
            probeIntervalSec: cfg.probe.intervalMs / 1000,
            probeTimeoutSec: cfg.probe.timeoutMs / 1000,
            classifier: classifier.enabled ? cfg.classifier.model : 'off',
            notify: cfg.notify.enabled ? 'on' : 'off',
            logWatch: cfg.logwatch.enabled ? cfg.logwatch.container : 'off',
            variantEscalateAfter: cfg.schedule.variantEscalateAfter,
            rotation: cfg.schedule.rotation?.enabled
              ? `每 ${Math.round((cfg.schedule.rotation.intervalMs || 0) / 60000)} 分钟`
              : 'off',
          },
          rotation: {
            lastRotatedAt: state.rotatedAt || 0,
            nextRotationInSec: nextRotationIn(state),
            lastUsed: state.lastUsed || {},
          },
          condition: {
            current: engine.variantLabel(state.variant || null),
            id: state.variant || null,
            since: state.variantSince || 0,
            globalFails: state.globalFails || 0,
          },
          cooldown: state.cooldown || {},
          fails: state.fails || {},
          allDeadUntil: state.allDeadUntil || 0,
          quietUntil: state.quietUntil || 0,
        },
        null,
        2
      )
    );
    return;
  }

  if (has('--nodes')) {
    const state = store.load();
    const group = await mihomo.readGroup();
    if (!group) return console.error('读不到组信息');
    for (const n of group.all) {
      const until = state.cooldown[n] || 0;
      const left = until > Date.now() ? `冷却 ${Math.ceil((until - Date.now()) / 60000)}min` : '可用';
      const fails = state.fails[n] ? `（连败 ${state.fails[n]}）` : '';
      const lu = state.lastUsed?.[n];
      const used = lu ? `上次使用 ${Math.round((Date.now() - lu) / 60000)}min 前` : '还没用过';
      console.log(`${n === group.now ? '▶' : ' '} ${left.padEnd(14)} ${n}${fails}  [${used}]`);
    }
    return;
  }

  if (has('--selftest')) {
    const rule = profile.selftest;
    if (typeof rule !== 'function') {
      console.log('该 profile 没提供 selftest()');
      return;
    }
    const cases = rule();
    let pass = 0;
    for (const c of cases) {
      const d = await engine.decide(c.obs, { node: 'test', failures: 0 });
      const ok = d.action === c.expect;
      if (ok) pass++;
      console.log(`${ok ? '✅' : '❌'} ${String(c.name).padEnd(16)} → ${d.action.padEnd(7)} 期望 ${c.expect}  [${d.source}]`);
    }
    // 轮换逻辑在引擎里，不在 profile 里，单独跑一套
    const rot = engine.selftestRotation ? engine.selftestRotation() : [];
    if (rot.length) {
      console.log('\n— 额度轮换 —');
      for (const c of rot) {
        if (c.ok) pass++;
        console.log(`${c.ok ? '✅' : '❌'} ${String(c.name).padEnd(16)} ${c.detail}`);
      }
    }
    const total = cases.length + rot.length;
    console.log(`\n${pass}/${total} 通过`);
    process.exitCode = pass === total ? 0 : 1;
    return;
  }

  if (has('--once') || has('--dry-run') || has('--simulate')) {
    const r = await engine.runOnce({ dryRun: has('--dry-run'), simulateFailure: has('--simulate') });
    console.log('RESULT:', JSON.stringify(r));
    return;
  }

  if (has('--loop')) {
    acquireLock();
    logger.info(
      `启动（profile=${profileName}, 组=${cfg.mihomo.group}, 间隔=${cfg.probe.intervalMs / 1000}s, ` +
        `超时=${cfg.probe.timeoutMs / 1000}s, 分类器=${classifier.enabled ? cfg.classifier.model : '关'}, ` +
        `退避=${cfg.schedule.cooldownBaseMs / 60000}min→${cfg.schedule.cooldownMaxMs / 3600000}h, ` +
        `轮换=${cfg.schedule.rotation?.enabled ? Math.round(cfg.schedule.rotation.intervalMs / 60000) + 'min' : '关'}）`
    );

    const watcher = createLogWatcher(
      cfg,
      profile,
      () => {
        engine.runOnce().catch((e) => logger.error('事件检查异常：' + e.message));
      },
      logger,
      () => engine.noteTraffic()
    );
    watcher.start();

    await engine.runOnce();
    setInterval(() => {
      engine.runOnce().catch((e) => logger.error('定时检查异常：' + e.message));
    }, cfg.probe.intervalMs);
    return;
  }

  console.log('未知命令，试 --help');
}

main().catch((e) => {
  logger.error('FATAL ' + e.message);
  process.exit(1);
});
