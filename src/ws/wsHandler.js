'use strict';

const { v4: uuidv4 } = require('uuid');
const clients = require('./wsClients');
const { query } = require('../db/pool');
const createLogger = require('../utils/logger');
const log = createLogger('WsHandler');

function send(ws, obj) {
  if (ws.readyState === 1 /* OPEN */) {
    ws.send(JSON.stringify(obj));
  }
}

async function handleMessage(ws, userId, msg) {
  const type = msg.type;

  // ── Direct message ──────────────────────────────────────────────
  if (type === 'msg') {
    const { to, payload } = msg;
    log.debug(`Message type=msg from=${userId} to=${to}`);

    const msgId = uuidv4();

    if (clients.isOnline(to)) {
      const recipientWs = clients.get(to);
      send(recipientWs, { type: 'msg', from: userId, msg_id: msgId, payload });
      send(ws, { type: 'delivered', msg_id: msgId });
      log.info(`Message delivered online: from=${userId} to=${to}`);
    } else {
      // Store for later delivery
      await query(
        `INSERT INTO pending_messages (id, to_user_id, from_user_id, payload)
         VALUES ($1, $2, $3, $4)`,
        [msgId, to, userId, JSON.stringify({ msg_id: msgId, from: userId, payload })]
      );
      send(ws, { type: 'delivered', msg_id: msgId });
      log.info(`Message queued: from=${userId} to=${to}`);
    }
    return;
  }

  // ── Group message ────────────────────────────────────────────────
  if (type === 'group_msg') {
    const { to: groupId, payload } = msg;
    log.debug(`Message type=group_msg from=${userId} groupId=${groupId}`);

    // Get group members (except sender)
    const { rows } = await query(
      `SELECT user_id FROM group_members WHERE group_id = $1 AND user_id != $2`,
      [groupId, userId]
    );

    const msgId = uuidv4();
    let onlineCount = 0;
    let offlineCount = 0;

    for (const { user_id } of rows) {
      const outMsg = { type: 'group_msg', from: userId, group_id: groupId, msg_id: msgId, payload };

      if (clients.isOnline(user_id)) {
        send(clients.get(user_id), outMsg);
        onlineCount++;
      } else {
        await query(
          `INSERT INTO pending_messages (id, to_user_id, from_user_id, payload)
           VALUES ($1, $2, $3, $4)`,
          [uuidv4(), user_id, userId, JSON.stringify(outMsg)]
        );
        offlineCount++;
      }
    }

    send(ws, { type: 'delivered', msg_id: msgId });
    log.info(`Group message: groupId=${groupId} online=${onlineCount} offline=${offlineCount}`);
    return;
  }

  // ── Message ACK ──────────────────────────────────────────────────
  if (type === 'msg_ack') {
    const { msg_id } = msg;
    await query(
      `DELETE FROM pending_messages WHERE id = $1 AND to_user_id = $2`,
      [msg_id, userId]
    );
    log.debug(`ACK: msgId=${msg_id} deleted from pending`);
    return;
  }

  // ── Ping ─────────────────────────────────────────────────────────
  if (type === 'ping') {
    send(ws, { type: 'pong' });
    return;
  }

  // ── Unknown ──────────────────────────────────────────────────────
  log.warn(`Unknown type: "${type}" from userId=${userId}`);
  send(ws, { type: 'error', code: 'UNKNOWN_TYPE', message: `Unknown message type: ${type}` });
}

module.exports = { handleMessage };
