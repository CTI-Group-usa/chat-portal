// Meta WhatsApp Cloud API client

export class MetaClient {
    constructor(env) {
        this.token   = env.WHATSAPP_TOKEN;
        this.phoneId = env.WHATSAPP_PHONE_NUMBER_ID;
        this.version = env.GRAPH_API_VERSION ?? 'v20.0';
        this.base    = `https://graph.facebook.com/${this.version}`;
    }

    async post(path, body) {
        const res = await fetch(`${this.base}${path}`, {
            method:  'POST',
            headers: {
                Authorization:  `Bearer ${this.token}`,
                'Content-Type': 'application/json',
            },
            body: JSON.stringify(body),
        });
        const data = await res.json();
        if (!res.ok) throw { status: res.status, detail: data };
        return data;
    }

    // ── Free-text message (inside 24-h window) ──────────────────
    sendText(to, text) {
        return this.post(`/${this.phoneId}/messages`, {
            messaging_product: 'whatsapp',
            recipient_type:    'individual',
            to,
            type: 'text',
            text: { preview_url: false, body: text },
        });
    }

    // ── Template message (outside 24-h window) ──────────────────
    sendTemplate(to, templateName, languageCode, components = []) {
        return this.post(`/${this.phoneId}/messages`, {
            messaging_product: 'whatsapp',
            recipient_type:    'individual',
            to,
            type: 'template',
            template: {
                name:       templateName,
                language:   { code: languageCode },
                components,
            },
        });
    }

    // ── Media message (inside 24-h window) ──────────────────────
    sendMedia(to, type, mediaUrl, caption = '') {
        return this.post(`/${this.phoneId}/messages`, {
            messaging_product: 'whatsapp',
            recipient_type:    'individual',
            to,
            type,
            [type]: { link: mediaUrl, ...(caption ? { caption } : {}) },
        });
    }

    // ── Mark message as read ─────────────────────────────────────
    markRead(metaMessageId) {
        return this.post(`/${this.phoneId}/messages`, {
            messaging_product: 'whatsapp',
            status:            'read',
            message_id:        metaMessageId,
        });
    }
}

// Build template components array from local template record + caller-supplied vars
// vars = { "1": "John Dela Cruz", "2": "June 15, 10:00 AM" }
export function buildTemplateComponents(template, vars = {}) {
    const parsed   = JSON.parse(template.variables ?? '[]');
    const bodyParams = parsed.map(v => ({
        type: 'text',
        text: vars[v.key] ?? `{{${v.key}}}`,
    }));

    const components = [];

    if (template.header_text) {
        components.push({
            type:       'header',
            parameters: [{ type: 'text', text: template.header_text }],
        });
    }

    if (bodyParams.length) {
        components.push({ type: 'body', parameters: bodyParams });
    }

    return components;
}
