# Atlas News

A small iOS-friendly PWA that shows live prices and upcoming high-impact news for a watchlist of 7 tickers (NVDA, TSLA, SPY, XAUUSD, AMZN, AAPL, META). Hosted free on GitHub Pages, refreshed by GitHub Actions.

```
┌─────────────────────┐  cron      ┌──────────────────┐  fetch     ┌──────────────┐
│ GitHub Action       │ ─────────▶ │ docs/*.json      │ ─────────▶ │ iPhone PWA   │
│ runs Python scripts │  commits   │ (this repo)      │  on open   │ (home screen)│
└─────────────────────┘            └──────────────────┘            └──────────────┘
```

## Security: API keys

**The default setup needs zero API keys.** Both data sources are public and keyless:

- **Yahoo Finance** (`yfinance`) — prices, earnings dates
- **ForexFactory** (`https://nfs.faireconomy.media/ff_calendar_thisweek.json`) — macro calendar

The PWA itself runs in your phone's browser and has **no credentials of any kind**. It only fetches the static JSON files this repo serves. There is nothing for an attacker to extract from the client side.

If you later wire up a paid data source (premium Yahoo, FRED for historical macro, etc.), follow this contract:

1. **Never** put real keys in committed code, JSON, or HTML.
2. Add the key as a **GitHub Actions secret** at:
   `Repo → Settings → Secrets and variables → Actions → New repository secret`
3. Reference it in workflow YAML with `${{ secrets.YOUR_KEY_NAME }}` — passed as an env var to the Python step.
4. Read it in Python with `os.environ.get("YOUR_KEY_NAME")` — never log it, never write it to JSON, never commit it to a file.
5. Document the variable name (not the value) in `.env.example`.

`.env` is in `.gitignore`. If you accidentally commit a real key:

1. Revoke it at the provider immediately.
2. Generate a new key.
3. Run `git filter-repo` (or BFG) to scrub it from history — `git rm` alone does not remove it from past commits.
4. Force-push the cleaned history.
5. Save the new key in GitHub Secrets only.

## Local development

```bash
uv sync                              # install Python deps
uv run python scripts/export_prices.py   # writes docs/intraday.json
uv run python scripts/export_news.py     # writes docs/data.json
python -m http.server 8000 --directory docs
# open http://localhost:8000
```

## Deployment

1. Push this repo to GitHub (public repo recommended — unlimited Action minutes).
2. Settings → Pages → Source: **Deploy from a branch** → Branch: `main`, Folder: `/docs`.
3. Wait ~30s, visit `https://<your-username>.github.io/<repo-name>/`.
4. The cron workflows (`refresh-prices.yml`, `refresh-news.yml`) start running automatically.

## Add to iPhone home screen

1. Open the GitHub Pages URL in **Safari** (must be Safari for PWA install on iOS).
2. Tap the share button → **Add to Home Screen**.
3. The icon now lives on your springboard. Tapping launches it full-screen with no Safari chrome.

## Data refresh cadence

| Job | Cadence | Source | Cost |
|---|---|---|---|
| `refresh-prices` | every 15 min | Yahoo Finance (`yfinance`) | ~30s/run, ~24h/month |
| `refresh-news` | every hour | ForexFactory + `yfinance.earnings_dates` | ~10s/run, ~7h/month |

Both fit comfortably in GitHub's 2000 min/month free tier for private repos. Public repos have unlimited minutes.

## Folder layout

```
apps/news/
├── .github/workflows/      cron jobs that produce data.json + intraday.json
├── docs/                   GitHub Pages root (PWA + generated JSON)
├── scripts/                entry points the Actions invoke
├── src/atlas_news/         Python helpers (news + prices)
├── .env.example            documents OPTIONAL keys (real keys go in GH secrets)
├── .gitignore              excludes .env and other private files
├── pyproject.toml          uv-managed Python deps
└── README.md               this file
```

## Extracting to its own repo

This scaffold lives inside the parent Atlas repo for convenience. To split it out:

```bash
cd apps/news
git init
git add .
git commit -m "init: atlas-news scaffold"
gh repo create atlas-news --public --source=. --push
```

The workflow files in `.github/workflows/` activate as soon as the repo exists on GitHub.
