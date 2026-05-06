"""Fetch upcoming events: macro releases (ForexFactory) + equity earnings (yfinance).

Output `data.json` shape:
    {
        "generated_at": "2026-05-06T14:00:00Z",
        "next_event": { ... },               # nearest upcoming event
        "in_blackout": false,
        "active_blackout": null | { ... },
        "upcoming": [ {event}, ... ]         # next 7 days, sorted ascending
    }

Each event:
    {
        "title":        "CPI YoY",
        "kind":         "macro" | "earnings",
        "symbol":       "SPY" | "NVDA" | ...,
        "impact":       "high" | "medium" | "low",
        "scheduled_at": "2026-05-06T12:30:00Z",   # always UTC
        "blackout_start": "2026-05-06T12:25:00Z", # nullable (only macro)
        "blackout_end":   "2026-05-06T12:45:00Z",
        "forecast":     "3.4%",                   # nullable
        "previous":     "3.5%"                    # nullable
    }
"""

from __future__ import annotations

from dataclasses import asdict, dataclass
from datetime import UTC, datetime, timedelta
from typing import Any

import requests
import yfinance as yf

from .config import Settings, display_symbol

# Public, keyless. Returns events for the current week.
FF_URL = "https://nfs.faireconomy.media/ff_calendar_thisweek.json"

# Macro events that affect each instrument. Used to attach a `symbol` to FF rows
# (FF labels by country, not ticker).
COUNTRY_TO_SYMBOL: dict[str, str] = {
    "USD": "SPY",  # US macro → SPY proxy
    "EUR": "XAUUSD",  # ECB moves gold
    "GBP": "XAUUSD",
}

IMPACT_MAP: dict[str, str] = {"High": "high", "Medium": "medium", "Low": "low"}


@dataclass(frozen=True, slots=True)
class Event:
    title: str
    kind: str  # "macro" | "earnings"
    symbol: str
    impact: str
    scheduled_at: str
    blackout_start: str | None = None
    blackout_end: str | None = None
    forecast: str | None = None
    previous: str | None = None


def _parse_ff_datetime(date: str) -> datetime | None:
    """ForexFactory uses ISO-8601 with `+0000` style offsets."""
    try:
        return datetime.fromisoformat(date).astimezone(UTC)
    except (ValueError, TypeError):
        return None


def fetch_macro_events() -> list[Event]:
    """ForexFactory weekly calendar. Public, keyless."""
    try:
        resp = requests.get(FF_URL, timeout=10)
        resp.raise_for_status()
        rows = resp.json()
    except (requests.RequestException, ValueError):
        return []

    events: list[Event] = []
    for row in rows:
        country = row.get("country", "")
        if country not in COUNTRY_TO_SYMBOL:
            continue
        impact_raw = row.get("impact", "")
        if impact_raw not in ("High", "Medium"):
            continue
        when = _parse_ff_datetime(row.get("date", ""))
        if when is None:
            continue
        events.append(
            Event(
                title=str(row.get("title", "")).strip(),
                kind="macro",
                symbol=COUNTRY_TO_SYMBOL[country],
                impact=IMPACT_MAP.get(impact_raw, "low"),
                scheduled_at=when.isoformat(timespec="seconds"),
                blackout_start=(when - timedelta(minutes=5)).isoformat(timespec="seconds"),
                blackout_end=(when + timedelta(minutes=15)).isoformat(timespec="seconds"),
                forecast=row.get("forecast") or None,
                previous=row.get("previous") or None,
            )
        )
    return events


def fetch_earnings_events(settings: Settings) -> list[Event]:
    """yfinance earnings dates per equity. Public, keyless. Tolerant to failures.

    Logs each ticker's outcome so we can diagnose silent emptiness in the
    Action's run output without re-deploying.
    """
    events: list[Event] = []
    now = datetime.now(UTC)
    horizon = now + timedelta(days=60)

    for yahoo_sym in settings.watchlist:
        sym = display_symbol(yahoo_sym)
        # FX, futures, and the SPY index don't report earnings.
        if "=" in yahoo_sym or sym in {"SPY", "XAUUSD"}:
            continue

        df = None
        err = None
        try:
            df = yf.Ticker(yahoo_sym).earnings_dates
        except Exception as e:
            err = repr(e)

        if df is None or df.empty:
            print(f"earnings[{sym}]: empty (err={err})")
            continue

        added = 0
        for ts, _row in df.iterrows():
            when = ts.to_pydatetime().astimezone(UTC)
            if when < now or when > horizon:
                continue
            events.append(
                Event(
                    title=f"{sym} Earnings",
                    kind="earnings",
                    symbol=sym,
                    impact="high",
                    scheduled_at=when.isoformat(timespec="seconds"),
                )
            )
            added += 1
        print(f"earnings[{sym}]: {added} upcoming row(s) within 60d")
    return events


def build_payload(settings: Settings) -> dict[str, Any]:
    now = datetime.now(UTC)
    events = fetch_macro_events() + fetch_earnings_events(settings)
    events.sort(key=lambda e: e.scheduled_at)

    upcoming = [e for e in events if e.scheduled_at >= now.isoformat(timespec="seconds")]
    next_event = upcoming[0] if upcoming else None

    active = next(
        (
            e
            for e in events
            if e.blackout_start
            and e.blackout_end
            and e.blackout_start <= now.isoformat(timespec="seconds") < e.blackout_end
        ),
        None,
    )

    return {
        "generated_at": now.isoformat(timespec="seconds"),
        "next_event": asdict(next_event) if next_event else None,
        "in_blackout": active is not None,
        "active_blackout": asdict(active) if active else None,
        "upcoming": [asdict(e) for e in upcoming[:50]],
    }
