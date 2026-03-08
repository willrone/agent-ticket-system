-- 增加工单锁定字段
ALTER TABLE tickets ADD COLUMN locked_by TEXT;
ALTER TABLE tickets ADD COLUMN locked_at TEXT;

-- 创建索引加速查询
CREATE INDEX IF NOT EXISTS idx_tickets_locked_by ON tickets(locked_by);
