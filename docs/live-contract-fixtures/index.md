# Live Contract Fixtures Index

用于给 dispatch / notify / receipt / live acceptance contract 建一个最小可交付的只读样本目录，方便后续做基线比对、incident 复盘与 fixture 补齐。

## 目录约定

- `baseline/`：当前稳定 contract 的基线说明与样本入口
- `incidents/`：历史事故、误判、断链与修复记录
- `manifest/`：机器可读索引，列出 fixture catalog、来源文件、已覆盖与待补项

## 当前交付范围（machine-readable MVP）

### baseline
- `baseline/dispatch-notify-receipt-live-contract-baseline.md`
  - 汇总当前仓库里可作为 contract baseline 的 docs / tests / code surface
- `baseline/dispatch-ready.running-33.snapshot.json`
  - 冻结 2026-03-15 live baseline 中 #33 running assignment 的 dispatch ready 断面

### incidents / replay fixtures
- `incidents/terminal-stage-should-not-enter-dispatch.json`
  - complete / failed 等终态不能误进 dispatch ready
- `incidents/dispatch-receipt-cross-ticket-or-event-mismatch.error.json`
  - dispatch_receipt 的 dispatch_id / ticket_id 串票强校验
- `incidents/pending-decision-should-not-enter-dispatch.json`
  - pending_decision 只进 notifications ready
- `incidents/dispatch-dedupe-ticket-agent-status-contract.json`
  - dispatch/notify 去重必须保留 stage + reason + actor 语义
- `incidents/dependency-not-closed-live-acceptance.json`
  - dependency 未闭合时，live acceptance 必须返回 dependency-not-closed
- `incidents/live-contract-mismatch-verdicts.json`
  - 仓库与 live hosted contract 不一致时，必须显式返回 live-not-upgraded / contract-mismatch

### incident notes
- `incidents/2026-03-14-running-assignment-refresh.md`
- `incidents/2026-03-14-workflow-mismatch-false-positive.md`

### manifest
- `manifest/fixtures.manifest.json`
  - 机器可读索引
  - 校验 required paths / source refs / json fixture schema
- `replay-matrix.md`
  - fixture -> 断言 -> contract_category 的可执行回归矩阵

## 读取建议

1. 先看 `manifest/fixtures.manifest.json`
2. 再看 `baseline/dispatch-notify-receipt-live-contract-baseline.md`
3. 需要 live 断面时看 `baseline/dispatch-ready.running-33.snapshot.json`
4. 复盘历史事故时进入 `incidents/*.json` 与对应 incident note

## 说明

这套目录当前已经从 catalog 升级到 machine-readable MVP：
- 有 1 份 live baseline snapshot
- 有 6 份事故/边界 JSON fixtures
- 每份 fixture 都带 `source_refs / expected / historical_wrong_behavior`
- `scripts/validate-live-contract-fixtures.js` 可做静态校验
