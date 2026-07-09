import { Hono }         from 'hono';
import { hmacSha256Hex } from '../lib/utils.js';
import { uuid, now }     from '../lib/utils.js';
import { classifyIntent, draftAfterHoursReply } from '../lib/ai.js';
import { isBusinessHours, businessHoursText }    from '../lib/hours.js';
import { MetaClient }    from '../lib/meta.js';

const webhook = new Hono();

// ─────────────────────────────────────────────────────────────────
//  GET  /api/webhooks/whatsapp — Meta subscription handshake
// ─────────────────────────────────────────────────────────────────
webhook.get('/whatsapp', (c) => {
    const mode      = c.req.query('hub.mode');
    const token     = c.req.query('hub.verify_token');
    const challenge = c.req.query('hub.challenge');

    if (mode === 'subscribe' && token === c.env.WHATSAPP_VERIFY_TOKEN) {
        return new Response(challenge, { status: 200, headers: { 'Content-Type': 'text/plain' } });
    }
    return new Response('Verification failed', { status: 403 });
});

// ─────────────────────────────────────────────────────────────────
//  POST  /api/webhooks/whatsapp — incoming events from Meta
// ─────────────────────────────────────────────────────────────────
webhook.post('/whatsapp', async (c) => {
    const rawBody  = await c.req.text();
    const signature = c.req.header('x-hub-signature-256') ?? '';

    // ── 1. HMAC-SHA256 Signature Validation ─────────────────────
    const expectedHex = await hmacSha256Hex(c.env.WHATSAPP_APP_SECRET, rawBody);
    const expected    = `sha256=${expectedHex}`;

    // Constant-time compare via safeEqual on the hex portions
    if (signature !== expected) {
        // Fallback to manual char-by-char to be sure
        const a = signature.replace('sha256=', '');
        const b = expectedHex;
        if (a.length !== b.length) return new Response('Forbidden', { status: 403 });
        let diff = 0;
        for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
        if (diff !== 0) return new Response('Forbidden', { status: 403 });
    }

    // ── 2. Acknowledge Meta immediately ──────────────────────────
    // We respond 200 first, then process. Use waitUntil to keep Worker alive.
    c.executionCtx.waitUntil(processEvent(JSON.parse(rawBody), c.env));

    return new Response('OK', { status: 200 });
});

// ─────────────────────────────────────────────────────────────────
//  Core async event processor
// ─────────────────────────────────────────────────────────────────
async function processEvent(body, env) {
    const value = body?.entry?.[0]?.changes?.[0]?.value;
    if (!value) return;

    try {
        if (value.messages?.length)  await handleIncomingMessage(value, env);
        if (value.statuses?.length)  await handleStatusUpdate(value, env);
    } catch (e) {
        console.error('[Webhook] Processing error:', e);
    }
}

async function handleIncomingMessage(value, env) {
    const msg     = value.messages[0];
    const contact = value.contacts?.[0];

    const phone = msg.from;
    const name  = contact?.profile?.name ?? null;
    const ts    = now();

    // ── Upsert conversation ──────────────────────────────────────
    const existingConv = await env.DB.prepare(
        'SELECT * FROM conversations WHERE candidate_phone = ?'
    ).bind(phone).first();

    let conv;
    if (existingConv) {
        await env.DB.prepare(
            `UPDATE conversations
             SET candidate_name = COALESCE(?, candidate_name),
                 last_candidate_message_at = ?,
                 updated_at = ?,
                 snoozed_until = NULL
             WHERE candidate_phone = ?`
        ).bind(name, ts, ts, phone).run();
        conv = { ...existingConv, last_candidate_message_at: ts, updated_at: ts, snoozed_until: null };

        if (existingConv.snoozed_until) {
            await logSystemEvent(env, conv.id, 'Un-snoozed automatically — candidate replied');
        }
    } else {
        const convId = uuid();
        await env.DB.prepare(
            `INSERT INTO conversations (id, candidate_phone, candidate_name, last_candidate_message_at, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, ?)`
        ).bind(convId, phone, name, ts, ts, ts).run();
        conv = { id: convId, candidate_phone: phone, candidate_name: name, status: 'open',
                 assigned_agent_id: null, last_candidate_message_at: ts, created_at: ts, updated_at: ts };
    }

    // ── Insert message row ───────────────────────────────────────
    const msgId    = uuid();
    const bodyText = msg.type === 'text' ? (msg.text?.body ?? null) : null;
    const mediaType = msg.type !== 'text' ? msg.type : null;

    await env.DB.prepare(
        `INSERT OR IGNORE INTO messages
           (id, conversation_id, sender_type, body_text, media_type, meta_message_id, status, created_at)
         VALUES (?, ?, 'candidate', ?, ?, ?, 'delivered', ?)`
    ).bind(msgId, conv.id, bodyText, mediaType, msg.id, ts).run();

    const savedMsg = { id: msgId, conversation_id: conv.id, sender_type: 'candidate',
                       agent_id: null, body_text: bodyText, media_type: mediaType,
                       meta_message_id: msg.id, status: 'delivered', created_at: ts };

    // ── AI department routing (classify once, first message only) ─
    if (!conv.department) {
        const { department, confidence } = bodyText
            ? await classifyIntent(env, bodyText)
            : { department: 'general', confidence: 0 };

        await env.DB.prepare(
            'UPDATE conversations SET department = ?, intent_confidence = ? WHERE id = ?'
        ).bind(department, confidence, conv.id).run();

        conv.department = department;
        conv.intent_confidence = confidence;

        const pct = Math.round(confidence * 100);
        await logSystemEvent(env, conv.id, `AI routed this conversation to ${department} (${pct}% confidence)`);
    }

    // ── Broadcast to all agent dashboards via Durable Object ─────
    await broadcastToRoom(env, { type: 'new_message', conversation: conv, message: savedMsg });

    // ── After-hours AI auto-reply — acknowledge + set expectations only ─
    if (!(await isBusinessHours(env))) {
        await sendAfterHoursReply(env, conv, bodyText);
    }
}

async function sendAfterHoursReply(env, conv, bodyText) {
    const hoursText = await businessHoursText(env);
    const reply = await draftAfterHoursReply(env, bodyText, conv.department, hoursText);

    try {
        const meta = new MetaClient(env);
        const res  = await meta.sendText(conv.candidate_phone, reply);

        const aiMsgId = uuid();
        const ts      = now();
        await env.DB.prepare(
            `INSERT INTO messages (id, conversation_id, sender_type, body_text, meta_message_id, status, is_ai_generated, created_at)
             VALUES (?, ?, 'agent', ?, ?, 'sent', 1, ?)`
        ).bind(aiMsgId, conv.id, reply, res.messages?.[0]?.id ?? null, ts).run();

        await env.DB.prepare('UPDATE conversations SET updated_at = ? WHERE id = ?').bind(ts, conv.id).run();

        await broadcastToRoom(env, {
            type: 'new_message', direction: 'outgoing',
            message: { id: aiMsgId, conversation_id: conv.id, sender_type: 'agent', agent_id: null,
                       agent_name: 'CTI Assistant', body_text: reply, status: 'sent',
                       is_ai_generated: 1, created_at: ts },
        });
    } catch (e) {
        console.error('[AI] After-hours auto-reply send failed:', e);
    }
}

async function handleStatusUpdate(value, env) {
    const stat = value.statuses[0];

    await env.DB.prepare(
        'UPDATE messages SET status = ? WHERE meta_message_id = ?'
    ).bind(stat.status, stat.id).run();

    await broadcastToRoom(env, {
        type:            'message_status',
        meta_message_id: stat.id,
        status:          stat.status,
        timestamp:       stat.timestamp,
    });
}

// Persists a system-narrated event ("assigned to X", "AI routed to Y") into the
// thread itself (not just a live WS ping) so it's still visible after a reload.
async function logSystemEvent(env, conversationId, text) {
    const id = uuid();
    const ts = now();

    await env.DB.prepare(
        `INSERT INTO messages (id, conversation_id, sender_type, body_text, status, created_at)
         VALUES (?, ?, 'system', ?, 'sent', ?)`
    ).bind(id, conversationId, text, ts).run();

    await broadcastToRoom(env, {
        type: 'new_message',
        message: { id, conversation_id: conversationId, sender_type: 'system', body_text: text, status: 'sent', created_at: ts },
    });

    return { id, created_at: ts };
}

// Calls the Durable Object's /broadcast endpoint
async function broadcastToRoom(env, payload) {
    const id  = env.INBOX_ROOM.idFromName('global-inbox-room');
    const stub = env.INBOX_ROOM.get(id);
    await stub.fetch('https://internal/broadcast', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify(payload),
    });
}

export { webhook, broadcastToRoom, logSystemEvent };
