# egress-guard

> 看住你的代理出口节点。上游报错时，判断该不该换节点——并且只在真的该换的时候换。

**English TL;DR** — A small supervisor for mihomo/Clash proxy pools used behind LLM gateways.
It probes a group of egress nodes, decides whether a failure is the *node's* fault or a *global
upstream* problem, and rotates the pool only when switching would actually help. Rules first,
an optional decision-model classifier for unknown error shapes, exponential backoff so a node
that dies for a day comes back on its own. Zero dependencies.

---

## 这玩意儿为什么存在

我有台小机器跑 10Router 当 AI 网关，出口走一组机场节点。有一段时间怎么都不对劲：

- 节点 A 被上游按 IP 封了，网关自动切到节点 B —— 对的。
- 但上游**全站在排队**，每个节点都要等 15 秒，网关以为节点坏了，切到 C，还是 15 秒，切到 D…… 一晚上切了十几次。每切一次换一个出口 IP，上游的 prompt cache 全丢，账单反而更高。
- 还有一次，某个节点 144 毫秒返回了一个**空响应**。探针一看"没响应"就判定节点故障，切走了。事后手动切回来一测，那节点好得很，就是抖了一下。

问题不在节点，在**判断**。

mihomo 自带的 `fallback` 组只能测出「TCP 通不通」。它测不出这三种完全不同的情况：

| 情况 | 换节点有用吗 | mihomo 看得出来吗 |
|---|---|---|
| 节点 IP 被上游封了 | ✅ 有用 | ❌ 看不出来 |
| 上游全站排队 / 限流 | ❌ 没用，只会更糟 | ❌ 看不出来 |
| 传输层抖了一下 | ❌ 没用，等一秒就好 | ❌ 看不出来 |

三件事在 `fallback` 眼里长得一模一样：都是"请求失败了"。

**所以这个项目做的是那件 mihomo 不做的事：判断。**

---

## 它怎么做判断

核心是一句话：**规则优先，模型兜底，拿不准就不动手。**

```
              ┌─────────────┐
   定时探针 ──▶│  探针（真实请求）│
   日志事件 ──▶└──────┬──────┘
                      ▼
              ┌───────────────┐
              │ 1. 命中规则？   │──是──▶ 直接定论（switch / wait / alert / retry）
              └───────┬───────┘
                      │ 否
                      ▼
              ┌───────────────┐
              │ 2. 问分类器     │──失败──▶ 走默认策略
              │  （决策模型）    │
              └───────┬───────┘
                      │
                      ▼
              置信度 < 阈值？ ──是──▶ 保守处理（重试同一节点，不乱切）
                      │ 否
                      ▼
                   执行动作
```

### 为什么规则必须排第一

因为模型会犯你不会犯的错。

我把 12 个真实的错误样本喂给决策模型测了一遍，11 个判对。唯一判错的那个，恰好就是上面说的 **144ms 空响应**——模型觉得"该换节点"，置信度 0.55。

一次误切的代价是换 IP、丢上游缓存。所以已知的坑必须写死在规则里，模型只负责处理**没见过的错误形态**（这才是它的价值：上游改个报错文案，正则就失效了，但模型还能读懂）。

### 为什么节点永不被剔除

大多数 failover 逻辑是「连续失败 N 次 → 移出轮换」。问题是**机场节点崩一整天是常事**。

这里的做法是**指数退避**：

```
第 1 次失败 → 冷却 20min
第 2 次失败 → 40min
第 3 次失败 → 1.3h
第 4 次      → 2.7h
第 5 次      → 5.3h
第 6 次      → 10.7h
第 7 次起    → 封顶 12h
```

节点永远留在名单里，只是排队越来越久。**任意一次成功，计数立刻归零、冷却立即解除**——不是"熬满 12 小时才算数"。

另外每 30 分钟会挑优先级最高的冷却节点做一次**康复探测**，恢复了就提前解冷却，不用干等。

---

## 安装

只需要 Node.js 18+，**没有任何 npm 依赖**。

```bash
git clone https://github.com/IOPQWE51/egress-guard.git
cd egress-guard

cp config/config.example.json config/config.json
cp secrets.example.json secrets.json
chmod 600 secrets.json
```

### 1. 让 mihomo 暴露 external-controller

```yaml
# mihomo/config.yaml
external-controller: 127.0.0.1:9095
```

要操作的组必须是 **`select` 类型**——因为 `fallback` / `url-test` 不接受外部指定节点，
只有 `select` 能被程序钉住。如果你原来用的是 `fallback`，改一下：

```yaml
proxy-groups:
  - name: proxy-pool
    type: select
    use: [your-provider]
```

改完热加载，不用重启：

```bash
curl -X PUT "http://127.0.0.1:9095/configs?force=true" \
  -H "Content-Type: application/json" \
  -d '{"path":"/path/to/mihomo/config.yaml"}'
```

### 2. 准备一个 profile

`profiles/` 下面放「站点专属」的那一小块逻辑。仓库里带了一个示例：

```bash
cp profiles/openai-compatible.example.js profiles/mysite.js
```

然后填上你的接口地址、模型 ID、API Key 环境变量。

### 3. 跑起来

```bash
node src/cli.js --selftest     # 先跑规则自测，不联网
node src/cli.js --once         # 探一次，看判断对不对
node src/cli.js --loop         # 常驻
```

想先用 systemd 托管：

```bash
sudo cp systemd/egress-guard.service /etc/systemd/system/
# 改里面的 User / WorkingDirectory / ExecStart 路径
sudo systemctl daemon-reload
sudo systemctl enable --now egress-guard
journalctl -u egress-guard -f
```

---

## 命令

```bash
node src/cli.js --loop             # 常驻
node src/cli.js --once             # 探一次，打印完整判断
node src/cli.js --dry-run          # 走完流程但不切节点、不推送
node src/cli.js --simulate         # 假定探针失败，演练切换
node src/cli.js --status           # 生效配置 + 运行状态
node src/cli.js --nodes            # 组内节点 + 冷却情况
node src/cli.js --selftest         # 规则自测（纯本地，不联网）
node src/cli.js --test-notify      # 测通知通道
```

常用参数：

```bash
--profile <名>     # 指定 profiles/ 下的 profile
--group <名>       # 覆盖 mihomo 组名
```

`--nodes` 的输出长这样，一眼看清谁在冷却：

```
▶ 可用            node-us-west
  冷却 12min      node-jp-tokyo      （连败 1）
  冷却 2.7h       node-hk-01         （连败 4）
```

---

## 配置

非敏感配置放 `config/config.json`，密钥放 `secrets.json`，环境变量优先级最高。

关键几项：

| 键 | 默认 | 说明 |
|---|---|---|
| `mihomo.group` | — | 要操作的 select 组名 |
| `mihomo.auth` | `""` | mihomo 配了 secret 就填 |
| `nodes.priority` | `[]` | 节点优先顺序；留空则用组内顺序 |
| `probe.intervalMs` | `180000` | 定时探针间隔 |
| `probe.timeoutMs` | `45000` | 单次探针超时，**宁可长别短**（见下方坑） |
| `probe.retryFastMs` | `3000` | 失败快于此值视为抖动，自动复测一次 |
| `schedule.cooldownBaseMs` | `1200000` | 首次失败冷却（20min） |
| `schedule.cooldownMaxMs` | `43200000` | 退避上限（12h） |
| `classifier.enabled` | `false` | 是否启用决策模型分类器 |
| `classifier.minConfidence` | `0.65` | 低于此置信度转保守策略 |
| `notify.enabled` | `false` | 是否推送通知 |
| `logwatch.container` | `""` | 填了容器名就 tail 它的日志触发检查 |
| `fallbackAction` | `switch` | 规则和分类器都给不出结论时的默认动作 |

### 环境变量（优先级最高）

```bash
MIHOMO_HOST / MIHOMO_PORT / MIHOMO_GROUP / MIHOMO_SECRET
CLASSIFIER_API_KEY / CLASSIFIER_URL / CLASSIFIER_MODEL
NOTIFY_WEBHOOK
LOG_LEVEL
```

---

## 写一个 profile

profile 是唯一需要按站点定制的地方。**能用的钩子就这么几个**：

```js
module.exports = {
  id: 'mysite',
  group: 'proxy-pool',          // 对应 mihomo 里哪个 select 组
  priority: [],                 // 可选：节点优先级
  logPatterns: ['ERROR 429'],   // 可选：容器日志里出现就立刻触发检查

  // 必填：发一个最小的合法请求并报告结果
  async probe({ cfg }) {
    const r = await request({ url, headers, body, timeoutMs: cfg.probe.timeoutMs });
    return { status: r.status, body: r.body, ttfbMs: r.ttfbMs };
  },

  // 可选：自定义"成功"的判定（默认 status === 200）
  isOk: (obs) => obs.status === 200,

  // 必填：按顺序匹配，第一个命中的就是结论
  rules: [
    { name: 'rate-limit', when: (o) => o.status === 429, action: 'switch', reason: '按 IP 限流' },
    { name: 'quota',      when: (o) => o.status === 402, action: 'alert',  reason: '余额问题' },
    { name: 'blip',       when: (o) => o.status === 0 && o.ttfbMs < 2000, action: 'retry', reason: '传输抖动' },
  ],

  // 可选：给决策模型的上下文（规则没命中时才用得上）
  classify: {
    context: 'A request to X went through an egress node and failed. What should the guardian do?',
    actions: { switch_node: '这个站是按出口 IP 封的，换节点有用' },
  },

  // 可选：自测用例，命令行 --selftest 会跑
  selftest() {
    return [{ name: '限流', obs: { status: 429, body: '', ttfbMs: 300, ok: false }, expect: 'switch' }];
  },
};
```

### 四个动作的含义

| action | 什么时候用 | 引擎会做什么 |
|---|---|---|
| `switch` | 问题在这个节点上（IP 被封、节点挂了） | 冷却当前节点 → 切到下一个 → 探活确认 |
| `wait` | 全局问题（上游排队、5xx、限流） | 不切节点，静默一段时间再来 |
| `retry` | 抖动（极快空响应） | 不切节点，60 秒后重试同一节点 |
| `alert` | 要人处理（余额、指纹、模型下架） | 不切节点，静默 30 分钟 + 告警 |

⚠️ **profile 不要提交**。`.gitignore` 里已经排除了 `profiles/*.js`，只放行示例文件——
因为你的 profile 里通常有 API Key 和站点特征。

---

## 踩过的坑（这部分大概是本仓库最值钱的东西）

### 探针超时设太短，会把"排队"判成"故障"

上游排队时，首字节（TTFB）实测能到 **14~16 秒**。如果探针超时设 15 秒，
大概一半的探针会超时 → 判定失败 → 切节点 → 把好节点一个个打进冷却。

**建议 `probe.timeoutMs` 不要低于 45000。** 慢不可怕，判错才可怕。

### "探针健康"可能掩盖真实故障

如果你的探针用的是**模型 A**，而实际业务用的是**模型 B**，
那么 B 被限流、A 正常时，探针会一路报健康，你完全看不见故障。

> **探针必须用你真正在跑的那个模型。** 宁可慢一点，也要测真实链路。

### 极快失败 ≠ 节点故障

144 毫秒返回空响应、连接被提前关闭——这类都是传输层抖动。
把它当节点故障处理，会白切一次、丢一轮 cache。

引擎内置了处理：失败快于 `probe.retryFastMs`（默认 3s）会自动复测一次，
复测还不行才下结论。**慢失败不复测**——已经等了 15 秒，再测等于双倍排队。

### `rate limit` 到底是该等还是该换？

看站点的风控维度。同一个站点的免费额度限流，实测是**按出口 IP** 算的：

| 节点 | 结果 |
|---|---|
| 节点 A | `429 rate limit` |
| 节点 B | `200` ✅ |
| 节点 C | `429` ❌ |
| 节点 D | `200`（但很慢） |

所以对这类站点，`429` 应该映射成 `switch` 而不是 `wait`。
但如果是**全站**限流，换了也没用。**这条要靠你自己实测确认**，然后写进 profile 的 rules 里。

### 健康检查端点往往不做风控，别拿它当探针

有些服务的 `/v1/models` 这类元数据端点永远返回 200，即使聊天接口已经把你封了。
用这种端点做健康检查，等于什么都没检查。**探针要打真正会失败的那个端点。**

### 诊断链路不要依赖被诊断的东西

分类器要判断"代理节点是不是坏了"。如果分类器自己也走代理，那节点全挂时分类器也挂了，
就变成"最需要诊断的时候诊断工具罢工"。

所以：**探针走代理（测真实链路），分类器走直连（保证独立）。**

### 别用 `pkill -f` 停守护进程

```bash
pkill -f "mymonitor --loop"     # 💀 会匹配到你自己的 ssh 命令行，把自己也杀了
```

用 pid 文件。

### Docker 日志别用 `docker logs -f`

那个常驻的 docker CLI 子进程要占 **~30MB** 内存。对小机器来说不值得。
直接读 unix socket 是零子进程的：

```
GET /var/run/docker.sock → /containers/<name>/logs?follow=1&tail=0
```

本项目就是这么做的，实测让整个守护进程从 25MB 降到 14MB。

---

## 关于分类器

`classifier` 是可选的。不配也能跑——规则层足够覆盖常见情况。

它对接的是「决策模型」接口（System One / Jev 风格），**不是**普通的 chat 接口：

```http
POST <classifier.url>
{
  "model": "codiv/openjev-latest",
  "state": { "http_status": 403, "response_body": "...", "ttfb_ms": 600 },
  "questions": {
    "action": { "type": "choice", "instructions": "...", "criteria": { "switch_node": "...", ... } },
    "node_specific": { "type": "noul", "instructions": "..." }
  }
}
```

返回值是**校准过的概率分布**，不是生成的文本：

```json
{
  "answers": {
    "action": { "choice": "switch_node", "confidence": 0.998, "probabilities": { ... } },
    "node_specific": { "noul": 0.999 }
  }
}
```

为什么用这类模型而不是普通 LLM：

- 输出是概率分布，**不会格式错误**，不用解析
- 一次请求几十毫秒
- 校准过的 confidence 直接可以用来做「拿不准就保守」的阈值

想换任何兼容这个协议的服务，改 `classifier.url` / `classifier.model` 即可。

---

## 限制

说清楚这玩意儿**不做什么**：

- ❌ 不处理认证失败、余额不足这类"换节点也没用"的问题——它只会告警
- ❌ 不做负载均衡，不做测速选优，只做故障转移
- ❌ 不保证能识别所有错误形态。规则没覆盖、分类器也拿不准时，它会保守地不动
- ❌ 不会自动切回"最优节点"（每次切换都是一次换 IP + 丢缓存，默认 `autoReturn: false`）
- ⚠️ 只支持 mihomo/Clash 系的 external-controller API，不支持其它代理软件

---

## 目录结构

```
src/
  cli.js        命令行入口
  engine.js     核心：探针 → 判定 → 处置
  config.js     配置加载（config.json + secrets.json + 环境变量）
  mihomo.js     mihomo external-controller 客户端
  state.js      状态持久化 + 指数退避
  classifier.js 决策模型分类器
  notifier.js   飞书 webhook
  logwatch.js   Docker socket 日志监听
  probe.js      探针 HTTP 小工具
  logger.js     日志
profiles/
  openai-compatible.example.js    示例 profile
config/
  config.example.json             配置模板
systemd/
  egress-guard.service            服务单元示例
```

---

## License

MIT。拿去用，出了事别找我。
