/**
 * scrape.js — TournamentHub data fetcher
 *
 * Fetches junior U18 tournaments from both:
 *  - USTA Connect API  (OAuth 2.0, REST/JSON) — Levels L1, L2, L3
 *  - ITF World Tennis Number API (GraphQL, JWT) — Americas region
 *
 * Saves the merged result to tournaments.json so the frontend can load it
 * even when the backend server is not running.
 *
 * Usage:
 *   node scrape.js
 *
 * Required environment variables (copy .env.example → .env):
 *   USTA_CLIENT_ID, USTA_CLIENT_SECRET, USTA_API_BASE_URL, USTA_TOKEN_URL
 *   ITF_JWT_TOKEN, ITF_PROVIDER_ID, ITF_API_URL
 */

'use strict';

require('dotenv').config();

const axios = require('axios');
const fs = require('fs');
const path = require('path');

// ─── Retry helper ─────────────────────────────────────────────────────────────

/**
 * Retry an async function up to `maxAttempts` times with exponential back-off.
 * @param {Function} fn
 * @param {number}   maxAttempts
 * @returns {Promise<*>}
 */
async function withRetry(fn, maxAttempts = 3) {
    let lastError;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        try {
            return await fn();
        } catch (err) {
            lastError = err;
            if (attempt < maxAttempts) {
                const delay = 1000 * Math.pow(2, attempt - 1); // 1 s, 2 s, 4 s …
                console.warn(`  Attempt ${attempt} failed (${err.message}). Retrying in ${delay}ms…`);
                await new Promise((resolve) => setTimeout(resolve, delay));
            }
        }
    }
    throw lastError;
}

// ─── USTA ─────────────────────────────────────────────────────────────────────

/** Obtain an OAuth 2.0 access token from the USTA identity service. */
async function getUstaAccessToken() {
    const tokenUrl = process.env.USTA_TOKEN_URL || 'https://identity.usta.com/oauth/token';
    const clientId = process.env.USTA_CLIENT_ID;
    const clientSecret = process.env.USTA_CLIENT_SECRET;

    if (!clientId || !clientSecret) {
        throw new Error(
            'USTA_CLIENT_ID and USTA_CLIENT_SECRET must be set. ' +
            'See .env.example for instructions on obtaining credentials.'
        );
    }

    const params = new URLSearchParams({
        grant_type: 'client_credentials',
        client_id: clientId,
        client_secret: clientSecret,
    });

    const response = await axios.post(tokenUrl, params.toString(), {
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        timeout: 10000,
    });
    return response.data.access_token;
}

/**
 * Fetch a single page of USTA junior U18 tournaments for one level.
 * @param {string} token - OAuth access token
 * @param {string} level - 'L1' | 'L2' | 'L3'
 * @param {number} page  - 1-based page number
 */
async function fetchUstaPage(token, level, page = 1) {
    const baseUrl = process.env.USTA_API_BASE_URL || 'https://api.usta.com';
    const response = await axios.get(`${baseUrl}/tournament/v1/tournament-search`, {
        headers: { Authorization: `Bearer ${token}` },
        params: {
            divisionCategory: 'junior',
            ageGroup: '18',
            level,
            pageSize: 200,
            page,
        },
        timeout: 15000,
    });

    const body = response.data;
    const items = body.tournaments || body.data || (Array.isArray(body) ? body : []);
    const totalPages = body.totalPages || body.pagination?.totalPages || 1;
    return { items, totalPages };
}

/** Fetch all pages for one level and return the raw tournament array. */
async function fetchUstaLevel(token, level) {
    const first = await fetchUstaPage(token, level, 1);
    let all = [...first.items];
    for (let p = 2; p <= first.totalPages; p++) {
        const { items } = await fetchUstaPage(token, level, p);
        all = all.concat(items);
    }
    return all;
}

/** Transform a raw USTA API response object to the hub's normalised shape. */
function normaliseUstaTournament(raw, level) {
    const director = raw.tournamentDirector || raw.director || {};
    const directorName = director.name
        || [director.firstName, director.lastName].filter(Boolean).join(' ')
        || '';
    return {
        source: 'USTA',
        name: raw.name || raw.tournamentName || '',
        location: [raw.city, raw.state].filter(Boolean).join(', ') || raw.location || '',
        entry_deadline: raw.entryDeadline || raw.registrationDeadline || '',
        withdrawal_deadline: raw.withdrawalDeadline || '',
        freeze_deadline: raw.freezeDeadline || raw.drawsDeadline || '',
        director_name: directorName,
        director_phone: director.phone || director.phoneNumber || '',
        level: raw.level || level,
        tournament_url: raw.url || raw.registrationUrl
            || `https://playtennis.usta.com/competitions/USTA/competitiondetail?id=${raw.id || ''}`,
        start_date: raw.startDate || '',
        end_date: raw.endDate || '',
    };
}

/** Fetch all USTA junior U18 L1/L2/L3 tournaments. */
async function scrapeUstaTournaments() {
    console.log('[USTA] Authenticating…');
    const token = await withRetry(() => getUstaAccessToken());
    console.log('[USTA] Authenticated. Fetching L1, L2, L3 junior U18 tournaments…');

    const levels = ['L1', 'L2', 'L3'];
    const results = await Promise.allSettled(
        levels.map((level) =>
            withRetry(() => fetchUstaLevel(token, level)).then((items) => ({ level, items }))
        )
    );

    const tournaments = [];
    for (const result of results) {
        if (result.status === 'fulfilled') {
            const { level, items } = result.value;
            console.log(`[USTA] ${level}: ${items.length} tournament(s) found.`);
            items.forEach((t) => tournaments.push(normaliseUstaTournament(t, level)));
        } else {
            console.error(`[USTA] Error fetching a level: ${result.reason.message}`);
        }
    }

    console.log(`[USTA] Total: ${tournaments.length} tournament(s).`);
    return tournaments;
}

// ─── ITF WTN ──────────────────────────────────────────────────────────────────

/** GraphQL query for ITF junior U18 tournaments in the Americas zone. */
const ITF_QUERY = `
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

/** Transform a raw ITF API response object to the hub's normalised shape. */
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
async function scrapeItfTournaments() {
    const apiUrl = process.env.ITF_API_URL || 'https://api.worldtennisnumber.com/graphql';
    const token = process.env.ITF_JWT_TOKEN;
    const providerId = process.env.ITF_PROVIDER_ID;

    if (!token) {
        throw new Error(
            'ITF_JWT_TOKEN must be set. ' +
            'See .env.example for instructions on obtaining credentials.'
        );
    }

    console.log('[ITF] Fetching junior U18 Americas tournaments via GraphQL…');

    const response = await withRetry(() =>
        axios.post(
            apiUrl,
            {
                query: ITF_QUERY,
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
        )
    );

    const body = response.data;
    if (body.errors && body.errors.length > 0) {
        throw new Error(`ITF GraphQL errors: ${body.errors.map((e) => e.message).join('; ')}`);
    }

    const raw = (body.data && body.data.tournaments) || [];
    const tournaments = raw.map(normaliseItfTournament);
    console.log(`[ITF] Total: ${tournaments.length} tournament(s).`);
    return tournaments;
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
    console.log('═══════════════════════════════════════════════');
    console.log('  TournamentHub — Tournament Data Fetcher');
    console.log('═══════════════════════════════════════════════\n');

    const errors = [];

    let ustaTournaments = [];
    try {
        ustaTournaments = await scrapeUstaTournaments();
    } catch (err) {
        console.error(`[USTA] Skipped: ${err.message}`);
        errors.push({ source: 'USTA', message: err.message });
    }

    let itfTournaments = [];
    try {
        itfTournaments = await scrapeItfTournaments();
    } catch (err) {
        console.error(`[ITF] Skipped: ${err.message}`);
        errors.push({ source: 'ITF', message: err.message });
    }

    const total = ustaTournaments.length + itfTournaments.length;
    if (total === 0 && errors.length > 0) {
        console.error('\n⚠ No tournaments fetched. Check credentials in .env');
        process.exitCode = 1;
    }

    const output = {
        generatedAt: new Date().toISOString(),
        usta: ustaTournaments,
        itf: itfTournaments,
    };

    const outPath = path.join(__dirname, 'tournaments.json');
    fs.writeFileSync(outPath, JSON.stringify(output, null, 2));
    console.log(`\n✔ Saved ${total} tournament(s) to tournaments.json`);

    if (errors.length > 0) {
        console.warn('\nErrors encountered during fetch:');
        errors.forEach((e) => console.warn(`  [${e.source}] ${e.message}`));
    }
}

main();