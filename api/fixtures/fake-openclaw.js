#!/usr/bin/env node
/**
 * 测试用 OpenClaw 模拟脚本。
 * 通过环境变量 FAKE_OPENCLAW 控制行为：success | fail
 * 生产代码不调用此脚本，仅测试时通过 OPENCLAW_CLI 指向。
 */
const mode = process.env.FAKE_OPENCLAW || 'success';
if (mode === 'fail') {
  process.stderr.write('openclaw: command not found or execution failed\n');
  process.exit(1);
}
const out = {
  session_key: 'test-session-' + Date.now(),
  sessionKey: 'test-session-' + Date.now(),
  result_summary: 'Task completed successfully',
  run_id: 'run-' + process.pid,
};
process.stdout.write(JSON.stringify(out) + '\n');
process.exit(0);
