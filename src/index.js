import { Hono }          from 'hono';
import { cors }          from 'hono/cors';
import { InboxRoom }     from './durable/InboxRoom.js';
import { webhook }       from './routes/webhook.js';
import { agents }        from './routes/agents.js';
import { conversations } from './routes/conversations.js';
import { messages }      from './routes/messages.js';
import { templates }     from './routes/templates.js';
import { settings }      from './routes/settings.js';

export { InboxRoom };   // Durable Object export — required by wrangler

const app = new Hono();

// ── CORS ──────────────────────────────────────────────────────────
app.use('/api/*', cors({
    origin:         ['http://localhost:8787', 'https://whatsapp-inbox.YOUR_SUBDOMAIN.workers.dev'],
    allowMethods:   ['GET', 'POST', 'PATCH', 'DELETE', 'OPTIONS'],
    allowHeaders:   ['Content-Type', 'Authorization'],
    exposeHeaders:  ['X-Request-Id'],
    maxAge:         86400,
    credentials:    true,
}));

// ── API Routes ────────────────────────────────────────────────────
app.route('/api/webhooks', webhook);
app.route('/api/auth',     agents);
app.route('/api/agents',   agents);
app.route('/api/conversations', conversations);
app.route('/api/messages',     messages);
app.route('/api/templates',    templates);
app.route('/api/settings',     settings);

// ── WebSocket upgrade — proxied to Durable Object ─────────────────
// GET /ws?token=JWT_TOKEN
app.get('/ws', async (c) => {
    const { verifyToken } = await import('./lib/auth.js');

    const token    = c.req.query('token');
    const claims   = token ? await verifyToken(token, c.env.JWT_SECRET) : null;
    if (!claims) return new Response('Unauthorized', { status: 401 });

    const id   = c.env.INBOX_ROOM.idFromName('global-inbox-room');
    const stub = c.env.INBOX_ROOM.get(id);

    // Forward the WebSocket upgrade to the Durable Object
    const url = new URL(c.req.url);
    url.pathname  = '/ws';
    url.searchParams.set('agent_id',   claims.sub);
    url.searchParams.set('agent_name', claims.name);

    return stub.fetch(new Request(url.toString(), c.req.raw));
});

// ── Health check ──────────────────────────────────────────────────
app.get('/api/health', (c) => c.json({ ok: true, ts: new Date().toISOString() }));

// ── 404 fallback ─────────────────────────────────────────────────
app.notFound((c) => c.json({ error: 'Not found' }, 404));

export default app;
