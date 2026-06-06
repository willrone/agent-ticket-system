# Ticket Platform 质量评分提升计划（目标：9+/10）

## 评分 Rubric

总分 10 分，9 分以上表示：日常开发可持续、发布门禁可信、线上运行有可观测性，且主要安全/运维风险已收敛。

| 维度 | 权重 | 9+ 标准 |
| --- | ---: | --- |
| 发布门禁 | 2.0 | `npm run release:check` 一键全绿，失败原因可行动，不被空 scratch 目录等低价值噪音阻断 |
| 测试与契约 | 2.0 | 单元/API/前端/MCP/contract fixture 全绿；关键回归有测试锁定 |
| 安全依赖 | 1.5 | `npm audit --omit=dev` 无 high/critical；moderate 要么清零，要么有明确豁免说明 |
| 可观测性 | 1.5 | 核心运行链路结构化日志；日志有级别、脱敏、降噪、request/ticket/dispatch/event 关联字段 |
| 可维护性 | 1.5 | 高复杂模块有拆分路线；新逻辑不继续扩大 monolith；关键 util 有独立测试 |
| 运行健康 | 1.5 | live healthcheck 可复查；LaunchAgent/8788/DB/log incident 状态可解释 |

## 当前差距（2026-06-06）

- 发布门禁：已修复空 `tmp/` 假失败；`release:check` 已加入 production dependency audit。
- 安全依赖：已升级/override 生产依赖，目标为 `npm audit --omit=dev` 0 vulnerabilities。
- 可观测性：已有 `api/logger.js` 初版；README 已记录日志环境变量；internal poller / dispatch ready / API 高噪音路径已先行迁移。
- 可维护性：`api/app.js`、`api/store-sqlite.js`、`api/app.test.js` 体量偏大；本轮先不大拆，先防止新增风险。
- 运行健康：live 8788 当前不可达，LaunchAgent 未加载；这是 9 分以上的主要阻塞项之一。

## 执行计划

1. 发布门禁修复
   - 让 repo hygiene 自动忽略/清理空 `tmp/` scratch 目录，避免假失败。
   - 保持对非空 scratch 文件的阻断能力。

2. 日志系统完善
   - 保留轻量结构化 logger：JSON、level、脱敏、rate limit。
   - 补文档：`TICKET_LOG_LEVEL`、`TICKET_LOG_FORMAT`、`TICKET_LOG_STACKS`。
   - 把 internal poller/dispatch ready/API 高噪音日志纳入结构化输出。

3. 安全依赖升级
   - 先跑 `npm update` / 定点升级，目标清掉 production high。
   - 升级后完整跑 lint/test/build/audit。

4. 质量门禁
   - 跑：`npm run lint`、`npm test`、`npm run build`、`npm run mcp:smoke`、`npm run validate:live-contract-fixtures`、`npm audit --omit=dev`、`npm run release:check`。

5. live 健康
   - 若允许操作 LaunchAgent：恢复 8788 并跑 `scripts/healthcheck-live-8788.sh`。
   - 若不操作生产：记录为唯一阻塞，并给出恢复命令/检查点。

## 目标状态

- 静态/测试/发布质量：9+/10。
- 若 live 8788 也恢复并 healthcheck 通过：整体质量可评 9+/10。
- 若 live 保持不可达：代码质量可到 9+，生产运行态不能超过 8。

## 本轮已落地

- 新增结构化 logger 与单测。
- 高噪音 internal poller / dispatch ready / API 局部日志迁移。
- `repo:hygiene` 忽略空 `tmp/`，非空仍阻断。
- `release:check` 加入 `npm audit --omit=dev --audit-level=moderate`。
- 升级/固定生产依赖，清理 production audit 告警。
