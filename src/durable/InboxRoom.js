// Durable Object — maintains all agent WebSocket connections for real-time broadcast.
// One singleton instance (id derived from constant string "global-inbox-room").

export class InboxRoom {
    constructor(state) {
        this.state    = state;
        this.sessions = new Map(); // agentId → WebSocket
    }

    async fetch(request) {
        const url = new URL(request.url);

        if (url.pathname === '/ws') {
            // Upgrade to WebSocket
            if (request.headers.get('Upgrade') !== 'websocket') {
                return new Response('Expected websocket', { status: 426 });
            }

            const agentId   = url.searchParams.get('agent_id') ?? 'anon';
            const agentName = url.searchParams.get('agent_name') ?? 'Unknown';

            const pair   = new WebSocketPair();
            const [client, server] = Object.values(pair);

            this.state.acceptWebSocket(server, [agentId]);
            this.sessions.set(agentId, { ws: server, name: agentName });

            // Notify others that this agent came online
            this.#broadcast({ type: 'agent_online', agent_id: agentId, agent_name: agentName }, agentId);

            return new Response(null, { status: 101, webSocket: client });
        }

        if (url.pathname === '/broadcast' && request.method === 'POST') {
            const payload = await request.json();
            this.#broadcast(payload, null);
            return new Response('ok');
        }

        return new Response('Not found', { status: 404 });
    }

    webSocketMessage(ws, message) {
        // Agents can send typing indicators or ping/pong via WS
        try {
            const data = JSON.parse(message);
            if (data.type === 'ping') ws.send(JSON.stringify({ type: 'pong' }));
            if (data.type === 'typing') {
                const tags = this.state.getTags(ws);
                this.#broadcast({ type: 'typing', agent_id: tags[0] }, tags[0]);
            }
        } catch { /* ignore malformed */ }
    }

    webSocketClose(ws) {
        const tags    = this.state.getTags(ws);
        const agentId = tags[0];
        this.sessions.delete(agentId);
        this.#broadcast({ type: 'agent_offline', agent_id: agentId }, agentId);
    }

    webSocketError(ws) {
        const tags = this.state.getTags(ws);
        this.sessions.delete(tags[0]);
    }

    // Broadcast to ALL connected agent sessions except optional excludeId
    #broadcast(payload, excludeId) {
        const msg = JSON.stringify(payload);
        for (const ws of this.state.getWebSockets()) {
            try {
                const tags = this.state.getTags(ws);
                if (excludeId && tags[0] === excludeId) continue;
                ws.send(msg);
            } catch { /* closed socket — ignore */ }
        }
    }
}
