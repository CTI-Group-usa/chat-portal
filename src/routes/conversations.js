import { Hono }          from 'hono';
import { requireAuth }   from '../lib/auth.js';
import { json, err, now } from '../lib/utils.js';
import { broadcastToRoom } from './webhook.js';

const conversations = new Hono();

conversations.use('*', (c, next) => requireAuth(c.env.JWT_SECRET)(c, next));

// ─────────────────────────────────────────────────────────────────
//  GET /api/conversations
//  ?queue=unassigned | mine | all   (default: all)
//  ?status=open | resolved | pending
//  ?limit=50&offset=0
// ─────────────────────────────────────────────────────────────────
conversations.get('/', async (c) => {
    const agent   = c.get('agent');
    const queue   = c.req.query('queue')  ?? 'all';
    const status  = c.req.query('status') ?? 'open';
    const limit   = Math.min(parseInt(c.req.query('limit')  ?? '50'), 100);
    const offset  = parseInt(c.req.query('offset') ?? '0');

    let where  = 'WHERE c.status = ?';
    const params = [status];

    if (queue === 'unassigned') {
        where += ' AND c.assigned_agent_id IS NULL';
    } else if (queue === 'mine') {
        where += ' AND c.assigned_agent_id = ?';
        params.push(agent.id);
    }

    // Non-admins only ever see conversations routed to their own department.
    // Admins can optionally filter with ?department=, or omit it to see all.
    const dept = agent.role === 'admin' ? c.req.query('department') : agent.department;
    if (dept) {
        where += ' AND c.department = ?';
        params.push(dept);
    }

    params.push(limit, offset);

    const { results } = await c.env.DB.prepare(
        `SELECT c.*,
                a.name AS agent_name,
                m.body_text AS last_message,
                m.created_at AS last_message_at,
                m.sender_type AS last_sender_type,
                (SELECT COUNT(*) FROM messages
                 WHERE conversation_id = c.id AND sender_type = 'candidate'
                   AND status = 'delivered') AS unread_count
         FROM conversations c
         LEFT JOIN agents a ON a.id = c.assigned_agent_id
         LEFT JOIN messages m ON m.id = (
             SELECT id FROM messages WHERE conversation_id = c.id
             ORDER BY created_at DESC LIMIT 1
         )
         ${where}
         ORDER BY c.updated_at DESC
         LIMIT ? OFFSET ?`
    ).bind(...params).all();

    return json({ conversations: results, limit, offset });
});

// ─────────────────────────────────────────────────────────────────
//  GET /api/conversations/:id
// ─────────────────────────────────────────────────────────────────
conversations.get('/:id', async (c) => {
    const conv = await c.env.DB.prepare(
        `SELECT c.*, a.name AS agent_name
         FROM conversations c
         LEFT JOIN agents a ON a.id = c.assigned_agent_id
         WHERE c.id = ?`
    ).bind(c.req.param('id')).first();

    if (!conv) return err('Conversation not found', 404);
    return json({ conversation: conv });
});

// ─────────────────────────────────────────────────────────────────
//  POST /api/conversations/:id/claim
//  Assigns this conversation to the calling agent
// ─────────────────────────────────────────────────────────────────
conversations.post('/:id/claim', async (c) => {
    const agent  = c.get('agent');
    const convId = c.req.param('id');

    const conv = await c.env.DB.prepare(
        'SELECT * FROM conversations WHERE id = ?'
    ).bind(convId).first();

    if (!conv) return err('Conversation not found', 404);

    if (conv.assigned_agent_id && conv.assigned_agent_id !== agent.id) {
        return err('already_claimed', 409, `Already claimed by agent ${conv.assigned_agent_id}`);
    }

    const ts = now();
    await c.env.DB.prepare(
        'UPDATE conversations SET assigned_agent_id = ?, updated_at = ? WHERE id = ?'
    ).bind(agent.id, ts, convId).run();

    await broadcastToRoom(c.env, {
        type:            'conversation_claimed',
        conversation_id: convId,
        agent_id:        agent.id,
        agent_name:      agent.name,
    });

    return json({ success: true, conversation_id: convId, agent_id: agent.id });
});

// ─────────────────────────────────────────────────────────────────
//  POST /api/conversations/:id/release
//  Puts the conversation back into the unassigned queue
// ─────────────────────────────────────────────────────────────────
conversations.post('/:id/release', async (c) => {
    const agent  = c.get('agent');
    const convId = c.req.param('id');

    const conv = await c.env.DB.prepare(
        'SELECT * FROM conversations WHERE id = ?'
    ).bind(convId).first();

    if (!conv) return err('Conversation not found', 404);
    if (conv.assigned_agent_id !== agent.id && agent.role !== 'admin') {
        return err('Forbidden — you do not own this conversation', 403);
    }

    const ts = now();
    await c.env.DB.prepare(
        'UPDATE conversations SET assigned_agent_id = NULL, updated_at = ? WHERE id = ?'
    ).bind(ts, convId).run();

    await broadcastToRoom(c.env, {
        type:            'conversation_released',
        conversation_id: convId,
    });

    return json({ success: true });
});

// ─────────────────────────────────────────────────────────────────
//  PATCH /api/conversations/:id/status
//  { "status": "resolved" | "pending" | "open" }
// ─────────────────────────────────────────────────────────────────
conversations.patch('/:id/status', async (c) => {
    const { status } = await c.req.json();
    const valid       = ['open', 'pending', 'resolved'];
    if (!valid.includes(status)) return err(`status must be one of: ${valid.join(', ')}`);

    const convId = c.req.param('id');
    const ts     = now();

    const result = await c.env.DB.prepare(
        'UPDATE conversations SET status = ?, updated_at = ? WHERE id = ?'
    ).bind(status, ts, convId).run();

    if (result.meta.changes === 0) return err('Conversation not found', 404);

    await broadcastToRoom(c.env, {
        type:            'conversation_status_changed',
        conversation_id: convId,
        status,
    });

    return json({ success: true, status });
});

export { conversations };
