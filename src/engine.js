'use strict';

/**
 * 引擎：探针 → 判定 → 处置。
 *
 * 判定顺序刻意是「规则优先，模型兜底」：
 *
 *   1. 规则命中（profile.rules）  —— 确定性高、零依赖、不受报错文案漂移影响
 *   2. 分类器（决策模型）          —— 处理没见过的错误形态
 *   3. 都没有 → 保守策略            —— 低置信度不乱切
 *
 * 之所以不纯靠模型：实测里模型会把「极快空响应」这种传输抖动判成「该换节点」，
 * 一次误切 = 换 IP = 上游 prompt cache 全丢。所以已知的坑必须写死在规则里。
 */

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * 分类器说的是它自己那套标准动作名，引擎用的是内部动作名。
 * 默认给一份翻译表 —— 别指望每个 profile 作者都会记得写 actionMap。
 *
 * 这个默认值是后来补的：之前只有 `profile.actionMap?.[choice] || choice`，
 * 而分类器固定吐 switch_node / wait_retry / alert_only / retry_same，
 * 于是每一句模型判断都落进「未知动作」分支被降级成 retry —— 分类器接了个寂寞。
 * 规则层一直工作，把这事盖住了，直到拿 --simulate 跑全流程演练才露出来。
 */
const DEFAULT_ACTION_MAP = {
  switch_node: 'switch',
  wait_retry: 'wait',
  alert_only: 'alert',
  retry_same: 'retry',
};

function createEngine({ cfg, profile, log, mihomo, store, classifier, notifier }) {
  const S = cfg.schedule;

  // ---------- 探针 ----------

  // 当前生效的探针。默认是 profile.probe（主条件）；主条件连续全局失败时，
  // 会被换成备选条件（见下面的变体一节）。
  let activeProbe = profile.probe;

  function toObs(r, started) {
    const obs = {
      status: r.status ?? 0,
      body: r.body || '',
      headers: r.headers || {},
      ttfbMs: r.ttfbMs ?? Date.now() - started,
      detail: r.detail || '',
    };
    obs.ok = profile.isOk ? profile.isOk(obs) : obs.status === 200;
    return obs;
  }

  async function probeWith(fn) {
    const started = Date.now();
    try {
      return toObs(await fn({ cfg }), started);
    } catch (e) {
      return { status: 0, body: '', ttfbMs: Date.now() - started, detail: e.message, ok: false };
    }
  }

  async function probeOnce() {
    return probeWith(activeProbe);
  }

  /**
   * 失败太快（默认 <3s）多半是传输层抖动，别急着下结论，复测一次。
   * 慢失败不复测 —— 已经等了 15s+，再测一次等于双倍排队。
   */
  async function probeConfirmed(label) {
    const obs = await probeOnce();

    // 只有「连 HTTP 状态行都没收到」并且很快返回的，才算传输层抖动，值得复测。
    // 已经拿到真实状态码（哪怕是 429 / 403）就是确定答案 —— 复测只白白多等 1.5 秒，
    // 而且故障期间每个节点都要多打一次请求，越乱越慢，正好卡在最不该慢的时候。
    const transportBlip = obs.status === 0 && obs.ttfbMs < cfg.probe.retryFastMs;
    if (obs.ok || !transportBlip) return obs;

    log.warn(`探针 ${label} 连状态行都没收到（${obs.ttfbMs}ms），疑似传输抖动，1.5s 后复测`);
    await sleep(1500);
    const again = await probeOnce();
    log.info(`复测 ${label} → ${again.ok ? 'OK' : 'FAIL'}（${again.ttfbMs}ms，status=${again.status}）`);
    return again;
  }

  // ---------- 判定 ----------

  function matchRule(obs) {
    for (const rule of profile.rules || []) {
      try {
        if (rule.when(obs)) return rule;
      } catch (e) {
        log.warn(`规则 ${rule.name} 抛错：${e.message}`);
      }
    }
    return null;
  }

  async function decide(obs, ctx) {
    if (obs.ok) return { action: 'ok', source: 'probe', confidence: 1, reason: '探针正常' };

    const rule = matchRule(obs);
    if (rule) {
      // 规则可以自己指定冷却时长。有确定依据的时候（比如 429 带了 Retry-After），
      // 按它来；没有就交给 store 的指数退避。
      let cooldownMs = 0;
      try {
        cooldownMs = typeof rule.cooldownMs === 'function' ? rule.cooldownMs(obs) : Number(rule.cooldownMs) || 0;
      } catch (e) {
        log.warn(`规则 ${rule.name} 的 cooldownMs 抛错：${e.message}`);
      }
      return {
        action: rule.action,
        source: `rule:${rule.name}`,
        confidence: 1,
        reason: rule.reason || rule.name,
        cooldownMs: cooldownMs > 0 ? cooldownMs : 0,
      };
    }

    const c = await classifier.classify(obs);
    if (!c) {
      return {
        action: cfg.fallbackAction || 'switch',
        source: 'fallback',
        confidence: 0.3,
        reason: '规则未命中且分类器不可用，按默认策略处理',
      };
    }

    const mapped = profile.actionMap?.[c.choice] || DEFAULT_ACTION_MAP[c.choice] || c.choice;
    const okAction = ['ok', 'switch', 'wait', 'retry', 'alert'].includes(mapped);
    if (!okAction) {
      log.warn(`分类器给出未知 action "${c.choice}"，按保守策略`);
      return { action: 'retry', source: 'classifier:unknown', confidence: c.confidence, reason: c.choice };
    }

    const low = c.confidence < cfg.classifier.minConfidence;
    log.info(
      `分类器 → ${c.choice}（conf=${c.confidence.toFixed(2)}, node_specific=${
        c.nodeSpecific === null || c.nodeSpecific === undefined ? '?' : c.nodeSpecific.toFixed(2)
      }）${low ? ' ⚠️ 置信度低，转保守策略' : ''}`
    );
    if (low) {
      return { action: 'retry', source: 'classifier:low-conf', confidence: c.confidence, reason: `分类器低置信（${c.choice}）` };
    }
    return { action: mapped, source: 'classifier', confidence: c.confidence, reason: c.choice };
  }

  /**
   * 换节点前的二次确认。
   *
   * 有些失败看着像「这个节点坏了」，其实是上游/模型级故障 —— 最典型的是 429：
   * 既可能是「这个出口 IP 被限流」（换节点能解），也可能是「对面某个模型端点挂了」（换节点白搭）。
   * 光看状态码分不出来，正文文案也未必每次都带。
   *
   * 所以留一个 profile 钩子：换一个条件（换模型、换路径、换参数）再探一次。
   * 换了条件就通了 → 问题跟这个节点无关，这次不切，省下一个好节点。
   *
   * 代价是多一次探针往返；收益是「一次误切 = 换 IP = 上游 prompt cache 全丢 + 一个节点白冻结」。
   * 这笔账只在一个方向上划算：确认失败才切，确认成功就等。
   */
  async function confirm(decision, obs) {
    const cc = profile.crossCheck;
    if (!cc || decision.action !== 'switch') return decision;

    const ruleName = String(decision.source).replace(/^rule:/, '');
    if (cc.onRules && !cc.onRules.includes(ruleName)) return decision;

    let r;
    try {
      r = await cc.probe({ cfg, failed: obs });
    } catch (e) {
      log.warn(`二次确认探针失败（${e.message}），无法证伪，按原判定继续`);
      return decision;
    }

    const passed = cc.isOk ? cc.isOk(r) : r.status === 200;
    if (!passed) {
      log.info(`二次确认「${cc.label}」仍然失败（status=${r.status}）→ 问题确实在这个节点，维持换节点`);
      return decision;
    }

    log.info(`二次确认「${cc.label}」通过（status=${r.status}）→ 问题不在节点，改判等待，不冻结节点`);
    return {
      ...decision,
      action: 'wait',
      source: 'crosscheck',
      confidence: 1,
      reason: `换条件复探通过（${cc.label}），说明是上游/模型级问题，不是这个节点坏了`,
    };
  }

  // ---------- 变体：换个条件再试 ----------

  /**
   * 「变体」= 请求的条件维度：用哪个模型、走哪条路径、用哪个账号、走哪个版本。
   *
   * 节点维度解决不了的问题，换个条件往往就通了。2026-10-21 那次就是：
   * 13 个不同国家、不同机房的节点在同一分钟内全部 429，根子是「某个模型的端点挂了」，
   * 换节点纯属白费 —— 那时候只能干等，等多久也不知道。
   *
   * 现在：连续 N 轮「全局失败」之后，挨个试备选条件。
   *
   *   换了条件就通   → 守护改用新条件继续盯，同时告诉人「主用挂了，建议临时切到备选」
   *   换了条件也不通 → 那才是真·全局故障，安静等，不刷屏
   *   主用恢复了     → 自动切回来，也告诉人一声
   *
   * 有一条线要划清楚：**守护只负责发现和报告，不替人改客户端的配置。**
   * 如果守护自己偷偷换条件探通了、而业务还在用挂掉的那个，
   * 就会造出「探针是绿的、业务还是红的」这种假象 —— 比不监控更糟。
   */

  const alts = () =>
    Array.isArray(profile.variants)
      ? profile.variants.filter((v) => v && v.id && typeof v.probe === 'function')
      : [];

  function variantLabel(id) {
    if (!id) return profile.primaryLabel || '主用条件';
    const v = alts().find((x) => x.id === id);
    return (v && v.label) || id;
  }

  function applyVariant(state) {
    const v = alts().find((x) => x.id === state.variant);
    if (state.variant && !v) {
      // profile 改过、备选被删了，别让状态文件里的旧 id 一直挂着
      log.warn(`状态里的备选条件 "${state.variant}" 在 profile 里已经不存在，退回主条件`);
      state.variant = null;
      state.variantSince = 0;
    }
    activeProbe = v ? v.probe : profile.probe;
    return activeProbe;
  }

  /**
   * 全局失败计数 + 可能的降级。只在结论是 wait 的时候调用。
   */
  async function onGlobalFail(state, { current, dryRun }) {
    const list = alts();
    if (!list.length) return null;

    const threshold = S.variantEscalateAfter || 3;
    state.globalFails = (state.globalFails || 0) + 1;

    if (state.globalFails < threshold) {
      log.info(`全局失败连续 ${state.globalFails}/${threshold} 轮（当前条件：${variantLabel(state.variant)}）`);
      return null;
    }
    state.globalFails = 0;

    // ① 还在主条件上：挨个试备选
    if (!state.variant) {
      for (const v of list) {
        const r = await probeWith(v.probe);
        log.info(`备选条件「${variantLabel(v.id)}」→ ${r.ok ? 'OK' : 'FAIL'}（status=${r.status}, ${r.ttfbMs}ms）`);
        if (!r.ok) continue;
        state.variant = v.id;
        state.variantSince = Date.now();
        store.save(state);
        applyVariant(state);
        log.warn(`主用条件连续失败，改用备选「${variantLabel(v.id)}」继续监视（节点没换）`);
        await notifier.send(
          `🔀 主用条件挂了，备选正常\n` +
            `条件：${variantLabel(null)} → ${variantLabel(v.id)}\n` +
            `节点：${current}（同一个节点，没换）\n` +
            `说明：换节点无用，是上游/条件级问题。守护已改用备选继续盯着。\n` +
            `建议：客户端也临时切到「${variantLabel(v.id)}」。`,
          { dryRun }
        );
        return { action: 'variant-switched', variant: v.id };
      }
      log.error(`主用条件和 ${list.length} 个备选条件全都不通 —— 这是真·全局故障，只能等`);
      return null;
    }

    // ② 当前在备选上：回头看主条件恢复没有
    const prim = await probeWith(profile.probe);
    if (!prim.ok) {
      log.info(`主用条件仍未恢复（status=${prim.status}），继续用备选「${variantLabel(state.variant)}」`);
      return null;
    }
    return await backToPrimary(state, { current, dryRun, why: '全局失败复查时发现主用已恢复' });
  }

  async function backToPrimary(state, { current, dryRun, why }) {
    const from = variantLabel(state.variant);
    state.variant = null;
    state.variantSince = 0;
    state.globalFails = 0;
    store.save(state);
    applyVariant(state);
    log.info(`主用条件恢复（${why}），从「${from}」切回「${variantLabel(null)}」`);
    await notifier.send(
      `✅ 主用条件恢复\n条件：${from} → ${variantLabel(null)}\n节点：${current}\n建议：客户端可以切回来了。`,
      { dryRun }
    );
    return { action: 'variant-recovered' };
  }

  // ---------- 候选节点 ----------

  function candidatePool(group) {
    const priority = cfg.nodes?.priority || profile.priority || [];
    const all = group.all || [];
    if (!priority.length) return all;
    // 优先级表里仍存在于组内的排在前面，其余追加在后
    const inGroup = priority.filter((n) => all.includes(n));
    const rest = all.filter((n) => !inGroup.includes(n));
    return [...inGroup, ...rest];
  }

  function pickCandidates(state, group, exclude) {
    const inCooldown = (n) => (state.cooldown[n] || 0) > Date.now();
    const pool = candidatePool(group).filter((n) => !exclude.includes(n));

    const ready = pool.filter((n) => !inCooldown(n));
    if (ready.length) return ready.slice(0, S.maxCandidates);

    // 全在冷却：不放弃，挑最早解锁的强制试一次
    const soonest = pool.slice().sort((a, b) => (state.cooldown[a] || 0) - (state.cooldown[b] || 0))[0];
    if (soonest) {
      log.warn(`候选全在冷却，强制试探最早解锁的 "${soonest}"`);
      return [soonest];
    }
    return [];
  }

  // ---------- 康复探测 ----------

  async function rehabSweep(state, group) {
    if (Date.now() < (state.nextRehabAt || 0)) return;
    state.nextRehabAt = Date.now() + S.rehabIntervalMs;

    const cooled = candidatePool(group).filter(
      (n) => n !== state.current && (state.cooldown[n] || 0) > Date.now()
    );
    if (!cooled.length) return store.save(state);

    const target = cooled[0];
    log.info(`康复探测 "${target}"`);
    const obs = await probeConfirmed(target);
    if (obs.ok) {
      store.succeed(state, target);
      await notifier.send(`✅ 节点已恢复：${target}\n冷却提前解除`);
    } else {
      log.info(`"${target}" 仍不可用（status=${obs.status}）`);
    }
    store.save(state);
  }

  // ---------- 主流程 ----------

  async function runOnce({ dryRun = false, simulateFailure = false } = {}) {
    const state = store.load();
    applyVariant(state);

    if (state.allDeadUntil > Date.now()) {
      log.info(`全挂静默中，跳过（剩余 ${Math.round((state.allDeadUntil - Date.now()) / 1000)}s）`);
      return { action: 'skip-all-dead' };
    }
    if (state.quietUntil > Date.now()) {
      log.info(`等待中，跳过（剩余 ${Math.round((state.quietUntil - Date.now()) / 1000)}s）`);
      return { action: 'skip-quiet' };
    }

    const group = await mihomo.readGroup();
    if (!group || !group.now) {
      log.error(`读不到 mihomo 组 "${cfg.mihomo.group}" 的当前节点，跳过本轮`);
      return { action: 'skip-no-group' };
    }

    const current = group.now;
    state.current = current;

    // 节点漂移：优先级表里的名字已不在组内
    const priority = cfg.nodes?.priority || profile.priority || [];
    const missing = priority.filter((n) => !group.all.includes(n));
    if (missing.length) {
      log.warn(`优先级表里 ${missing.length} 个节点已不在组内（改名/下架）：${missing.join(', ')}`);
    }
    if (group.all.length < 3) {
      log.error(`组内只剩 ${group.all.length} 个节点，订阅可能失效或 filter 写错`);
      await notifier.send(`🚨 代理组节点数异常\n${cfg.mihomo.group} 只剩 ${group.all.length} 个\n当前：${current}`, { dryRun });
    }

    let obs = await probeConfirmed(current);
    if (simulateFailure) {
      log.info('[simulate] 强制把探针结果当作失败');
      obs = { status: 403, body: '', ttfbMs: 0, detail: 'simulated', ok: false };
    }

    log.info(`探针 "${current}" → ${obs.ok ? 'OK' : 'FAIL'}（status=${obs.status}, ${obs.ttfbMs}ms）`);
    let decision = await decide(obs, { node: current, failures: state.fails[current] || 0 });
    log.info(`处置：${decision.action}（${decision.source}）— ${decision.reason}`);
    decision = await confirm(decision, obs);
    if (decision.source === 'crosscheck') log.info(`处置改判：${decision.action}（${decision.reason}）`);

    switch (decision.action) {
      case 'ok': {
        store.succeed(state, current);
        state.globalFails = 0;
        store.save(state);

        // 正跑在备选条件上：隔一段时间回头试试主条件，通了就切回去
        if (state.variant && Date.now() - (state.variantSince || 0) > S.rehabIntervalMs) {
          const prim = await probeWith(profile.probe);
          if (prim.ok) {
            const r = await backToPrimary(state, { current, dryRun, why: '定时复查' });
            await rehabSweep(state, group);
            return { action: 'ok', current, obs, decision, ...r };
          }
          state.variantSince = Date.now();
          store.save(state);
          log.info(`主用条件仍未恢复（status=${prim.status}），继续用备选，${Math.round(S.rehabIntervalMs / 60000)} 分钟后再试`);
        }

        await rehabSweep(state, group);
        return { action: 'ok', current, obs, decision };
      }

      case 'alert': {
        state.allDeadUntil = Date.now() + 30 * 60 * 1000;
        store.save(state);
        log.warn('需人工介入，静默 30 分钟且不换节点');
        await notifier.send(
          `⚠️ 需要人工介入\n原因：${decision.reason}\n来源：${decision.source}\n节点：${current}\n（换节点无用）`,
          { dryRun }
        );
        return { action: 'alert', current, obs, decision };
      }

      case 'wait':
      case 'retry': {
        const backoff = decision.action === 'wait' ? S.quietMs : 60000;
        state.quietUntil = Date.now() + backoff;

        // 「换条件」只对全局性失败有意义；单次抖动（retry）不动这个计数
        let extra = null;
        if (decision.action === 'wait') extra = await onGlobalFail(state, { current, dryRun });

        store.save(state);
        log.info(`${decision.action === 'wait' ? '全局问题，等待' : '疑似抖动，稍后重试'} ${Math.round(backoff / 60000)} 分钟`);
        return { action: decision.action, current, obs, decision, ...(extra || {}) };
      }

      case 'switch':
      default: {
        if (Date.now() - (state.lastSwitchAt || 0) < S.switchDebounceMs) {
          log.info('距上次切换不足防抖窗口，本轮跳过');
          return { action: 'debounced', current, obs, decision };
        }

        store.fail(state, current, decision.cooldownMs);
        const candidates = pickCandidates(state, group, [current]);
        if (!candidates.length) {
          state.allDeadUntil = Date.now() + S.allDeadMs;
          store.save(state);
          log.error('没有可用候选节点，静默等待');
          await notifier.send(`🚨 无可切换节点\n当前：${current}\n原因：${decision.reason}`, { dryRun });
          return { action: 'all-dead', current, obs, decision };
        }

        for (const cand of candidates) {
          if (dryRun) {
            log.info(`[dry-run] 拟切换到 "${cand}"（不实际执行）`);
            return { action: 'dry-run-switch', from: current, to: cand, obs, decision };
          }
          if (!(await mihomo.selectNode(cand))) continue;

          await sleep(800);
          const verify = await probeConfirmed(cand);
          log.info(`候选 "${cand}" 探活 → ${verify.ok ? 'OK' : 'FAIL'}（${verify.ttfbMs}ms）`);
          if (verify.ok) {
            store.succeed(state, cand);
            state.current = cand;
            state.lastSwitchAt = Date.now();
            store.save(state);
            log.warn(`已切换："${current}" → "${cand}"（${decision.reason}）`);
            await notifier.send(
              `🔄 已切换节点\n原因：${decision.reason}\n旧：${current}\n新：${cand}\n探测：${verify.ttfbMs}ms`,
              { dryRun }
            );
            return { action: 'switched', from: current, to: cand, obs, decision, verify };
          }
          store.fail(state, cand);
        }

        state.allDeadUntil = Date.now() + S.allDeadMs;
        store.save(state);
        log.error('候选全部失败，静默等待');
        await notifier.send(
          `🚨 无可用节点\n当前：${current}（${decision.reason}）\n已试：${candidates.join(', ')}`,
          { dryRun }
        );
        return { action: 'all-candidates-failed', current, obs, decision };
      }
    }
  }

  return {
    runOnce, probeOnce, probeConfirmed, decide, confirm, matchRule, pickCandidates, candidatePool,
    variantLabel, activeVariant: (state) => state.variant || null,
  };
}

module.exports = { createEngine };
