import { Hono }        from 'hono';
import { requireAuth } from '../lib/auth.js';
import { json, err, uuid } from '../lib/utils.js';

const templates = new Hono();

templates.use('*', (c, next) => requireAuth(c.env.JWT_SECRET)(c, next));

// GET /api/templates  — list all active templates
templates.get('/', async (c) => {
    const { results } = await c.env.DB.prepare(
        'SELECT * FROM message_templates WHERE is_active = 1 ORDER BY name ASC'
    ).all();

    // Parse variables JSON for each template
    const parsed = results.map(t => ({
        ...t,
        variables: JSON.parse(t.variables ?? '[]'),
    }));

    return json({ templates: parsed });
});

// GET /api/templates/:id
templates.get('/:id', async (c) => {
    const tpl = await c.env.DB.prepare(
        'SELECT * FROM message_templates WHERE id = ?'
    ).bind(c.req.param('id')).first();

    if (!tpl) return err('Template not found', 404);
    return json({ template: { ...tpl, variables: JSON.parse(tpl.variables ?? '[]') } });
});

// POST /api/templates  (admin only — add new template)
templates.post('/', async (c) => {
    const agent = c.get('agent');
    if (agent.role !== 'admin') return err('Forbidden', 403);

    const { name, language_code = 'en_US', category = 'UTILITY',
            header_text, body_text, footer_text, variables = [] } = await c.req.json();

    if (!name || !body_text) return err('name and body_text are required');

    const id = uuid();
    await c.env.DB.prepare(
        `INSERT INTO message_templates (id, name, language_code, category, header_text, body_text, footer_text, variables)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    ).bind(id, name, language_code, category, header_text ?? null,
           body_text, footer_text ?? null, JSON.stringify(variables)).run();

    return json({ template: { id, name, language_code, category, body_text, variables } }, 201);
});

// PATCH /api/templates/:id  (admin only — update)
templates.patch('/:id', async (c) => {
    const agent = c.get('agent');
    if (agent.role !== 'admin') return err('Forbidden', 403);

    const id      = c.req.param('id');
    const updates = await c.req.json();
    const allowed = ['header_text', 'body_text', 'footer_text', 'variables', 'is_active', 'language_code'];

    const sets   = [];
    const params = [];

    for (const key of allowed) {
        if (key in updates) {
            sets.push(`${key} = ?`);
            params.push(key === 'variables' ? JSON.stringify(updates[key]) : updates[key]);
        }
    }

    if (!sets.length) return err('No valid fields to update');
    params.push(id);

    await c.env.DB.prepare(
        `UPDATE message_templates SET ${sets.join(', ')} WHERE id = ?`
    ).bind(...params).run();

    return json({ success: true });
});

// DELETE /api/templates/:id  (admin — soft delete)
templates.delete('/:id', async (c) => {
    const agent = c.get('agent');
    if (agent.role !== 'admin') return err('Forbidden', 403);

    await c.env.DB.prepare(
        'UPDATE message_templates SET is_active = 0 WHERE id = ?'
    ).bind(c.req.param('id')).run();

    return json({ success: true });
});

export { templates };
