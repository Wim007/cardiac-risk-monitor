require('dotenv').config();

const express = require('express');
const cors = require('cors');
const axios = require('axios');
const { Pool } = require('pg');

const app = express();
const PORT = process.env.PORT || 3000;

// ── PostgreSQL connection ────────────────────────────────────────────────────
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL && process.env.DATABASE_URL.includes('localhost')
    ? false
    : { rejectUnauthorized: false }
});

// ── Middleware ───────────────────────────────────────────────────────────────
app.use(cors());
app.use(express.json());

// ── Database initialisation ──────────────────────────────────────────────────
async function initDb() {
  const createTable = `
    CREATE TABLE IF NOT EXISTS visitors (
      id           SERIAL PRIMARY KEY,
      ip_address   VARCHAR(45)  NOT NULL,
      country      VARCHAR(100),
      city         VARCHAR(100),
      latitude     FLOAT,
      longitude    FLOAT,
      user_agent   TEXT,
      timestamp    TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      created_at   TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )
  `;
  try {
    await pool.query(createTable);
    console.log('Database initialised – visitors table ready.');
  } catch (err) {
    console.error('Failed to initialise database:', err.message);
    process.exit(1);
  }
}

// ── Routes ───────────────────────────────────────────────────────────────────

/**
 * POST /api/track
 * Body: { ip_address: string, user_agent: string }
 * Looks up geolocation via ip-api.com (free, no key required) and stores the
 * result in PostgreSQL.
 */
app.post('/api/track', async (req, res) => {
  const { ip_address, user_agent } = req.body;

  if (!ip_address) {
    return res.status(400).json({ error: 'ip_address is required' });
  }

  let geo = { country: null, city: null, lat: null, lon: null };

  try {
    const geoRes = await axios.get(
      `http://ip-api.com/json/${ip_address}?fields=status,country,city,lat,lon`,
      { timeout: 5000 }
    );
    if (geoRes.data.status === 'success') {
      geo = geoRes.data;
    }
  } catch (err) {
    // Non-fatal – store the record without geo data
    console.error('Geolocation lookup failed:', err.message);
  }

  try {
    const result = await pool.query(
      `INSERT INTO visitors (ip_address, country, city, latitude, longitude, user_agent)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING *`,
      [ip_address, geo.country || null, geo.city || null, geo.lat || null, geo.lon || null, user_agent || null]
    );

    return res.status(201).json({
      success: true,
      visitor: result.rows[0],
      geolocation: {
        country: geo.country || null,
        city: geo.city || null,
        latitude: geo.lat || null,
        longitude: geo.lon || null
      }
    });
  } catch (err) {
    console.error('Failed to store visitor:', err.message);
    return res.status(500).json({ error: 'Failed to store visitor data' });
  }
});

/**
 * GET /api/visitors
 * Returns all tracked visitors ordered by most recent first.
 */
app.get('/api/visitors', async (_req, res) => {
  try {
    const result = await pool.query(
      'SELECT * FROM visitors ORDER BY created_at DESC'
    );
    return res.json(result.rows);
  } catch (err) {
    console.error('Failed to fetch visitors:', err.message);
    return res.status(500).json({ error: 'Failed to fetch visitors' });
  }
});

/**
 * GET /api/visitors/stats
 * Returns summary statistics: total visitors, unique IPs, unique countries.
 */
app.get('/api/visitors/stats', async (_req, res) => {
  try {
    const result = await pool.query(`
      SELECT
        COUNT(*)                        AS total_visitors,
        COUNT(DISTINCT ip_address)      AS unique_ips,
        COUNT(DISTINCT country)
          FILTER (WHERE country IS NOT NULL) AS unique_countries
      FROM visitors
    `);
    const row = result.rows[0];
    return res.json({
      total_visitors:   parseInt(row.total_visitors, 10),
      unique_ips:       parseInt(row.unique_ips, 10),
      unique_countries: parseInt(row.unique_countries, 10)
    });
  } catch (err) {
    console.error('Failed to fetch stats:', err.message);
    return res.status(500).json({ error: 'Failed to fetch stats' });
  }
});

/**
 * POST /api/backfill
 * No request body required.
 * Imports 7 historical visitors (May 16 – Jun 16 2026) from nginx logs,
 * looks up geolocation for each, and inserts them with their original
 * timestamps.  A 500 ms delay between requests avoids hitting ip-api.com
 * rate limits.
 */
app.post('/api/backfill', async (_req, res) => {
  const historicalVisitors = [
    { ip: "86.81.83.35",      timestamp: "2026-05-16T14:38:28Z", ua: "Mozilla/5.0 (X11; CrOS x86_64 14541.0.0) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/147.0.0.0 Safari/537.36" },
    { ip: "89.205.245.219",   timestamp: "2026-05-16T18:18:09Z", ua: "Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/148.0.0.0 Mobile Safari/537.36" },
    { ip: "212.178.86.11",    timestamp: "2026-05-17T19:28:59Z", ua: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/147.0.0.0 Safari/537.36" },
    { ip: "98.88.148.58",     timestamp: "2026-05-24T17:38:23Z", ua: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/148.0.0.0 Safari/537.36" },
    { ip: "86.81.83.35",      timestamp: "2026-06-05T10:05:39Z", ua: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/148.0.0.0 Safari/537.36" },
    { ip: "89.205.150.138",   timestamp: "2026-06-10T19:09:38Z", ua: "Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/149.0.0.0 Mobile Safari/537.36" },
    { ip: "104.23.166.35",    timestamp: "2026-06-16T07:51:49Z", ua: "-" }
  ];

  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  let imported = 0;
  let errors   = 0;

  for (const visitor of historicalVisitors) {
    let geo = { country: null, city: null, lat: null, lon: null };

    try {
      const geoRes = await axios.get(
        `http://ip-api.com/json/${visitor.ip}?fields=status,country,city,lat,lon`,
        { timeout: 5000 }
      );
      if (geoRes.data.status === 'success') {
        geo = geoRes.data;
      }
    } catch (err) {
      // Non-fatal – store the record without geo data
      console.error(`Geolocation lookup failed for ${visitor.ip}:`, err.message);
    }

    try {
      await pool.query(
        `INSERT INTO visitors (ip_address, country, city, latitude, longitude, user_agent, timestamp, created_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $7)`,
        [
          visitor.ip,
          geo.country || null,
          geo.city    || null,
          geo.lat     || null,
          geo.lon     || null,
          visitor.ua  || null,
          new Date(visitor.timestamp)
        ]
      );
      imported++;
      console.log(`Backfill: imported ${visitor.ip} (${visitor.timestamp})`);
    } catch (err) {
      errors++;
      console.error(`Backfill: failed to insert ${visitor.ip}:`, err.message);
    }

    // Respect ip-api.com free-tier rate limit (45 req/min)
    await sleep(500);
  }

  return res.json({ success: true, imported, errors });
});

// ── Start ────────────────────────────────────────────────────────────────────
initDb().then(() => {
  app.listen(PORT, () => {
    console.log(`Geolocation API listening on port ${PORT}`);
  });
});
