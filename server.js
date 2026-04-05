/**
 * server.js — Express backend for Tournament Hub
 *
 * Endpoints:
 *   GET  /api/tournaments  — Return cached tournament data from tournaments.json
 *   POST /api/refresh      — Re-fetch from USTA API and update tournaments.json
 *
 * The server also serves index.html and other static assets from the project root.
 *
 * Configuration (via .env):
 *   PORT           — HTTP port (default 3000)
 *   USTA_API_KEY   — Bearer token for the USTA developer API
 *   USTA_API_BASE  — Base URL override for the USTA competitions API
 *
 * Usage:
 *   node server.js           # production
 *   npm run dev              # auto-reload with nodemon
 */

require('dotenv').config();
const express   = require('express');
const cors      = require('cors');
const fs        = require('fs');
const path      = require('path');
const cron      = require('node-cron');
const rateLimit = require('express-rate-limit');
const { scrapeTournaments } = require('./scrape');

const app  = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());

// Rate-limit the read endpoint: 120 requests / minute per IP
const readLimiter = rateLimit({
    windowMs: 60 * 1000,
    max: 120,
    standardHeaders: true,
    legacyHeaders: false,
});

// Rate-limit the refresh endpoint more aggressively: 5 requests / 10 minutes per IP
const refreshLimiter = rateLimit({
    windowMs: 10 * 60 * 1000,
    max: 5,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: 'Too many refresh requests. Please wait before trying again.' },
});

// Serve static files (index.html, style.css, etc.) from the project root
app.use(express.static(path.join(__dirname)));

// ---------------------------------------------------------------------------
// GET /api/tournaments
// ---------------------------------------------------------------------------
app.get('/api/tournaments', readLimiter, (req, res) => {
    const filePath = path.join(__dirname, 'tournaments.json');

    if (!fs.existsSync(filePath)) {
        return res.json([]);
    }

    try {
        const raw  = fs.readFileSync(filePath, 'utf8');
        const data = JSON.parse(raw);
        res.json(data);
    } catch (err) {
        console.error('Error reading tournaments.json:', err.message);
        res.status(500).json({ error: 'Failed to read tournament data' });
    }
});

// ---------------------------------------------------------------------------
// POST /api/refresh
// ---------------------------------------------------------------------------
app.post('/api/refresh', refreshLimiter, async (req, res) => {
    console.log('[refresh] Starting USTA data refresh…');
    try {
        const tournaments = await scrapeTournaments();
        res.json({ success: true, count: tournaments.length });
    } catch (err) {
        console.error('[refresh] Error:', err.message);
        res.status(500).json({ error: 'Failed to refresh tournament data', detail: err.message });
    }
});

// ---------------------------------------------------------------------------
// Scheduled refresh: every day at midnight UTC
// ---------------------------------------------------------------------------
cron.schedule('0 0 * * *', async () => {
    console.log('[cron] Daily USTA data refresh starting…');
    try {
        const tournaments = await scrapeTournaments();
        console.log(`[cron] Refreshed ${tournaments.length} tournaments`);
    } catch (err) {
        console.error('[cron] Refresh failed:', err.message);
    }
});

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------
app.listen(PORT, () => {
    console.log(`Tournament Hub server running at http://localhost:${PORT}`);
});
