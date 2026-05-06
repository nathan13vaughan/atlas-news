"""Write `docs/data.json` — macro + earnings calendar."""

from __future__ import annotations

import json
from pathlib import Path

from atlas_news.config import Settings
from atlas_news.news import build_payload

OUT = Path(__file__).resolve().parent.parent / "docs" / "data.json"


def main() -> int:
    payload = build_payload(Settings.from_env())
    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text(json.dumps(payload, indent=2), encoding="utf-8")
    print(f"wrote {OUT} — {len(payload['upcoming'])} events")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
