import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import path from 'path';
import { Pool } from 'pg';

// Load .env from the service directory regardless of CWD
dotenv.config({ path: path.resolve(__dirname, '../../.env') });

const app = express();
const port = process.env.PORT || 3001;

app.use(cors());
app.use(express.json());

// Database Connection
const pool = new Pool({
  connectionString: process.env.DATABASE_URL || 'postgres://powerguard_user:powerguard_password@localhost:5432/powerguard_db',
});

app.get('/health', (req, res) => {
  res.json({ status: 'ok', service: 'auth-service' });
});

// Basic Login (Mock for MVP)
// Real Login Implementation
import bcrypt from 'bcrypt';
import jwt from 'jsonwebtoken';

const JWT_SECRET = process.env.JWT_SECRET || 'powerguard-super-secret-key-change-in-prod';

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

    // 4. Return Token & User Info
    res.json({
      token,
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

// Verify Token Endpoint (for Gateway/Other Services)
app.get('/verify', (req, res) => {
  const authHeader = req.headers.authorization;
  if (!authHeader) return res.status(401).json({ error: 'No token provided' });

  const token = authHeader.split(' ')[1];
  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    res.json({ valid: true, user: decoded });
  } catch (err) {
    res.status(401).json({ valid: false, error: 'Invalid token' });
  }
});

// Middleware for Admin Routes
const requireSuperAdmin = (req: any, res: any, next: any) => {
  const authHeader = req.headers.authorization;
  const token = authHeader && authHeader.split(' ')[1];
  if (!token) return res.status(401).json({ error: 'Unauthorized' });

  try {
    const decoded: any = jwt.verify(token, JWT_SECRET);
    if (decoded.role !== 'super_admin' && decoded.role !== 'admin') {
      // NOTE: For demo, allowing 'admin' (the seeded user) to act as super_admin for now
      return res.status(403).json({ error: 'Forbidden: Super Admin required' });
    }
    req.user = decoded;
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
      SELECT t.id, t.name, t.created_at,
             COUNT(DISTINCT s.id) as site_count,
             COUNT(DISTINCT u.id) as user_count
      FROM tenants t
      LEFT JOIN sites s ON t.id = s.tenant_id
      LEFT JOIN users u ON t.id = u.tenant_id
      GROUP BY t.id, t.name, t.created_at
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

// Create a new User
app.post('/users', requireSuperAdmin, async (req: any, res) => {
  const { email, password, full_name, role = 'viewer', tenant_id } = req.body;

  if (!email || !password || !tenant_id) {
    return res.status(400).json({ error: 'Email, password, and tenant_id are required' });
  }

  try {
    const client = await pool.connect();

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
      INSERT INTO users (email, password_hash, full_name, role, tenant_id)
      VALUES ($1, $2, $3, $4, $5)
      RETURNING id, email, full_name, role, tenant_id, created_at
    `;
    const result = await client.query(query, [email, password_hash, full_name, role, tenant_id]);

    client.release();
    res.status(201).json(result.rows[0]);
  } catch (err) {
    console.error('Error creating user:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

app.listen(port, () => {
  console.log(`Auth Service running on port ${port}`);
});
