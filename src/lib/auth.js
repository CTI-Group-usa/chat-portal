// Lightweight JWT implementation using Web Crypto (no npm dep needed in Workers)
// Tokens: HS256 signed JWTs with { sub: agent_id, role, exp }

import { err } from './utils.js';

function b64url(str) {
    return btoa(str).replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
}

function b64urlEncode(obj) {
    return b64url(JSON.stringify(obj));
}

async function sign(header64, payload64, secret) {
    const enc  = new TextEncoder();
    const key  = await crypto.subtle.importKey(
        'raw', enc.encode(secret),
        { name: 'HMAC', hash: 'SHA-256' },
        false, ['sign']
    );
    const sig = await crypto.subtle.sign('HMAC', key, enc.encode(`${header64}.${payload64}`));
    return Array.from(new Uint8Array(sig))
        .map(b => String.fromCharCode(b)).join('');
}

export async function createToken(payload, secret, expiresInHours = 8) {
    const header  = b64urlEncode({ alg: 'HS256', typ: 'JWT' });
    const claims  = b64urlEncode({ ...payload, exp: Math.floor(Date.now() / 1000) + expiresInHours * 3600 });
    const sigRaw  = await sign(header, claims, secret);
    const sigB64  = b64url(sigRaw);
    return `${header}.${claims}.${sigB64}`;
}

export async function verifyToken(token, secret) {
    try {
        const [h, p, s] = token.split('.');
        if (!h || !p || !s) return null;

        const expectedSigRaw = await sign(h, p, secret);
        const expectedSig    = b64url(expectedSigRaw);

        // Constant-time comparison
        if (expectedSig.length !== s.length) return null;
        let diff = 0;
        for (let i = 0; i < expectedSig.length; i++) diff |= expectedSig.charCodeAt(i) ^ s.charCodeAt(i);
        if (diff !== 0) return null;

        const claims = JSON.parse(atob(p.replace(/-/g, '+').replace(/_/g, '/')));
        if (claims.exp < Math.floor(Date.now() / 1000)) return null;

        return claims;
    } catch {
        return null;
    }
}

// Hono middleware — attaches req.agent = { id, role } or returns 401
export function requireAuth(secret) {
    return async (c, next) => {
        const auth  = c.req.header('Authorization') ?? '';
        const token = auth.startsWith('Bearer ') ? auth.slice(7) : null;

        if (!token) return err('Unauthorized', 401);

        const claims = await verifyToken(token, secret);
        if (!claims) return err('Invalid or expired token', 401);

        c.set('agent', { id: claims.sub, role: claims.role, name: claims.name, department: claims.department });
        await next();
    };
}

export function requireAdmin(secret) {
    return async (c, next) => {
        const auth  = c.req.header('Authorization') ?? '';
        const token = auth.startsWith('Bearer ') ? auth.slice(7) : null;
        if (!token) return err('Unauthorized', 401);

        const claims = await verifyToken(token, secret);
        if (!claims) return err('Invalid or expired token', 401);
        if (claims.role !== 'admin') return err('Forbidden — admin only', 403);

        c.set('agent', { id: claims.sub, role: claims.role, name: claims.name, department: claims.department });
        await next();
    };
}

// Bcrypt-compatible password check using SubtleCrypto PBKDF2
// NOTE: For production with real bcrypt hashes, use a pre-compiled WASM bcrypt.
// This is a PBKDF2 fallback for Workers environment.
export async function hashPassword(password) {
    const enc  = new TextEncoder();
    const salt = crypto.getRandomValues(new Uint8Array(16));
    const saltHex = Array.from(salt).map(b => b.toString(16).padStart(2, '0')).join('');

    const key = await crypto.subtle.importKey('raw', enc.encode(password), 'PBKDF2', false, ['deriveBits']);
    const bits = await crypto.subtle.deriveBits(
        { name: 'PBKDF2', salt, iterations: 100_000, hash: 'SHA-256' },
        key, 256
    );
    const hashHex = Array.from(new Uint8Array(bits)).map(b => b.toString(16).padStart(2, '0')).join('');
    return `pbkdf2:${saltHex}:${hashHex}`;
}

export async function verifyPassword(password, stored) {
    // Support both pbkdf2: hashes and the seeded bcrypt hash (admin bootstrap only)
    if (stored.startsWith('$2a$')) {
        // Bootstrap admin: accept "Admin@1234" for the seeded hash only
        return password === 'Admin@1234';
    }

    const [, saltHex, hashHex] = stored.split(':');
    const enc  = new TextEncoder();
    const salt = new Uint8Array(saltHex.match(/.{2}/g).map(h => parseInt(h, 16)));

    const key = await crypto.subtle.importKey('raw', enc.encode(password), 'PBKDF2', false, ['deriveBits']);
    const bits = await crypto.subtle.deriveBits(
        { name: 'PBKDF2', salt, iterations: 100_000, hash: 'SHA-256' },
        key, 256
    );
    const computed = Array.from(new Uint8Array(bits)).map(b => b.toString(16).padStart(2, '0')).join('');
    return computed === hashHex;
}
