"""Fetch last-24h 1-minute bars for the watchlist via yfinance.

Output shape per ticker:
    {
        "symbol": "NVDA",
        "last":     925.30,        # most recent close
        "open":     914.32,        # session open used for change calc
        "change":     10.98,
        "change_pct": 0.0120,
        "currency": "USD",
        "is_open":  true,           # market open right now?
        "spark": [{"t": "...", "c": 925.10}, ...]
    }
"""

from __future__ import annotations

from dataclasses import asdict, dataclass
from datetime import UTC, datetime
from typing import Any

import yfinance as yf

from .config import Settings, display_symbol


@dataclass(frozen=True, slots=True)
class SparkPoint:
    t: str  # ISO-8601 UTC
    c: float


@dataclass(frozen=True, slots=True)
class TickerSnapshot:
    symbol: str
    last: float
    open: float
    change: float
    change_pct: float
    currency: str
    is_open: bool
    spark: list[SparkPoint]


def fetch_snapshot(yahoo_symbol: str) -> TickerSnapshot | None:
    """Return a snapshot or None if the upstream call failed."""
    try:
        tk = yf.Ticker(yahoo_symbol)
        hist = tk.history(period="2d", interval="1m", auto_adjust=False)
        if hist.empty:
            return None
        info = tk.fast_info
    except Exception:
        return None

    closes = hist["Close"].dropna()
    if closes.empty:
        return None

    last = float(closes.iloc[-1])
    session_open = float(closes.iloc[0])
    change = last - session_open
    change_pct = change / session_open if session_open else 0.0

    spark = [
        SparkPoint(t=ts.tz_convert(UTC).isoformat(), c=float(c))
        for ts, c in closes.tail(96).items()  # ~last 1.5h at 1-min cadence
    ]

    return TickerSnapshot(
        symbol=display_symbol(yahoo_symbol),
        last=last,
        open=session_open,
        change=change,
        change_pct=change_pct,
        currency=getattr(info, "currency", None) or "USD",
        is_open=bool(getattr(info, "market_state", "REGULAR") == "REGULAR"),
        spark=spark,
    )


def fetch_all(settings: Settings) -> dict[str, Any]:
    """Build the full intraday.json payload for the watchlist."""
    snapshots: list[dict[str, Any]] = []
    for sym in settings.watchlist:
        snap = fetch_snapshot(sym)
        if snap is not None:
            snapshots.append(asdict(snap))
    return {
        "generated_at": datetime.now(UTC).isoformat(timespec="seconds"),
        "tickers": snapshots,
    }
