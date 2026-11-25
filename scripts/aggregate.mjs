#!/usr/bin/env node
// Builds the Simplii Strategic Market Intelligence data in data/ for the static site.
//
// Pipeline (rules for what qualifies live in prompt.md, not here):
//   RSS feeds -> Claude Haiku drops obvious noise -> data/candidates.json (21-day pool of leads)
//   -> Claude Opus + web search curates the leads against prompt.md, two views:
//        Weekly Brief: the last completed Mon–Fri (Eastern), published once and never changed
//                      (data/editions/<monday>.json, listed in data/editions/index.json)
//        Last 7 Days:  rebuilt every run (data/rolling.json)
//   -> Claude Opus + web search: upcoming strategic calendar, next 4 weeks (data/calendar.json)
//
// Each step is best-effort: a failed step keeps that step's previous data.
// Run:  npm run refresh     Self-check:  npm run selftest

import { readFile, writeFile, mkdir } from "node:fs/promises";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const DATA = join(ROOT, "data");
const MODEL_FAST = "claude-haiku-5-5"; // cheap first-pass filter
const MODEL = "claude-opus-5-5";       // curation + calendar
const POOL_DAYS = 21;                  // how long feed leads stay in the candidate pool
const MAX_TIER1 = 8, MAX_TIER2 = 10, MAX_TOTAL = 15, MAX_EVENTS = 8;

const GEOS = ["Canada", "U.S.", "U.K. & Europe", "Other international"];
const PEERS = ["Canadian bank", "Canadian digital & fintech", "International digital & fintech", "Big Tech & payments", "Regulator"];
const TYPES = ["Product & proposition", "Pricing & value", "Business model", "Partnership & M&A", "Market entry",
  "Payments & cards", "Technology", "Regulation & policy", "Customer behaviour"];
const EVENT_TYPES = ["Investor day", "Product event", "Keynote", "Conference", "Industry event"];

// --- pure helpers (covered by --selftest) ----------------------------------

const normTitle = (s) => (s || "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
// strip a trailing " - Publisher" / " | Publisher" suffix (Google News adds these)
const cleanTitle = (s) => (s || "").replace(/\s[-–—|]\s[^-–—|]*$/, "").trim();
const idFor = (item) => createHash("sha1").update(item.url || normTitle(item.title)).digest("hex").slice(0, 12);
const isDirect = (u) => u && !/news\.google\./.test(u);
const pick = (v, allowed, fallback) => (allowed.includes(v) ? v : fallback);
const hostOf = (u) => { try { return new URL(u).hostname.replace(/^www\./, ""); } catch { return ""; } };

// Dates are YYYY-MM-DD strings in Eastern Time; string comparison orders them.
const etDate = (d = new Date()) => d.toLocaleDateString("en-CA", { timeZone: "America/New_York" });
const addDays = (iso, n) => {
  const d = new Date(iso + "T12:00:00Z");
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};
const mondayOf = (iso) => addDays(iso, -((new Date(iso + "T12:00:00Z").getUTCDay() + 6) % 7));
// "Week of Nov 16–20, 2026", or "Week of Nov 30–Dec 4, 2026" across a month end
function weekLabel(monday) {
  const fri = addDays(monday, 4);
  const mon = (iso) => new Date(iso + "T12:00:00Z").toLocaleDateString("en-US", { month: "short", timeZone: "UTC" });
  const endMonth = mon(fri) === mon(monday) ? "" : mon(fri) + " ";
  return `Week of ${mon(monday)} ${+monday.slice(8)}–${endMonth}${+fri.slice(8)}, ${fri.slice(0, 4)}`;
}

// Pull JSON out of an LLM reply that may wrap it in a ```json fence or narrate around it
// (web-search answers interleave citations). Prefers a fenced block, else the outermost {...} or [...].
function extractJson(text) {
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidates = [];
  if (fence) candidates.push(fence[1]);
  const o = text.indexOf("{"), oc = text.lastIndexOf("}");
  const a = text.indexOf("["), ac = text.lastIndexOf("]");
  const obj = o !== -1 && oc > o ? text.slice(o, oc + 1) : null;
  const arr = a !== -1 && ac > a ? text.slice(a, ac + 1) : null;
  if (arr && (o === -1 || a < o)) { candidates.push(arr); if (obj) candidates.push(obj); }
  else { if (obj) candidates.push(obj); if (arr) candidates.push(arr); }
  for (const c of candidates) {
    try { return JSON.parse(c); } catch { /* try next */ }
  }
  throw new Error("no parseable JSON in model reply");
}

// Candidate pool: merge new feed leads into the existing pool, collapsing the same headline from
// several feeds (keeps the direct URL over a Google News redirect, and the longer summary), and
// dropping leads dated before `since`. Newest first. The curator dedupes on the underlying
// development, so this only has to stop the obvious repeats.
function mergeCandidates(existing, incoming, since) {
  const byKey = new Map();
  for (const it of [...existing, ...incoming]) {
    if (!it.title || !it.date || it.date < since) continue;
    const key = normTitle(cleanTitle(it.title)).slice(0, 80);
    if (!key) continue;
    const prev = byKey.get(key);
    const m = prev
      ? {
          ...prev, ...it,
          url: isDirect(it.url) ? it.url : isDirect(prev.url) ? prev.url : it.url || prev.url,
          summary: (it.summary || "").length >= (prev.summary || "").length ? it.summary : prev.summary,
          firstSeen: prev.firstSeen || it.firstSeen,
        }
      : { ...it };
    m.id = idFor(m);
    byKey.set(key, m);
  }
  return [...byKey.values()].sort((a, b) => b.date.localeCompare(a.date));
}

// Turn the curator's raw answer into dashboard items: validate every field, keep item ids stable
// across runs (so "new since your last visit" works), enforce the tier caps, map themes to ids.
//   known:      Map of id -> item already on the dashboard (previous Last 7 Days + recent editions)
//   editionIds: ids already published in a Weekly Brief
//   weekly:     true when building a Weekly Brief, which must not repeat a published development
//               unless it is marked as an update (then it gets its own id)
function finalize(raw, { from, to, known, editionIds, weekly, now }) {
  const items = [];
  const seen = new Set();
  for (const [i, r] of (raw?.items || []).entries()) {
    const statement = String(r?.statement || "").trim();
    const date = String(r?.date || "").slice(0, 10);
    const tier = Number(r?.tier);
    const sources = (Array.isArray(r?.sources) ? r.sources : [])
      .filter((s) => /^https?:\/\//.test(s?.url || ""))
      .slice(0, 3)
      .map((s) => ({ url: s.url, publisher: String(s.publisher || "").trim() || hostOf(s.url) }));
    if (!statement || !sources.length || !(date >= from && date <= to) || (tier !== 1 && tier !== 2)) continue;
    const prev = known.get(r.same_as);
    const published = prev && editionIds.has(prev.id);
    if (weekly && published && !r.update) continue; // already in an earlier brief, nothing new
    const reuse = prev && !(weekly && published);
    const id = reuse ? prev.id : idFor({ title: statement });
    if (seen.has(id)) continue;
    seen.add(id);
    items.push({
      i, id, tier, rank: Number(r.rank) || 99, statement, date,
      geography: pick(r.geography, GEOS, "Other international"),
      companies: (Array.isArray(r.companies) ? r.companies : []).map(String).filter(Boolean).slice(0, 4),
      peerGroup: pick(r.peer_group, PEERS, ""),
      type: pick(r.type, TYPES, ""),
      update: !!r.update,
      sources,
      firstSeen: (reuse && prev.firstSeen) || now,
    });
  }
  items.sort((a, b) => a.tier - b.tier || a.rank - b.rank);
  const t1 = items.filter((x) => x.tier === 1).slice(0, MAX_TIER1);
  const t2 = items.filter((x) => x.tier === 2).slice(0, Math.min(MAX_TIER2, MAX_TOTAL - t1.length));
  const kept = [...t1, ...t2];
  for (const list of [t1, t2]) list.forEach((x, n) => { x.rank = n + 1; });
  const idAt = new Map(kept.map((x) => [x.i, x.id]));
  const themes = (Array.isArray(raw?.themes) ? raw.themes : [])
    .map((t) => ({ label: String(t?.label || "").trim(), ids: (t?.items || []).map((n) => idAt.get(Number(n))).filter(Boolean) }))
    .filter((t) => t.label && t.ids.length)
    .slice(0, 5);
  return {
    summary: String(raw?.summary || "").trim(),
    themes,
    items: kept.map(({ i, ...x }) => x),
  };
}

// Calendar: only dated events in the window, no earnings, one entry per event, soonest first.
function cleanEvents(events, from, to) {
  const out = [];
  const seen = new Set();
  const list = (Array.isArray(events) ? events : []).filter((e) => /^\d{4}-\d{2}-\d{2}$/.test(e?.date || ""));
  for (const e of list.sort((a, b) => a.date.localeCompare(b.date))) {
    const name = String(e.name || "").trim();
    const endDate = /^\d{4}-\d{2}-\d{2}$/.test(e.end_date || "") && e.end_date >= e.date ? e.end_date : e.date;
    const key = normTitle(name);
    if (!name || seen.has(key) || endDate < from || e.date > to) continue;
    if (/earning|quarterly results|results call|conference call/i.test(`${name} ${e.type}`)) continue;
    seen.add(key);
    out.push({
      date: e.date, endDate, tbc: !!e.tbc, name,
      organization: String(e.organization || "").trim(),
      location: String(e.location || "").trim(),
      type: pick(e.type, EVENT_TYPES, "Conference"),
      watch: String(e.watch || "").trim().split(/\s+/).slice(0, 15).join(" "),
      url: /^https?:\/\//.test(e.url || "") ? e.url : "",
    });
  }
  return out.slice(0, MAX_EVENTS);
}

// --- I/O --------------------------------------------------------------------

async function loadJson(name, fallback) {
  try { return JSON.parse(await readFile(join(DATA, name), "utf8")); } catch { return fallback; }
}
async function writeJson(name, value) {
  await mkdir(dirname(join(DATA, name)), { recursive: true });
  await writeFile(join(DATA, name), JSON.stringify(value, null, 2) + "\n");
}

async function fetchRss(feeds) {
  const { default: Parser } = await import("rss-parser");
  const parser = new Parser({ timeout: 15000, headers: { "User-Agent": "Mozilla/5.0 (compatible; SimpliiRadar/1.0)" } });
  const out = [];
  for (const { url, source } of feeds) {
    try {
      const feed = await parser.parseURL(url);
      for (const e of feed.items || []) {
        const date = e.isoDate || e.pubDate;
        if (!date) continue;
        out.push({
          title: (e.title || "").trim(),
          url: e.link,
          source,
          summary: (e.contentSnippet || e.content || "").replace(/\s+/g, " ").trim().slice(0, 400),
          date: new Date(date).toISOString().slice(0, 10),
        });
      }
      console.log(`  rss ok: ${source} (${feed.items?.length ?? 0})`);
    } catch (err) {
      console.warn(`  rss FAIL: ${source} — ${err.message}`);
    }
  }
  return out;
}

// --- Claude calls -------------------------------------------------------------

// Haiku keeps any headline that could plausibly qualify; Opus applies the real bar later.
// Forced tool => schema-valid output. A failed batch is dropped (those leads come back tomorrow).
const KEEP_TOOL = {
  name: "record_keep",
  description: "Record the indexes of the items worth a closer look.",
  input_schema: {
    type: "object",
    properties: { keep: { type: "array", items: { type: "integer" } } },
    required: ["keep"],
  },
};

async function prefilter(anthropic, items) {
  const BATCH = 50;
  const kept = [];
  for (let start = 0; start < items.length; start += BATCH) {
    const slice = items.slice(start, start + BATCH);
    const input = slice.map((it, i) => ({ i, title: it.title, summary: (it.summary || "").slice(0, 160) }));
    const prompt =
      `These headlines are leads for a strategic market-intelligence brief for Simplii Financial, CIBC's digital-only bank ` +
      `in Canada. Via record_keep, list the indexes worth a closer look: concrete new developments by banks, digital banks, ` +
      `fintechs, payments networks, Big Tech in finance, or regulators that touch consumer banking or payments (launches, ` +
      `pricing or fee changes, new business models, partnerships, acquisitions, market entry, regulation, payments ` +
      `infrastructure, customer-behaviour data). Drop routine earnings and results, stock or crypto price moves, opinion and ` +
      `explainers, promotions, awards, executive interviews, and anything unrelated. When unsure, keep it.\n\n` +
      `ITEMS:\n${JSON.stringify(input)}`;
    try {
      const resp = await anthropic.messages.create({
        model: MODEL_FAST,
        max_tokens: 2000,
        tools: [KEEP_TOOL],
        tool_choice: { type: "tool", name: "record_keep" },
        messages: [{ role: "user", content: prompt }],
      });
      const tu = resp.content.find((c) => c.type === "tool_use");
      for (const i of tu?.input?.keep || []) if (slice[i]) kept.push(slice[i]);
    } catch (err) {
      console.warn(`  prefilter batch @${start} dropped: ${err.message}`);
    }
  }
  console.log(`  prefilter: kept ${kept.length}/${items.length}`);
  return kept;
}

// One Opus request with web search, continued while the server pauses a long search turn.
// Server-side fallback reruns a declined request on another model inside the same call.
async function askWithSearch(anthropic, system, user, maxSearches) {
  const messages = [{ role: "user", content: user }];
  for (let turn = 0; turn < 5; turn++) {
    const msg = await anthropic.beta.messages
      .stream({
        model: MODEL,
        max_tokens: 32000,
        betas: ["server-side-fallback-2026-07-01"],
        fallbacks: "default",
        output_config: { effort: "high" },
        system,
        tools: [{ type: "web_search_20260209", name: "web_search", max_uses: maxSearches }],
        messages,
      })
      .finalMessage();
    if (msg.stop_reason === "pause_turn") {
      messages.push({ role: "assistant", content: msg.content });
      continue;
    }
    if (msg.stop_reason === "refusal") throw new Error(`declined (${msg.stop_details?.category ?? "no category"})`);
    if (msg.stop_reason === "max_tokens") throw new Error("reply hit max_tokens");
    return msg.content.filter((b) => b.type === "text").map((b) => b.text).join("");
  }
  throw new Error("search turn still paused after 5 continuations");
}

const ITEM_SHAPE =
  `{"summary":"","themes":[{"label":"","items":[0]}],"items":[{"same_as":"","update":false,"tier":1,"rank":1,` +
  `"statement":"","date":"YYYY-MM-DD","geography":"","companies":[""],"peer_group":"","type":"","sources":[{"url":"","publisher":""}]}]}`;

async function curate(anthropic, system, { weekly, label, from, to, today, pool, known, editionIds }) {
  const leads = pool
    .filter((c) => c.date >= addDays(from, -3) && c.date <= to)
    .map((c) => ({ title: c.title, summary: (c.summary || "").slice(0, 240), url: c.url, source: c.source, date: c.date }));
  const onBoard = [...known.values()].map((it) => ({
    id: it.id, statement: it.statement, date: it.date,
    ...(editionIds.has(it.id) && { in_published_weekly_brief: true }),
  }));
  const user =
    `Today is ${today}. Build the ${weekly ? `Weekly Brief for ${label}` : "Last 7 Days view"}.\n` +
    `Period: developments dated ${from} to ${to}, inclusive` +
    (weekly ? " (Monday to Friday, plus the weekend before, which rolls into this edition).\n\n" : ".\n\n") +
    `LEADS below come from news feeds. They are leads, not facts, and most will not qualify. Use web search to check the ` +
    `ones that might, to find the primary source and the date of the development itself, and to find qualifying ` +
    `developments in the period that the leads missed: Canadian banks, digital banks and regulators first, then ` +
    `international digital banks, payments networks and Big Tech. State only facts you confirmed in a source.\n\n` +
    `ALREADY ON THE DASHBOARD below. If you select one of these developments, set "same_as" to its id. ` +
    (weekly
      ? `Developments marked in_published_weekly_brief must not be repeated unless something materially new happened; ` +
        `then include the new phase with "update": true.`
      : `Developments marked in_published_weekly_brief may appear again if they fall in the period.`) +
    `\n\nAnswer with ONLY a JSON object in a \`\`\`json fence, nothing after it, in this shape:\n${ITEM_SHAPE}\n` +
    `- tier: 1 (Top Strategic Development) or 2 (Broader Strategic Signal); rank starts at 1 within each tier.\n` +
    `- geography: one of ${GEOS.join(" / ")}. peer_group: one of ${PEERS.join(" / ")}. type: one of ${TYPES.join(" / ")}.\n` +
    `- companies: the primary organizations, names only. sources: primary first, at most 3, URLs you found.\n` +
    `- date: the date of the development, not the article. update: true only for a new phase of an earlier development.\n` +
    `- themes: 3-5 short labels, each listing the 0-based indexes of the items it covers.\n` +
    `- summary: per the weekly summary rules. If nothing qualifies, return no items and say it was a quiet period.\n\n` +
    `LEADS:\n${JSON.stringify(leads)}\n\nALREADY ON THE DASHBOARD:\n${JSON.stringify(onBoard)}`;
  const raw = extractJson(await askWithSearch(anthropic, system, user, 15));
  const out = finalize(raw, { from, to, known, editionIds, weekly, now: new Date().toISOString() });
  console.log(`  ${weekly ? "weekly" : "last 7 days"}: ${out.items.length} items (${out.items.filter((x) => x.tier === 1).length} top)`);
  return out;
}

async function buildCalendar(anthropic, system, today, current) {
  const to = addDays(today, 28);
  const user =
    `Today is ${today}. Build the Upcoming Strategic Calendar: events from ${today} to ${to}. Use web search to confirm ` +
    `each event's dates on an official page. The current calendar is below: re-check it, drop what no longer fits the ` +
    `rules or the window, and add what is missing.\n\nCURRENT:\n${JSON.stringify(current)}\n\n` +
    `Answer with ONLY a JSON object in a \`\`\`json fence, nothing after it:\n` +
    `{"events":[{"date":"YYYY-MM-DD","end_date":"YYYY-MM-DD","tbc":false,"name":"","organization":"","location":"city, or Virtual",` +
    `"type":"${EVENT_TYPES.join("|")}","watch":"what to watch for, 15 words max","url":"official page"}]}`;
  const raw = extractJson(await askWithSearch(anthropic, system, user, 10));
  const events = cleanEvents(raw.events, today, to);
  console.log(`  calendar: ${events.length} events`);
  return events;
}

// --- main -------------------------------------------------------------------

async function main() {
  const { default: Anthropic } = await import("@anthropic-ai/sdk");
  const anthropic = new Anthropic();
  const cfg = JSON.parse(await readFile(join(ROOT, "feeds.json"), "utf8"));
  const system = await readFile(join(ROOT, "prompt.md"), "utf8");
  const today = etDate();
  const now = new Date().toISOString();
  let ok = 0;

  console.log("Fetching RSS…");
  const leads = mergeCandidates([], await fetchRss(cfg.feeds), addDays(today, -10)).slice(0, 250);
  console.log("Prefiltering…");
  const fresh = (await prefilter(anthropic, leads)).map((c) => ({ ...c, firstSeen: now }));
  const pool = mergeCandidates(await loadJson("candidates.json", []), fresh, addDays(today, -POOL_DAYS));
  await writeJson("candidates.json", pool);

  const index = await loadJson("editions/index.json", []);
  const editions = (await Promise.all(index.slice(0, 4).map((e) => loadJson(`editions/${e.id}.json`, null)))).filter(Boolean);
  const editionIds = new Set(editions.flatMap((e) => e.items.map((it) => it.id)));
  const rollingPrev = await loadJson("rolling.json", { items: [] });
  const known = new Map([...editions.flatMap((e) => e.items), ...rollingPrev.items].map((it) => [it.id, it]));

  // Weekly Brief for the last completed Mon–Fri, published once. Not there yet (first Monday run,
  // or an earlier run failed) -> build it now; once written it is never rebuilt.
  const monday = addDays(mondayOf(today), -7);
  if (!index.some((e) => e.id === monday)) {
    console.log("Weekly Brief…");
    const label = weekLabel(monday);
    const from = addDays(monday, -2), to = addDays(monday, 4);
    try {
      const ed = await curate(anthropic, system, { weekly: true, label, from, to, today, pool, known, editionIds });
      await writeJson(`editions/${monday}.json`, { id: monday, label, from, to, published: now, ...ed });
      await writeJson("editions/index.json", [{ id: monday, label }, ...index].sort((a, b) => b.id.localeCompare(a.id)));
      for (const it of ed.items) { editionIds.add(it.id); known.set(it.id, it); }
      ok++;
    } catch (err) {
      console.warn(`  weekly brief not published: ${err.message}`);
    }
  }

  console.log("Last 7 Days…");
  try {
    const from = addDays(today, -6);
    const r = await curate(anthropic, system, { weekly: false, from, to: today, today, pool, known, editionIds });
    for (const it of r.items) it.newThisWeek = !editionIds.has(it.id);
    await writeJson("rolling.json", { updated: now, from, to: today, ...r });
    ok++;
  } catch (err) {
    console.warn(`  last 7 days not updated: ${err.message}`);
  }

  console.log("Calendar…");
  try {
    const current = (await loadJson("calendar.json", { events: [] })).events;
    const events = await buildCalendar(anthropic, system, today, current);
    await writeJson("calendar.json", { updated: now, events });
    ok++;
  } catch (err) {
    console.warn(`  calendar not updated: ${err.message}`);
  }

  console.log(`Done. ${ok} of the views updated.`);
  if (!ok) process.exitCode = 1; // nothing worked: fail the run so it shows up in Actions
}

// --- self-check -------------------------------------------------------------

function selftest() {
  const assert = (c, m) => { if (!c) throw new Error("FAIL: " + m); };

  // extractJson: fenced block wins over narration; bare objects and arrays work; garbage throws
  assert(extractJson('Here:\n```json\n{"a":1}\n```').a === 1, "extractJson reads fenced block");
  assert(extractJson('I searched. Final: {"items":[]} done.').items.length === 0, "extractJson reads bare object amid prose");
  assert(extractJson('[{"i":0}]')[0].i === 0, "extractJson reads bare array");
  let threw = false; try { extractJson("no json here"); } catch { threw = true; }
  assert(threw, "extractJson throws when nothing parses");

  // dates: Monday of a week, week labels within and across months
  assert(mondayOf("2026-11-25") === "2026-11-23" && mondayOf("2026-11-23") === "2026-11-23" && mondayOf("2026-11-29") === "2026-11-23", "mondayOf");
  assert(weekLabel("2026-11-16") === "Week of Nov 16–20, 2026", `weekLabel same month (${weekLabel("2026-11-16")})`);
  assert(weekLabel("2026-11-30") === "Week of Nov 30–Dec 4, 2026", `weekLabel across months (${weekLabel("2026-11-30")})`);

  // candidate pool: same headline from two feeds collapses, direct URL and longer summary win; old leads drop
  const pool = mergeCandidates([], [
    { title: "BMO launches AI agent - BMO Newsroom", url: "https://news.google.com/rss/articles/abc", date: "2026-11-20", summary: "short", firstSeen: "t1" },
    { title: "BMO launches AI agent", url: "https://bmo.com/press/ai", date: "2026-11-20", summary: "a much longer summary", firstSeen: "t2" },
    { title: "Old story", url: "https://x.example", date: "2026-10-01" },
  ], "2026-11-04");
  assert(pool.length === 1, "pool dedupes by headline and drops old leads");
  assert(pool[0].url === "https://bmo.com/press/ai" && /longer/.test(pool[0].summary) && pool[0].firstSeen === "t1", "pool keeps best fields + first sighting");

  // finalize
  const src = [{ url: "https://example.com/a", publisher: "Example" }];
  const item = (o) => ({ tier: 1, rank: 1, statement: "S", date: "2026-11-18", geography: "Canada", companies: ["KOHO"], peer_group: "Canadian digital & fintech", type: "Business model", sources: src, ...o });
  const known = new Map([
    ["old1", { id: "old1", statement: "Published", firstSeen: "2026-11-10T00:00:00Z" }],
    ["roll1", { id: "roll1", statement: "Rolling", firstSeen: "2026-11-19T00:00:00Z" }],
  ]);
  const ctx = { from: "2026-11-14", to: "2026-11-20", known, editionIds: new Set(["old1"]), now: "NOW" };
  const w = finalize({
    summary: "x",
    themes: [{ label: "Subscriptions", items: [0, 5] }, { label: "Empty", items: [1] }],
    items: [
      item({ statement: "KOHO premium tier", same_as: "roll1" }),
      item({ statement: "Out of window", date: "2026-11-01" }),
      item({ statement: "No source", sources: [{ url: "not a url" }] }),
      item({ statement: "Republished", same_as: "old1" }),
      item({ statement: "Approved now", same_as: "old1", update: true, tier: 2 }),
      item({ statement: "Bad enums", geography: "Mars", tier: 2, rank: 2 }),
    ],
  }, { ...ctx, weekly: true });
  const ids = w.items.map((x) => x.statement);
  assert(ids.join("|") === "KOHO premium tier|Approved now|Bad enums", `weekly finalize keeps the right items (${ids.join("|")})`);
  assert(w.items[0].id === "roll1" && w.items[0].firstSeen === "2026-11-19T00:00:00Z", "reuses a known id + firstSeen");
  assert(w.items[1].id !== "old1" && w.items[1].update && w.items[1].firstSeen === "NOW", "an update to a published item gets a new id");
  assert(w.items[2].geography === "Other international" && w.items[2].rank === 2, "invalid enum falls back; ranks renumbered per tier");
  assert(w.themes.length === 1 && w.themes[0].ids.length === 2 && w.themes[0].ids[0] === "roll1", "themes map indexes to kept ids, empty themes dropped");
  const r = finalize({ items: [item({ statement: "Republished", same_as: "old1" })] }, { ...ctx, weekly: false });
  assert(r.items.length === 1 && r.items[0].id === "old1", "last 7 days may show a published development under its id");
  const many = finalize({ items: Array.from({ length: 20 }, (_, n) => item({ statement: `S${n}`, tier: n < 10 ? 1 : 2, rank: n })) }, { ...ctx, weekly: false });
  assert(many.items.filter((x) => x.tier === 1).length === MAX_TIER1 && many.items.length === MAX_TOTAL, "tier caps enforced");

  // calendar: window, no earnings, dedupe by name, sorted, watch note capped at 15 words
  const evs = cleanEvents([
    { date: "2026-12-10", name: "Money20/20 Europe Preview", type: "Conference", watch: "w ".repeat(30) },
    { date: "2026-12-02", name: "Scotiabank Q4 2026 Earnings Call", type: "Investor day" },
    { date: "2026-12-03", name: "RBC Investor Day", type: "Investor day" },
    { date: "2026-12-03", name: "RBC investor day", type: "Investor day" },
    { date: "2027-02-01", name: "Too far", type: "Conference" },
    { date: "TBC", name: "No date" },
  ], "2026-11-25", "2026-12-23");
  assert(evs.map((e) => e.name).join("|") === "RBC Investor Day|Money20/20 Europe Preview", `calendar cleaned (${evs.map((e) => e.name).join("|")})`);
  assert(evs[1].watch.split(" ").length === 15, "watch note capped");

  console.log("selftest OK");
}

if (process.argv.includes("--selftest")) selftest();
else main().catch((e) => { console.error(e); process.exit(1); });
