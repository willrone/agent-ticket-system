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
export const getDependents = impl.getDependents;
export const hasUnmetDependencies = impl.hasUnmetDependencies;
export const listExecutionWorkers = impl.listExecutionWorkers;
export const getExecutionWorker = impl.getExecutionWorker;
export const getExecutionWorkerStats = impl.getExecutionWorkerStats;
export const registerExecutionWorker = impl.registerExecutionWorker;
export const updateExecutionWorker = impl.updateExecutionWorker;
export const terminateActiveExecutionWorkersForTicket = impl.terminateActiveExecutionWorkersForTicket;
export const findRunningTicketConflict = impl.findRunningTicketConflict;

export const getAssignmentById = impl.getAssignmentById;
export const getAssignmentByDispatchEventId = impl.getAssignmentByDispatchEventId;
export const findLatestAssignmentForTicket = impl.findLatestAssignmentForTicket;
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
