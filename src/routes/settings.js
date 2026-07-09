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
// Body: { tz: "Asia/Jakarta", schedule: { Mon: {start,end}, ..., Sat: {start,end} } }
// A day omitted from `schedule` is closed all day.
settings.put('/business-hours', async (c) => {
    const agent = c.get('agent');
    if (agent.role !== 'admin') return err('Forbidden', 403);

    const { tz, schedule } = await c.req.json();

    if (!tz || typeof tz !== 'string') return err('tz is required (IANA timezone, e.g. Asia/Jakarta)');
    if (!schedule || typeof schedule !== 'object' || Array.isArray(schedule) || !Object.keys(schedule).length) {
        return err('schedule must be a non-empty object of day -> {start, end}');
    }

    for (const [day, hrs] of Object.entries(schedule)) {
        if (!VALID_DAYS.includes(day)) return err(`Invalid day: ${day}`);
        if (!hrs || !TIME_RE.test(hrs.start) || !TIME_RE.test(hrs.end)) {
            return err(`${day}: start/end must be in HH:MM 24h format`);
        }
        if (hrs.start >= hrs.end) return err(`${day}: start time must be before end time`);
    }

    // Validate the timezone is real by letting Intl throw on a bad IANA name.
    try {
        new Intl.DateTimeFormat('en-US', { timeZone: tz });
    } catch {
        return err(`Unrecognized timezone: ${tz}`);
    }

    const config = { tz, schedule };
    await setBusinessHoursConfig(c.env, config);

    return json({ businessHours: config });
});

export { settings };
