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

function createEngine({ cfg, profile, log, mihomo, store, classifier, notifier }) {
  const S = cfg.schedule;

  // ---------- 探针 ----------

  async function probeOnce() {
    const started = Date.now();
    try {
      const r = await profile.probe({ cfg });
      const obs = {
        status: r.status ?? 0,
        body: r.body || '',
        ttfbMs: r.ttfbMs ?? Date.now() - started,
        detail: r.detail || '',
      };
      obs.ok = profile.isOk ? profile.isOk(obs) : obs.status === 200;
      return obs;
    } catch (e) {
      return { status: 0, body: '', ttfbMs: Date.now() - started, detail: e.message, ok: false };
    }
  }

  /**
   * 失败太快（默认 <3s）多半是传输层抖动，别急着下结论，复测一次。
   * 慢失败不复测 —— 已经等了 15s+，再测一次等于双倍排队。
   */
  async function probeConfirmed(label) {
    let obs = await probeOnce();
    if (obs.ok || obs.ttfbMs >= cfg.probe.retryFastMs) return obs;

    log.warn(`探针 ${label} 极快失败（${obs.ttfbMs}ms，status=${obs.status}），1.5s 后复测`);
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
      return {
        action: rule.action,
        source: `rule:${rule.name}`,
        confidence: 1,
        reason: rule.reason || rule.name,
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

    const mapped = profile.actionMap?.[c.choice] || c.choice;
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
        store.save(state);
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
        store.save(state);
        log.info(`${decision.action === 'wait' ? '全局问题，等待' : '疑似抖动，稍后重试'} ${Math.round(backoff / 60000)} 分钟`);
        return { action: decision.action, current, obs, decision };
      }

      case 'switch':
      default: {
        if (Date.now() - (state.lastSwitchAt || 0) < S.switchDebounceMs) {
          log.info('距上次切换不足防抖窗口，本轮跳过');
          return { action: 'debounced', current, obs, decision };
        }

        store.fail(state, current);
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

  return { runOnce, probeOnce, probeConfirmed, decide, confirm, matchRule, pickCandidates, candidatePool };
}

module.exports = { createEngine };
