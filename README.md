# GMGN Scanner for LP

Standalone scanner that queries **GMGN trending**, applies midcap-degen filters, and outputs clean JSON candidates for downstream LP execution.

**Zero execution — no minting, no transactions, no private keys.** This is the *scanner only*. Pair it with your LP execution engine of choice.

## Quickstart

```bash
npm install
cp .env.example .env
npm run build
npm run scan
```

## How It Works

```
GMGN Trending (5m, 50 tokens)
    │
    ▼
Filter Pipeline
    ├─ Volume $200K–$1M (5m window)
    ├─ Holders ≥ 750
    ├─ Smart Degen ≥ 1
    └─ Wash Trading → reject
    │
    ▼
Sort by volume desc → Top N candidates
    │
    ▼
JSON output to stdout
```

## Output Format

### JSON (default)
```json
{
  "timestamp": "2026-08-01T10:00:00.000Z",
  "chain": "robinhood",
  "filters": { ... },
  "stats": {
    "total_trending": 50,
    "passed": 3,
    "rejected": 47
  },
  "candidates": [
    {
      "address": "0x...",
      "symbol": "PONS",
      "volume_5m": 325000,
      "holder_count": 1200,
      "smart_degen_count": 3,
      "is_wash_trading": false,
      ...
    }
  ],
  "rejected": [...]
}
```

### Pretty format
Set `OUTPUT_FORMAT=pretty` for human-readable terminal output.

## Filter Tuning

All filters are configurable via `.env`:

| Env | Default | Description |
|-----|---------|-------------|
| `CHAIN` | `robinhood` | Chain to scan (robinhood, ethereum, base, bsc) |
| `MIN_VOLUME_USD` | `200000` | Min 5m volume ($) |
| `MAX_VOLUME_USD` | `1000000` | Max 5m volume ($) |
| `MIN_HOLDERS` | `750` | Min holder count |
| `MIN_SMART_DEGEN` | `1` | Min smart degen wallets |
| `REJECT_WASH_TRADING` | `true` | Filter out wash trading tokens |
| `MAX_CANDIDATES` | `5` | Max candidates to return |

## Prerequisites

- **Node.js** ≥ 18
- **gmgn-cli** installed globally: `npm i -g gmgn-cli`
- Valid GMGN API key (demo key works for read-only)

## Downstream Integration

Pipe the JSON output to your LP execution engine. The scanner provides candidate addresses + metadata — the LP engine handles pool discovery, minting, and position management.

```bash
# Example: pipe to a custom LP script
npm run scan | node ../lp-engine/mint.js
```

## License

MIT
