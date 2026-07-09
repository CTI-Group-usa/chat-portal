// Business-hours check used to decide whether the after-hours AI agent should reply.
// Editable at runtime via PUT /api/settings/business-hours (stored in D1); falls back
// to wrangler.toml [vars] BUSINESS_TZ/BUSINESS_DAYS/BUSINESS_START/BUSINESS_END, then
// to a hardcoded default, so it always resolves to something even if unconfigured.

const DEFAULT_CONFIG = { tz: 'Asia/Jakarta', days: ['Mon', 'Tue', 'Wed', 'Thu', 'Fri'], start: '09:00', end: '18:00' };

export async function getBusinessHoursConfig(env) {
    try {
        const row = await env.DB.prepare('SELECT value FROM settings WHERE key = ?').bind('business_hours').first();
        if (row) return JSON.parse(row.value);
    } catch (e) {
        console.error('[Hours] Failed to load settings, falling back to env/defaults:', e.message);
    }

    return {
        tz:    env.BUSINESS_TZ    ?? DEFAULT_CONFIG.tz,
        days:  (env.BUSINESS_DAYS ?? DEFAULT_CONFIG.days.join(',')).split(',').map(d => d.trim()),
        start: env.BUSINESS_START ?? DEFAULT_CONFIG.start,
        end:   env.BUSINESS_END   ?? DEFAULT_CONFIG.end,
    };
}

export async function setBusinessHoursConfig(env, config) {
    await env.DB.prepare(
        'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value'
    ).bind('business_hours', JSON.stringify(config)).run();
}

export async function isBusinessHours(env, at = new Date()) {
    const { tz, days, start, end } = await getBusinessHoursConfig(env);

    const parts = new Intl.DateTimeFormat('en-US', {
        timeZone: tz, weekday: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
    }).formatToParts(at);

    const weekday = parts.find(p => p.type === 'weekday').value;
    const hour    = parseInt(parts.find(p => p.type === 'hour').value, 10);
    const minute  = parseInt(parts.find(p => p.type === 'minute').value, 10);
    const nowMinutes = hour * 60 + minute;

    const [sh, sm] = start.split(':').map(Number);
    const [eh, em] = end.split(':').map(Number);

    return days.includes(weekday) && nowMinutes >= (sh * 60 + sm) && nowMinutes < (eh * 60 + em);
}

export async function businessHoursText(env) {
    const { tz, days, start, end } = await getBusinessHoursConfig(env);
    return `${start}–${end} ${tz}, ${days.join('/')}`;
}
