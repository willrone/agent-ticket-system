import * as store from './store.js';
import { getStatusMeta } from '../workflow-schema.js';
import { AGENT_API_PREFIX, buildAgentWorkflowSchema, buildCurrentAgentSkillBundle, buildRuntimeContext } from './agent-facing.js';
import { getAgentTopologyRegistry } from './agent-topology.js';
import { getRuntimeVersion } from './runtime-version.js';

function normalizeOptionalText(value, maxLength = 20000) {
  if (value === undefined) return undefined;
  if (value === null) return null;
  const text = String(value).trim();
  return text.slice(0, maxLength);
}

function parseExpectedListParam(value) {
  if (Array.isArray(value)) {
    return value
      .flatMap((item) => parseExpectedListParam(item))
      .filter(Boolean);
  }
  if (typeof value !== 'string') return [];
  return value.split(',').map((item) => item.trim()).filter(Boolean);
}

export function buildLiveAcceptanceGate(ticket, options = {}) {
  const enrichTicket = options.enrichTicketForApi;
  if (typeof enrichTicket !== 'function') {
    throw new Error('buildLiveAcceptanceGate requires options.enrichTicketForApi');
  }

  const enriched = enrichTicket(ticket);
  const assignment = store.findLatestAssignmentForTicket(enriched.id);
  const runtimeContext = buildRuntimeContext({ assignment });
  const bundle = buildCurrentAgentSkillBundle();
  const workflow = buildAgentWorkflowSchema();
  const topology = getAgentTopologyRegistry();

  const expectedBundleVersion = normalizeOptionalText(options.expectedBundleVersion, 255) || null;
  const expectedBundleChecksum = normalizeOptionalText(options.expectedBundleChecksum, 255) || null;
  const requiredTicketActions = parseExpectedListParam(options.requiredTicketActions);
  const requiredBootstrapEndpoints = parseExpectedListParam(options.requiredBootstrapEndpoints);
  const requiredWorkboards = parseExpectedListParam(options.requiredWorkboards);

  const dependencies = store.getDependencies(enriched.id).map((dep) => {
    const depTicket = enrichTicket(store.getTicketById(dep.depends_on_ticket_id) || {
      id: dep.depends_on_ticket_id,
      title: dep.title,
      status: dep.status,
      comments: [],
    });
    return {
      ticket_id: dep.depends_on_ticket_id,
      title: depTicket.title,
      status: depTicket.status,
      counts_as_closed: Boolean(getStatusMeta(depTicket.status)?.counts_as_closed),
      dependency_type: dep.dependency_type || 'blocks',
    };
  });
  const unresolvedDependencies = dependencies.filter((item) => !item.counts_as_closed);

  const bundleTicketActions = Array.isArray(bundle.manifest?.ticket_actions)
    ? bundle.manifest.ticket_actions.map((item) => item.key).filter(Boolean)
    : [];
  const runtimeWorkboards = Array.isArray(runtimeContext.workboards)
    ? runtimeContext.workboards.map((item) => item.key).filter(Boolean)
    : [];

  const contractMismatches = [];
  const warnings = [];

  if (runtimeContext.namespace?.canonical_prefix !== AGENT_API_PREFIX) {
    contractMismatches.push({
      code: 'runtime-namespace-mismatch',
      message: `runtime context canonical_prefix=${runtimeContext.namespace?.canonical_prefix || 'null'}，预期 ${AGENT_API_PREFIX}`,
    });
  }
  if (runtimeContext.auth?.preferred_transport?.name !== 'X-Assignment-Token') {
    contractMismatches.push({
      code: 'auth-transport-mismatch',
      message: `runtime context preferred auth=${runtimeContext.auth?.preferred_transport?.name || 'null'}，预期 X-Assignment-Token`,
    });
  }
  if (runtimeContext.request_id?.header !== 'X-Request-Id' || runtimeContext.request_id?.error_field !== 'request_id') {
    contractMismatches.push({
      code: 'request-id-contract-mismatch',
      message: 'runtime context request_id contract 与当前 canonical 约定不一致',
    });
  }
  if (runtimeContext.error_model?.shape?.detail !== 'string' || runtimeContext.error_model?.shape?.request_id !== 'string') {
    contractMismatches.push({
      code: 'error-model-mismatch',
      message: 'runtime context error_model 未保持 {detail, request_id} canonical 形状',
    });
  }
  if (runtimeContext.skill_ref?.version !== bundle.version || runtimeContext.playbook_ref?.version !== bundle.version) {
    contractMismatches.push({
      code: 'bundle-version-mismatch',
      message: 'runtime context 引用的 bundle version 与 live hosted bundle 不一致',
      evidence: {
        runtime_skill_version: runtimeContext.skill_ref?.version || null,
        runtime_playbook_version: runtimeContext.playbook_ref?.version || null,
        live_bundle_version: bundle.version,
      },
    });
  }
  if (runtimeContext.skill_ref?.checksum_sha256 !== bundle.checksum_sha256 || runtimeContext.playbook_ref?.checksum_sha256 !== bundle.checksum_sha256) {
    contractMismatches.push({
      code: 'bundle-checksum-mismatch',
      message: 'runtime context 引用的 checksum 与 live hosted bundle 不一致',
      evidence: {
        runtime_skill_checksum: runtimeContext.skill_ref?.checksum_sha256 || null,
        runtime_playbook_checksum: runtimeContext.playbook_ref?.checksum_sha256 || null,
        live_bundle_checksum: bundle.checksum_sha256,
      },
    });
  }

  for (const key of requiredTicketActions) {
    if (!bundleTicketActions.includes(key)) {
      contractMismatches.push({
        code: 'missing-ticket-action',
        message: `live hosted bundle 缺少 required ticket action: ${key}`,
      });
    }
  }

  for (const key of requiredBootstrapEndpoints) {
    if (!runtimeContext.bootstrap?.[key]) {
      contractMismatches.push({
        code: 'missing-bootstrap-endpoint',
        message: `runtime context 缺少 required bootstrap endpoint: ${key}`,
      });
    }
  }

  for (const key of requiredWorkboards) {
    if (!runtimeWorkboards.includes(key)) {
      contractMismatches.push({
        code: 'missing-workboard',
        message: `runtime context 缺少 required workboard: ${key}`,
      });
    }
  }

  if (!runtimeContext.api_base_url) {
    warnings.push({
      code: 'api-base-url-missing',
      message: 'runtime context 未提供 api_base_url，reviewer 无法据此确认 agent 应访问的 live 平台地址',
    });
  }
  if (!topology?.main_gateway_id) {
    warnings.push({
      code: 'gateway-topology-missing',
      message: 'agent topology 缺少 main_gateway_id，gateway 健康信号不完整',
    });
  }
  if (!assignment) {
    warnings.push({
      code: 'assignment-missing',
      message: 'ticket 当前没有 live assignment，无法完整验证 assignment/runtime/receipt 断面',
    });
  }
  if (enriched.execution_mode !== 'direct' && !enriched.execution_guard?.has_active_execution_evidence) {
    warnings.push({
      code: 'worker-evidence-missing',
      message: `execution_mode=${enriched.execution_mode} 但当前缺少活跃 worker 执行证据（历史 succeeded 不算新开工），live 收口仍可能被 guard 拦截`,
    });
  }

  let verdict = 'pass';
  if (expectedBundleVersion && expectedBundleVersion !== bundle.version) {
    verdict = 'live-not-upgraded';
  } else if (expectedBundleChecksum && expectedBundleChecksum !== bundle.checksum_sha256) {
    verdict = 'live-not-upgraded';
  } else if (unresolvedDependencies.length > 0) {
    verdict = 'dependency-not-closed';
  } else if (contractMismatches.length > 0) {
    verdict = 'contract-mismatch';
  } else if (warnings.length > 0) {
    verdict = 'partial';
  }

  const summaryMap = {
    pass: 'live acceptance gate 通过：关键 live contract 断面已对齐。',
    partial: 'live acceptance gate 部分通过：核心 contract 可读，但仍有 live 健康/证据缺口。',
    'live-not-upgraded': 'live acceptance gate 判定 live-not-upgraded：当前 live bundle/version 尚未达到预期。',
    'contract-mismatch': 'live acceptance gate 判定 contract-mismatch：live 断面之间存在 contract 不一致。',
    'dependency-not-closed': 'live acceptance gate 判定 dependency-not-closed：仍有未闭合依赖阻止 reviewer 视作完整交付。',
  };

  return {
    verdict,
    summary: summaryMap[verdict],
    ticket: {
      id: enriched.id,
      status: enriched.status,
      current_actor: enriched.current_actor,
      current_actor_source: enriched.current_actor_source,
      execution_mode: enriched.execution_mode,
      execution_guard: enriched.execution_guard,
    },
    live_surfaces: {
      workflow_schema: {
        status_count: Array.isArray(workflow.statuses) ? workflow.statuses.length : 0,
        action_count: Array.isArray(workflow.actions) ? workflow.actions.length : 0,
      },
      runtime_context: {
        api_base_url: runtimeContext.api_base_url,
        canonical_prefix: runtimeContext.namespace?.canonical_prefix || null,
        auth_transport: runtimeContext.auth?.preferred_transport?.name || null,
        skill_ref: runtimeContext.skill_ref || null,
        playbook_ref: runtimeContext.playbook_ref || null,
      },
      hosted_bundle: {
        version: bundle.version,
        checksum_sha256: bundle.checksum_sha256,
        ticket_actions: bundleTicketActions,
        workboards: runtimeWorkboards,
      },
      assignment: assignment ? {
        assignment_id: assignment.assignment_id,
        assignment_status: assignment.assignment_status,
        gateway_id: assignment.gateway_id || null,
        transport: assignment.transport || null,
      } : null,
      topology: {
        main_gateway_id: topology?.main_gateway_id || null,
        gateway_count: topology?.gateways ? Object.keys(topology.gateways).length : 0,
      },
      runtime_version: getRuntimeVersion(),
      dependencies: {
        total: dependencies.length,
        unresolved: unresolvedDependencies.length,
        items: dependencies,
      },
    },
    expectations: {
      expected_bundle_version: expectedBundleVersion,
      expected_bundle_checksum: expectedBundleChecksum,
      required_ticket_actions: requiredTicketActions,
      required_bootstrap_endpoints: requiredBootstrapEndpoints,
      required_workboards: requiredWorkboards,
    },
    issues: {
      contract_mismatches: contractMismatches,
      warnings,
      unresolved_dependencies: unresolvedDependencies,
      live_not_upgraded: verdict === 'live-not-upgraded' ? {
        expected_bundle_version: expectedBundleVersion,
        expected_bundle_checksum: expectedBundleChecksum,
        actual_bundle_version: bundle.version,
        actual_bundle_checksum: bundle.checksum_sha256,
      } : null,
    },
    generated_at: new Date().toISOString(),
  };
}
