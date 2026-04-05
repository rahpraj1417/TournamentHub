# TournamentHub
Junior Tennis Tournament Hub — dynamically populated with live data from the USTA API.

## Features
- Displays USTA junior U18 tournaments for **Level 1, Level 2, and Level 3**
- ITF junior tournaments table (Americas)
- Search, filter by level/region, and sort by any column
- Live data refresh via Express backend + USTA API

## Setup

### 1. Install dependencies
```bash
npm install
```

### 2. Configure USTA API credentials
```bash
cp .env.example .env
# Edit .env and set your USTA_API_KEY
# Get API access at: https://ustadigital.atlassian.net/wiki/spaces/DEV/pages/39638433862/API+Reference
```

### 3. Fetch tournament data
```bash
npm run scrape
```
This calls the USTA API and writes results to `tournaments.json`.

### 4. Start the server
```bash
npm start
# Open http://localhost:3000
```

The page automatically loads `tournaments.json` via `GET /api/tournaments`.  
Click **🔄 Refresh Data** to re-fetch live data from the USTA API at any time.

## Scripts
| Command | Description |
|---------|-------------|
| `npm start` | Start the Express server |
| `npm run dev` | Start server with auto-reload (nodemon) |
| `npm run scrape` | Fetch fresh tournament data from USTA |

## Architecture
- `server.js` — Express backend; serves static files and `/api/tournaments`, `/api/refresh`
- `scrape.js` — Fetches USTA junior U18 tournaments (L1/L2/L3) from the USTA competitions API
- `index.html` — Frontend; dynamically renders tournament data fetched from the server
- `tournaments.json` — Cached tournament data (auto-generated, not committed to git)
