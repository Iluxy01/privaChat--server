'use strict';

const createLogger = require('../utils/logger');
const log = createLogger('WsClients');

/** Map<userId, WebSocket> */
const clients = new Map();

function add(userId, ws) {
  clients.set(userId, ws);
  log.info(`Client connected: userId=${userId} (online: ${clients.size})`);
}

function remove(userId) {
  clients.delete(userId);
  log.info(`Client disconnected: userId=${userId} (online: ${clients.size})`);
}

function get(userId) {
  return clients.get(userId) || null;
}

function isOnline(userId) {
  return clients.has(userId);
}

function getOnlineCount() {
  return clients.size;
}

module.exports = { add, remove, get, isOnline, getOnlineCount };
