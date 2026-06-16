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

// ── Start ────────────────────────────────────────────────────────────────────
initDb().then(() => {
  app.listen(PORT, () => {
    console.log(`Geolocation API listening on port ${PORT}`);
  });
});
