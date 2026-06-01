# Ticket Platform v2：老库导入与 cutover 预演（最小可执行版）

_Updated: 2026-03-20_

这份 runbook 只解决一件事：

> **在不动 8788 现网的前提下，把老库复制到 v2 DB，并完成一次可留痕的 cutover 预演。**

它不是正式切换 SOP，也不是最终上线审批单；目标是把 #178 从“只有 bootstrap / parallel skeleton”推进到“至少能做一次可验证的 rehearsal”。

---

## 1. 当前 bootstrap / runbook 还缺什么

相对于“老库导入 + cutover 预演方案”，现有 `docs/ticket-platform-v2-bootstrap.md` 与 `docs/v2-parallel-runbook.md` 还缺 4 个关键环节：

1. **缺老库导入动作**
   - 现有文档只说 v2 用独立 DB 路径启动。
   - 但没有说明如何把老平台现有 SQLite 数据带到 v2 rehearsal DB。

2. **缺预演前置检查（preflight）**
   - 需要明确 source/target DB 不能相同。
   - 需要确认 v2 poller 默认关闭，避免误动 ready/notify/audit。
   - 需要确认端口、日志、LaunchAgent 标签隔离。

3. **缺导入后的最小验数**
   - 不能只“拷过去能启动”就算完成。
   - 至少要对关键表做行数比对，证明 rehearsal DB 不是空库/坏库/串库。

4. **缺 cutover rehearsal 的执行顺序与回滚点**
   - 什么时候拷库
   - 什么时候启动 v2
   - 验完什么就算 rehearsal 通过
   - 出现异常时如何只回滚 v2，不影响 8788

---

## 2. 本轮补齐的最小交付

### 2.1 新增脚本：`scripts/rehearse-v2-cutover.js`

用途：
- 从老库复制出一份 v2 rehearsal DB
- 对关键业务表做 source/target 行数比对
- 输出可贴进工单/评审记录的摘要

默认路径：
- source：`data/tickets.db`
- target：`data/ticket-platform-v2.db`

默认校验表（存在才检查）：
- `tickets`
- `ticket_comments`
- `ticket_dependencies`
- `ticket_workers`
- `dispatch_events`
- `notifications`

示例：

```bash
npm run cutover:rehearse:v2 -- --source data/tickets.db --target tmp/ticket-platform-v2-rehearsal.db --overwrite
```

JSON 输出：

```bash
node scripts/rehearse-v2-cutover.js \
  --source data/tickets.db \
  --target tmp/ticket-platform-v2-rehearsal.db \
  --overwrite \
  --json
```

### 2.2 新增测试：`scripts/rehearse-v2-cutover.test.js`

覆盖两件最关键的事：
- 能把 source DB 复制到 target，并通过行数比对
- source/target 相同路径时会拒绝执行，避免误覆盖现网库

### 2.3 新增文档：本文件

作用：
- 把“老库导入 + 预演步骤 + 验收点 + 回滚点”写清楚
- 让 reviewer 能判断 #178 现在到底补到了哪一步

---

## 3. 推荐预演步骤（最小闭环）

### Step 1：确认隔离参数

- 老平台端口：`8788`
- v2 端口：`8790`（本轮唯一 canonical 验收入口）
- 老库：`/Users/ronghui/Projects/agent-ticket-system/data/tickets.db`
- v2 canonical DB：`/Users/ronghui/Projects/agent-ticket-system-v2/data/tickets-v2.db`
- 若仅做临时 rehearsal，可显式改成 `tmp/ticket-platform-v2-rehearsal.db`，但默认验收口径仍以独立实例当前托管的 `tickets-v2.db` 为准
- `TICKET_INTERNAL_POLLERS_ENABLED=false`
- `ai.openclaw.ticket-platform-api-v2` 为 canonical v2 LaunchAgent label

### Step 2：复制老库到 rehearsal DB

```bash
npm run cutover:rehearse:v2 -- \
  --source data/tickets.db \
  --target tmp/ticket-platform-v2-rehearsal.db \
  --overwrite
```

通过标准：
- 脚本 exit code = 0
- 输出 `PASS row counts match`

### Step 3：用 rehearsal DB 启动 v2

```bash
TICKET_API_PORT=8790 \
TICKETS_DB_PATH=/Users/ronghui/Projects/agent-ticket-system/tmp/ticket-platform-v2-rehearsal.db \
TICKET_INTERNAL_POLLERS_ENABLED=false \
./scripts/run-api-v2.sh
```

### Step 4：做最小 smoke

```bash
curl http://127.0.0.1:8788/api/version
curl http://127.0.0.1:8790/api/version
curl http://127.0.0.1:8790/api/tickets | head
curl http://127.0.0.1:8790/api/v1/agent/runtime/context | head
```

通过标准：
- 8788 继续可用
- 8790 可用
- 8790 读到的不是空库/初始化坏库
- v2 poller 仍关闭，没有误触发 ready/notify/audit 链路

### Step 5：回滚 rehearsal

- 停掉 8790 v2 进程即可
- 保留 rehearsal DB 作为留痕，或直接删除
- 不改 8788，不切老库

---

## 4. 当前仍未覆盖的内容（也是剩余风险）

这轮是“最小可执行预演”，**还不等于正式 cutover ready**。仍缺：

1. **缺线上冻结窗口 SOP**
   - 尚未定义正式切换时是否需要短暂停写 / 如何控写入窗口。

2. **缺读写一致性比对**
   - 当前只做表级行数比对，不做逐票字段 diff，也不做写路径双写/回放比对。

3. **缺 poller / dispatch / notify 的 rehearsal checklist**
   - 目前明确要求 v2 poller 保持关闭，避免误动现网；
   - 但这意味着“带真实 poller 的切换预演”还没做。

4. **缺 LaunchAgent / 守护进程切换 SOP**
   - 现在能并行拉起、能验证健康，但没有形成正式的 launchctl 切换顺序单。

5. **缺 reviewer sign-off 模板**
   - 还没有把“何时允许从 rehearsal 进入正式 cutover”写成明确门槛。

---

## 5. 对 #178 的实际判断

如果 #178 的目标是：

> “先把 v2 bootstrap/runbook 从抽象骨架推进到能做老库导入与 cutover 预演的最小交付”

那么这轮已经补到：
- 有并行运行骨架
- 有老库导入脚本
- 有 rehearsal 验数脚本
- 有最小 runbook
- 有脚本测试

如果 #178 的目标是：

> “已经足够支持正式切流 / 正式 cutover”

那还**不够**，因为还缺：冻结窗口、写一致性比对、poller rehearsal、LaunchAgent 切换 SOP、reviewer 准入门槛。

---

## 6. 建议 reviewer 关注的验收点

最小验收建议：

1. `scripts/rehearse-v2-cutover.js` 能在真实老库上跑通
2. source/target 路径保护有效
3. 行数比对结果可留痕
4. v2 用 rehearsal DB 独立启动，不影响 8788
5. 文档明确写出“这只是 rehearsal-ready，不是 production cutover-ready”

---

## 7. 一句话结论

这轮不是把 v2 切上线，
而是把 #178 从“只有 bootstrap 骨架”推进到：

> **已经具备老库导入 + isolated cutover rehearsal 的最小执行能力。**
 的最小执行能力。**
