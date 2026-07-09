import { Hono }                         from 'hono';
import { requireAuth }                  from '../lib/auth.js';
import { json, err, uuid, now,
         hoursSince, compileTemplate }  from '../lib/utils.js';
import { MetaClient, buildTemplateComponents } from '../lib/meta.js';
import { broadcastToRoom }              from './webhook.js';

const messages = new Hono();

messages.use('*', (c, next) => requireAuth(c.env.JWT_SECRET)(c, next));

// ─────────────────────────────────────────────────────────────────
//  GET /api/messages/:conversation_id
//  Paginated message history for a conversation thread
// ─────────────────────────────────────────────────────────────────
messages.get('/:conversation_id', async (c) => {
    const convId = c.req.param('conversation_id');
    const limit  = Math.min(parseInt(c.req.query('limit')  ?? '50'), 100);
    const offset = parseInt(c.req.query('offset') ?? '0');

    const conv = await c.env.DB.prepare(
        'SELECT id FROM conversations WHERE id = ?'
    ).bind(convId).first();
    if (!conv) return err('Conversation not found', 404);

    const { results } = await c.env.DB.prepare(
        `SELECT m.*, a.name AS agent_name
         FROM messages m
         LEFT JOIN agents a ON a.id = m.agent_id
         WHERE m.conversation_id = ?
         ORDER BY m.created_at ASC
         LIMIT ? OFFSET ?`
    ).bind(convId, limit, offset).all();

    return json({ messages: results, limit, offset });
});

// ─────────────────────────────────────────────────────────────────
//  POST /api/messages/send
//  Unified send endpoint — auto-routes to free-text or template
//  based on the 24-hour window.
//
//  Body:
//    { conversation_id, body_text }               ← free-text attempt
//    { conversation_id, template_name, vars:{} }  ← explicit template
// ─────────────────────────────────────────────────────────────────
messages.post('/send', async (c) => {
    const agent  = c.get('agent');
    const body   = await c.req.json();

    const { conversation_id, body_text, template_name, vars = {} } = body;
    if (!conversation_id) return err('conversation_id is required');

    // ── Fetch conversation ───────────────────────────────────────
    const conv = await c.env.DB.prepare(
        'SELECT * FROM conversations WHERE id = ?'
    ).bind(conversation_id).first();
    if (!conv) return err('Conversation not found', 404);

    // ── 24-Hour Window Check ─────────────────────────────────────
    const windowHours    = parseFloat(c.env.WINDOW_HOURS ?? '24');
    const elapsed        = hoursSince(conv.last_candidate_message_at);
    const isInsideWindow = elapsed < windowHours;

    if (!isInsideWindow && !template_name) {
        return err('outside_window', 403,
            `Free-text messaging is locked. The candidate's last message was ${elapsed.toFixed(1)}h ago. ` +
            `You must send an approved template.`
        );
    }

    if (isInsideWindow && !body_text && !template_name) {
        return err('body_text or template_name is required');
    }

    const meta = new MetaClient(c.env);
    let metaMessageId;
    let usedBodyText  = null;
    let usedTemplate  = null;

    try {
        if (isInsideWindow && body_text) {
            // ── Free-text send ───────────────────────────────────
            const res     = await meta.sendText(conv.candidate_phone, body_text);
            metaMessageId = res.messages?.[0]?.id;
            usedBodyText  = body_text;

        } else {
            // ── Template send ────────────────────────────────────
            const tpl = await c.env.DB.prepare(
                'SELECT * FROM message_templates WHERE name = ? AND is_active = 1'
            ).bind(template_name).first();
            if (!tpl) return err('Template not found or inactive', 404);

            const components = buildTemplateComponents(tpl, vars);
            const res        = await meta.sendTemplate(
                conv.candidate_phone, tpl.name, tpl.language_code, components
            );
            metaMessageId = res.messages?.[0]?.id;
            usedBodyText  = compileTemplate(tpl.body_text, vars);
            usedTemplate  = tpl.name;
        }
    } catch (e) {
        console.error('[Meta API] Send failed:', JSON.stringify(e));
        return err('meta_api_error', 502, e?.detail ?? e?.message ?? 'Unknown Meta API error');
    }

    // ── Persist message to DB ────────────────────────────────────
    const msgId = uuid();
    const ts    = now();

    await c.env.DB.prepare(
        `INSERT INTO messages
           (id, conversation_id, sender_type, agent_id, body_text, meta_message_id, status, template_name, created_at)
         VALUES (?, ?, 'agent', ?, ?, ?, 'sent', ?, ?)`
    ).bind(msgId, conversation_id, agent.id, usedBodyText, metaMessageId, usedTemplate, ts).run();

    // Update conversation timestamp
    await c.env.DB.prepare(
        'UPDATE conversations SET updated_at = ? WHERE id = ?'
    ).bind(ts, conversation_id).run();

    const savedMsg = {
        id: msgId, conversation_id, sender_type: 'agent',
        agent_id: agent.id, agent_name: agent.name,
        body_text: usedBodyText, meta_message_id: metaMessageId,
        status: 'sent', template_name: usedTemplate, created_at: ts,
    };

    // Broadcast outgoing message to all dashboards
    await broadcastToRoom(c.env, { type: 'new_message', direction: 'outgoing', message: savedMsg });

    return json({ message: savedMsg }, 201);
});

// ─────────────────────────────────────────────────────────────────
//  GET /api/messages/window/:conversation_id
//  Returns the 24-h window status for the given conversation
// ─────────────────────────────────────────────────────────────────
messages.get('/window/:conversation_id', async (c) => {
    const conv = await c.env.DB.prepare(
        'SELECT last_candidate_message_at FROM conversations WHERE id = ?'
    ).bind(c.req.param('conversation_id')).first();

    if (!conv) return err('Conversation not found', 404);

    const windowHours    = parseFloat(c.env.WINDOW_HOURS ?? '24');
    const elapsed        = hoursSince(conv.last_candidate_message_at);
    const isInsideWindow = elapsed < windowHours;
    const remainingHours = isInsideWindow ? (windowHours - elapsed).toFixed(2) : 0;

    return json({
        is_inside_window:        isInsideWindow,
        elapsed_hours:           elapsed === Infinity ? null : +elapsed.toFixed(2),
        remaining_hours:         +remainingHours,
        last_candidate_message:  conv.last_candidate_message_at,
    });
});

export { messages };
