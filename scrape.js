/**
 * scrape.js — Fetch USTA junior U18 tournaments (L1, L2, L3) from the USTA API
 *
 * Configuration (via .env or environment variables):
 *   USTA_API_BASE  — Base URL of the USTA competitions API
 *                    Default: https://api.usta.com/competitions/v1
 *   USTA_API_KEY   — Bearer token / API key issued by USTA developer portal
 *                    (https://ustadigital.atlassian.net/wiki/spaces/DEV/pages/39638433862/API+Reference)
 *   OUTPUT_FILE    — Path to write tournament JSON (default: tournaments.json)
 */

require('dotenv').config();
const axios = require('axios');
const fs = require('fs');

const USTA_API_BASE = process.env.USTA_API_BASE || 'https://api.usta.com/competitions/v1';
const USTA_API_KEY  = process.env.USTA_API_KEY  || '';
const OUTPUT_FILE   = process.env.OUTPUT_FILE   || 'tournaments.json';

const TARGET_LEVELS  = ['L1', 'L2', 'L3'];
const AGE_CATEGORY   = '18U';
const PAGE_SIZE      = 200;

// ---------------------------------------------------------------------------
// HTTP helpers
// ---------------------------------------------------------------------------

function buildHeaders() {
    const headers = {
        Accept: 'application/json',
        'Content-Type': 'application/json',
    };
    if (USTA_API_KEY) {
        headers['Authorization'] = `Bearer ${USTA_API_KEY}`;
    }
    return headers;
}

// ---------------------------------------------------------------------------
// Data-mapping helpers
// ---------------------------------------------------------------------------

function formatDate(dateStr) {
    if (!dateStr) return 'N/A';
    // Trim any time component (e.g. "2026-04-15T00:00:00Z" → "2026-04-15")
    const date = new Date(dateStr);
    if (isNaN(date.getTime())) return dateStr;
    return date.toISOString().split('T')[0];
}

function formatLocation(loc) {
    if (!loc) return 'N/A';
    if (typeof loc === 'string') return loc;
    return [loc.city, loc.state, loc.country].filter(Boolean).join(', ') || 'N/A';
}

function formatDirectorName(director) {
    if (!director) return 'N/A';
    if (typeof director === 'string') return director;
    const full = [director.firstName, director.lastName].filter(Boolean).join(' ');
    return full || director.name || director.fullName || 'N/A';
}

function formatPhone(director) {
    if (!director) return '';
    return director.phone || director.phoneNumber || director.contactPhone || '';
}

function buildTournamentUrl(t) {
    if (t.url)       return t.url;
    if (t.link)      return t.link;
    if (t.id)        return `https://playtennis.usta.com/tournaments/${t.id}`;
    return 'https://playtennis.usta.com/tournaments';
}

/**
 * Map a raw USTA API tournament object to our canonical shape.
 * Field names are tried in order of most→least likely from the USTA API.
 */
function mapTournament(t, level) {
    const directorRaw = t.director || t.tournamentDirector || t.contact || {};
    return {
        name:                 t.name || t.tournamentName || t.title || 'Unknown Tournament',
        location:             formatLocation(t.location || t.venue || t.address || ''),
        entry_deadline:       formatDate(t.entryDeadline   || t.registrationDeadline || t.entryCloseDate || ''),
        withdrawal_deadline:  formatDate(t.withdrawalDeadline || t.withdrawDeadline  || ''),
        freeze_deadline:      formatDate(t.freezeDeadline  || t.drawDeadline         || t.freezeDate    || ''),
        director_name:        formatDirectorName(directorRaw),
        director_phone:       formatPhone(directorRaw),
        level:                `Level ${level.replace('L', '')}`,
        tournament_url:       buildTournamentUrl(t),
    };
}

// ---------------------------------------------------------------------------
// API fetch
// ---------------------------------------------------------------------------

/**
 * Fetch all tournaments for a given level, handling pagination automatically.
 */
async function fetchTournamentsForLevel(level) {
    const headers = buildHeaders();
    const collected = [];
    let page = 1;

    while (true) {
        const params = {
            levelCategoryCode: level,
            ageCategoryCode:   AGE_CATEGORY,
            typeCode:          'JR',     // Junior
            pageSize:          PAGE_SIZE,
            pageNumber:        page,
        };

        try {
            console.log(`  GET ${USTA_API_BASE}/tournament-search  [level=${level}, page=${page}]`);
            const response = await axios.get(`${USTA_API_BASE}/tournament-search`, {
                params,
                headers,
                timeout: 20000,
            });

            const body = response.data;

            // The USTA API may wrap results in different envelope shapes
            const items = body.tournaments
                       || body.items
                       || body.results
                       || body.data
                       || (Array.isArray(body) ? body : []);

            if (!Array.isArray(items) || items.length === 0) break;

            collected.push(...items.map(t => mapTournament(t, level)));

            // Stop paginating when we receive fewer items than requested
            if (items.length < PAGE_SIZE) break;
            page++;
        } catch (err) {
            const status = err.response ? err.response.status : 'N/A';
            console.error(`  Error fetching ${level} tournaments (HTTP ${status}): ${err.message}`);
            if (status === 401 || status === 403) {
                console.error('  → Check your USTA_API_KEY in .env (see .env.example).');
            }
            break; // Don't retry on error — let the caller handle gracefully
        }
    }

    return collected;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

/**
 * Fetch all USTA junior U18 tournaments for L1, L2, L3 and write to disk.
 * @returns {Promise<Array>} The combined tournament array
 */
const scrapeTournaments = async () => {
    console.log('Fetching USTA junior U18 tournaments (L1, L2, L3)…');
    const all = [];

    for (const level of TARGET_LEVELS) {
        console.log(`Fetching ${level} tournaments…`);
        const results = await fetchTournamentsForLevel(level);
        console.log(`  → ${results.length} tournaments found for ${level}`);
        all.push(...results);
    }

    // Sort by entry deadline (soonest first, N/A entries last)
    all.sort((a, b) => {
        if (a.entry_deadline === 'N/A') return 1;
        if (b.entry_deadline === 'N/A') return -1;
        const tA = new Date(a.entry_deadline).getTime();
        const tB = new Date(b.entry_deadline).getTime();
        if (isNaN(tA) && isNaN(tB)) return 0;
        if (isNaN(tA)) return 1;
        if (isNaN(tB)) return -1;
        return tA - tB;
    });

    fs.writeFileSync(OUTPUT_FILE, JSON.stringify(all, null, 2));
    console.log(`Saved ${all.length} tournament(s) to ${OUTPUT_FILE}`);

    return all;
};

// Run directly: `node scrape.js`
if (require.main === module) {
    scrapeTournaments().catch(err => {
        console.error('Fatal error in scrape:', err);
        process.exit(1);
    });
}

module.exports = { scrapeTournaments };