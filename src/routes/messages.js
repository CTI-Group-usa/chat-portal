import { Hono }                         from 'hono';
import { requireAuth }                  from '../lib/auth.js';
import { json, err, uuid, now,
         hoursSince, compileTemplate }  from '../lib/utils.js';
import { MetaClient, buildTemplateComponents } from '../lib/meta.js';
import { draftAgentReplySuggestion }    from '../lib/ai.js';
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

// ─────────────────────────────────────────────────────────────────
//  POST /api/messages/note
//  Internal, agent-only note — never sent to the candidate. Any active
//  teammate mentioned as "@FirstName" gets flagged in the broadcast so
//  the frontend can toast them.
//  Body: { conversation_id, body_text }
// ─────────────────────────────────────────────────────────────────
messages.post('/note', async (c) => {
    const agent = c.get('agent');
    const { conversation_id, body_text } = await c.req.json();
    if (!conversation_id || !body_text?.trim()) return err('conversation_id and body_text are required');

    const conv = await c.env.DB.prepare('SELECT id FROM conversations WHERE id = ?').bind(conversation_id).first();
    if (!conv) return err('Conversation not found', 404);

    const msgId = uuid();
    const ts    = now();

    await c.env.DB.prepare(
        `INSERT INTO messages (id, conversation_id, sender_type, agent_id, body_text, status, is_internal, created_at)
         VALUES (?, ?, 'agent', ?, ?, 'sent', 1, ?)`
    ).bind(msgId, conversation_id, agent.id, body_text.trim(), ts).run();

    await c.env.DB.prepare('UPDATE conversations SET updated_at = ? WHERE id = ?').bind(ts, conversation_id).run();

    // @mention detection — match "@FirstName" against active teammates' first names.
    const { results: teammates } = await c.env.DB.prepare(
        'SELECT id, name FROM agents WHERE is_active = 1 AND id != ?'
    ).bind(agent.id).all();
    const lowerText = body_text.toLowerCase();
    const mentioned = teammates
        .filter(a => lowerText.includes('@' + a.name.split(' ')[0].toLowerCase()))
        .map(a => a.id);

    const savedMsg = {
        id: msgId, conversation_id, sender_type: 'agent', agent_id: agent.id, agent_name: agent.name,
        body_text: body_text.trim(), status: 'sent', is_internal: 1, created_at: ts,
    };

    await broadcastToRoom(c.env, { type: 'new_message', message: savedMsg, mentions: mentioned, mentioned_by: agent.name });

    return json({ message: savedMsg }, 201);
});

// ─────────────────────────────────────────────────────────────────
//  POST /api/messages/:conversation_id/ai-draft
//  Returns a SUGGESTED reply for the agent to review/edit — never sent
//  automatically. Built from the last 10 customer-facing messages
//  (internal notes excluded so the model isn't confused about what was
//  actually said to the candidate).
// ─────────────────────────────────────────────────────────────────
messages.post('/:conversation_id/ai-draft', async (c) => {
    const convId = c.req.param('conversation_id');

    const conv = await c.env.DB.prepare('SELECT department FROM conversations WHERE id = ?').bind(convId).first();
    if (!conv) return err('Conversation not found', 404);

    const { results: history } = await c.env.DB.prepare(
        `SELECT sender_type, body_text FROM messages
         WHERE conversation_id = ? AND is_internal = 0 AND sender_type != 'system'
         ORDER BY created_at DESC LIMIT 10`
    ).bind(convId).all();

    const draft = await draftAgentReplySuggestion(c.env, history.reverse(), conv.department);
    return json({ draft });
});

export { messages };
