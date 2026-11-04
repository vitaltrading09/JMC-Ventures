// ─────────────────────────────────────────────────────────────────────────────
// Deferred PUBACKs for QoS 1 messages (mqtt.js 5).
//
// The goal: the broker only gets the PUBACK for a message once the batch that
// wrote it has committed, so a crash between "received" and "committed" makes
// the broker redeliver it (persistent session) instead of losing it.
//
// Why not simply call handleMessage's callback after the flush: mqtt.js 5
// processes incoming packets one at a time and only reads the next packet when
// that callback has run (client.js work/nextTickWork). Waiting there for a
// 1-second flush would cap ingest at about one message per flush.
//
// So the packet loop is released immediately, and only the outgoing PUBACK is
// held: client._sendPacket is wrapped, and a puback for a message that is still
// waiting for its commit is parked until release(messageId) is called. The
// _sendPacket callback (which continues mqtt.js's loop) still runs at once.
// _sendPacket is internal to mqtt.js, so this is pinned to the 5.x line and
// covered by test/ack-gate.test.js.
// ─────────────────────────────────────────────────────────────────────────────

type SendPacket = (packet: any, cb?: (err?: any) => void, ...rest: any[]) => void;

export interface AckGate {
    /** Mark a QoS 1 message as waiting: its PUBACK is held until release(). */
    hold(messageId: number): void;
    /** The message's row is committed (or it was dead-lettered): send its PUBACK. */
    release(messageId: number): void;
    /** Messages received but not yet released. */
    readonly pending: number;
}

export function installAckGate(client: { _sendPacket: SendPacket }): AckGate {
    const original: SendPacket = client._sendPacket.bind(client);
    // messageId → 'waiting' (not committed yet) or the parked puback packet.
    const waiting = new Map<number, 'waiting' | { packet: any; rest: any[] }>();
    const released = new Set<number>();

    client._sendPacket = (packet: any, cb?: (err?: any) => void, ...rest: any[]) => {
        if (packet?.cmd === 'puback' && waiting.has(packet.messageId)) {
            const id = packet.messageId;
            if (released.has(id)) {
                // Committed before mqtt.js got round to the puback (possible when
                // the message was held back by queue backpressure). Send now.
                released.delete(id);
                waiting.delete(id);
                return original(packet, cb, ...rest);
            }
            waiting.set(id, { packet, rest });
            // Let mqtt.js move on to the next incoming packet straight away.
            if (cb) cb();
            return;
        }
        return original(packet, cb, ...rest);
    };

    return {
        hold(messageId: number) {
            waiting.set(messageId, 'waiting');
            released.delete(messageId);
        },
        release(messageId: number) {
            const state = waiting.get(messageId);
            if (state === undefined) return;
            if (state === 'waiting') {
                // PUBACK not generated yet; send it as soon as mqtt.js does.
                released.add(messageId);
                return;
            }
            waiting.delete(messageId);
            original(state.packet, undefined, ...state.rest);
        },
        get pending() {
            return waiting.size;
        },
    };
}
