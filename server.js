/**
 * server.js — TournamentHub Express backend
 *
 * Responsibilities:
 *  1. Proxy calls to the USTA Connect API (OAuth 2.0, REST/JSON)
 *  2. Proxy calls to the ITF World Tennis Number API (GraphQL, JWT)
 *  3. Serve index.html and static assets
 *  4. Cache tournament data in memory (configurable TTL)
 *  5. Expose a /api/refresh endpoint to force a re-fetch
 */

'use strict';

require('dotenv').config();

const express = require('express');
const rateLimit = require('express-rate-limit');
const axios = require('axios');
const path = require('path');
const fs = require('fs');
const cron = require('node-cron');

const app = express();
const PORT = process.env.PORT || 3000;

// ─── In-memory cache ─────────────────────────────────────────────────────────
const CACHE_TTL_MS = 60 * 60 * 1000; // 1 hour — stale cache triggers a re-fetch on next request
const cache = {
    usta: { data: null, fetchedAt: null },
    itf: { data: null, fetchedAt: null },
};

function isCacheStale(entry) {
    return !entry.data || !entry.fetchedAt || Date.now() - entry.fetchedAt > CACHE_TTL_MS;
}

// ─── USTA API helpers ─────────────────────────────────────────────────────────

/** Obtain an OAuth 2.0 access token using the client-credentials grant. */
async function getUstaAccessToken() {
    const tokenUrl = process.env.USTA_TOKEN_URL || 'https://identity.usta.com/oauth/token';
    const params = new URLSearchParams({
        grant_type: 'client_credentials',
        client_id: process.env.USTA_CLIENT_ID,
        client_secret: process.env.USTA_CLIENT_SECRET,
    });

    const response = await axios.post(tokenUrl, params.toString(), {
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        timeout: 10000,
    });
    return response.data.access_token;
}

/**
 * Fetch USTA junior U18 tournaments for a specific level.
 * @param {string} token   - OAuth access token
 * @param {string} level   - One of 'L1', 'L2', 'L3'
 * @returns {Array}        - Raw tournament objects from USTA API
 */
async function fetchUstaTournamentsByLevel(token, level) {
    const baseUrl = process.env.USTA_API_BASE_URL || 'https://api.usta.com';
    const response = await axios.get(`${baseUrl}/tournament/v1/tournament-search`, {
        headers: { Authorization: `Bearer ${token}` },
        params: {
            divisionCategory: 'junior',
            ageGroup: '18',
            level,
            pageSize: 200,
            page: 1,
        },
        timeout: 15000,
    });
    return response.data.tournaments || response.data.data || response.data || [];
}

/** Transform a raw USTA tournament object into the hub's normalised shape. */
function normaliseUstaTournament(raw, level) {
    const director = raw.tournamentDirector || raw.director || {};
    return {
        source: 'USTA',
        name: raw.name || raw.tournamentName || '',
        location: [raw.city, raw.state].filter(Boolean).join(', ') || raw.location || '',
        entry_deadline: raw.entryDeadline || raw.registrationDeadline || '',
        withdrawal_deadline: raw.withdrawalDeadline || '',
        freeze_deadline: raw.freezeDeadline || raw.drawsDeadline || '',
        director_name: director.name || director.firstName
            ? `${director.firstName || ''} ${director.lastName || ''}`.trim()
            : '',
        director_phone: director.phone || director.phoneNumber || '',
        level: raw.level || level,
        tournament_url: raw.url || raw.registrationUrl
            || `https://playtennis.usta.com/competitions/USTA/competitiondetail?id=${raw.id || ''}`,
        start_date: raw.startDate || '',
        end_date: raw.endDate || '',
    };
}

/** Fetch all USTA junior U18 tournaments for levels L1, L2, L3. */
async function fetchAllUstaTournaments() {
    const levels = ['L1', 'L2', 'L3'];
    let token;
    try {
        token = await getUstaAccessToken();
    } catch (err) {
        throw new Error(`USTA authentication failed: ${err.message}`);
    }

    const results = await Promise.allSettled(
        levels.map((level) => fetchUstaTournamentsByLevel(token, level))
    );

    const tournaments = [];
    results.forEach((result, idx) => {
        const level = levels[idx];
        if (result.status === 'fulfilled') {
            const raw = Array.isArray(result.value) ? result.value : [];
            raw.forEach((t) => tournaments.push(normaliseUstaTournament(t, level)));
        } else {
            console.error(`[USTA] Failed to fetch ${level} tournaments: ${result.reason.message}`);
        }
    });

    return tournaments;
}

// ─── ITF WTN API helpers ──────────────────────────────────────────────────────

/** GraphQL query for ITF junior U18 tournaments in the Americas zone. */
const ITF_TOURNAMENTS_QUERY = `
  query JuniorAmericasTournaments($zone: String!, $ageCategory: String!) {
    tournaments(filter: { zone: $zone, ageCategory: $ageCategory, type: "Junior" }) {
      id
      name
      venue {
        city
        country
        countryCode
      }
      startDate
      endDate
      entryDeadline
      withdrawalDeadline
      freezeDeadline
      director {
        name
        phone
      }
      category
      url
    }
  }
`;

/** Transform a raw ITF tournament object into the hub's normalised shape. */
function normaliseItfTournament(raw) {
    const venue = raw.venue || {};
    const director = raw.director || {};
    return {
        source: 'ITF',
        name: raw.name || '',
        location: [venue.city, venue.country].filter(Boolean).join(', '),
        entry_deadline: raw.entryDeadline || '',
        withdrawal_deadline: raw.withdrawalDeadline || '',
        freeze_deadline: raw.freezeDeadline || '',
        director_name: director.name || '',
        director_phone: director.phone || '',
        level: raw.category || 'U18',
        tournament_url: raw.url || `https://www.itftennis.com/en/tournament/${raw.id}/`,
        start_date: raw.startDate || '',
        end_date: raw.endDate || '',
    };
}

/** Fetch all ITF junior U18 tournaments in the Americas. */
async function fetchAllItfTournaments() {
    const apiUrl = process.env.ITF_API_URL || 'https://api.worldtennisnumber.com/graphql';
    const token = process.env.ITF_JWT_TOKEN;
    const providerId = process.env.ITF_PROVIDER_ID;

    if (!token) {
        throw new Error('ITF_JWT_TOKEN is not set in environment variables');
    }

    const response = await axios.post(
        apiUrl,
        {
            query: ITF_TOURNAMENTS_QUERY,
            variables: { zone: 'Americas', ageCategory: 'U18' },
        },
        {
            headers: {
                'Content-Type': 'application/json',
                Authorization: `Bearer ${token}`,
                ...(providerId ? { 'x-clubspark-provider-id': providerId } : {}),
            },
            timeout: 15000,
        }
    );

    const data = response.data;
    if (data.errors && data.errors.length > 0) {
        throw new Error(`ITF GraphQL errors: ${data.errors.map((e) => e.message).join('; ')}`);
    }

    const raw = (data.data && data.data.tournaments) || [];
    return raw.map(normaliseItfTournament);
}

// ─── Cache refresh ────────────────────────────────────────────────────────────

async function refreshUstaCache() {
    console.log('[USTA] Refreshing tournament cache…');
    try {
        const tournaments = await fetchAllUstaTournaments();
        cache.usta.data = tournaments;
        cache.usta.fetchedAt = Date.now();
        console.log(`[USTA] Cached ${tournaments.length} tournaments.`);
    } catch (err) {
        console.error('[USTA] Cache refresh failed:', err.message);
        // Keep stale cache if available
    }
}

async function refreshItfCache() {
    console.log('[ITF] Refreshing tournament cache…');
    try {
        const tournaments = await fetchAllItfTournaments();
        cache.itf.data = tournaments;
        cache.itf.fetchedAt = Date.now();
        console.log(`[ITF] Cached ${tournaments.length} tournaments.`);
    } catch (err) {
        console.error('[ITF] Cache refresh failed:', err.message);
        // Keep stale cache if available
    }
}

/** Load seed data from tournaments.json as a fallback. */
function loadFallbackData() {
    try {
        const raw = fs.readFileSync(path.join(__dirname, 'tournaments.json'), 'utf-8');
        const all = JSON.parse(raw);
        const usta = Array.isArray(all.usta) ? all.usta
            : Array.isArray(all) ? all.filter((t) => t.source === 'USTA' || !t.source)
            : [];
        const itf = Array.isArray(all.itf) ? all.itf
            : Array.isArray(all) ? all.filter((t) => t.source === 'ITF')
            : [];
        return { usta, itf };
    } catch {
        return { usta: [], itf: [] };
    }
}

// ─── Routes ───────────────────────────────────────────────────────────────────

app.use(express.json());

// Rate limiter for static file routes (prevent directory traversal / DoS)
const staticLimiter = rateLimit({
    windowMs: 60 * 1000, // 1 minute
    max: 120,            // 120 requests per minute per IP
    standardHeaders: true,
    legacyHeaders: false,
});

// Serve only specific public files — never expose .env, server.js, scrape.js, etc.
const PUBLIC_FILES = new Set(['index.html', 'style.css', 'tournaments.json']);

app.get('/', staticLimiter, (_req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});

app.get('/:file', staticLimiter, (req, res, next) => {
    const file = path.basename(req.params.file);
    if (PUBLIC_FILES.has(file)) {
        return res.sendFile(path.join(__dirname, file));
    }
    next();
});

/** GET /api/tournaments/usta — returns cached USTA tournament list */
app.get('/api/tournaments/usta', async (req, res) => {
    if (isCacheStale(cache.usta)) {
        await refreshUstaCache();
    }
    if (cache.usta.data) {
        return res.json({ tournaments: cache.usta.data, fetchedAt: cache.usta.fetchedAt });
    }
    // Fallback to seed data
    const fallback = loadFallbackData();
    res.json({ tournaments: fallback.usta, fetchedAt: null, fallback: true });
});

/** GET /api/tournaments/itf — returns cached ITF tournament list */
app.get('/api/tournaments/itf', async (req, res) => {
    if (isCacheStale(cache.itf)) {
        await refreshItfCache();
    }
    if (cache.itf.data) {
        return res.json({ tournaments: cache.itf.data, fetchedAt: cache.itf.fetchedAt });
    }
    // Fallback to seed data
    const fallback = loadFallbackData();
    res.json({ tournaments: fallback.itf, fetchedAt: null, fallback: true });
});

/** POST /api/refresh — force a cache refresh for one or both sources */
app.post('/api/refresh', async (req, res) => {
    const { source } = req.body || {};
    const tasks = [];
    if (!source || source === 'usta') tasks.push(refreshUstaCache());
    if (!source || source === 'itf') tasks.push(refreshItfCache());
    await Promise.allSettled(tasks);
    res.json({
        usta: { count: cache.usta.data ? cache.usta.data.length : 0, fetchedAt: cache.usta.fetchedAt },
        itf: { count: cache.itf.data ? cache.itf.data.length : 0, fetchedAt: cache.itf.fetchedAt },
    });
});

/** GET /health — quick liveness check */
app.get('/health', (_req, res) => {
    res.json({ status: 'ok', uptime: process.uptime() });
});

// ─── Scheduled refresh (every 6 hours: 00:00, 06:00, 12:00, 18:00) ──────────
// Background cron ensures fresh data even on quiet servers with no incoming requests.
cron.schedule('0 */6 * * *', () => {
    console.log('[cron] Scheduled tournament refresh starting…');
    Promise.allSettled([refreshUstaCache(), refreshItfCache()])
        .then(() => console.log('[cron] Scheduled refresh complete.'));
});

// ─── Start ────────────────────────────────────────────────────────────────────
app.listen(PORT, () => {
    console.log(`TournamentHub server running at http://localhost:${PORT}`);
    // Pre-warm the cache on startup (non-blocking)
    refreshUstaCache();
    refreshItfCache();
});

module.exports = app; // allow testing
