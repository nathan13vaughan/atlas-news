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

const TICKERS = [
  "NVDA", "TSLA", "AAPL", "MSFT", "AMZN", "META", "GOOGL", "AMD", "NFLX",
  "SPY", "QQQ", "IWM",
  "XAUUSD", "BTC",
];
// TradingView symbol resolution. Equities work as bare tickers; gold needs an
// exchange prefix to disambiguate (OANDA spot is the most accurate ref).
const TV_SYMBOLS = {
  NVDA:  "NASDAQ:NVDA",
  TSLA:  "NASDAQ:TSLA",
  AAPL:  "NASDAQ:AAPL",
  MSFT:  "NASDAQ:MSFT",
  AMZN:  "NASDAQ:AMZN",
  META:  "NASDAQ:META",
  GOOGL: "NASDAQ:GOOGL",
  AMD:   "NASDAQ:AMD",
  NFLX:  "NASDAQ:NFLX",
  SPY:   "AMEX:SPY",
  QQQ:   "NASDAQ:QQQ",
  IWM:   "AMEX:IWM",
  XAUUSD: "OANDA:XAUUSD",
  BTC:   "COINBASE:BTCUSD",
};
const FILTER_KEY = "atlas-news.filter";
const IMPACT_KEY = "atlas-news.impact";
const KEYS_KEY   = "atlas-news.api-keys";
const FAVS_KEY   = "atlas-news.favs";

// Tickers that have actual earnings (used by Finnhub fetchers).
const EQUITY_SYMBOLS = ["NVDA", "TSLA", "AAPL", "MSFT", "AMZN", "META", "GOOGL", "AMD", "NFLX"];

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
  {
    id: "groq",
    name: "Groq AI Summaries",
    desc: "1-sentence AI summaries on every news headline (Llama 3.1 via Groq). Free tier: 30 req/min.",
    keyUrl: "https://console.groq.com/keys",
    fetch: testGroqKey,
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
  favs: loadFavs(),   // Set<string> of favourited tickers
};

function loadFavs() {
  try {
    const v = JSON.parse(localStorage.getItem(FAVS_KEY) || "[]");
    return new Set(Array.isArray(v) ? v : []);
  } catch { return new Set(); }
}
function saveFavs() {
  localStorage.setItem(FAVS_KEY, JSON.stringify([...state.favs]));
}
function toggleFav(symbol) {
  if (state.favs.has(symbol)) state.favs.delete(symbol);
  else state.favs.add(symbol);
  saveFavs();
  render();
}

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
  // Apply any cached AI summaries / OG images immediately, then kick off
  // fire-and-forget batches for new articles. Both run in parallel.
  maybeSummarizeArticles();
  ensureImages();
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
  const eqs = EQUITY_SYMBOLS;

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

// --- Groq AI: validates the key + summarises + analyses news headlines ---
// Cached enrichments shape, keyed by article URL:
//   { summary?: "string", analysis?: { what, impact, watch } }
const ENRICH_KEY = "atlas-news.enrich";
function loadEnrich() {
  try {
    const v = JSON.parse(localStorage.getItem(ENRICH_KEY) || "{}");
    return (v && typeof v === "object" && !Array.isArray(v)) ? v : {};
  } catch { return {}; }
}
function saveEnrich(map) { localStorage.setItem(ENRICH_KEY, JSON.stringify(map)); }

async function testGroqKey(key) {
  // Cheap key-validation call — 5-token reply, ~ 30ms billed.
  const resp = await fetch("https://api.groq.com/openai/v1/chat/completions", {
    method: "POST",
    headers: { "Authorization": `Bearer ${key}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      model: "llama-3.1-8b-instant",
      messages: [{ role: "user", content: "Reply with the single word OK." }],
      max_tokens: 5,
    }),
  });
  if (!resp.ok) throw new Error(`Groq ${resp.status}`);
  // Provider contract returns nothing — Groq enriches existing data, doesn't fetch new.
  return { events: [], articles: [] };
}

async function groqSummarize(article, key) {
  const sys = "You write one-sentence summaries of financial news for traders. Plain English, ≤25 words, no fluff, no hedging.";
  const user = `Symbol: ${article.symbol}\nHeadline: ${article.headline}\n${article.summary || ""}\n\nWhat is the takeaway in one sentence?`;
  const resp = await fetch("https://api.groq.com/openai/v1/chat/completions", {
    method: "POST",
    headers: { "Authorization": `Bearer ${key}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      model: "llama-3.1-8b-instant",
      messages: [
        { role: "system", content: sys },
        { role: "user", content: user },
      ],
      max_tokens: 80,
      temperature: 0.3,
    }),
  });
  if (!resp.ok) throw new Error(`Groq ${resp.status}`);
  const data = await resp.json();
  return data.choices?.[0]?.message?.content?.trim() || null;
}

async function maybeSummarizeArticles() {
  const cached = loadEnrich();
  state.articles.forEach((a) => {
    if (cached[a.url]?.summary)  a.aiSummary  = cached[a.url].summary;
    if (cached[a.url]?.analysis) a.aiAnalysis = cached[a.url].analysis;
  });

  const cfg = state.keys.groq;
  if (!cfg?.enabled || !cfg?.key) return;

  // Cap how many we summarise per refresh — Groq free tier is 30/min and we
  // don't want to burn budget on stuff that may already be off-screen.
  const todo = state.articles.filter((a) => !a.aiSummary).slice(0, 12);
  if (!todo.length) return;

  const results = await Promise.allSettled(todo.map((a) => groqSummarize(a, cfg.key)));
  let dirty = false;
  results.forEach((r, i) => {
    if (r.status === "fulfilled" && r.value) {
      todo[i].aiSummary = r.value;
      cached[todo[i].url] = { ...(cached[todo[i].url] || {}), summary: r.value };
      dirty = true;
    }
  });
  if (dirty) {
    saveEnrich(cached);
    renderArticles();
  }
}

// Heuristic: is this URL a publisher-logo fallback rather than a real article
// image? Finnhub returns the source's site logo when an article has no OG
// image set, which is why we kept seeing the Yahoo Finance logo on every row.
function isLikelyGenericImage(url) {
  if (!url) return true;
  return /(?:s\.yimg\.com|yahoo\.com\/uu|finance\.yahoo|\/logo[._-]|logo\.png|logo\.svg|favicon|seeklogo)/i.test(url);
}

// Microlink fetches the OG hero image for an article URL — bypasses Finnhub's
// fallback-to-publisher-logo behaviour (which is why every article was showing
// the Yahoo Finance logo). Free tier: 50 req/day per origin, no key, CORS ok.
// Cached per URL forever; runs in parallel with the Groq summariser.
async function fetchArticleImage(url) {
  try {
    const resp = await fetch(`https://api.microlink.io?url=${encodeURIComponent(url)}`);
    if (!resp.ok) return null;
    const data = await resp.json();
    return data.data?.image?.url || null;
  } catch { return null; }
}

async function ensureImages() {
  const cached = loadEnrich();
  // Apply already-cached image overrides immediately.
  state.articles.forEach((a) => {
    if (cached[a.url]?.image) a.image = cached[a.url].image;
  });

  const todo = state.articles
    .filter((a) => !cached[a.url]?.image && a.url)
    .slice(0, 12);
  if (!todo.length) return;

  const results = await Promise.allSettled(todo.map((a) => fetchArticleImage(a.url)));
  let dirty = false;
  results.forEach((r, i) => {
    if (r.status === "fulfilled" && r.value) {
      todo[i].image = r.value;
      cached[todo[i].url] = { ...(cached[todo[i].url] || {}), image: r.value };
      dirty = true;
    }
  });
  if (dirty) {
    saveEnrich(cached);
    renderArticles();
  }
}

// Generates the structured analysis for an article — called lazily when the
// article view is opened, so we don't burn rate-limit on stuff the user
// never reads.
async function ensureAnalysis(article) {
  if (article.aiAnalysis) return article.aiAnalysis;
  const cached = loadEnrich();
  if (cached[article.url]?.analysis) {
    article.aiAnalysis = cached[article.url].analysis;
    return article.aiAnalysis;
  }
  const cfg = state.keys.groq;
  if (!cfg?.enabled || !cfg?.key) return null;
  try {
    const analysis = await groqAnalyze(article, cfg.key);
    if (!analysis) return null;
    article.aiAnalysis = analysis;
    cached[article.url] = { ...(cached[article.url] || {}), analysis };
    saveEnrich(cached);
    return analysis;
  } catch (e) {
    console.warn("groqAnalyze failed:", e);
    return null;
  }
}

async function groqAnalyze(article, key) {
  const sys = "You are a financial analyst. Reply with ONLY valid JSON (no prose, no markdown).";
  const user =
    `Symbol: ${article.symbol}\nHeadline: ${article.headline}\n\n` +
    `Article excerpt:\n${article.summary || "(no excerpt available)"}\n\n` +
    `Reply as: {"what": "...", "impact": "...", "watch": "..."}\n` +
    `- "what":   one sentence on what happened (≤25 words)\n` +
    `- "impact": one sentence on how this likely affects ${article.symbol} (≤25 words)\n` +
    `- "watch":  one sentence on what to watch for next (≤25 words)\n` +
    `Plain English, no hedging, no caveats.`;

  const resp = await fetch("https://api.groq.com/openai/v1/chat/completions", {
    method: "POST",
    headers: { "Authorization": `Bearer ${key}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      model: "llama-3.1-8b-instant",
      messages: [
        { role: "system", content: sys },
        { role: "user", content: user },
      ],
      max_tokens: 280,
      temperature: 0.3,
      response_format: { type: "json_object" },
    }),
  });
  if (!resp.ok) throw new Error(`Groq ${resp.status}`);
  const data = await resp.json();
  const text = data.choices?.[0]?.message?.content?.trim() || "{}";
  try {
    const p = JSON.parse(text);
    if (!p.what && !p.impact && !p.watch) return null;
    return { what: p.what || "", impact: p.impact || "", watch: p.watch || "" };
  } catch { return null; }
}

// Last 7 days of company-specific news. Filtered to credible outlets so the
// list isn't drowned in PR-newswire spam. Top 5 most recent per ticker.
async function fetchFinnhubArticles(key) {
  const fmt = (ms) => new Date(ms).toISOString().slice(0, 10);
  const fromIso = fmt(Date.now() - 7 * 86400000);
  const toIso = fmt(Date.now());
  const eqs = EQUITY_SYMBOLS;
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
        // Drop publisher-logo fallbacks (s.yimg.com, finance.yahoo.com, etc).
        // Microlink fills in the real article image asynchronously.
        image: isLikelyGenericImage(a.image) ? null : a.image,
        published_at: new Date(a.datetime * 1000).toISOString(),
        summary: a.summary || "",
      });
    }
  }
  return out;
}

// Two events are the same if:
//   - earnings: same ticker and scheduled within ±36h
//     (yfinance/Finnhub disagree on whether after-hours = today or tomorrow)
//   - macro:    same symbol, same title (parens stripped), within ±6h
// Provider events sit ahead of action events in the merge so the richer copy
// (EPS estimate, quarter info) wins.
function mergedUpcoming() {
  const fromAction = state.news?.upcoming || [];
  const all = [...state.providerEvents, ...fromAction];
  const accepted = [];

  const norm = (s) => s.toLowerCase().replace(/\([^)]*\)/g, "").trim();

  for (const e of all) {
    const eTs = +new Date(e.scheduled_at);
    const isDup = accepted.some((a) => {
      if (a.kind !== e.kind || a.symbol !== e.symbol) return false;
      const dt = Math.abs(+new Date(a.scheduled_at) - eTs);
      if (e.kind === "earnings") return dt < 36 * 3600 * 1000;
      return norm(a.title) === norm(e.title) && dt < 6 * 3600 * 1000;
    });
    if (!isDup) accepted.push(e);
  }

  accepted.sort((a, b) => a.scheduled_at.localeCompare(b.scheduled_at));
  return accepted;
}

// final filtered list applied to every consumer (hero, list). Drops events
// more than 30 min in the past — keeps the recently-released ones around so
// the hero can show a "LIVE NOW" banner during the immediate aftermath.
function visibleUpcoming() {
  const cutoff = Date.now() - 30 * 60 * 1000;
  let events = mergedUpcoming();
  events = events.filter(e => +new Date(e.scheduled_at) >= cutoff);
  if (state.impact === "high") events = events.filter(e => e.impact === "high");
  if (state.filter === "favs")     events = events.filter(e => state.favs.has(e.symbol));
  else if (state.filter !== "all") events = events.filter(e => e.symbol === state.filter);
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
function fmtAbs(x) {
  const sign = x >= 0 ? "+" : "−";
  return `${sign}$${Math.abs(x).toFixed(2)}`;
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
    { key: "all",  label: "All" },
    { key: "favs", label: "★", isFavs: true },
    ...TICKERS.map(t => ({ key: t, label: t, gold: t === "XAUUSD" })),
  ];
  const symbolHtml = items.map(i => {
    const on = state.filter === i.key;
    const cls = ["chip",
                 on ? "on" : "",
                 i.gold ? "gold" : "",
                 i.isFavs ? "fav" : ""].filter(Boolean).join(" ");
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
    : state.filter === "favs"
      ? state.prices.tickers.filter(t => state.favs.has(t.symbol))
      : state.prices.tickers.filter(t => t.symbol === state.filter);

  el.innerHTML = filtered.map(t => {
    const isUp = t.change >= 0;
    const arrow = isUp ? "▲" : "▼";
    const cls = ["pricecard", isUp ? "up" : "down", t.is_open ? "" : "muted"]
      .filter(Boolean).join(" ");
    const tag = t.is_open ? `<div class="arrow">${arrow}</div>` : `<div class="closed-tag">closed</div>`;
    const [line, fill] = sparkPath(t.spark, isUp);
    const isFav = state.favs.has(t.symbol);
    return `
      <div class="${cls}" data-symbol="${t.symbol}">
        <button class="fav-btn ${isFav ? "on" : ""}" data-fav="${t.symbol}"
                aria-label="${isFav ? "Unfavourite" : "Favourite"} ${t.symbol}">
          ${isFav ? "★" : "☆"}
        </button>
        <div class="head"><div class="sym">${t.symbol}</div>${tag}</div>
        <div class="px">${fmtPrice(t.last)}</div>
        <div class="chg">
          <span class="pct">${fmtPct(t.change_pct)}</span>
          <span class="abs">${fmtAbs(t.change)}</span>
        </div>
        <svg class="spark" viewBox="0 0 100 26" preserveAspectRatio="none">
          <path class="fill" d="${fill}"/>
          <path class="line" d="${line}"/>
        </svg>
      </div>`;
  }).join("");
  el.querySelectorAll(".pricecard").forEach(card =>
    card.addEventListener("click", () => openChart(card.dataset.symbol))
  );
  el.querySelectorAll(".fav-btn").forEach(btn =>
    btn.addEventListener("click", (e) => {
      e.stopPropagation();   // don't also open the chart
      toggleFav(btn.dataset.fav);
    })
  );

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
  showOverlay(sheet);
  showOverlay(overlay);
  overlay.onclick = closeSheet;
}
function closeSheet() {
  hideOverlay(document.getElementById("sheet"), 380);
  hideOverlay(document.getElementById("overlay"), 380);
}
function dismissSheet() {
  dismissOverlay(document.getElementById("sheet"));
  dismissOverlay(document.getElementById("overlay"));
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
function sourceClass(name) {
  return "source-" + name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
}
function renderArticles() {
  const sectionH = document.getElementById("articlesH");
  const el = document.getElementById("articles");
  let arts = state.articles || [];
  if (state.filter === "favs")     arts = arts.filter(a => state.favs.has(a.symbol));
  else if (state.filter !== "all") arts = arts.filter(a => a.symbol === state.filter);
  arts = arts.slice().sort((a, b) => b.published_at.localeCompare(a.published_at)).slice(0, 25);
  if (!arts.length) { sectionH.hidden = true; el.innerHTML = ""; return; }
  sectionH.hidden = false;
  el.innerHTML = arts.map(a => {
    const symCls = a.symbol === "XAUUSD" ? "symbol-xau" : "symbol-spy";
    const srcCls = sourceClass(a.source);
    const img = a.image
      ? `<img class="article-image" src="${escapeHtml(a.image)}" alt="" loading="lazy" onerror="this.remove()">`
      : "";
    const summary = a.aiSummary
      ? `<div class="article-summary"><span class="ai-badge">AI</span>${escapeHtml(a.aiSummary)}</div>`
      : (a.summary
          ? `<div class="article-summary">${escapeHtml(a.summary)}</div>`
          : "");
    return `
      <a class="article" href="${escapeHtml(a.url)}" rel="noopener">
        ${img}
        <div class="article-body">
          <div class="article-source-row">
            <span class="article-source-name ${srcCls}">${escapeHtml(a.source)}</span>
            <span class="article-time">${timeAgo(a.published_at)}</span>
          </div>
          <div class="article-headline">${escapeHtml(a.headline)}</div>
          ${summary}
          <div class="article-tickers"><span class="badge ${symCls}">${a.symbol}</span></div>
        </div>
      </a>`;
  }).join("");

  // Intercept the tap so we open the in-app reader instead of Safari.
  el.querySelectorAll(".article").forEach((card, i) => {
    card.addEventListener("click", (e) => {
      e.preventDefault();
      openArticleView(arts[i]);
    });
  });
}

// --- high-impact events ribbon (sits with the chart) ---
function renderEventsRibbon() {
  const el = document.getElementById("eventsRibbon");
  const all = mergedUpcoming();
  const high = all
    .filter(e => e.impact === "high" && +new Date(e.scheduled_at) >= Date.now())
    .slice(0, 8);
  if (!high.length) { el.hidden = true; el.innerHTML = ""; return; }
  el.hidden = false;

  el.innerHTML = high.map((e, i) => {
    const t = timeUntil(e.scheduled_at);
    let cd = `${t.s}s`;
    if (t.d > 0)      cd = `${t.d}d ${pad2(t.h)}h`;
    else if (t.h > 0) cd = `${t.h}h ${pad2(t.m)}m`;
    else if (t.m > 0) cd = `${t.m}m ${pad2(t.s)}s`;
    const kindLabel = e.kind === "earnings" ? "Earnings" : "Macro";
    return `
      <div class="event-chip" data-evt-idx="${i}">
        <div class="event-chip-head">
          <span class="led"></span>
          <span class="countdown">${cd}</span>
        </div>
        <div class="label">${escapeHtml(e.title)}</div>
        <div class="meta">${escapeHtml(e.symbol)} · ${kindLabel}</div>
      </div>`;
  }).join("");

  el.querySelectorAll(".event-chip").forEach((chip, i) =>
    chip.addEventListener("click", () => openSheet(high[i]))
  );
}

// --- inline TradingView chart ---
// Follows the chip filter. "All" defaults to SPY (broad-market reference).
function activeChartSymbol() {
  if (state.filter !== "all" && TV_SYMBOLS[state.filter]) return state.filter;
  return "SPY";
}
function renderInlineChart() {
  const sym = activeChartSymbol();
  const frame = document.getElementById("inlineTvChart");
  // Avoid reloading the iframe (and its websocket) on every render tick.
  if (frame.dataset.symbol === sym) return;
  frame.dataset.symbol = sym;
  frame.src = buildTvUrl(TV_SYMBOLS[sym]);
}

// --- master render ---
function render() {
  renderChips();
  renderBlackout();
  renderPriceStrip();
  renderInlineChart();
  renderEventsRibbon();
  renderHero();
  renderList();
  renderArticles();
  renderUpdatedLabel();
}

// tick the countdown every second so the user sees live progress
setInterval(() => {
  renderHero();
  renderBlackout();
  renderEventsRibbon();
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

// --- iOS-style overlay show/hide helpers ---
// Open: unhide → reflow → add .open → CSS transition slides it in.
// Close: remove .open → wait for the slide-out → set hidden.
// Dismiss: instant cleanup — used after swipe-back has already animated.
function showOverlay(el) {
  el.hidden = false;
  void el.offsetWidth;          // force reflow so the .open class transition fires
  el.classList.add("open");
}
function hideOverlay(el, ms = 420) {
  el.classList.remove("open");
  setTimeout(() => {
    if (!el.classList.contains("open")) el.hidden = true;
  }, ms);
}
function dismissOverlay(el) {
  el.classList.remove("open");
  el.style.transform = "";
  el.style.transition = "";
  el.hidden = true;
}

function openSettings()    { renderSettings(); showOverlay(document.getElementById("settings")); }
function closeSettings()   { hideOverlay(document.getElementById("settings")); }
function dismissSettings() { dismissOverlay(document.getElementById("settings")); }

// --- in-app article reader ---
async function openArticleView(article) {
  document.getElementById("avSource").textContent = article.source;
  document.getElementById("avSource").className =
    `article-view-source ${sourceClass(article.source)}`;
  document.getElementById("avTime").textContent = timeAgo(article.published_at);
  document.getElementById("avHeadline").textContent = article.headline;
  document.getElementById("avLink").href = article.url;

  const img = document.getElementById("avImg");
  if (article.image) { img.src = article.image; img.style.display = ""; }
  else                { img.removeAttribute("src"); img.style.display = "none"; }

  const sym = document.getElementById("avSymbol");
  sym.textContent = article.symbol;
  sym.className = `badge ${article.symbol === "XAUUSD" ? "symbol-xau" : "symbol-spy"}`;

  // original excerpt block — only show if Finnhub had any prose
  const orig = document.getElementById("avOriginal");
  if (article.summary) {
    orig.innerHTML = `
      <div class="ai-label">Original excerpt</div>
      ${escapeHtml(article.summary)}`;
    orig.hidden = false;
  } else {
    orig.hidden = true;
  }

  const ai = document.getElementById("avAi");
  const groqOn = state.keys.groq?.enabled && state.keys.groq?.key;

  // If we already have a cached analysis, render immediately. Otherwise show
  // a loading state (or a fallback if Groq isn't configured).
  if (article.aiAnalysis) {
    ai.innerHTML = renderAnalysis(article.aiAnalysis, article.symbol);
  } else if (groqOn) {
    ai.innerHTML = `<div class="ai-loading">Generating brief<span class="dots"></span></div>`;
  } else {
    ai.innerHTML = `
      <div class="ai-fallback">
        <strong>AI brief disabled</strong>
        Add a free Groq key in Settings to get a 3-line WHAT / IMPACT / WATCH summary on every article.
      </div>`;
  }

  showOverlay(document.getElementById("articleView"));
  document.getElementById("articleView").scrollTop = 0;

  if (groqOn && !article.aiAnalysis) {
    const analysis = await ensureAnalysis(article);
    if (analysis) {
      ai.innerHTML = renderAnalysis(analysis, article.symbol);
    } else {
      ai.innerHTML = `
        <div class="ai-fallback">
          <strong>Couldn't reach Groq</strong>
          Check your key in Settings or try again. Original excerpt is below.
        </div>`;
    }
  }
}

function renderAnalysis(a, symbol) {
  const row = (label, text) => `
    <div class="ai-section">
      <div class="ai-label">${escapeHtml(label)}</div>
      <div class="ai-text">${escapeHtml(text)}</div>
    </div>`;
  return [
    row("What happened", a.what),
    row(`Impact on ${symbol}`, a.impact),
    row("What to watch", a.watch),
  ].join("") +
  `<div class="ai-disclaimer">AI brief generated from headline + excerpt.</div>`;
}

function closeArticleView()   { hideOverlay(document.getElementById("articleView")); }
function dismissArticleView() { dismissOverlay(document.getElementById("articleView")); }

// --- TradingView chart sheet ---
// Stripped TradingView config — bare-candle look, no volume / studies / panels.
// `studies_overrides` hides volume even if `hide_volume` isn't honoured by the
// embed, by setting both volume series + MA to 100% transparency.
const TV_BASE_PARAMS = {
  interval: "15",
  theme: "dark",
  style: "1",                              // 1 = candles
  locale: "en",
  timezone: "Australia/Sydney",
  toolbar_bg: "#0b0d10",
  hideideas: "1",
  hide_volume: "1",                        // explicit volume off
  hidesidetoolbar: "1",                    // no drawing toolbar
  withdateranges: "0",                     // no date-range strip at bottom
  details: "0", hotlist: "0", calendar: "0",
  saveimage: "0",
  enable_publishing: "0",
  studies: "[]",
  studies_overrides: JSON.stringify({
    "volume.volume.transparency":    100,
    "volume.volume ma.transparency": 100,
    "volume.show ma":                false,
    "volume.options.showLabelsOnPriceScale": false,
  }),
};

function buildTvUrl(tvSym) {
  const params = new URLSearchParams({ ...TV_BASE_PARAMS, symbol: tvSym });
  return `https://www.tradingview.com/widgetembed/?${params}`;
}

function openChart(symbol) {
  const tv = TV_SYMBOLS[symbol] || symbol;
  document.getElementById("tvchart").src = buildTvUrl(tv);
  document.getElementById("chartTitle").textContent = symbol;
  showOverlay(document.getElementById("chart"));
}
function closeChart() {
  hideOverlay(document.getElementById("chart"));
  // unload the iframe to stop background quote streaming + free memory
  setTimeout(() => { document.getElementById("tvchart").src = "about:blank"; }, 420);
}
function dismissChart() {
  dismissOverlay(document.getElementById("chart"));
  document.getElementById("tvchart").src = "about:blank";
}
document.getElementById("chartClose").addEventListener("click", closeChart);
document.getElementById("settingsBtn").addEventListener("click", openSettings);
document.getElementById("settingsClose").addEventListener("click", closeSettings);
document.getElementById("articleClose").addEventListener("click", closeArticleView);
// extra escape hatches so the user is never trapped in any overlay
document.addEventListener("keydown", (e) => {
  if (e.key !== "Escape") return;
  closeSettings();
  closeChart();
  closeArticleView();
});

// --- iOS-style edge-swipe-back ---
// PWAs in standalone mode don't get the native back-swipe gesture, so each
// full-screen overlay gets a 24px-wide invisible "edge gripper" on its left
// side. Touchstart there primes the swipe; touchmove translates the overlay
// horizontally to follow the finger; touchend either dismisses (>35% screen
// width) or springs back.
let activeSwipe = null;

function setupSwipeBack(overlayEl, onClose) {
  const edge = document.createElement("div");
  edge.className = "swipe-edge";
  overlayEl.appendChild(edge);
  edge.addEventListener("touchstart", (e) => {
    if (e.touches.length !== 1) return;
    activeSwipe = {
      overlay: overlayEl,
      onClose,
      startX: e.touches[0].clientX,
      startY: e.touches[0].clientY,
      dx: 0,
      decided: false,
    };
  }, { passive: true });
}

document.addEventListener("touchmove", (e) => {
  if (!activeSwipe) return;
  const t = e.touches[0];
  let dx = t.clientX - activeSwipe.startX;
  const dy = t.clientY - activeSwipe.startY;

  // First 8px decide the gesture direction. Vertical scrolls win and abort.
  if (!activeSwipe.decided) {
    if (Math.abs(dx) < 8 && Math.abs(dy) < 8) return;
    if (Math.abs(dy) > Math.abs(dx)) {
      activeSwipe.overlay.style.transform = "";
      activeSwipe.overlay.style.transition = "";
      activeSwipe = null;
      return;
    }
    activeSwipe.decided = true;
    // Disable the .open-class transition so the overlay tracks the finger
    // 1:1 instead of easing into every dx update.
    activeSwipe.overlay.style.transition = "none";
  }

  if (dx < 0) dx = 0;
  activeSwipe.dx = dx;
  activeSwipe.overlay.style.transform = `translateX(${dx}px)`;
  e.preventDefault();
}, { passive: false });

function endSwipe(commit) {
  if (!activeSwipe) return;
  const { overlay, onClose, dx } = activeSwipe;
  activeSwipe = null;
  const dismiss = commit && dx > window.innerWidth * 0.35;
  // iOS-native curve for the snap-back / slide-off
  overlay.style.transition = "transform 0.28s cubic-bezier(0.32, 0.72, 0, 1)";
  overlay.style.transform = dismiss ? "translateX(100%)" : "";
  setTimeout(() => {
    if (dismiss && onClose) onClose();    // dismissX — instant cleanup
    else { overlay.style.transition = ""; overlay.style.transform = ""; }
  }, 280);
}
document.addEventListener("touchend",   () => endSwipe(true),  { passive: true });
document.addEventListener("touchcancel", () => endSwipe(false), { passive: true });

setupSwipeBack(document.getElementById("settings"),    dismissSettings);
setupSwipeBack(document.getElementById("chart"),       dismissChart);
setupSwipeBack(document.getElementById("articleView"), dismissArticleView);
setupSwipeBack(document.getElementById("sheet"),       dismissSheet);
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
