import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import path from 'path';
import { Pool } from 'pg';
import { assertSchemaCurrent, SchemaBehindError } from '@gridiq/db';

// Load .env from the service directory regardless of CWD
dotenv.config({ path: path.resolve(__dirname, '../.env') });

// Crash early rather than run against a guessed database
if (!process.env.DATABASE_URL) {
  console.error('FATAL: DATABASE_URL is not set.');
  console.error('       Set it in services/auth-service/.env (see .env.example at the repo root).');
  process.exit(1);
}

const app = express();
const port = process.env.PORT || 3001;

app.use(cors());
app.use(express.json());

// Database Connection
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
});
// A database restart terminates idle pooled connections and the pool emits
// 'error'; unhandled, that kills the process. Logged instead: the next query
// gets a fresh connection.
pool.on('error', (err) => {
  console.error('[db] idle connection lost:', err.message);
});

app.get('/health', (req, res) => {
  res.json({ status: 'ok', service: 'auth-service' });
});

// Basic Login (Mock for MVP)
// Real Login Implementation
import bcrypt from 'bcrypt';
import jwt from 'jsonwebtoken';
import { apiKeyRouter } from './api-keys';

const JWT_SECRET = process.env.JWT_SECRET;
if (!JWT_SECRET || JWT_SECRET === 'gridiq-super-secret-key-change-in-prod' || JWT_SECRET.length < 32) {
  console.error('FATAL: JWT_SECRET is missing, too short, or still set to the default placeholder.');
  console.error('       Set a strong secret (≥32 chars) in services/auth-service/.env');
  process.exit(1);
}
// COOKIE_SECURE must be explicitly set to 'true' via env — not inferred from
// NODE_ENV — so we can run production mode over HTTP until TLS is provisioned.
const COOKIE_SECURE = process.env.COOKIE_SECURE === 'true';

app.post('/login', async (req, res) => {
  const { email, password } = req.body;

  try {
    const client = await pool.connect();
    // 1. Find user by email
    const result = await client.query('SELECT * FROM users WHERE email = $1', [email]);
    const user = result.rows[0];
    client.release();

    if (!user) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }

    // 2. Verify Password
    // Handle legacy/seed "hashed_secret" case for dev convenience if needed, 
    // but better to just fix the data. We assume data is proper bcrypt hash.
    const valid = await bcrypt.compare(password, user.password_hash);

    if (!valid) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }

    // 3. Generate JWT
    const token = jwt.sign(
      {
        userId: user.id,
        email: user.email,
        role: user.role,
        tenantId: user.tenant_id
      },
      JWT_SECRET,
      { expiresIn: '24h' }
    );

    // 4. Set HTTPOnly cookie (not readable by JS — XSS-safe) + return user display info
    const cookieOptions = [
      `token=${token}`,
      'HttpOnly',
      'Path=/',
      'Max-Age=86400',
      'SameSite=Strict',
      ...(COOKIE_SECURE ? ['Secure'] : []),
    ].join('; ');
    res.setHeader('Set-Cookie', cookieOptions);

    res.json({
      user: {
        id: user.id,
        email: user.email,
        name: user.full_name || 'Admin User',
        role: user.role,
        tenantId: user.tenant_id
      }
    });

  } catch (err) {
    console.error('Login error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Logout — clears the HTTPOnly cookie
app.post('/logout', (req, res) => {
  res.setHeader('Set-Cookie', 'token=; HttpOnly; Path=/; Max-Age=0; SameSite=Strict');
  res.json({ ok: true });
});

// Verify Token Endpoint — accepts HTTPOnly cookie OR Authorization: Bearer header
app.get('/verify', (req, res) => {
  // 1. Try cookie first
  const cookieHeader = req.headers.cookie || '';
  const cookieMatch = cookieHeader.match(/(?:^|;\s*)token=([^;]+)/);
  const cookieToken = cookieMatch ? cookieMatch[1] : null;

  // 2. Fall back to Authorization header
  const authHeader = req.headers.authorization;
  const bearerToken = authHeader ? authHeader.split(' ')[1] : null;

  const token = cookieToken || bearerToken;
  if (!token) return res.status(401).json({ error: 'No token provided' });

  try {
    const decoded = jwt.verify(token, JWT_SECRET as string);
    res.json({ valid: true, user: decoded });
  } catch (err) {
    res.status(401).json({ valid: false, error: 'Invalid token' });
  }
});

// Roles (Phase 7). Old names are accepted and mapped.
const INTERNAL_ROLES = ['super_admin', 'engineer'];
const CLIENT_ROLES = ['client_admin', 'client_viewer'];
const LEGACY_ROLES: Record<string, string> = { admin: 'client_admin', user: 'client_viewer', viewer: 'client_viewer' };
/** A valid role for a new user (default client_viewer), or null. */
export function userRole(v: unknown): string | null {
  if (v === undefined || v === null || v === '') return 'client_viewer';
  const r = LEGACY_ROLES[String(v)] ?? String(v);
  return [...INTERNAL_ROLES, ...CLIENT_ROLES].includes(r) ? r : null;
}

// Middleware for Admin Routes — accepts HTTPOnly cookie OR Authorization: Bearer
const requireSuperAdmin = (req: any, res: any, next: any) => {
  const cookieHeader = req.headers.cookie || '';
  const cookieMatch = cookieHeader.match(/(?:^|;\s*)token=([^;]+)/);
  const cookieToken = cookieMatch ? cookieMatch[1] : null;

  const authHeader = req.headers.authorization;
  const bearerToken = authHeader ? authHeader.split(' ')[1] : null;

  const token = cookieToken || bearerToken;
  if (!token) return res.status(401).json({ error: 'Unauthorized' });

  try {
    const decoded: any = jwt.verify(token, JWT_SECRET as string);
    // Only the platform operator. (A demo shortcut once let a client 'admin'
    // through here, which let any client admin create users in any tenant.)
    if (decoded.role !== 'super_admin') {
      return res.status(403).json({ error: 'Forbidden: Super Admin required' });
    }
    req.user = decoded;
    next();
  } catch (err) {
    res.status(403).json({ error: 'Invalid token' });
  }
};

// Super admin, or a client_admin for their own tenant (Phase 8: clients
// manage their own team). Sets req.userAdmin = { userId, role, tenantId, isSuper }.
const requireUserAdmin = (req: any, res: any, next: any) => {
  const cookieMatch = (req.headers.cookie || '').match(/(?:^|;\s*)token=([^;]+)/);
  const authHeader = req.headers.authorization;
  const token = (cookieMatch ? cookieMatch[1] : null) || (authHeader ? authHeader.split(' ')[1] : null);
  if (!token) return res.status(401).json({ error: 'Unauthorized' });
  try {
    const decoded: any = jwt.verify(token, JWT_SECRET as string);
    const role = LEGACY_ROLES[decoded.role] ?? decoded.role;
    if (role !== 'super_admin' && role !== 'client_admin') {
      return res.status(403).json({ error: 'Forbidden: an admin role is required' });
    }
    req.userAdmin = { userId: decoded.userId ?? null, role, tenantId: decoded.tenantId ?? null, isSuper: role === 'super_admin' };
    next();
  } catch (err) {
    res.status(403).json({ error: 'Invalid token' });
  }
};

// --- Admin APIs ---

// Get all Tenants (Clients)
app.get('/tenants', requireSuperAdmin, async (req, res) => {
  try {
    const client = await pool.connect();
    const query = `
      SELECT t.id, t.name, t.kind, t.slug, t.created_at,
             COUNT(DISTINCT s.id) as site_count,
             COUNT(DISTINCT u.id) as user_count
      FROM tenants t
      LEFT JOIN sites s ON t.id = s.tenant_id
      LEFT JOIN users u ON t.id = u.tenant_id
      GROUP BY t.id, t.name, t.kind, t.slug, t.created_at
      ORDER BY t.created_at DESC
    `;
    const result = await client.query(query);
    client.release();
    res.json(result.rows);
  } catch (err) {
    console.error('Error fetching tenants:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Create a new Tenant
app.post('/tenants', requireSuperAdmin, async (req: any, res) => {
  const { name } = req.body;

  if (!name) {
    return res.status(400).json({ error: 'Tenant name is required' });
  }

  try {
    const client = await pool.connect();
    const result = await client.query(
      'INSERT INTO tenants (name) VALUES ($1) RETURNING id, name, created_at',
      [name]
    );
    client.release();

    // Return standard format expected by frontend
    const newTenant = {
      ...result.rows[0],
      site_count: 0,
      user_count: 0
    };

    res.status(201).json(newTenant);
  } catch (err) {
    console.error('Error creating tenant:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// List users: a tenant's (client_admin: always their own).
app.get('/users', requireUserAdmin, async (req: any, res) => {
  const a = req.userAdmin;
  const tenantId = a.isSuper ? (req.query.tenant_id || null) : a.tenantId;
  try {
    const r = await pool.query(
      `SELECT u.id, u.email, u.role, u.tenant_id, u.created_at, t.name AS tenant_name
       FROM users u LEFT JOIN tenants t ON t.id = u.tenant_id
       WHERE ($1::uuid IS NULL OR u.tenant_id = $1) ORDER BY t.name, u.email`, [tenantId]);
    res.json(r.rows);
  } catch (err) {
    console.error('Error listing users:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

/** A user the caller may manage, or null. */
async function managedUser(a: any, id: string) {
  if (!/^[0-9a-f-]{36}$/i.test(id)) return null;
  const r = await pool.query(
    `SELECT u.id, u.role, u.tenant_id, t.kind FROM users u JOIN tenants t ON t.id = u.tenant_id WHERE u.id = $1`, [id]);
  const u = r.rows[0];
  if (!u || (!a.isSuper && u.tenant_id !== a.tenantId)) return null;
  return u;
}

// Change a user's role (within the rules of their tenant's kind).
app.patch('/users/:id', requireUserAdmin, async (req: any, res) => {
  const a = req.userAdmin;
  const role = userRole(req.body?.role);
  if (!role || req.body?.role === undefined) return res.status(400).json({ error: 'role is required' });
  try {
    const u = await managedUser(a, req.params.id);
    if (!u) return res.status(404).json({ error: 'User not found' });
    if (u.id === a.userId) return res.status(400).json({ error: 'You cannot change your own role' });
    if (!a.isSuper && !CLIENT_ROLES.includes(role)) return res.status(403).json({ error: 'A client admin can assign client roles only' });
    if (INTERNAL_ROLES.includes(role) !== (u.kind === 'internal')) {
      return res.status(400).json({ error: `${role} does not fit this tenant` });
    }
    const r = await pool.query(`UPDATE users SET role = $2 WHERE id = $1 RETURNING id, email, role, tenant_id`, [u.id, role]);
    res.json(r.rows[0]);
  } catch (err) {
    console.error('Error updating user:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Remove a user's access.
app.delete('/users/:id', requireUserAdmin, async (req: any, res) => {
  const a = req.userAdmin;
  try {
    const u = await managedUser(a, req.params.id);
    if (!u) return res.status(404).json({ error: 'User not found' });
    if (u.id === a.userId) return res.status(400).json({ error: 'You cannot remove yourself' });
    if (!a.isSuper && !CLIENT_ROLES.includes(u.role)) return res.status(403).json({ error: 'Forbidden' });
    await pool.query(`DELETE FROM users WHERE id = $1`, [u.id]);
    res.json({ removed: true });
  } catch (err) {
    console.error('Error removing user:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Create a new User (super_admin: any tenant; client_admin: their own, client roles only)
app.post('/users', requireUserAdmin, async (req: any, res) => {
  const a = req.userAdmin;
  const { email, password } = req.body;
  const tenant_id = a.isSuper ? req.body.tenant_id : a.tenantId;
  const role = userRole(req.body.role);
  if (!a.isSuper && role && !CLIENT_ROLES.includes(role)) {
    return res.status(403).json({ error: 'A client admin can create client_admin or client_viewer users only' });
  }

  if (!email || !password || !tenant_id) {
    return res.status(400).json({ error: 'Email, password, and tenant_id are required' });
  }
  if (!role) {
    return res.status(400).json({ error: `role must be one of ${[...INTERNAL_ROLES, ...CLIENT_ROLES].join(', ')}` });
  }

  try {
    const client = await pool.connect();

    // Internal roles belong to the internal tenant, client roles to a client tenant.
    const tenant = await client.query('SELECT kind FROM tenants WHERE id = $1', [tenant_id]);
    if (tenant.rows.length === 0) {
      client.release();
      return res.status(400).json({ error: 'tenant_id does not exist' });
    }
    const internalTenant = tenant.rows[0].kind === 'internal';
    if (INTERNAL_ROLES.includes(role) !== internalTenant) {
      client.release();
      return res.status(400).json({ error: internalTenant
        ? `${role} is a client role; this is the internal tenant (super_admin or engineer)`
        : `${role} is an internal role; this is a client tenant (client_admin or client_viewer)` });
    }

    // Check if user exists
    const existing = await client.query('SELECT id FROM users WHERE email = $1', [email]);
    if (existing.rows.length > 0) {
      client.release();
      return res.status(409).json({ error: 'Email already exists' });
    }

    // Hash Password
    const saltRounds = 10;
    const password_hash = await bcrypt.hash(password, saltRounds);

    const query = `
      -- (users has no full_name column; inserting one made this endpoint always fail)
      INSERT INTO users (email, password_hash, role, tenant_id)
      VALUES ($1, $2, $3, $4)
      RETURNING id, email, role, tenant_id, created_at
    `;
    const result = await client.query(query, [email, password_hash, role, tenant_id]);

    client.release();
    res.status(201).json(result.rows[0]);
  } catch (err) {
    console.error('Error creating user:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// API keys (Phase 9): /keys for client admins, /internal/keys/verify for the gateway.
app.use(apiKeyRouter(pool, requireUserAdmin));

// Refuse to serve against a database that is behind the latest migration
// (packages/db/migrations; the compose `migrate` service applies them).
// Retries while the database is still starting.
(async () => {
  for (let attempt = 1; ; attempt++) {
    try {
      await assertSchemaCurrent(pool);
      break;
    } catch (e: any) {
      if (e instanceof SchemaBehindError) {
        console.error(`FATAL: ${e.message}`);
        process.exit(1);
      }
      if (attempt >= 60) {
        console.error('FATAL: database unreachable:', e?.message || e);
        process.exit(1);
      }
      console.log(`Waiting for database (${e?.message || e})`);
      await new Promise((r) => setTimeout(r, 2000));
    }
  }
  app.listen(port, () => {
    console.log(`Auth Service running on port ${port}`);
  });
})();
