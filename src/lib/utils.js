// Generates a UUID v4 compatible with D1 (no crypto.randomUUID in older runtimes)
export function uuid() {
    return crypto.randomUUID();
}

// Returns current ISO8601 timestamp string for D1 TEXT datetime columns
export function now() {
    return new Date().toISOString();
}

// JSON response helper
export function json(data, status = 200) {
    return new Response(JSON.stringify(data), {
        status,
        headers: { 'Content-Type': 'application/json' },
    });
}

export function err(message, status = 400, detail = null) {
    return json({ error: message, ...(detail ? { detail } : {}) }, status);
}

// Timing-safe string comparison (prevents timing oracle on HMAC)
export async function safeEqual(a, b) {
    const enc = new TextEncoder();
    const ka   = await crypto.subtle.importKey('raw', enc.encode(a), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
    const kb   = await crypto.subtle.importKey('raw', enc.encode(b), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
    const sa   = await crypto.subtle.sign('HMAC', ka, enc.encode('cmp'));
    const sb   = await crypto.subtle.sign('HMAC', kb, enc.encode('cmp'));
    const va   = new Uint8Array(sa);
    const vb   = new Uint8Array(sb);
    if (va.length !== vb.length) return false;
    let diff = 0;
    for (let i = 0; i < va.length; i++) diff |= va[i] ^ vb[i];
    return diff === 0;
}

// Compute HMAC-SHA256 hex digest of a string payload
export async function hmacSha256Hex(secret, payload) {
    const enc  = new TextEncoder();
    const key  = await crypto.subtle.importKey(
        'raw', enc.encode(secret),
        { name: 'HMAC', hash: 'SHA-256' },
        false, ['sign']
    );
    const sig  = await crypto.subtle.sign('HMAC', key, enc.encode(payload));
    return Array.from(new Uint8Array(sig)).map(b => b.toString(16).padStart(2, '0')).join('');
}

// Hours elapsed since an ISO8601 date string
export function hoursSince(isoString) {
    if (!isoString) return Infinity;
    return (Date.now() - new Date(isoString).getTime()) / 3_600_000;
}

// Compile template body: replace {{1}}, {{2}}... with values from vars object
export function compileTemplate(bodyText, vars = {}) {
    return bodyText.replace(/\{\{(\d+)\}\}/g, (_, key) => vars[key] ?? `{{${key}}}`);
}
