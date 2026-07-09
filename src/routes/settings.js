import { Hono }         from 'hono';
import { requireAuth }  from '../lib/auth.js';
import { json, err }    from '../lib/utils.js';
import { getBusinessHoursConfig, setBusinessHoursConfig } from '../lib/hours.js';

const settings = new Hono();

settings.use('*', (c, next) => requireAuth(c.env.JWT_SECRET)(c, next));

const VALID_DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const TIME_RE    = /^([01]\d|2[0-3]):[0-5]\d$/;

// GET /api/settings/business-hours — any authenticated agent can view
settings.get('/business-hours', async (c) => {
    const config = await getBusinessHoursConfig(c.env);
    return json({ businessHours: config });
});

// PUT /api/settings/business-hours — admin only
settings.put('/business-hours', async (c) => {
    const agent = c.get('agent');
    if (agent.role !== 'admin') return err('Forbidden', 403);

    const { tz, days, start, end } = await c.req.json();

    if (!tz || typeof tz !== 'string') return err('tz is required (IANA timezone, e.g. Asia/Jakarta)');
    if (!Array.isArray(days) || !days.length || !days.every(d => VALID_DAYS.includes(d))) {
        return err(`days must be a non-empty array from: ${VALID_DAYS.join(', ')}`);
    }
    if (!TIME_RE.test(start) || !TIME_RE.test(end)) return err('start/end must be in HH:MM 24h format');

    // Validate the timezone is real by letting Intl throw on a bad IANA name.
    try {
        new Intl.DateTimeFormat('en-US', { timeZone: tz });
    } catch {
        return err(`Unrecognized timezone: ${tz}`);
    }

    const config = { tz, days, start, end };
    await setBusinessHoursConfig(c.env, config);

    return json({ businessHours: config });
});

export { settings };
