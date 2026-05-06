// Atlas News — vanilla JS PWA renderer.
// Fetches data.json + intraday.json, renders the watchlist + calendar,
// ticks the countdown each second, persists the chip filter in localStorage.

const TZ = "Australia/Sydney";
const FMT_TIME = new Intl.DateTimeFormat("en-AU", {
  timeZone: TZ, weekday: "short", hour: "2-digit", minute: "2-digit", hour12: false,
});
const FMT_FULL = new Intl.DateTimeFormat("en-AU", {
  timeZone: TZ, weekday: "short", day: "2-digit", month: "short",
  hour: "2-digit", minute: "2-digit", hour12: false,
});

const TICKERS = ["NVDA", "TSLA", "SPY", "XAUUSD", "AMZN", "AAPL", "META"];
const FILTER_KEY = "atlas-news.filter";

// --- state ---
let state = {
  news: null,         // data.json
  prices: null,       // intraday.json
  filter: localStorage.getItem(FILTER_KEY) || "all",
};

// --- fetchers (network-first via service worker, fall back to cache) ---
async function loadJSON(name) {
  const url = `${name}?t=${Date.now()}`;
  const resp = await fetch(url, { cache: "no-cache" });
  if (!resp.ok) throw new Error(`${name}: ${resp.status}`);
  return resp.json();
}

async function refresh() {
  const results = await Promise.allSettled([
    loadJSON("data.json"),
    loadJSON("intraday.json"),
  ]);
  if (results[0].status === "fulfilled") state.news = results[0].value;
  if (results[1].status === "fulfilled") state.prices = results[1].value;
  render();
}

// --- formatting helpers ---
function fmtPct(x) {
  const sign = x >= 0 ? "+" : "−";
  return `${sign}${(Math.abs(x) * 100).toFixed(2)}%`;
}
function fmtPrice(x) {
  return x >= 1000 ? `$${x.toFixed(2)}` : `$${x.toFixed(2)}`;
}
function timeUntil(iso) {
  const ms = new Date(iso) - Date.now();
  if (ms <= 0) return null;
  const d = Math.floor(ms / 86400000);
  const h = Math.floor((ms / 3600000) % 24);
  const m = Math.floor((ms / 60000) % 60);
  const s = Math.floor((ms / 1000) % 60);
  return { d, h, m, s };
}
function pad2(n) { return String(n).padStart(2, "0"); }

function sparkPath(spark, isUp) {
  if (!spark || spark.length < 2) return ["", ""];
  const cs = spark.map(p => p.c);
  const lo = Math.min(...cs), hi = Math.max(...cs);
  const range = hi - lo || 1;
  const w = 100, h = 26, pad = 3;
  const pts = cs.map((c, i) => {
    const x = (i / (cs.length - 1)) * w;
    const y = h - pad - ((c - lo) / range) * (h - 2 * pad);
    return `${x.toFixed(1)},${y.toFixed(1)}`;
  });
  const line = `M${pts.join(" L")}`;
  const fill = `${line} L${w},${h} L0,${h} Z`;
  return [line, fill];
}

// --- render: chips ---
function renderChips() {
  const el = document.getElementById("chips");
  const items = [
    { key: "all", label: "All" },
    ...TICKERS.map(t => ({ key: t, label: t, gold: t === "XAUUSD" })),
  ];
  el.innerHTML = items.map(i => {
    const on = state.filter === i.key;
    const cls = ["chip", on ? "on" : "", i.gold ? "gold" : ""].filter(Boolean).join(" ");
    return `<div class="${cls}" data-filter="${i.key}">${i.label}</div>`;
  }).join("");
  el.querySelectorAll(".chip").forEach(c =>
    c.addEventListener("click", () => {
      state.filter = c.dataset.filter;
      localStorage.setItem(FILTER_KEY, state.filter);
      render();
    })
  );
}

// --- render: price strip ---
function renderPriceStrip() {
  const el = document.getElementById("pricestrip");
  const meta = document.getElementById("pricestripMeta");
  if (!state.prices) {
    el.innerHTML = "";
    meta.textContent = "loading prices…";
    return;
  }
  const filtered = state.filter === "all"
    ? state.prices.tickers
    : state.prices.tickers.filter(t => t.symbol === state.filter);

  const wide = filtered.length === 1;

  el.innerHTML = filtered.map(t => {
    const isUp = t.change >= 0;
    const arrow = isUp ? "▲" : "▼";
    const cls = ["pricecard", isUp ? "up" : "down", t.is_open ? "" : "muted", wide ? "wide" : ""]
      .filter(Boolean).join(" ");
    const tag = t.is_open ? `<div class="arrow">${arrow}</div>` : `<div class="closed-tag">closed</div>`;
    const [line, fill] = sparkPath(t.spark, isUp);
    return `
      <div class="${cls}">
        <div class="head"><div class="sym">${t.symbol}</div>${tag}</div>
        <div class="px">${fmtPrice(t.last)}</div>
        <div class="chg"><span class="pct">${fmtPct(t.change_pct)}</span></div>
        <svg class="spark" viewBox="0 0 100 26" preserveAspectRatio="none">
          <path class="fill" d="${fill}"/>
          <path class="line" d="${line}"/>
        </svg>
      </div>`;
  }).join("");

  const ageMin = Math.round((Date.now() - new Date(state.prices.generated_at)) / 60000);
  meta.textContent = `prices ${ageMin}m ago · 1-min bars · Yahoo`;
}

// --- render: blackout banner ---
function renderBlackout() {
  const el = document.getElementById("blackout");
  const sub = document.getElementById("blackoutSub");
  const dot = document.getElementById("dot");
  if (state.news?.in_blackout && state.news.active_blackout) {
    const a = state.news.active_blackout;
    const until = timeUntil(a.blackout_end);
    sub.textContent = until
      ? `${a.title} · ends in ${until.h ? until.h + "h " : ""}${until.m}m ${pad2(until.s)}s`
      : `${a.title} · ending now`;
    el.hidden = false;
    dot.parentElement.classList.add("blackout");
  } else {
    el.hidden = true;
    dot.parentElement.classList.remove("blackout");
  }
}

// --- render: hero (next event countdown) ---
function renderHero() {
  const el = document.getElementById("hero");
  const titleEl = document.getElementById("heroTitle");
  const cdEl = document.getElementById("countdown");
  const badgesEl = document.getElementById("heroBadges");
  const evt = pickNextEventForFilter();
  if (!evt) { el.hidden = true; return; }
  el.hidden = false;
  titleEl.textContent = evt.title;
  const t = timeUntil(evt.scheduled_at);
  if (!t) { cdEl.innerHTML = `<div class="cell"><div class="num">live</div></div>`; }
  else {
    cdEl.innerHTML = ["d", "h", "m", "s"].map((u, i) => {
      const v = [t.d, t.h, t.m, t.s][i];
      return `<div class="cell"><div class="num">${pad2(v)}</div><div class="unit">${
        ["days","hrs","min","sec"][i]
      }</div></div>`;
    }).join("");
  }
  const symCls = evt.symbol === "XAUUSD" ? "symbol-xau" : "symbol-spy";
  badgesEl.innerHTML = `
    <span class="badge ${symCls}">${evt.symbol}</span>
    <span class="badge impact-${evt.impact}">${evt.impact.toUpperCase()}</span>`;
}

function pickNextEventForFilter() {
  if (!state.news?.upcoming) return null;
  if (state.filter === "all") return state.news.next_event;
  return state.news.upcoming.find(e => e.symbol === state.filter) || null;
}

// --- render: upcoming list ---
function renderList() {
  const el = document.getElementById("list");
  if (!state.news?.upcoming) { el.innerHTML = ""; return; }
  const filtered = state.filter === "all"
    ? state.news.upcoming
    : state.news.upcoming.filter(e => e.symbol === state.filter);
  el.innerHTML = filtered.slice(0, 30).map((e, i) => {
    const when = FMT_TIME.format(new Date(e.scheduled_at));
    const symCls = e.symbol === "XAUUSD" ? "symbol-xau" : "symbol-spy";
    return `
      <div class="row" data-idx="${i}">
        <span class="when">${when}</span>
        <span class="what">${e.title}</span>
        <span class="right">
          <span class="badge ${symCls}">${e.symbol}</span>
        </span>
      </div>`;
  }).join("");
  el.querySelectorAll(".row").forEach((row, i) =>
    row.addEventListener("click", () => openSheet(filtered[i]))
  );
}

// --- detail sheet ---
function openSheet(evt) {
  const sheet = document.getElementById("sheet");
  const overlay = document.getElementById("overlay");
  document.getElementById("sheetTitle").textContent = evt.title;
  const t = timeUntil(evt.scheduled_at);
  const away = t ? `${t.d ? t.d + "d " : ""}${t.h}h ${t.m}m away` : "live now";
  document.getElementById("sheetMeta").textContent =
    `${FMT_FULL.format(new Date(evt.scheduled_at))} AEST · ${away}`;
  const kv = [
    ["Symbol", evt.symbol],
    ["Kind", evt.kind],
    ["Impact", evt.impact.toUpperCase()],
    evt.forecast ? ["Forecast", evt.forecast] : null,
    evt.previous ? ["Previous", evt.previous] : null,
    evt.blackout_start ? ["Blackout",
      `${FMT_TIME.format(new Date(evt.blackout_start))} → ${FMT_TIME.format(new Date(evt.blackout_end))}`] : null,
  ].filter(Boolean);
  document.getElementById("sheetKv").innerHTML =
    kv.map(([k, v]) => `<div class="k">${k}</div><div>${v}</div>`).join("");
  sheet.hidden = false;
  overlay.hidden = false;
  overlay.onclick = closeSheet;
}
function closeSheet() {
  document.getElementById("sheet").hidden = true;
  document.getElementById("overlay").hidden = true;
}

// --- updated indicator ---
function renderUpdatedLabel() {
  const el = document.getElementById("updated");
  if (!state.news && !state.prices) { el.textContent = "loading…"; return; }
  const newsAge = state.news
    ? Math.round((Date.now() - new Date(state.news.generated_at)) / 60000) + "m"
    : "—";
  const pxAge = state.prices
    ? Math.round((Date.now() - new Date(state.prices.generated_at)) / 60000) + "m"
    : "—";
  el.textContent = `px ${pxAge} · news ${newsAge}`;
}

// --- master render ---
function render() {
  renderChips();
  renderBlackout();
  renderPriceStrip();
  renderHero();
  renderList();
  renderUpdatedLabel();
}

// tick the countdown every second so the user sees live progress
setInterval(() => {
  renderHero();
  renderBlackout();
  renderUpdatedLabel();
}, 1000);

// service worker registration
if ("serviceWorker" in navigator) {
  navigator.serviceWorker.register("service-worker.js").catch(() => {});
}

// pull-to-refresh: refetch JSON when the user comes back to the tab
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible") refresh();
});

refresh();
