# 临时措施：游戏内 chat 一律视为 admin 指令 (2026-07-07)

## 是什么
`src/agent/agent.js` 的 `bot.on('chat', …)` 处理器把**游戏内公共聊天里收到的任何消息**
（除 bot 自己发的）**一律当作 `admin` 指令**喂给 `agent.handleMessage('admin', …)`。
等价于：用户直接在 MC 聊天框打字即可命令 bot，且走与 WS `task` **完全相同**的 admin 路径
——内部 gpt-5.4-mini 理解上下文 + 编排动作，完成后回落，并享受下述“外部意图独占优先级”。

```js
this.bot.on('chat', (username, message) => {
    if (serverProxy.getNumOtherAgents() > 0) return;   // 仅单-agent 时生效
    if (username === this.name || (this.bot && username === this.bot.username)) return; // ★滤自己
    respondFunc('admin', message);                     // ← 原为 respondFunc(username, message)
});
```

## 为什么是「临时」
- **方便调试/直接控制**：不必经外部 LLM / WS，打字即命令。
- **语义粗糙**：“一律 admin”没有来源鉴别（谁在聊天框都算 admin）。正式方案应区分来源 / 加鉴权。
- **与 bot 自己的聊天镜像共存的脆弱点**：`bot_status_nl` 人话 + `◀外部指令[…]` 都是 `bot.chat`
  发出的，会作为 `chat` 事件被 bot 自己听到。`admin` 化后 `respondFunc` 内的 self 过滤
  （`username === this.name`）在 MC 用户名 ≠ agent 名时会漏网 → 因此这里**双重过滤**
  （`this.name` + `this.bot.username`）。**换 agent 名 / 账号名务必复核此过滤**，否则 bot 会把自己的
  播报当指令回灌，形成死循环。

## 触发条件
仅在**单 agent**时生效（`serverProxy.getNumOtherAgents() === 0`）；有其他 agent 时游戏内 chat 不处理。

## 关联机制：外部意图独占优先级
admin 指令（WS task 或本措施的游戏内 chat）执行期间，**内核完全让位**：
- `src/agent/agent.js` `handleMessage`：source==='admin' 时在开头置 `bot._extIntentUntil = now+5min`，
  在 `finally`（chat-loop 结束 = gpt-5.4-mini 判定完成）清 0。
- `src/agent/framework/kernel.js` `_survivalTick`：读到 `bot._extIntentUntil` 有效则整拍 `return`
  —— 不派发任何提案（夜挖 / FREE_PLAY），也不 force 灰区求生。
- 硬保命反射（modes.js `vitalNow`：溺水 / 着火 / 岩浆 / hp≤4）独立于内核，仍生效。
- 5min 是崩溃兜底（正常由 finally 清）。

## 撤销
把 `respondFunc('admin', message)` 改回 `respondFunc(username, message)` 即恢复原行为
（游戏内 chat 按真实用户名处理、不享受 admin 独占优先级）。外部意图独占机制本身可保留。
