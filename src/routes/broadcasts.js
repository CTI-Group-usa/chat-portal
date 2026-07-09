import { Hono }         from 'hono';
import { requireAuth }  from '../lib/auth.js';
import { json, err, uuid, now, compileTemplate } from '../lib/utils.js';
import { MetaClient, buildTemplateComponents }    from '../lib/meta.js';
import { broadcastToRoom } from './webhook.js';

const broadcasts = new Hono();

broadcasts.use('*', (c, next) => requireAuth(c.env.JWT_SECRET)(c, next));

const MAX_RECIPIENTS = 500;
const SEND_DELAY_MS  = 300; // gentle pacing so we don't hammer Meta's rate limits

// ─────────────────────────────────────────────────────────────────
//  POST /api/broadcasts — admin only
//  Body: { template_name, department?, vars?, recipients: [{phone, name}] }
//  `vars` are shared across every recipient EXCEPT key "1", which is
//  always the per-recipient name (matches every seeded template's
//  {{1}} = candidate name convention).
// ─────────────────────────────────────────────────────────────────
broadcasts.post('/', async (c) => {
    const agent = c.get('agent');
    if (agent.role !== 'admin') return err('Forbidden — broadcasts are admin-only', 403);

    const { template_name, department, vars: sharedVars = {}, recipients } = await c.req.json();

    if (!template_name) return err('template_name is required');
    if (!Array.isArray(recipients) || !recipients.length) return err('recipients must be a non-empty array of {phone, name}');
    if (recipients.length > MAX_RECIPIENTS) return err(`Max ${MAX_RECIPIENTS} recipients per broadcast`);

    const dept = department ?? agent.department ?? 'general';

    const tpl = await c.env.DB.prepare(
        'SELECT * FROM message_templates WHERE name = ? AND is_active = 1'
    ).bind(template_name).first();
    if (!tpl) return err('Template not found or inactive', 404);

    const clean = recipients
        .map(r => ({ id: uuid(), phone: String(r.phone ?? '').replace(/[^\d]/g, ''), name: String(r.name ?? '').trim() || null }))
        .filter(r => r.phone);
    if (!clean.length) return err('No valid phone numbers in recipient list');

    const broadcastId = uuid();
    const ts = now();

    await c.env.DB.prepare(
        `INSERT INTO broadcasts (id, template_name, department, created_by, total, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`
    ).bind(broadcastId, tpl.name, dept, agent.id, clean.length, ts).run();

    for (const r of clean) {
        await c.env.DB.prepare(
            `INSERT INTO broadcast_recipients (id, broadcast_id, phone, name) VALUES (?, ?, ?, ?)`
        ).bind(r.id, broadcastId, r.phone, r.name).run();
    }

    c.executionCtx.waitUntil(processBroadcast(c.env, broadcastId, tpl, dept, sharedVars, clean, agent));

    return json({ broadcast: { id: broadcastId, total: clean.length, status: 'running' } }, 202);
});

// ─────────────────────────────────────────────────────────────────
//  GET /api/broadcasts — recent broadcasts (own department unless admin)
// ─────────────────────────────────────────────────────────────────
broadcasts.get('/', async (c) => {
    const agent = c.get('agent');
    const dept  = agent.role === 'admin' ? c.req.query('department') : agent.department;

    let where = '';
    const params = [];
    if (dept) { where = 'WHERE b.department = ?'; params.push(dept); }

    const { results } = await c.env.DB.prepare(
        `SELECT b.*, a.name AS created_by_name
         FROM broadcasts b LEFT JOIN agents a ON a.id = b.created_by
         ${where}
         ORDER BY b.created_at DESC LIMIT 20`
    ).bind(...params).all();

    return json({ broadcasts: results });
});

// ─────────────────────────────────────────────────────────────────
//  GET /api/broadcasts/:id — status + per-recipient results
// ─────────────────────────────────────────────────────────────────
broadcasts.get('/:id', async (c) => {
    const b = await c.env.DB.prepare('SELECT * FROM broadcasts WHERE id = ?').bind(c.req.param('id')).first();
    if (!b) return err('Broadcast not found', 404);

    const { results } = await c.env.DB.prepare(
        'SELECT phone, name, status, error, conversation_id FROM broadcast_recipients WHERE broadcast_id = ? ORDER BY created_at ASC'
    ).bind(b.id).all();

    return json({ broadcast: b, recipients: results });
});

// ─────────────────────────────────────────────────────────────────
//  Background sender — runs via waitUntil, paced to avoid rate limits.
//  Reuses an existing conversation for a phone number if one exists
//  (never creates a duplicate); otherwise starts a new one.
// ─────────────────────────────────────────────────────────────────
async function processBroadcast(env, broadcastId, tpl, dept, sharedVars, recipients, agent) {
    const meta = new MetaClient(env);
    let sent = 0, failed = 0;

    for (const r of recipients) {
        try {
            const vars = { ...sharedVars, 1: r.name ?? sharedVars['1'] ?? '' };
            const components = buildTemplateComponents(tpl, vars);

            let conv = await env.DB.prepare('SELECT * FROM conversations WHERE candidate_phone = ?').bind(r.phone).first();
            const ts = now();

            if (!conv) {
                const convId = uuid();
                await env.DB.prepare(
                    `INSERT INTO conversations (id, candidate_phone, candidate_name, assigned_agent_id, department, created_at, updated_at)
                     VALUES (?, ?, ?, ?, ?, ?, ?)`
                ).bind(convId, r.phone, r.name, agent.id, dept, ts, ts).run();
                conv = { id: convId, candidate_phone: r.phone, candidate_name: r.name, department: dept, assigned_agent_id: agent.id };
            }

            const res = await meta.sendTemplate(r.phone, tpl.name, tpl.language_code, components);
            const metaMessageId = res.messages?.[0]?.id;
            const usedBodyText  = compileTemplate(tpl.body_text, vars);

            const msgId = uuid();
            await env.DB.prepare(
                `INSERT INTO messages (id, conversation_id, sender_type, agent_id, body_text, meta_message_id, status, template_name, created_at)
                 VALUES (?, ?, 'agent', ?, ?, ?, 'sent', ?, ?)`
            ).bind(msgId, conv.id, agent.id, usedBodyText, metaMessageId, tpl.name, ts).run();

            await env.DB.prepare('UPDATE conversations SET updated_at = ? WHERE id = ?').bind(ts, conv.id).run();
            await env.DB.prepare('UPDATE broadcast_recipients SET status = ?, conversation_id = ? WHERE id = ?')
                .bind('sent', conv.id, r.id).run();

            await broadcastToRoom(env, {
                type: 'new_message',
                conversation: { ...conv, updated_at: ts },
                message: {
                    id: msgId, conversation_id: conv.id, sender_type: 'agent', agent_id: agent.id, agent_name: agent.name,
                    body_text: usedBodyText, status: 'sent', template_name: tpl.name, created_at: ts,
                },
            });

            sent++;
        } catch (e) {
            failed++;
            const message = e?.detail ? JSON.stringify(e.detail) : (e?.message ?? 'Unknown error');
            await env.DB.prepare('UPDATE broadcast_recipients SET status = ?, error = ? WHERE id = ?')
                .bind('failed', message.slice(0, 500), r.id).run();
            console.error('[Broadcast] send failed for', r.phone, message);
        }

        await env.DB.prepare('UPDATE broadcasts SET sent_count = ?, failed_count = ? WHERE id = ?')
            .bind(sent, failed, broadcastId).run();

        await new Promise(resolve => setTimeout(resolve, SEND_DELAY_MS));
    }

    await env.DB.prepare("UPDATE broadcasts SET status = 'completed' WHERE id = ?").bind(broadcastId).run();
}

export { broadcasts };
