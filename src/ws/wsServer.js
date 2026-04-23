'use strict';

const WebSocket = require('ws');
const clients = require('./wsClients');
const { authenticateWs } = require('./wsAuth');
const { handleMessage } = require('./wsHandler');
const { query } = require('../db/pool');
const createLogger = require('../utils/logger');
const log = createLogger('WsServer');

const HEARTBEAT_INTERVAL_MS = 30_000;

function createWsServer(httpServer) {
  const wss = new WebSocket.Server({ server: httpServer });

  wss.on('connection', async (ws, req) => {
    const ip = req.headers['x-forwarded-for'] || req.socket.remoteAddress;
    log.info(`New WS connection from IP: ${ip}`);

    let userId;
    try {
      userId = await authenticateWs(ws);
    } catch {
      return; // authenticateWs already closed the socket
    }

    // Mark alive for heartbeat
    ws.isAlive = true;
    ws.on('pong', () => { ws.isAlive = true; });

    // Register client
    clients.add(userId, ws);

    // Flush pending messages
    try {
      const { rows } = await query(
        `SELECT id, payload FROM pending_messages
         WHERE to_user_id = $1 AND expires_at > NOW()
         ORDER BY created_at ASC`,
        [userId]
      );

      log.info(`Delivering ${rows.length} pending messages to userId=${userId}`);

      if (rows.length > 0) {
        ws.send(JSON.stringify({ type: 'pending', messages: rows.map(r => r.payload) }));
      }
    } catch (err) {
      log.error(`Failed to fetch pending messages for userId=${userId}`, err);
    }

    // Send auth_ok
    ws.send(JSON.stringify({ type: 'auth_ok', user_id: userId }));

    // Incoming messages
    ws.on('message', async (raw) => {
      let msg;
      try {
        msg = JSON.parse(raw);
      } catch {
        log.warn(`Invalid JSON from userId=${userId}`);
        ws.send(JSON.stringify({ type: 'error', code: 'INVALID_JSON', message: 'Invalid JSON' }));
        return;
      }

      try {
        await handleMessage(ws, userId, msg);
      } catch (err) {
        log.error(`Handler error for userId=${userId}: ${err.message}`, err);
      }
    });

    ws.on('error', (err) => {
      log.error(`WS error for userId=${userId}: ${err.message}`, err);
    });

    ws.on('close', () => {
      clients.remove(userId);
    });
  });

  // Heartbeat — removes dead connections every 30s
  const heartbeatTimer = setInterval(() => {
    let alive = 0;
    let removed = 0;

    wss.clients.forEach((ws) => {
      if (!ws.isAlive) {
        ws.terminate();
        removed++;
        return;
      }
      ws.isAlive = false;
      ws.ping();
      alive++;
    });

    log.debug(`Heartbeat: ${alive} alive, ${removed} removed`);
  }, HEARTBEAT_INTERVAL_MS);

  wss.on('close', () => clearInterval(heartbeatTimer));

  return wss;
}

module.exports = { createWsServer };
