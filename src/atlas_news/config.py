"""Single source of truth for runtime configuration.

All env-var reads live here. No other module reads os.environ directly,
which makes it easy to audit that no secret is ever logged or written
to disk.
"""

from __future__ import annotations

import os
from dataclasses import dataclass


# Yahoo symbols — equities use plain tickers, FX/metals use the =X suffix.
DEFAULT_WATCHLIST: tuple[str, ...] = (
    "NVDA",
    "TSLA",
    "SPY",
    "XAUUSD=X",
    "AMZN",
    "AAPL",
    "META",
)


@dataclass(frozen=True, slots=True)
class Settings:
    watchlist: tuple[str, ...]
    display_tz: str
    fred_api_key: str | None  # optional; never logged

    @classmethod
    def from_env(cls) -> "Settings":
        raw = os.environ.get("WATCHLIST", "").strip()
        watchlist = tuple(s.strip() for s in raw.split(",") if s.strip()) or DEFAULT_WATCHLIST
        return cls(
            watchlist=watchlist,
            display_tz=os.environ.get("DISPLAY_TZ", "Australia/Sydney"),
            fred_api_key=os.environ.get("FRED_API_KEY") or None,
        )


def display_symbol(yahoo_symbol: str) -> str:
    """`XAUUSD=X` → `XAUUSD` for UI display. Equities pass through unchanged."""
    return yahoo_symbol.removesuffix("=X")
