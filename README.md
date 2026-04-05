# 🏆 TournamentHub — Junior Tennis Tournament Hub

A web application that displays junior U18 tennis tournament data from both the **USTA Connect API** (Levels L1, L2, L3) and the **ITF World Tennis Number API** (Americas region).

## Screenshot

![Tournament Hub UI](https://github.com/user-attachments/assets/b34f4aa2-3ef0-4437-b428-982f7643d8d5)

## Features

- **USTA tab** — Junior U18 tournaments for Levels 1, 2, and 3
- **ITF tab** — Junior U18 tournaments across North and South America
- Real-time search/filter by tournament name, location, and level
- Sortable columns (click any table header)
- 1-hour in-memory cache with automatic refresh every 6 hours
- Manual **🔄 Refresh Data** button
- Graceful fallback to `tournaments.json` when API credentials are unavailable

## Quick Start

### 1. Install dependencies

```bash
npm install
```

### 2. Configure API credentials

```bash
cp .env.example .env
# Edit .env and fill in your USTA and ITF credentials
```

#### USTA Connect API credentials
Apply for access at <https://ustadigital.atlassian.net/wiki/spaces/DEV/pages/742916315/> or email **ustaconnect@usta.com**.

#### ITF World Tennis Number API credentials
Request access via <https://docs.worldtennisnumber.com/> as an ITF partner.

### 3. Run the scraper (optional — populates `tournaments.json`)

```bash
node scrape.js
```

### 4. Start the server

```bash
npm start
# Open http://localhost:3000
```

## Architecture

| File | Purpose |
|------|---------|
| `server.js` | Express backend — proxies USTA & ITF API calls, serves static files, caches results |
| `scrape.js` | Standalone script — fetches from both APIs and writes `tournaments.json` |
| `index.html` | Frontend — dynamically loads tournament data from the backend via `fetch()` |
| `tournaments.json` | Auto-generated seed/fallback data (produced by `scrape.js`) |
| `.env.example` | Template for required environment variables |

## API Endpoints

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/api/tournaments/usta` | USTA junior U18 tournaments (L1, L2, L3) |
| `GET` | `/api/tournaments/itf` | ITF junior U18 Americas tournaments |
| `POST` | `/api/refresh` | Force a cache refresh (`body: { "source": "usta" | "itf" }`) |
| `GET` | `/health` | Liveness check |

## Environment Variables

See `.env.example` for a full list. Key variables:

```
USTA_CLIENT_ID        # USTA OAuth 2.0 client ID
USTA_CLIENT_SECRET    # USTA OAuth 2.0 client secret
USTA_API_BASE_URL     # https://api.usta.com  (confirm with USTA)
USTA_TOKEN_URL        # https://identity.usta.com/oauth/token

ITF_JWT_TOKEN         # ITF WTN JWT bearer token
ITF_PROVIDER_ID       # ITF provider ID (x-clubspark-provider-id header)
ITF_API_URL           # https://api.worldtennisnumber.com/graphql
```

Junior Tennis Tournament Hub
