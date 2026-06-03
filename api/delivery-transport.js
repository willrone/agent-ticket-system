import { spawn } from 'child_process';
import fs from 'fs';
import { getGatewayById, getSshDestination } from './agent-topology.js';

function isInvalidCliValue(value) {
  const normalized = String(value || '').trim();
  return !normalized || normalized === '1' || normalized === 'true' || normalized === 'false';
}

function chooseCli(envValue, candidates, fallback) {
  if (!isInvalidCliValue(envValue)) return String(envValue).trim();
  for (const candidate of candidates) {
    if (candidate && fs.existsSync(candidate)) return candidate;
  }
  return fallback;
}

const OPENCLAW_CLI = chooseCli(process.env.OPENCLAW_CLI, ['/opt/homebrew/bin/openclaw'], 'openclaw');
const SSH_CLI = chooseCli(process.env.SSH_CLI, ['/usr/bin/ssh'], 'ssh');

function parseJsonOutput(stdout) {
  try {
    return JSON.parse(stdout || '{}');
  } catch {
    return { raw: String(stdout || '').trim() };
  }
}

function runCommand(command, args, label) {
  return new Promise((resolve, reject) => {
    if (isInvalidCliValue(command)) {
      return reject(new Error(`${label} invalid command: ${String(command || '')}`));
    }
    const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';

    child.stdout.on('data', (chunk) => {
      stdout += String(chunk);
    });
    child.stderr.on('data', (chunk) => {
      stderr += String(chunk);
    });

    child.on('error', (err) => reject(err));
    child.on('close', (code) => {
      if (code !== 0) {
        return reject(new Error(`${label} failed (code=${code}): ${stderr || stdout}`));
      }
      return resolve(parseJsonOutput(stdout));
    });
  });
}

function shellEscape(value) {
  return `'${String(value ?? '').replace(/'/g, `'"'"'`)}'`;
}

function normalizeResetReason(reason) {
  if (!reason || reason === 'reset') return 'reset';
  if (reason === 'assignment_refresh') return 'reset';
  return 'reset';
}

export function resetSessionViaLocalCli({ sessionKey, reason = 'reset' }) {
  const params = {
    key: sessionKey,
    reason: normalizeResetReason(reason),
  };

  return runCommand(
    OPENCLAW_CLI,
    ['gateway', 'call', 'sessions.reset', '--json', '--params', JSON.stringify(params)],
    'local sessions.reset',
  );
}

export function sendChatViaLocalCli({ sessionKey, message, idempotencyKey }) {
  const params = {
    sessionKey,
    message,
    idempotencyKey,
  };

  return runCommand(
    OPENCLAW_CLI,
    ['gateway', 'call', 'chat.send', '--expect-final', '--json', '--params', JSON.stringify(params)],
    'local chat.send',
  );
}

export function resetSessionViaSshGateway({ gateway, sessionKey, reason = 'reset' }) {
  const destination = getSshDestination(gateway);
  if (!destination) {
    throw new Error(`gateway ${gateway?.id || 'unknown'} 缺少 ssh_destination/ssh_host 配置`);
  }

  const params = JSON.stringify({ key: sessionKey, reason: normalizeResetReason(reason) });
  const remoteCli = gateway?.openclaw_bin || 'openclaw';
  const remoteCommand = `${shellEscape(remoteCli)} gateway call sessions.reset --json --params ${shellEscape(params)}`;

  const args = ['-o', 'BatchMode=yes'];
  if (gateway?.ssh_port) {
    args.push('-p', String(gateway.ssh_port));
  }
  args.push(destination, remoteCommand);

  return runCommand(SSH_CLI, args, `ssh sessions.reset(${gateway?.id || destination})`);
}

export function sendChatViaSshGateway({ gateway, sessionKey, message, idempotencyKey }) {
  const destination = getSshDestination(gateway);
  if (!destination) {
    throw new Error(`gateway ${gateway?.id || 'unknown'} 缺少 ssh_destination/ssh_host 配置`);
  }

  const params = JSON.stringify({ sessionKey, message, idempotencyKey });
  const remoteCli = gateway?.openclaw_bin || 'openclaw';
  const remoteCommand = `${shellEscape(remoteCli)} gateway call chat.send --expect-final --json --params ${shellEscape(params)}`;

  const args = ['-o', 'BatchMode=yes'];
  if (gateway?.ssh_port) {
    args.push('-p', String(gateway.ssh_port));
  }
  args.push(destination, remoteCommand);

  return runCommand(SSH_CLI, args, `ssh chat.send(${gateway?.id || destination})`);
}

export async function deliverChatToGateway({
  targetGatewayId,
  transport,
  targetSessionKey,
  message,
  idempotencyKey,
  resetSession = false,
  resetReason = 'reset',
}) {
  if (!targetSessionKey) {
    throw new Error('target_session_key 缺失，无法投递');
  }

  if ((transport || 'local_cli') === 'local_cli') {
    let reset = null;
    let reset_error = null;
    if (resetSession) {
      try {
        reset = await resetSessionViaLocalCli({ sessionKey: targetSessionKey, reason: resetReason });
      } catch (err) {
        reset_error = err?.message || String(err);
      }
    }
    const send = await sendChatViaLocalCli({ sessionKey: targetSessionKey, message, idempotencyKey });
    if (reset || reset_error) {
      return {
        ...(reset ? { reset } : {}),
        ...(reset_error ? { reset_error } : {}),
        send,
      };
    }
    return send;
  }

  if (transport === 'ssh_gateway_call') {
    const gateway = getGatewayById(targetGatewayId);
    if (!gateway) {
      throw new Error(`未知 gateway: ${targetGatewayId}`);
    }
    let reset = null;
    let reset_error = null;
    if (resetSession) {
      try {
        reset = await resetSessionViaSshGateway({ gateway, sessionKey: targetSessionKey, reason: resetReason });
      } catch (err) {
        reset_error = err?.message || String(err);
      }
    }
    const send = await sendChatViaSshGateway({ gateway, sessionKey: targetSessionKey, message, idempotencyKey });
    if (reset || reset_error) {
      return {
        ...(reset ? { reset } : {}),
        ...(reset_error ? { reset_error } : {}),
        send,
      };
    }
    return send;
  }

  throw new Error(`不支持的 transport: ${transport}`);
}
