const path = require('path');

// NEXT_PUBLIC_API_URL is inlined into the client bundle at build time, so it
// has to be known here. There is deliberately no fallback host: a missing
// value would ship a bundle pointing at the wrong server.
if (!process.env.NEXT_PUBLIC_API_URL) {
    throw new Error(
        'NEXT_PUBLIC_API_URL is not set. Put it in apps/web/.env.local for local dev, ' +
        'or pass it as the NEXT_PUBLIC_API_URL build arg for the Docker image.'
    );
}

/** @type {import('next').NextConfig} */
const nextConfig = {
    // Self-contained server for the Docker image (node server.js).
    output: 'standalone',
    experimental: {
        // Monorepo: trace dependencies from the repo root so hoisted
        // node_modules end up in the standalone output.
        outputFileTracingRoot: path.join(__dirname, '../../'),
    },
};

module.exports = nextConfig;
