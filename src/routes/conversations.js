import { Hono }          from 'hono';
import { requireAuth }   from '../lib/auth.js';
import { json, err, now, uuid, compileTemplate } from '../lib/utils.js';
import { MetaClient, buildTemplateComponents } from '../lib/meta.js';
import { broadcastToRoom } from './webhook.js';

const conversations = new Hono();

conversations.use('*', (c, next) => requireAuth(c.env.JWT_SECRET)(c, next));

// ─────────────────────────────────────────────────────────────────
//  POST /api/conversations
//  Starts a brand-new conversation with a candidate who has never
//  messaged in — WhatsApp only allows business-initiated contact via
//  an approved template, so template_name is required (no free text).
//  Body: { candidate_phone, candidate_name?, department?, template_name, vars }
// ─────────────────────────────────────────────────────────────────
conversations.post('/', async (c) => {
    const agent = c.get('agent');
    const { candidate_phone, candidate_name, department, template_name, vars = {} } = await c.req.json();

    if (!candidate_phone) return err('candidate_phone is required');
    if (!template_name)   return err('template_name is required — a new WhatsApp conversation can only start with an approved template');

    const phone = candidate_phone.replace(/[^\d]/g, '');
    if (!phone) return err('candidate_phone must contain digits (E.164 without the leading +)');

    // Non-admins can only start conversations in their own department queue —
    // otherwise they'd create a conversation they can't see themselves.
    const dept = agent.role === 'admin' ? (department ?? agent.department ?? 'general') : agent.department;

    const existing = await c.env.DB.prepare(
        'SELECT id FROM conversations WHERE candidate_phone = ?'
    ).bind(phone).first();
    if (existing) {
        return err('conversation_exists', 409, `A conversation with this number already exists (id ${existing.id}) — open it instead of starting a new one.`);
    }

    const tpl = await c.env.DB.prepare(
        'SELECT * FROM message_templates WHERE name = ? AND is_active = 1'
    ).bind(template_name).first();
    if (!tpl) return err('Template not found or inactive', 404);

    const meta = new MetaClient(c.env);
    const components = buildTemplateComponents(tpl, vars);

    let metaMessageId;
    try {
        const res = await meta.sendTemplate(phone, tpl.name, tpl.language_code, components);
        metaMessageId = res.messages?.[0]?.id;
    } catch (e) {
        console.error('[Meta API] New-conversation template send failed:', JSON.stringify(e));
        return err('meta_api_error', 502, e?.detail ?? e?.message ?? 'Unknown Meta API error');
    }

    const ts    = now();
    const convId = uuid();
    const usedBodyText = compileTemplate(tpl.body_text, vars);

    await c.env.DB.prepare(
        `INSERT INTO conversations (id, candidate_phone, candidate_name, assigned_agent_id, department, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`
    ).bind(convId, phone, candidate_name ?? null, agent.id, dept, ts, ts).run();

    const msgId = uuid();
    await c.env.DB.prepare(
        `INSERT INTO messages (id, conversation_id, sender_type, agent_id, body_text, meta_message_id, status, template_name, created_at)
         VALUES (?, ?, 'agent', ?, ?, ?, 'sent', ?, ?)`
    ).bind(msgId, convId, agent.id, usedBodyText, metaMessageId, tpl.name, ts).run();

    const conv = {
        id: convId, candidate_phone: phone, candidate_name: candidate_name ?? null,
        assigned_agent_id: agent.id, agent_name: agent.name, department: dept,
        status: 'open', last_candidate_message_at: null, created_at: ts, updated_at: ts,
    };
    const savedMsg = {
        id: msgId, conversation_id: convId, sender_type: 'agent', agent_id: agent.id,
        agent_name: agent.name, body_text: usedBodyText, meta_message_id: metaMessageId,
        status: 'sent', template_name: tpl.name, created_at: ts,
    };

    await broadcastToRoom(c.env, { type: 'new_message', conversation: conv, message: savedMsg });

    return json({ conversation: conv, message: savedMsg }, 201);
});

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
