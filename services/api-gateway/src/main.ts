import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import { createProxyMiddleware } from 'http-proxy-middleware';
import dotenv from 'dotenv';

dotenv.config();

// Crash early rather than run with an insecure default
const JWT_SECRET = process.env.JWT_SECRET;
if (!JWT_SECRET || JWT_SECRET === 'gridiq-super-secret-key-change-in-prod' || JWT_SECRET.length < 32) {
    console.error('FATAL: JWT_SECRET is missing, too short, or still set to the default placeholder.');
    console.error('       Set a strong secret (≥32 chars) in services/api-gateway/.env');
    process.exit(1);
}

const app = express();
const port = process.env.PORT || 8081;

// Behind Caddy every request arrives from the proxy's address, so the rate
// limiter would put all users in one bucket. TRUST_PROXY=1 (set in compose)
// takes the client IP from Caddy's X-Forwarded-For. Unset when the gateway is
// reached directly (npm run dev), so the header can't be spoofed there.
const trustProxy = Number(process.env.TRUST_PROXY || 0);
if (trustProxy > 0) app.set('trust proxy', trustProxy);

// 1. Security Headers (Helmet)
app.use(helmet());

// 2. Rate Limiting (DDoS Protection)
const limiter = rateLimit({
    windowMs: 15 * 60 * 1000, // 15 minutes
    max: 10000, // Allow 10k requests per window for dev
    standardHeaders: true, // Return rate limit info in the `RateLimit-*` headers
    legacyHeaders: false, // Disable the `X-RateLimit-*` headers
    message: 'Too many requests from this IP, please try again after 15 minutes',
});
app.use(limiter);

// 3. CORS Configuration (Restrict to Frontend)
// PATCH is required by meter pause toggle, meter load profile, and lead status updates.
// Without it the browser blocks the request before it even hits the gateway ("Failed to fetch").
const corsOptions = {
    origin: process.env.FRONTEND_URL || 'http://localhost:3000',
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization', 'Cookie'],
    // X-Readings-Source: the aggregate and bucket behind a chart (its stated basis).
    exposedHeaders: ['Set-Cookie', 'X-Readings-Source'],
    credentials: true,
};
app.use(cors(corsOptions));

app.get('/health', (req, res) => {
    res.json({ status: 'ok', service: 'api-gateway', timestamp: new Date().toISOString() });
});

// Strip CORS headers from upstream responses so the gateway's own CORS headers
// are not overridden. Internal services run cors() with no options which emits
// Access-Control-Allow-Origin: * — invalid when combined with credentials.
function stripUpstreamCors(proxyRes: any) {
    delete proxyRes.headers['access-control-allow-origin'];
    delete proxyRes.headers['access-control-allow-credentials'];
    delete proxyRes.headers['access-control-allow-methods'];
    delete proxyRes.headers['access-control-allow-headers'];
    delete proxyRes.headers['access-control-expose-headers'];
}

// Deep health for the external uptime monitor: served by the ingestion api
// (token-protected there), path kept as /health/deep.
app.use(createProxyMiddleware('/health/deep', {
    target: process.env.INGESTION_SERVICE_URL || 'http://localhost:3002',
    changeOrigin: true,
    onProxyRes: stripUpstreamCors,
}));

// Proxy to Auth Service
app.use('/auth', createProxyMiddleware({
    target: process.env.AUTH_SERVICE_URL || 'http://localhost:3001',
    changeOrigin: true,
    pathRewrite: {
        '^/auth': '', // Remove /auth prefix when forwarding
    },
    onProxyRes: stripUpstreamCors,
}));

// Proxy to Ingestion Service (if needed for manual trigger)
app.use('/ingestion', createProxyMiddleware({
    target: process.env.INGESTION_SERVICE_URL || 'http://localhost:3002',
    changeOrigin: true,
    pathRewrite: {
        '^/ingestion': '', // Remove /ingestion prefix when forwarding
    },
    onProxyRes: stripUpstreamCors,
}));

app.listen(port, () => {
    console.log(`API Gateway running on port ${port}`);
});
