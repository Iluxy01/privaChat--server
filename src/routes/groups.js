'use strict';

const express = require('express');
const { query } = require('../db/pool');
const authMiddleware = require('../middleware/auth');
const createLogger = require('../utils/logger');
const log = createLogger('Groups');

const router = express.Router();
router.use(authMiddleware);

// POST /api/groups — create group
router.post('/', async (req, res) => {
  const { name, members } = req.body; // members: [{userId, encryptedGroupKey}]
  const ownerId = req.userId;

  if (!name || !name.trim()) {
    return res.status(400).json({ error: 'Group name is required' });
  }
  if (!Array.isArray(members) || members.length === 0) {
    return res.status(400).json({ error: 'At least one member is required' });
  }

  try {
    const groupResult = await query(
      `INSERT INTO groups (name, owner_id) VALUES ($1, $2) RETURNING id`,
      [name.trim(), ownerId]
    );
    const groupId = groupResult.rows[0].id;

    // Add owner as member (they must provide their own encrypted key)
    for (const m of members) {
      await query(
        `INSERT INTO group_members (group_id, user_id, encrypted_group_key)
         VALUES ($1, $2, $3) ON CONFLICT DO NOTHING`,
        [groupId, m.userId, m.encryptedGroupKey]
      );
    }

    log.info(`Group created: id=${groupId} name=${name} members=${members.length}`);
    return res.status(201).json({ id: groupId, name, ownerId });
  } catch (err) {
    log.error('Create group error', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

// GET /api/groups/:id — get group info
router.get('/:id', async (req, res) => {
  const { id } = req.params;
  log.debug(`Group info: groupId=${id}`);

  try {
    const { rows } = await query(
      `SELECT g.id, g.name, g.owner_id, g.created_at,
              array_agg(gm.user_id) AS member_ids
       FROM groups g
       LEFT JOIN group_members gm ON gm.group_id = g.id
       WHERE g.id = $1
       GROUP BY g.id`,
      [id]
    );

    if (rows.length === 0) {
      return res.status(404).json({ error: 'Group not found' });
    }

    const g = rows[0];

    // Only members can see group info
    if (!g.member_ids.includes(req.userId)) {
      return res.status(403).json({ error: 'Forbidden' });
    }

    return res.json({
      id: g.id,
      name: g.name,
      ownerId: g.owner_id,
      memberIds: g.member_ids,
      createdAt: g.created_at,
    });
  } catch (err) {
    log.error('Get group error', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

// POST /api/groups/:id/members — add member
router.post('/:id/members', async (req, res) => {
  const { id: groupId } = req.params;
  const { userId, encryptedGroupKey } = req.body;

  try {
    // Only owner can add members
    const { rows } = await query(
      `SELECT owner_id FROM groups WHERE id = $1`,
      [groupId]
    );
    if (rows.length === 0) return res.status(404).json({ error: 'Group not found' });
    if (rows[0].owner_id !== req.userId) {
      return res.status(403).json({ error: 'Only the group owner can add members' });
    }

    await query(
      `INSERT INTO group_members (group_id, user_id, encrypted_group_key)
       VALUES ($1, $2, $3) ON CONFLICT (group_id, user_id)
       DO UPDATE SET encrypted_group_key = EXCLUDED.encrypted_group_key`,
      [groupId, userId, encryptedGroupKey]
    );

    log.info(`Member added: userId=${userId} to groupId=${groupId}`);
    return res.json({ status: 'ok' });
  } catch (err) {
    log.error('Add member error', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

// DELETE /api/groups/:id/members/:userId — remove member
router.delete('/:id/members/:userId', async (req, res) => {
  const { id: groupId, userId: targetId } = req.params;

  try {
    const { rows } = await query(
      `SELECT owner_id FROM groups WHERE id = $1`,
      [groupId]
    );
    if (rows.length === 0) return res.status(404).json({ error: 'Group not found' });

    const isOwner = rows[0].owner_id === req.userId;
    const isSelf  = targetId === req.userId;

    if (!isOwner && !isSelf) {
      return res.status(403).json({ error: 'Forbidden' });
    }

    await query(
      `DELETE FROM group_members WHERE group_id = $1 AND user_id = $2`,
      [groupId, targetId]
    );

    log.info(`Member removed: userId=${targetId} from groupId=${groupId}`);
    return res.json({ status: 'ok' });
  } catch (err) {
    log.error('Remove member error', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

// GET /api/groups/:id/keys — get my encrypted group key
router.get('/:id/keys', async (req, res) => {
  const { id: groupId } = req.params;

  try {
    const { rows } = await query(
      `SELECT encrypted_group_key FROM group_members
       WHERE group_id = $1 AND user_id = $2`,
      [groupId, req.userId]
    );

    if (rows.length === 0) {
      return res.status(403).json({ error: 'Not a member of this group' });
    }

    return res.json({ encryptedGroupKey: rows[0].encrypted_group_key });
  } catch (err) {
    log.error('Get group key error', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

// PUT /api/groups/:id/keys — rotate all group keys (after member removal)
router.put('/:id/keys', async (req, res) => {
  const { id: groupId } = req.params;
  const { keys } = req.body; // [{userId, encryptedGroupKey}]

  try {
    const { rows } = await query(
      `SELECT owner_id FROM groups WHERE id = $1`,
      [groupId]
    );
    if (rows.length === 0) return res.status(404).json({ error: 'Group not found' });
    if (rows[0].owner_id !== req.userId) {
      return res.status(403).json({ error: 'Only the owner can rotate keys' });
    }

    for (const { userId, encryptedGroupKey } of keys) {
      await query(
        `UPDATE group_members SET encrypted_group_key = $1
         WHERE group_id = $2 AND user_id = $3`,
        [encryptedGroupKey, groupId, userId]
      );
    }

    log.info(`Group keys rotated: groupId=${groupId} keys=${keys.length}`);
    return res.json({ status: 'ok' });
  } catch (err) {
    log.error('Rotate keys error', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

module.exports = router;
