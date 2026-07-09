import { Hono }                           from 'hono';
import { requireAuth, requireAdmin,
         createToken, hashPassword,
         verifyPassword }                  from '../lib/auth.js';
import { uuid, now, json, err }            from '../lib/utils.js';

const agents = new Hono();

// ── POST /api/auth/login ──────────────────────────────────────────
agents.post('/login', async (c) => {
    const { email, password } = await c.req.json();
    if (!email || !password) return err('email and password required');

    const agent = await c.env.DB.prepare(
        'SELECT * FROM agents WHERE LOWER(email) = LOWER(?) AND is_active = 1'
    ).bind(email.trim()).first();

    if (!agent) return err('Invalid credentials', 401);

    const valid = await verifyPassword(password, agent.password_hash);
    if (!valid)  return err('Invalid credentials', 401);

    const token = await createToken(
        { sub: agent.id, role: agent.role, name: agent.name, department: agent.department },
        c.env.JWT_SECRET
    );

    return json({
        token,
        agent: { id: agent.id, name: agent.name, email: agent.email, role: agent.role, department: agent.department },
    });
});

// ── All routes below require auth ─────────────────────────────────
agents.use('*', (c, next) => requireAuth(c.env.JWT_SECRET)(c, next));

// GET /api/agents/me
agents.get('/me', (c) => {
    return json({ agent: c.get('agent') });
});

// GET /api/agents  (admin only — list all agents)
agents.get('/', async (c) => {
    const caller = c.get('agent');
    if (caller.role !== 'admin') return err('Forbidden', 403);

    const { results } = await c.env.DB.prepare(
        'SELECT id, name, email, role, department, is_active, created_at FROM agents ORDER BY created_at ASC'
    ).all();

    return json({ agents: results });
});

const DEPARTMENTS = ['business', 'recruitment', 'j1', 'general'];

// POST /api/agents  (admin — create new agent)
agents.post('/', async (c) => {
    const caller = c.get('agent');
    if (caller.role !== 'admin') return err('Forbidden', 403);

    const { name, email, password, role = 'recruiter', department = 'business' } = await c.req.json();
    if (!name || !email || !password) return err('name, email, and password required');
    if (!DEPARTMENTS.includes(department)) return err(`department must be one of: ${DEPARTMENTS.join(', ')}`);

    const exists = await c.env.DB.prepare(
        'SELECT id FROM agents WHERE email = ?'
    ).bind(email.toLowerCase().trim()).first();
    if (exists) return err('Email already registered', 409);

    const id   = uuid();
    const hash = await hashPassword(password);
    const ts   = now();

    await c.env.DB.prepare(
        'INSERT INTO agents (id, name, email, password_hash, role, department, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)'
    ).bind(id, name, email.toLowerCase().trim(), hash, role, department, ts).run();

    return json({ agent: { id, name, email, role, department } }, 201);
});

// PATCH /api/agents/:id/password  (agent changes their own password)
agents.patch('/:id/password', async (c) => {
    const caller    = c.get('agent');
    const targetId  = c.req.param('id');

    if (caller.id !== targetId && caller.role !== 'admin') return err('Forbidden', 403);

    const { current_password, new_password } = await c.req.json();
    if (!new_password || new_password.length < 8) return err('new_password must be at least 8 characters');

    const agent = await c.env.DB.prepare('SELECT * FROM agents WHERE id = ?').bind(targetId).first();
    if (!agent) return err('Agent not found', 404);

    if (caller.role !== 'admin') {
        const valid = await verifyPassword(current_password, agent.password_hash);
        if (!valid) return err('Current password is incorrect', 401);
    }

    const hash = await hashPassword(new_password);
    await c.env.DB.prepare('UPDATE agents SET password_hash = ? WHERE id = ?').bind(hash, targetId).run();

    return json({ success: true });
});

// DELETE /api/agents/:id  (admin — deactivate agent)
agents.delete('/:id', async (c) => {
    const caller = c.get('agent');
    if (caller.role !== 'admin') return err('Forbidden', 403);

    const id = c.req.param('id');
    if (id === caller.id) return err('Cannot deactivate yourself');

    await c.env.DB.prepare('UPDATE agents SET is_active = 0 WHERE id = ?').bind(id).run();
    return json({ success: true });
});

export { agents };
