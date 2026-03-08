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
export const addDependency = impl.addDependency;
export const removeDependency = impl.removeDependency;
export const getDependencies = impl.getDependencies;
export const getDependents = impl.getDependents;
export const hasUnmetDependencies = impl.hasUnmetDependencies;
