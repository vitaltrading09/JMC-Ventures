import dotenv from 'dotenv';
import { Pool } from 'pg';
import cron from 'node-cron';
import { Queue, Worker } from 'bullmq';
import IORedis from 'ioredis';

dotenv.config();

// Redis Connection
const redisConnection = new IORedis({
    host: process.env.REDIS_HOST || 'localhost',
    port: Number(process.env.REDIS_PORT) || 6379,
    maxRetriesPerRequest: null,
});

// Database Connection
const pool = new Pool({
    connectionString: process.env.DATABASE_URL || 'postgres://powerguard_user:powerguard_password@localhost:5432/powerguard_db',
    max: 20, // Connection pool size from env
    idleTimeoutMillis: 30000,
});

// Queue Definition
const ingestionQueue = new Queue('ingestion-queue', { connection: redisConnection });

// Worker Definition (Consumer)
const worker = new Worker('ingestion-queue', async (job) => {
    const { meterId } = job.data;
    // console.log(`Processing job ${job.id} for meter ${meterId}`);

    const client = await pool.connect();
    try {
        // Simulate data fetch latency
        // await new Promise(resolve => setTimeout(resolve, 100));

        // Randomize mock data
        const voltage = 230 + (Math.random() * 10 - 5);
        const current = 50 + (Math.random() * 20 - 10);
        const power = (voltage * current * 0.95) / 1000; // kW

        const query = `
            INSERT INTO meter_readings (
                time, meter_id, voltage_a, current_a, power_active_total
            ) VALUES (
                NOW(), $1, $2, $3, $4
            )
        `;
        await client.query(query, [meterId, voltage, current, power]);
        // console.log(`Ingested data for meter ${meterId}`);
    } catch (err) {
        console.error(`Error processing job ${job.id}:`, err);
        throw err;
    } finally {
        client.release();
    }
}, {
    connection: redisConnection,
    concurrency: 50 // Process 50 jobs in parallel
});

worker.on('completed', (job) => {
    // console.log(`Job ${job.id} completed!`);
});

worker.on('failed', (job, err) => {
    console.error(`Job ${job?.id} failed with ${err.message}`);
});

// Producer Logic (Scheduler)
// In a real scenario, this could be triggered by webhooks
async function scheduleIngestion() {
    console.log('Scheduling ingestion jobs...');
    const client = await pool.connect();
    try {
        // Get all meters
        const metersRes = await client.query('SELECT id FROM meters');
        const meters = metersRes.rows;

        if (meters.length === 0) {
            console.log('No meters found. Skipping scheduling.');
            return;
        }

        // Add jobs to queue using bulk add for efficiency
        const jobs = meters.map(meter => ({
            name: 'ingest-meter',
            data: { meterId: meter.id },
            opts: { removeOnComplete: true } // Don't clog Redis with completed jobs
        }));

        await ingestionQueue.addBulk(jobs);
        console.log(`Scheduled ${jobs.length} ingestion jobs.`);

    } catch (err) {
        console.error('Scheduling error:', err);
    } finally {
        client.release();
    }
}

// Run scheduler every minute
cron.schedule('* * * * *', () => {
    scheduleIngestion();
});

// Express API for Data Access
import express from 'express';
import cors from 'cors';

const app = express();
const port = process.env.PORT || 3002;

app.use(cors());
app.use(express.json());

app.get('/health', (req, res) => {
    res.json({ status: 'ok', service: 'ingestion-service', mode: 'queue+api' });
});

app.get('/meters', async (req, res) => {
    const client = await pool.connect();
    try {
        // Fetch meters with their latest reading
        const query = `
            SELECT m.*, 
            (
                SELECT row_to_json(r) 
                FROM (
                    SELECT * FROM meter_readings 
                    WHERE meter_id = m.id 
                    ORDER BY time DESC 
                    LIMIT 1
                ) r
            ) as latest_reading
            FROM meters m
            ORDER BY m.created_at ASC
        `;
        const result = await client.query(query);
        res.json(result.rows);
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Database error' });
    } finally {
        client.release();
    }
});

app.get('/meters/:id/readings', async (req, res) => {
    const { id } = req.params;
    const limit = req.query.limit || 100;

    const client = await pool.connect();
    try {
        const result = await client.query(
            'SELECT * FROM meter_readings WHERE meter_id = $1 ORDER BY time DESC LIMIT $2',
            [id, limit]
        );
        res.json(result.rows);
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: 'Database error' });
    } finally {
        client.release();
    }
});

app.listen(port, () => {
    console.log(`Ingestion Service API running on port ${port}`);
});

console.log('Ingestion Service (Queue Mode) started.');
