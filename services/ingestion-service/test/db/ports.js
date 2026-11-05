'use strict';
// Free TCP ports for the services a DB test starts.
//
// A port picked at random from a fixed range can already be in use: on Linux
// the range 32768-60999 is also where outgoing connections get their local
// port, so a random 39xxx port collided on a CI runner (EADDRINUSE). Asking
// the OS for port 0 returns one that is free now. The test closes it before
// the child service binds it, which leaves a tiny window, far smaller than a
// random pick.
const net = require('node:net');

function freePort() {
    return new Promise((resolve, reject) => {
        const srv = net.createServer();
        srv.unref();
        srv.on('error', reject);
        srv.listen(0, '127.0.0.1', () => {
            const { port } = srv.address();
            srv.close(() => resolve(port));
        });
    });
}

/** n distinct free ports. */
async function freePorts(n) {
    const ports = new Set();
    while (ports.size < n) ports.add(await freePort());
    return [...ports];
}

module.exports = { freePort, freePorts };
