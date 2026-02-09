import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import { Pool } from 'pg';

dotenv.config();

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

app.listen(port, () => {
  console.log(`Auth Service running on port ${port}`);
});
