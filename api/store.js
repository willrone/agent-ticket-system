/**
 * 工单存储层（SQLite-only）
 */
import * as impl from './store-sqlite.js';

export const getAllTickets = impl.getAllTickets;
export const getTicketById = impl.getTicketById;
export const createTicket = impl.createTicket;
export const updateTicket = impl.updateTicket;
export const addComment = impl.addComment;
export const deleteTicket = impl.deleteTicket;
export const deleteTickets = impl.deleteTickets;

// 依赖关系管理
export const addTicketRelation = impl.addTicketRelation;
export const removeTicketRelation = impl.removeTicketRelation;
export const getTicketRelations = impl.getTicketRelations;
export const addDependency = impl.addDependency;
export const removeDependency = impl.removeDependency;
export const getDependencies = impl.getDependencies;
export const getDependencySummaryMap = impl.getDependencySummaryMap;
export const getDependents = impl.getDependents;
export const hasUnmetDependencies = impl.hasUnmetDependencies;
export const listExecutionWorkers = impl.listExecutionWorkers;
export const getExecutionWorker = impl.getExecutionWorker;
export const getExecutionWorkerStats = impl.getExecutionWorkerStats;
export const registerExecutionWorker = impl.registerExecutionWorker;
export const updateExecutionWorker = impl.updateExecutionWorker;
export const terminateActiveExecutionWorkersForTicket = impl.terminateActiveExecutionWorkersForTicket;
export const findRunningTicketConflict = impl.findRunningTicketConflict;
export const getExecutionReservationForTicket = impl.getExecutionReservationForTicket;
export const findExecutionReservationConflict = impl.findExecutionReservationConflict;
export const tryAcquireExecutionReservation = impl.tryAcquireExecutionReservation;
export const updateExecutionReservation = impl.updateExecutionReservation;
export const releaseExecutionReservationByTicket = impl.releaseExecutionReservationByTicket;

export const getAssignmentById = impl.getAssignmentById;
export const getAssignmentByDispatchEventId = impl.getAssignmentByDispatchEventId;
export const findLatestAssignmentForTicket = impl.findLatestAssignmentForTicket;
export const invalidateAssignmentsForTicket = impl.invalidateAssignmentsForTicket;
export const createOrReuseAssignment = impl.createOrReuseAssignment;
export const updateAssignment = impl.updateAssignment;
export const markAssignmentDeliveredByDispatchEvent = impl.markAssignmentDeliveredByDispatchEvent;
export const markAssignmentDeliveryFailedByDispatchEvent = impl.markAssignmentDeliveryFailedByDispatchEvent;
export const getAssignmentHeartbeatByIdempotency = impl.getAssignmentHeartbeatByIdempotency;
export const recordAssignmentHeartbeat = impl.recordAssignmentHeartbeat;
export const getAssignmentReportByIdempotency = impl.getAssignmentReportByIdempotency;
export const createAssignmentReport = impl.createAssignmentReport;
export const finalizeAssignmentReport = impl.finalizeAssignmentReport;
export const listAssignmentReports = impl.listAssignmentReports;

// 事件驱动：domain_events / commands / projections
export const appendDomainEvent = impl.appendDomainEvent;
export const appendCommandLog = impl.appendCommandLog;
export const getCommandById = impl.getCommandById;
export const getPendingCommands = impl.getPendingCommands;
export const updateCommandResult = impl.updateCommandResult;
export const getAggregateVersion = impl.getAggregateVersion;
export const replaceDispatchReadyProjectionForTicket = impl.replaceDispatchReadyProjectionForTicket;
export const replaceAllDispatchReadyProjection = impl.replaceAllDispatchReadyProjection;
export const getDispatchReadyProjection = impl.getDispatchReadyProjection;
export const upsertTicketProjection = impl.upsertTicketProjection;
export const getTicketProjection = impl.getTicketProjection;
export const upsertWorkerProjection = impl.upsertWorkerProjection;
export const getWorkerProjectionForTicket = impl.getWorkerProjectionForTicket;
export const replaceAllAuditReadyProjection = impl.replaceAllAuditReadyProjection;
export const getAuditReadyProjection = impl.getAuditReadyProjection;
export const appendValidationAudit = impl.appendValidationAudit;
export const upsertParticipantRegistryEntry = impl.upsertParticipantRegistryEntry;
export const getParticipantRegistryEntry = impl.getParticipantRegistryEntry;
export const listParticipantRegistryEntries = impl.listParticipantRegistryEntries;
export const syncParticipantRegistryFromTopology = impl.syncParticipantRegistryFromTopology;

// 多 Agent 平台 shadow-mode registry
export const listPlatformAgents = impl.listPlatformAgents;
export const listPlatformCapabilities = impl.listPlatformCapabilities;
export const listPlatformRoleContracts = impl.listPlatformRoleContracts;
export const listPlatformWorkflowTemplates = impl.listPlatformWorkflowTemplates;
export const recordPlatformRoutingDecision = impl.recordPlatformRoutingDecision;
export const listPlatformRoutingDecisions = impl.listPlatformRoutingDecisions;
