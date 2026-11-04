// PUBACK deferral: mqtt.js's packet loop keeps moving, the PUBACK waits for commit.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');

const { installAckGate } = require('../dist/ingest/ack-gate.js');

function fakeClient() {
    const sent = [];
    return { sent, _sendPacket(packet, cb) { sent.push(packet); if (cb) cb(); } };
}

test('a held PUBACK is sent only on release, while the loop continues at once', () => {
    const c = fakeClient();
    const gate = installAckGate(c);
    gate.hold(7);
    let loopContinued = false;
    c._sendPacket({ cmd: 'puback', messageId: 7 }, () => { loopContinued = true; });
    assert.strictEqual(loopContinued, true, 'mqtt.js callback runs immediately');
    assert.deepStrictEqual(c.sent, [], 'PUBACK parked');
    assert.strictEqual(gate.pending, 1);
    gate.release(7);
    assert.deepStrictEqual(c.sent, [{ cmd: 'puback', messageId: 7 }]);
    assert.strictEqual(gate.pending, 0);
});

test('release before mqtt.js generates the PUBACK: it is sent as soon as it is', () => {
    const c = fakeClient();
    const gate = installAckGate(c);
    gate.hold(3);
    gate.release(3); // committed while the message was held back by backpressure
    assert.deepStrictEqual(c.sent, []);
    c._sendPacket({ cmd: 'puback', messageId: 3 });
    assert.deepStrictEqual(c.sent, [{ cmd: 'puback', messageId: 3 }]);
    assert.strictEqual(gate.pending, 0);
});

test('other packets and un-held PUBACKs pass straight through', () => {
    const c = fakeClient();
    installAckGate(c);
    c._sendPacket({ cmd: 'pingreq' });
    c._sendPacket({ cmd: 'puback', messageId: 99 });
    assert.deepStrictEqual(c.sent.map((p) => p.cmd), ['pingreq', 'puback']);
});

test('release of an unknown id is a no-op; releases are independent', () => {
    const c = fakeClient();
    const gate = installAckGate(c);
    gate.release(1);
    gate.hold(1);
    gate.hold(2);
    c._sendPacket({ cmd: 'puback', messageId: 1 });
    c._sendPacket({ cmd: 'puback', messageId: 2 });
    gate.release(2);
    assert.deepStrictEqual(c.sent.map((p) => p.messageId), [2]);
    gate.release(1);
    assert.deepStrictEqual(c.sent.map((p) => p.messageId), [2, 1]);
});

test('the installed mqtt.js still sends QoS 1 PUBACKs through _sendPacket', () => {
    // Guards the assumption ack-gate.ts relies on, against an mqtt.js upgrade.
    const major = Number(require('mqtt/package.json').version.split('.')[0]);
    assert.strictEqual(major, 5);
    const mqttDir = require('node:path').dirname(require.resolve('mqtt/package.json'));
    const src = fs.readFileSync(require('node:path').join(mqttDir, 'build/lib/handlers/publish.js'), 'utf8');
    assert.match(src, /client\['_sendPacket'\]\(\{ cmd: 'puback', messageId, reasonCode: code \}, done\)/);
});
