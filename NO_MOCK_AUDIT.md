# No-Mock 审计报告（本轮）

## a) 命中点清单与分类

### 必须清理（生产代码）

| 文件 | 行号 | 关键词 | 描述 | 状态 |
|------|------|--------|------|------|
| `src/api/tickets.js` | 16-53 | mock, fallback | `createMockComment` 与 `submitComment` 的 fallback 逻辑 | ✅ 已清理 |
| `src/pages/TicketDetail.jsx` | 9-45, 60-63 | Mock, _fallback | `initialTicket` 硬编码数据与 `_fallback` 成功提示 | ✅ 已清理 |

### 可保留（仅测试文件）

| 文件 | 行号 | 关键词 | 描述 |
|------|------|--------|------|
| `src/pages/TicketDetail.test.jsx` | 7, 29-31, 36-37, 89, 126 | mock, vi.mock, mockResolvedValue, mockImplementation, mockRejectedValue | 测试用 mock，符合“测试可保留必要 mock”要求 |

### 剩余（聚焦范围外，可选后续清理）

| 文件 | 行号 | 关键词 | 描述 |
|------|------|--------|------|
| `src/pages/Tickets.jsx` | 9, 21 | Mock | tickets 与 bots 的硬编码数据；本次聚焦 ticket detail / comment 流程，未改动 |

---

## b) 变更文件清单

| 文件 | 变更类型 |
|------|----------|
| `src/api/tickets.js` | 移除 `createMockComment`、移除 `submitComment` 的 catch fallback，失败时直接 throw |
| `src/pages/TicketDetail.jsx` | 移除 `initialTicket` mock，改用 `fetchTicketDetail` 真实 API；移除 `_fallback` 处理；添加 loading/error 状态 |
| `src/pages/TicketDetail.test.jsx` | 添加 `fetchTicketDetail` mock、`mockTicket` 数据；各用例增加 `waitFor` 等待异步加载 |
| `NO_MOCK_AUDIT.md` | 新增本轮审计与结论文档 |

---

## c) 已完成 / 剩余 / 阻塞 / ETA

| 项 | 状态 |
|----|------|
| tickets API 去 mock 化（submitComment 仅真实 API） | ✅ 已完成 |
| TicketDetail 页面去 mock 化（fetchTicketDetail + 无 fallback 成功） | ✅ 已完成 |
| 评论提交流程：真实 API-only，失败仅错误提示 | ✅ 已完成 |
| TicketDetail 测试更新 | ✅ 已完成 |
| Tickets 列表页 mock 数据 | 剩余（聚焦范围外） |
| 阻塞 | 无 |
| ETA | 剩余项可单独一轮迭代完成（预计 0.5~1 天） |

---

## d) 结论：生产代码是否已无 mock

**聚焦范围（ticket detail / comment 提交流程）：生产代码已无 mock。**

- `src/api/tickets.js`：`submitComment` 仅调用真实 HTTP POST，失败时抛出错误，无本地伪造成功。
- `src/pages/TicketDetail.jsx`：工单数据来自 `fetchTicketDetail`，评论提交成功后显示“评论已发布”，失败时仅显示错误信息。

**若仍有 mock（逐项说明）：**

- `src/pages/Tickets.jsx`：tickets 列表与 bots 仍使用硬编码 mock 数据，未接入 `fetchTickets` / `fetchBots`。本次按“最小可验证增量”聚焦 ticket detail 与 comment 流程，未纳入改动。

---

## e) 测试与构建结果摘要

| 命令 | 结果 |
|------|------|
| `npm run test` | ✅ 通过（4 tests, 1 file） |
| `npm run build` | ✅ 通过 |

---

## 接口与状态一致性检查

- **baseURL**：统一通过 `api/client.js` 的 `getBaseUrl()`（`VITE_API_BASE_URL`）。
- **endpoint**：`/api/tickets`、`/api/tickets/:id`、`/api/tickets/:id/comments` 一致。
- **错误处理**：`apiRequest` 统一解析错误并 throw；TicketDetail 在 catch 中展示 `err?.message` 或默认提示。
- **TicketDetail 成功/失败行为**：成功显示“评论已发布”并更新列表；失败显示错误信息，保留输入内容。
