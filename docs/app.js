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
const IMPACT_KEY = "atlas-news.impact";
const KEYS_KEY = "atlas-news.api-keys";

// --- provider catalog ---
// Each entry knows how to fetch from a public API and map results into the
// internal Event shape. Built-ins (forexfactory, yahoo) are powered by the
// GitHub Action; client-side providers live here.
const PROVIDERS = [
  {
    id: "forexfactory",
    name: "ForexFactory",
    desc: "US/EU/UK macro calendar (CPI, FOMC, NFP, ECB...).",
    builtin: true,
  },
  {
    id: "yahoo-earnings",
    name: "Yahoo Earnings",
    desc: "Equity earnings dates for tickers in your watchlist.",
    builtin: true,
  },
  {
    id: "finnhub",
    name: "Finnhub Calendar",
    desc: "Worldwide economic events + earnings dates for NVDA, TSLA, AMZN, AAPL, META. Free tier: 60 req/min.",
    keyUrl: "https://finnhub.io/dashboard",
    fetch: fetchFinnhub,
  },
];

// --- state ---
let state = {
  news: null,         // data.json
  prices: null,       // intraday.json
  providerEvents: [], // calendar events fetched client-side from APIs
  articles: [],       // recent news headlines fetched client-side from APIs
  filter: localStorage.getItem(FILTER_KEY) || "all",
  impact: localStorage.getItem(IMPACT_KEY) || "high",   // "high" | "all"
  keys: loadKeys(),
};

function loadKeys() {
  try {
    const v = JSON.parse(localStorage.getItem(KEYS_KEY) || "{}");
    return (v && typeof v === "object" && !Array.isArray(v)) ? v : {};
  } catch { return {}; }
}
function saveKeys(keys) {
  localStorage.setItem(KEYS_KEY, JSON.stringify(keys));
  state.keys = keys;
}

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
    refreshProviders(),
  ]);
  if (results[0].status === "fulfilled") state.news = results[0].value;
  if (results[1].status === "fulfilled") state.prices = results[1].value;
  render();
}

// --- client-side providers ---
async function refreshProviders() {
  const events = [];
  const articles = [];
  for (const p of PROVIDERS) {
    if (!p.fetch) continue;                // built-ins skip
    const cfg = state.keys[p.id];
    if (!cfg?.enabled || !cfg?.key) continue;
    try {
      const got = await p.fetch(cfg.key);
      // Provider may return either a flat events array or { events, articles }.
      if (Array.isArray(got)) {
        events.push(...got);
      } else {
        if (Array.isArray(got.events)) events.push(...got.events);
        if (Array.isArray(got.articles)) articles.push(...got.articles);
      }
    } catch (e) {
      console.warn(`provider ${p.id} fetch failed:`, e);
    }
  }
  state.providerEvents = events;
  state.articles = articles;
}

// Finnhub provider — fetches calendar events AND recent news headlines.
// Returns { events, articles }. Events fetch is the validation gate (so a bad
// key fails the Save button); articles fetch is best-effort.
async function fetchFinnhub(key) {
  const events = await fetchFinnhubEvents(key);
  let articles = [];
  try { articles = await fetchFinnhubArticles(key); }
  catch (e) { console.warn("Finnhub articles fetch failed:", e); }
  return { events, articles };
}

async function fetchFinnhubEvents(key) {
  const now = Date.now();
  const horizon = now + 100 * 86400000;
  const fmt = (ms) => new Date(ms).toISOString().slice(0, 10);
  const eqs = ["NVDA", "TSLA", "AMZN", "AAPL", "META"];

  const econUrl = `https://finnhub.io/api/v1/calendar/economic?token=${encodeURIComponent(key)}`;
  const earnUrl = (sym) =>
    `https://finnhub.io/api/v1/calendar/earnings?from=${fmt(now)}&to=${fmt(horizon)}` +
    `&symbol=${sym}&token=${encodeURIComponent(key)}`;

  const results = await Promise.allSettled([
    fetch(econUrl).then(r => r.ok ? r.json() : Promise.reject(`econ ${r.status}`)),
    ...eqs.map(s => fetch(earnUrl(s)).then(r => r.ok ? r.json() : Promise.reject(`earn ${r.status}`))),
  ]);

  if (results[0].status === "rejected") throw new Error(`Finnhub: ${results[0].reason}`);

  const events = [];

  const COUNTRY_TO_SYMBOL = { US: "SPY", EU: "XAUUSD", GB: "XAUUSD" };
  const IMPACT_MAP = { high: "high", medium: "medium", low: "low" };
  const econRows = results[0].value.economicCalendar || [];
  for (const r of econRows) {
    if (!COUNTRY_TO_SYMBOL[r.country] || !IMPACT_MAP[r.impact]) continue;
    const at = new Date(r.time.replace(" ", "T") + "Z");
    if (+at < now || +at > horizon) continue;
    events.push({
      title: r.event,
      kind: "macro",
      symbol: COUNTRY_TO_SYMBOL[r.country],
      impact: IMPACT_MAP[r.impact],
      scheduled_at: at.toISOString(),
      forecast: r.estimate || null,
      previous: r.prev || null,
      source: "finnhub",
    });
  }

  const HOUR_UTC = { bmo: "12:30:00", dmh: "16:00:00", amc: "20:30:00" };
  for (let i = 0; i < eqs.length; i++) {
    const result = results[i + 1];
    if (result.status !== "fulfilled") continue;
    const rows = (result.value && result.value.earningsCalendar) || [];
    for (const r of rows) {
      const time = HOUR_UTC[r.hour] || "20:30:00";
      const at = new Date(`${r.date}T${time}Z`);
      if (+at < now || +at > horizon) continue;
      events.push({
        title: `${r.symbol} Earnings (Q${r.quarter} ${r.year})`,
        kind: "earnings",
        symbol: r.symbol,
        impact: "high",
        scheduled_at: at.toISOString(),
        forecast: r.epsEstimate != null ? `EPS est ${r.epsEstimate}` : null,
        previous: r.epsActual != null ? `EPS prev ${r.epsActual}` : null,
        source: "finnhub",
      });
    }
  }
  return events;
}

// Last 7 days of company-specific news. Filtered to credible outlets so the
// list isn't drowned in PR-newswire spam. Top 5 most recent per ticker.
async function fetchFinnhubArticles(key) {
  const fmt = (ms) => new Date(ms).toISOString().slice(0, 10);
  const fromIso = fmt(Date.now() - 7 * 86400000);
  const toIso = fmt(Date.now());
  const eqs = ["NVDA", "TSLA", "AMZN", "AAPL", "META"];
  const TRUSTED = new Set([
    "Reuters", "Bloomberg", "CNBC", "Yahoo", "MarketWatch",
    "Wall Street Journal", "WSJ", "Financial Times", "Barrons",
    "SeekingAlpha", "TheStreet", "Investopedia", "Forbes",
    "Business Insider", "Investing.com", "Benzinga", "Fortune",
  ]);

  const results = await Promise.allSettled(
    eqs.map(s =>
      fetch(`https://finnhub.io/api/v1/company-news?symbol=${s}&from=${fromIso}&to=${toIso}` +
            `&token=${encodeURIComponent(key)}`)
        .then(r => r.ok ? r.json() : [])
    )
  );

  const out = [];
  for (let i = 0; i < eqs.length; i++) {
    const result = results[i];
    if (result.status !== "fulfilled" || !Array.isArray(result.value)) continue;
    const filtered = result.value
      .filter(a => a.headline && a.url && TRUSTED.has(a.source))
      .sort((a, b) => b.datetime - a.datetime)
      .slice(0, 5);
    for (const a of filtered) {
      out.push({
        symbol: eqs[i],
        headline: a.headline,
        source: a.source,
        url: a.url,
        published_at: new Date(a.datetime * 1000).toISOString(),
        summary: a.summary || "",
      });
    }
  }
  return out;
}

// dedupe key: same earnings is the same earnings regardless of exact time
// (yfinance gives the press-release minute; Finnhub gives a coarse after-hours
// slot — both are the same event). Macro events keep finer matching since
// FF and Finnhub usually agree on minute-level times.
function dedupKey(e) {
  const date = e.scheduled_at.slice(0, 10); // YYYY-MM-DD
  if (e.kind === "earnings") return `earnings|${e.symbol}|${date}`;
  const t = e.title.toLowerCase().replace(/\([^)]*\)/g, "").trim();
  return `macro|${e.symbol}|${t}|${date}`;
}

// merge data.json upcoming + provider events. Provider events come FIRST so
// that when the same earnings appears in both, the richer copy (EPS estimate,
// quarter info) wins.
function mergedUpcoming() {
  const fromAction = state.news?.upcoming || [];
  const all = [...state.providerEvents, ...fromAction];
  const seen = new Set();
  const out = [];
  for (const e of all) {
    const k = dedupKey(e);
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(e);
  }
  out.sort((a, b) => a.scheduled_at.localeCompare(b.scheduled_at));
  return out;
}

// final filtered list applied to every consumer (hero, list). Drops events
// more than 30 min in the past — keeps the recently-released ones around so
// the hero can show a "LIVE NOW" banner during the immediate aftermath.
function visibleUpcoming() {
  const cutoff = Date.now() - 30 * 60 * 1000;
  let events = mergedUpcoming();
  events = events.filter(e => +new Date(e.scheduled_at) >= cutoff);
  if (state.impact === "high") events = events.filter(e => e.impact === "high");
  if (state.filter !== "all") events = events.filter(e => e.symbol === state.filter);
  return events;
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
  const symbolHtml = items.map(i => {
    const on = state.filter === i.key;
    const cls = ["chip", on ? "on" : "", i.gold ? "gold" : ""].filter(Boolean).join(" ");
    return `<div class="${cls}" data-filter="${i.key}">${i.label}</div>`;
  }).join("");
  // separator + impact toggle
  const impactOn = state.impact === "high";
  const impactHtml = `
    <div class="chip-sep"></div>
    <div class="chip ${impactOn ? "on impact" : ""}" data-impact-toggle aria-pressed="${impactOn}">
      ${impactOn ? "High only ✓" : "High only"}
    </div>`;
  el.innerHTML = symbolHtml + impactHtml;

  el.querySelectorAll("[data-filter]").forEach(c =>
    c.addEventListener("click", () => {
      state.filter = c.dataset.filter;
      localStorage.setItem(FILTER_KEY, state.filter);
      render();
    })
  );
  el.querySelector("[data-impact-toggle]").addEventListener("click", () => {
    state.impact = state.impact === "high" ? "all" : "high";
    localStorage.setItem(IMPACT_KEY, state.impact);
    render();
  });
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
  if (!t) {
    // Event has passed — within our 30-min "live" window, show a polished banner.
    const elapsedMs = Date.now() - +new Date(evt.scheduled_at);
    const elapsedM = Math.floor(elapsedMs / 60000);
    const elapsedS = Math.floor((elapsedMs % 60000) / 1000);
    const sub = elapsedM === 0
      ? `released ${elapsedS}s ago`
      : `released ${elapsedM}m ${pad2(elapsedS)}s ago`;
    cdEl.classList.add("live");
    cdEl.innerHTML = `
      <div class="live-cell">
        <div class="live-row">
          <span class="live-dot"></span>
          <span class="live-label">LIVE NOW</span>
        </div>
        <div class="live-elapsed">${sub}</div>
      </div>`;
  } else {
    cdEl.classList.remove("live");
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
  const all = visibleUpcoming();
  return all.length ? all[0] : null;
}

// --- render: upcoming list, bucketed by time horizon ---
function renderList() {
  const el = document.getElementById("list");
  const filtered = visibleUpcoming();
  if (!filtered.length) { el.innerHTML = ""; return; }

  const weekCutoff = Date.now() + 7 * 86400000;
  const thisWeek = filtered.filter(e => +new Date(e.scheduled_at) <= weekCutoff);
  const later    = filtered.filter(e => +new Date(e.scheduled_at) >  weekCutoff).slice(0, 30);

  const renderRow = (e) => {
    const when = FMT_TIME.format(new Date(e.scheduled_at));
    const symCls = e.symbol === "XAUUSD" ? "symbol-xau" : "symbol-spy";
    return `
      <div class="row">
        <span class="when">${when}</span>
        <span class="what">${escapeHtml(e.title)}</span>
        <span class="right">
          <span class="badge ${symCls}">${e.symbol}</span>
        </span>
      </div>`;
  };

  // Track render order so click handlers map to the right event after the
  // section headers are interleaved in.
  const ordered = [];
  let html = "";
  if (thisWeek.length) {
    html += `<div class="section-h section-h--inline">This week · AEST</div>`;
    thisWeek.forEach(e => { ordered.push(e); html += renderRow(e); });
  }
  if (later.length) {
    html += `<div class="section-h section-h--inline">Later</div>`;
    later.forEach(e => { ordered.push(e); html += renderRow(e); });
  }
  el.innerHTML = html;

  el.querySelectorAll(".row").forEach((row, i) =>
    row.addEventListener("click", () => openSheet(ordered[i]))
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

// --- render: recent news articles ---
function escapeHtml(s) {
  return String(s).replace(/[&<>"]/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;"}[c]));
}
function timeAgo(iso) {
  const ms = Date.now() - +new Date(iso);
  if (ms < 60000) return "just now";
  const m = Math.floor(ms / 60000);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}
function renderArticles() {
  const sectionH = document.getElementById("articlesH");
  const el = document.getElementById("articles");
  let arts = state.articles || [];
  if (state.filter !== "all") arts = arts.filter(a => a.symbol === state.filter);
  arts = arts.slice().sort((a, b) => b.published_at.localeCompare(a.published_at)).slice(0, 25);
  if (!arts.length) { sectionH.hidden = true; el.innerHTML = ""; return; }
  sectionH.hidden = false;
  el.innerHTML = arts.map(a => {
    const symCls = a.symbol === "XAUUSD" ? "symbol-xau" : "symbol-spy";
    return `
      <a class="article" href="${escapeHtml(a.url)}" target="_blank" rel="noopener">
        <div class="article-meta">
          <span class="badge ${symCls}">${a.symbol}</span>
          <span class="article-source">${escapeHtml(a.source)} · ${timeAgo(a.published_at)}</span>
        </div>
        <div class="article-headline">${escapeHtml(a.headline)}</div>
      </a>`;
  }).join("");
}

// --- master render ---
function render() {
  renderChips();
  renderBlackout();
  renderPriceStrip();
  renderHero();
  renderList();
  renderArticles();
  renderUpdatedLabel();
}

// tick the countdown every second so the user sees live progress
setInterval(() => {
  renderHero();
  renderBlackout();
  renderUpdatedLabel();
}, 1000);

// --- settings panel ---
function renderSettings() {
  const root = document.getElementById("providers");
  root.innerHTML = PROVIDERS.map(p => {
    const cfg = state.keys[p.id] || {};
    const status = p.builtin
      ? `<span class="provider-status builtin">built-in</span>`
      : (cfg.enabled && cfg.key
          ? `<span class="provider-status active">active</span>`
          : `<span class="provider-status">add key</span>`);
    const linkRow = p.keyUrl
      ? `<a class="provider-link" href="${p.keyUrl}" target="_blank" rel="noopener">Get a free key ↗</a>`
      : "";
    const inputRow = p.builtin ? "" : `
      <div class="provider-input-row">
        <input type="password" class="provider-input"
          id="key-${p.id}" placeholder="paste API key here"
          value="${cfg.key ? "••••••••" : ""}" autocomplete="off"
          autocapitalize="off" autocorrect="off" spellcheck="false">
        <button class="settings-btn" data-save="${p.id}">Save</button>
      </div>
      ${cfg.enabled && cfg.key
        ? `<button class="settings-btn secondary" data-remove="${p.id}" style="margin-top:8px">Remove</button>`
        : ""}
      <div class="provider-msg" id="msg-${p.id}"></div>`;
    return `
      <div class="settings-card" data-provider="${p.id}">
        <div class="provider-head">
          <div class="provider-name">${p.name}</div>
          ${status}
        </div>
        <div class="provider-desc">${p.desc}</div>
        ${linkRow}
        ${inputRow}
      </div>`;
  }).join("");

  // wire up save + remove
  root.querySelectorAll("[data-save]").forEach(btn => {
    btn.addEventListener("click", async () => {
      const id = btn.dataset.save;
      const input = document.getElementById(`key-${id}`);
      const msg = document.getElementById(`msg-${id}`);
      const raw = input.value.trim();
      if (!raw || raw.startsWith("•")) {
        msg.textContent = "Paste a key first.";
        msg.className = "provider-msg err";
        return;
      }
      msg.textContent = "Testing…";
      msg.className = "provider-msg";
      const provider = PROVIDERS.find(p => p.id === id);
      try {
        const got = await provider.fetch(raw);
        const next = { ...state.keys, [id]: { key: raw, enabled: true } };
        saveKeys(next);
        const nE = Array.isArray(got) ? got.length : (got.events?.length || 0);
        const nA = Array.isArray(got) ? 0           : (got.articles?.length || 0);
        msg.textContent = `OK — ${nE} events, ${nA} articles. Saved on this device only.`;
        msg.className = "provider-msg ok";
        renderSettings();
        await refreshProviders();
        render();
      } catch (e) {
        msg.textContent = `Failed: ${e.message}. Check the key and try again.`;
        msg.className = "provider-msg err";
      }
    });
  });
  root.querySelectorAll("[data-remove]").forEach(btn => {
    btn.addEventListener("click", async () => {
      const id = btn.dataset.remove;
      const next = { ...state.keys };
      delete next[id];
      saveKeys(next);
      renderSettings();
      await refreshProviders();
      render();
    });
  });
}

function openSettings() {
  renderSettings();
  document.getElementById("settings").hidden = false;
}
function closeSettings() {
  document.getElementById("settings").hidden = true;
}
document.getElementById("settingsBtn").addEventListener("click", openSettings);
document.getElementById("settingsClose").addEventListener("click", closeSettings);
// extra escape hatches so the user is never trapped
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape") closeSettings();
});
document.getElementById("settings").addEventListener("click", (e) => {
  // tap directly on the gray bar background (outside any control) → dismiss
  if (e.target.id === "settings") closeSettings();
});
document.getElementById("clearKeys").addEventListener("click", async () => {
  if (!confirm("Clear all API keys from this device?")) return;
  saveKeys({});
  renderSettings();
  await refreshProviders();
  render();
});

// service worker registration
if ("serviceWorker" in navigator) {
  navigator.serviceWorker.register("service-worker.js").catch(() => {});
}

// pull-to-refresh: refetch JSON when the user comes back to the tab
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible") refresh();
});

refresh();
