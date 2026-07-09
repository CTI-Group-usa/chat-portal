// Groq-backed intent classification + after-hours auto-reply drafting.
// Requires secret: GROQ_API_KEY. Optional vars: GROQ_MODEL_CLASSIFY, GROQ_MODEL_REPLY.

const DEPARTMENTS = ['business', 'recruitment', 'j1', 'general'];

const DEPT_LABELS = {
    business:    'Business Inquiries',
    recruitment: 'Recruitment',
    j1:          'J1 Program',
    general:     'Customer Support',
};

async function groqChat(env, messages, { json = false, model } = {}) {
    const res = await fetch('https://api.groq.com/openai/v1/chat/completions', {
        method:  'POST',
        headers: {
            Authorization:  `Bearer ${env.GROQ_API_KEY}`,
            'Content-Type': 'application/json',
        },
        body: JSON.stringify({
            model: model ?? (json ? (env.GROQ_MODEL_CLASSIFY ?? 'llama-3.1-8b-instant')
                                   : (env.GROQ_MODEL_REPLY    ?? 'llama-3.3-70b-versatile')),
            messages,
            temperature: json ? 0 : 0.4,
            max_tokens:  json ? 60 : 150,
            ...(json ? { response_format: { type: 'json_object' } } : {}),
        }),
    });
    if (!res.ok) throw new Error(`Groq API error ${res.status}: ${await res.text()}`);
    const data = await res.json();
    return data.choices?.[0]?.message?.content ?? '';
}

// Classifies an inbound message into a department queue.
// Falls back to 'general' (never throws) so a Groq outage never blocks the webhook.
export async function classifyIntent(env, text) {
    if (!env.GROQ_API_KEY || !text) return { department: 'general', confidence: 0 };

    try {
        const content = await groqChat(env, [
            { role: 'system', content:
                'You are an intent router for CTI Group Worldwide Services\' WhatsApp inbox. ' +
                'Classify the inbound message into exactly one department: ' +
                '"business" (general company, partnership, vendor, or media inquiries), ' +
                '"recruitment" (job seekers asking about openings, applications, or interview status — NOT the J1 program), ' +
                '"j1" (anything about the J1 visa cultural exchange / work-and-travel program), ' +
                'or "general" (greetings, too short, or ambiguous). ' +
                'Respond ONLY with compact JSON: {"department":"business|recruitment|j1|general","confidence":0.0-1.0}.' },
            { role: 'user', content: text.slice(0, 1000) },
        ], { json: true });

        const parsed = JSON.parse(content);
        if (!DEPARTMENTS.includes(parsed.department)) throw new Error('unrecognized department: ' + parsed.department);
        return { department: parsed.department, confidence: Number(parsed.confidence) || 0.5 };
    } catch (e) {
        console.error('[AI] classifyIntent failed:', e.message);
        return { department: 'general', confidence: 0 };
    }
}

// Drafts a short after-hours acknowledgment. Deliberately avoids answering
// substantive questions (visa status, pay, legal/immigration) to prevent
// an ungrounded model from giving a candidate wrong information.
export async function draftAfterHoursReply(env, text, department, hoursText) {
    const label = DEPT_LABELS[department] ?? DEPT_LABELS.general;

    try {
        const content = await groqChat(env, [
            { role: 'system', content:
                `You are CTI Group Worldwide Services' after-hours WhatsApp assistant. Write a short (2-3 sentences), ` +
                `warm, professional English reply acknowledging the message below. Tell the sender their message has ` +
                `been received and routed to the ${label} team, and that someone will follow up during business hours ` +
                `(${hoursText}). Do NOT answer specific questions about visa status, pay, contracts, or legal/immigration ` +
                `matters — only acknowledge receipt and set expectations. Use at most one emoji.` },
            { role: 'user', content: (text || '(no text — media message)').slice(0, 1000) },
        ]);
        return content.trim() || fallbackReply(label, hoursText);
    } catch (e) {
        console.error('[AI] draftAfterHoursReply failed:', e.message);
        return fallbackReply(label, hoursText);
    }
}

function fallbackReply(label, hoursText) {
    return `Thanks for reaching out to CTI Group! We've received your message and routed it to our ${label} team. ` +
           `Someone will follow up during business hours (${hoursText}).`;
}

export { DEPARTMENTS, DEPT_LABELS };
