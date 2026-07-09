// Business-hours check used to decide whether the after-hours AI agent should reply.
// Editable at runtime via PUT /api/settings/business-hours (stored in D1); falls back
// to wrangler.toml [vars] BUSINESS_TZ/BUSINESS_DAYS/BUSINESS_START/BUSINESS_END, then
// to a hardcoded default, so it always resolves to something even if unconfigured.
//
// Config shape: { tz: "Asia/Jakarta", schedule: { Mon: {start,end}, ..., Sat: {start,end} } }
// A day absent from `schedule` is treated as closed all day (e.g. Sun/Sat by default).

const DEFAULT_TZ = 'Asia/Jakarta';
const DEFAULT_SCHEDULE = {
    Mon: { start: '09:00', end: '18:00' },
    Tue: { start: '09:00', end: '18:00' },
    Wed: { start: '09:00', end: '18:00' },
    Thu: { start: '09:00', end: '18:00' },
    Fri: { start: '09:00', end: '18:00' },
};

const DAY_ORDER = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

// Accepts either the current {tz, schedule} shape or the legacy {tz, days, start, end}
// shape (from before per-day hours existed) and always returns the current shape.
function normalizeConfig(raw) {
    if (!raw) return { tz: DEFAULT_TZ, schedule: { ...DEFAULT_SCHEDULE } };
    if (raw.schedule) return { tz: raw.tz ?? DEFAULT_TZ, schedule: raw.schedule };

    const days = raw.days ?? Object.keys(DEFAULT_SCHEDULE);
    const schedule = {};
    for (const d of days) schedule[d] = { start: raw.start ?? '09:00', end: raw.end ?? '18:00' };
    return { tz: raw.tz ?? DEFAULT_TZ, schedule };
}

export async function getBusinessHoursConfig(env) {
    try {
        const row = await env.DB.prepare('SELECT value FROM settings WHERE key = ?').bind('business_hours').first();
        if (row) return normalizeConfig(JSON.parse(row.value));
    } catch (e) {
        console.error('[Hours] Failed to load settings, falling back to env/defaults:', e.message);
    }

    if (env.BUSINESS_TZ || env.BUSINESS_DAYS || env.BUSINESS_START || env.BUSINESS_END) {
        return normalizeConfig({
            tz:    env.BUSINESS_TZ,
            days:  (env.BUSINESS_DAYS ?? 'Mon,Tue,Wed,Thu,Fri').split(',').map(d => d.trim()),
            start: env.BUSINESS_START,
            end:   env.BUSINESS_END,
        });
    }

    return normalizeConfig(null);
}

export async function setBusinessHoursConfig(env, config) {
    await env.DB.prepare(
        'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value'
    ).bind('business_hours', JSON.stringify(config)).run();
}

export async function isBusinessHours(env, at = new Date()) {
    const { tz, schedule } = await getBusinessHoursConfig(env);

    const parts = new Intl.DateTimeFormat('en-US', {
        timeZone: tz, weekday: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
    }).formatToParts(at);

    const weekday   = parts.find(p => p.type === 'weekday').value;
    const todayHours = schedule[weekday];
    if (!todayHours) return false;

    const hour   = parseInt(parts.find(p => p.type === 'hour').value, 10);
    const minute = parseInt(parts.find(p => p.type === 'minute').value, 10);
    const nowMinutes = hour * 60 + minute;

    const [sh, sm] = todayHours.start.split(':').map(Number);
    const [eh, em] = todayHours.end.split(':').map(Number);

    return nowMinutes >= (sh * 60 + sm) && nowMinutes < (eh * 60 + em);
}

// Collapses consecutive days sharing identical hours into ranges,
// e.g. "Mon-Fri 09:00-18:00, Sat 09:00-12:00 (Asia/Jakarta)".
export async function businessHoursText(env) {
    const { tz, schedule } = await getBusinessHoursConfig(env);

    const segments = [];
    let run = null;
    for (const day of DAY_ORDER) {
        const hrs = schedule[day] ?? null;
        const sig = hrs ? `${hrs.start}-${hrs.end}` : null;
        if (run && run.sig === sig) {
            run.last = day;
        } else {
            if (run) segments.push(run);
            run = { first: day, last: day, sig, hrs };
        }
    }
    if (run) segments.push(run);

    const parts = segments
        .filter(s => s.sig)
        .map(s => `${s.first === s.last ? s.first : `${s.first}-${s.last}`} ${s.hrs.start}-${s.hrs.end}`);

    return `${parts.join(', ')} (${tz})`;
}
