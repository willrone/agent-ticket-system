/**
 * 工单存储层（SQLite-only）
 */
import * as impl from './store-sqlite.js';

export const getAllTickets = impl.getAllTickets;
export const getTicketById = impl.getTicketById;
export const createTicket = impl.createTicket;
export const updateTicket = impl.updateTicket;
export const addComment = impl.addComment;
