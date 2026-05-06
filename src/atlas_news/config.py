"""Single source of truth for runtime configuration.

All env-var reads live here. No other module reads os.environ directly,
which makes it easy to audit that no secret is ever logged or written
to disk.
"""

from __future__ import annotations

import os
from dataclasses import dataclass


# Yahoo symbols. Gold uses GC=F (continuous futures) because Yahoo's
# XAUUSD=X spot pair is unreliable for intraday bars — futures track spot
# within a few dollars and update every minute, 23/5.
DEFAULT_WATCHLIST: tuple[str, ...] = (
    "NVDA",
    "TSLA",
    "SPY",
    "GC=F",
    "AMZN",
    "AAPL",
    "META",
)

# Yahoo symbol → user-facing label. Anything not listed falls through to
# `<symbol>` with a trailing `=X` stripped.
DISPLAY_OVERRIDES: dict[str, str] = {
    "GC=F": "XAUUSD",
}


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
    """`GC=F` → `XAUUSD`, `XAUUSD=X` → `XAUUSD`. Equities pass through unchanged."""
    if yahoo_symbol in DISPLAY_OVERRIDES:
        return DISPLAY_OVERRIDES[yahoo_symbol]
    return yahoo_symbol.removesuffix("=X")
