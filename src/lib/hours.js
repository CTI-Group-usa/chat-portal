// Business-hours check used to decide whether the after-hours AI agent should reply.
// Configurable via wrangler.toml [vars]: BUSINESS_TZ, BUSINESS_DAYS, BUSINESS_START, BUSINESS_END.

export function isBusinessHours(env, at = new Date()) {
    const tz    = env.BUSINESS_TZ    ?? 'Asia/Jakarta';
    const days  = (env.BUSINESS_DAYS ?? 'Mon,Tue,Wed,Thu,Fri').split(',').map(d => d.trim());
    const start = env.BUSINESS_START ?? '09:00';
    const end   = env.BUSINESS_END   ?? '18:00';

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

export function businessHoursText(env) {
    const tz    = env.BUSINESS_TZ    ?? 'Asia/Jakarta';
    const days  = env.BUSINESS_DAYS  ?? 'Mon,Tue,Wed,Thu,Fri';
    const start = env.BUSINESS_START ?? '09:00';
    const end   = env.BUSINESS_END   ?? '18:00';
    return `${start}–${end} ${tz}, ${days}`;
}
