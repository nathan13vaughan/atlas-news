"""Write `docs/intraday.json` for the watchlist."""

from __future__ import annotations

import json
import sys
from pathlib import Path

from atlas_news.config import Settings
from atlas_news.prices import fetch_all

OUT = Path(__file__).resolve().parent.parent / "docs" / "intraday.json"


def main() -> int:
    payload = fetch_all(Settings.from_env())
    if not payload["tickers"]:
        print("no tickers fetched — leaving existing intraday.json untouched", file=sys.stderr)
        return 1
    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text(json.dumps(payload, indent=2), encoding="utf-8")
    print(f"wrote {OUT} — {len(payload['tickers'])} tickers")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
