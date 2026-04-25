'use strict';

const { verifyAccess } = require('../utils/jwt');
const createLogger = require('../utils/logger');
const log = createLogger('WsAuth');

const AUTH_TIMEOUT_MS = 5000;

/**
 * Wait for the first message from a new WS connection and verify JWT.
 * Resolves with userId on success, rejects (and closes socket) on failure.
 */
function authenticateWs(ws) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      log.warn('Auth timeout, closing connection');
      ws.close(4001, 'Authentication timeout');
      reject(new Error('Auth timeout'));
    }, AUTH_TIMEOUT_MS);

    ws.once('message', (raw) => {
      clearTimeout(timer);

      let msg;
      try {
        msg = JSON.parse(raw);
      } catch {
        log.warn('Invalid JSON in auth message');
        ws.close(4002, 'Invalid JSON');
        return reject(new Error('Invalid JSON'));
      }

      if (msg.type !== 'auth' || !msg.token) {
        log.warn('Expected auth message, got something else');
        ws.close(4003, 'Expected auth message');
        return reject(new Error('Expected auth'));
      }

      try {
        const payload = verifyAccess(msg.token);
        log.info(`WebSocket authenticated: userId=${payload.userId}`);
        resolve(payload.userId);
      } catch {
        log.warn('Invalid token in WS auth');
        ws.close(4004, 'Invalid token');
        reject(new Error('Invalid token'));
      }
    });
  });
}

module.exports = { authenticateWs };
