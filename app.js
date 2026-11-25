// Static dashboard: reads data/*.json (built by scripts/aggregate.mjs) and renders the Weekly Brief
// or the Last 7 Days view, ranked in two tiers, plus the upcoming strategic calendar.
const state = { view: "weekly", data: null, index: [], rolling: null, theme: null, geo: "all", company: "all", type: "all", tier: "all", q: "" };
const editions = {}; // edition id -> loaded edition
let lastVisit = null; // ISO time of the previous visit, for the "new since last view" dot

const $ = (s) => document.querySelector(s);
const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
const fmtDate = (iso, o = { month: "short", day: "numeric" }) => new Date(iso + "T12:00:00").toLocaleDateString("en-CA", o);
const getJson = (path, fallback) => fetch(path).then((r) => (r.ok ? r.json() : fallback)).catch(() => fallback);
const GEO_ORDER = ["Canada", "U.S.", "U.K. & Europe", "Other international"];

async function load() {
  const [index, rolling, cal] = await Promise.all([
    getJson("data/editions/index.json", []),
    getJson("data/rolling.json", null),
    getJson("data/calendar.json", { events: [] }),
  ]);
  state.index = index;
  state.rolling = rolling;
  // read the previous visit, then record this one (browser-only; never reorders anything)
  try { lastVisit = localStorage.getItem("lastVisit"); localStorage.setItem("lastVisit", new Date().toISOString()); } catch { /* private mode */ }
  renderCalendar(cal.events || []);
  renderArchive();
  $("#updated").textContent = rolling?.updated ? `Last refreshed ${new Date(rolling.updated).toLocaleString("en-CA", { dateStyle: "medium", timeStyle: "short" })}` : "";
  await route();
  hideLoader();
}

// URL hash picks the view: "" = latest Weekly Brief, #last-7-days, #week-YYYY-MM-DD = an archived edition
async function route() {
  const h = location.hash;
  if (h === "#last-7-days") return show("rolling");
  const m = h.match(/^#week-(\d{4}-\d{2}-\d{2})$/);
  return show("weekly", m && state.index.some((e) => e.id === m[1]) ? m[1] : state.index[0]?.id);
}
addEventListener("hashchange", route);

async function show(view, editionId) {
  state.view = view;
  if (view === "weekly") {
    if (editionId && !editions[editionId]) editions[editionId] = await getJson(`data/editions/${editionId}.json`, null);
    state.data = editionId ? editions[editionId] : null;
  } else {
    state.data = state.rolling;
  }
  state.theme = null;
  document.querySelectorAll(".view-toggle button").forEach((b) => b.setAttribute("aria-pressed", String(b.dataset.view === view)));
  $("#archive").value = view === "weekly" && editionId ? editionId : "";
  populateFilters();
  render();
}

document.querySelector(".view-toggle").addEventListener("click", (e) => {
  const b = e.target.closest("button[data-view]");
  if (b) location.hash = b.dataset.view === "rolling" ? "#last-7-days" : "";
});

function editionLabel() {
  const d = state.data;
  if (state.view === "rolling") {
    return d ? `Last 7 days · ${fmtDate(d.from)} – ${fmtDate(d.to, { month: "short", day: "numeric", year: "numeric" })}` : "Last 7 days";
  }
  if (!d) return "Weekly Brief";
  return d.id === state.index[0]?.id ? d.label : `${d.label} · previous edition`;
}

function render() {
  $("#edition").textContent = editionLabel();
  renderBrief();
  const d = state.data;
  const items = d?.items || [];
  const shown = items.filter(matches);
  const t1 = shown.filter((i) => i.tier === 1), t2 = shown.filter((i) => i.tier === 2);
  $("#tier1").hidden = state.tier === "2";
  $("#tier2").hidden = state.tier === "1" || (!items.length && !!d);
  let empty;
  if (!d) {
    empty = state.view === "weekly"
      ? "The first Weekly Brief publishes on Monday morning. Last 7 Days shows the latest developments in the meantime."
      : "The Last 7 Days view hasn't been built yet.";
  } else if (!items.length) {
    empty = "A quiet period: no developments met the bar for senior leaders.";
  } else {
    empty = "No items match these filters.";
  }
  $("#list1").innerHTML = t1.length ? t1.map(card).join("") : `<div class="empty">${!items.length ? empty : t2.length ? "No top developments match these filters." : empty}</div>`;
  $("#list2").innerHTML = t2.length ? t2.map(card).join("") : `<div class="empty">No broader signals${items.length ? " match these filters" : ""}.</div>`;
}

function renderBrief() {
  const d = state.data;
  if (!d?.summary) { $("#brief").innerHTML = ""; return; }
  const chips = (d.themes || []).map((t, n) =>
    `<button type="button" class="theme" data-theme-index="${n}" aria-pressed="${state.theme === n}">${esc(t.label)}</button>`).join("");
  $("#brief").innerHTML = `
    <h2 class="brief-head">${state.view === "weekly" ? "Week in brief" : "Last 7 days in brief"}</h2>
    <p class="brief-tldr">${esc(d.summary)}</p>
    ${chips ? `<div class="brief-themes" role="group" aria-label="Filter by theme">${chips}</div>` : ""}`;
}

// theme chips filter the page to the items they cover; tap again to clear
$("#brief").addEventListener("click", (e) => {
  const b = e.target.closest("button[data-theme-index]");
  if (!b) return;
  const n = Number(b.dataset.themeIndex);
  state.theme = state.theme === n ? null : n;
  render();
});

function matches(it) {
  if (state.theme !== null && !state.data.themes[state.theme]?.ids.includes(it.id)) return false;
  if (state.geo !== "all" && it.geography !== state.geo) return false;
  if (state.company !== "all" && !it.companies.includes(state.company)) return false;
  if (state.type !== "all" && it.type !== state.type) return false;
  if (state.tier !== "all" && String(it.tier) !== state.tier) return false;
  const q = state.q.trim().toLowerCase();
  if (q && !`${it.statement} ${it.companies.join(" ")} ${it.sources.map((s) => s.publisher).join(" ")}`.toLowerCase().includes(q)) return false;
  return true;
}

// dropdown options come from the items in the current view; a choice that no longer exists resets to "all"
function populateFilters() {
  const items = state.data?.items || [];
  const fill = (sel, key, all, values) => {
    if (!values.includes(state[key])) state[key] = "all";
    $(sel).innerHTML = `<option value="all">${all}</option>` +
      values.map((v) => `<option value="${esc(v)}"${v === state[key] ? " selected" : ""}>${esc(v)}</option>`).join("");
  };
  const uniq = (a) => [...new Set(a.filter(Boolean))];
  fill("#fGeo", "geo", "All geographies", GEO_ORDER.filter((g) => items.some((i) => i.geography === g)));
  fill("#fCompany", "company", "All companies", uniq(items.flatMap((i) => i.companies)).sort((a, b) => a.localeCompare(b)));
  fill("#fType", "type", "All development types", uniq(items.map((i) => i.type)).sort());
}
for (const [sel, key] of [["#fGeo", "geo"], ["#fCompany", "company"], ["#fType", "type"], ["#fTier", "tier"]]) {
  $(sel).addEventListener("change", (e) => { state[key] = e.target.value; render(); });
}
$("#search").addEventListener("input", (e) => { state.q = e.target.value; render(); });

function card(it) {
  const isNew = !!lastVisit && it.firstSeen > lastVisit;
  const marks = [
    it.update && `<span class="mark">Update</span>`,
    state.view === "rolling" && it.newThisWeek && `<span class="mark">New this week</span>`,
  ].filter(Boolean).join("");
  const tags = [it.geography, it.type, it.peerGroup].filter(Boolean).map((t) => `<span class="pill">${esc(t)}</span>`).join("");
  const sources = it.sources.map((s) => `<a class="src-link" href="${esc(s.url)}" target="_blank" rel="noopener">${esc(s.publisher)}</a>`).join(", ");
  return `<article class="card item">
    <p class="stmt">${isNew ? `<span class="new-dot" title="New since your last visit"></span><span class="sr-only">New since your last visit: </span>` : ""}${esc(it.statement)}</p>
    <div class="item-meta">
      <span class="item-date">${esc(fmtDate(it.date))}</span>${marks}${tags}
      <span class="srcs">Source: ${sources}</span>
    </div>
  </article>`;
}

function renderCalendar(events) {
  $("#events").innerHTML = events.length ? events.map((e) => {
    const d = new Date(e.date + "T12:00:00");
    const range = e.endDate && e.endDate !== e.date ? `${fmtDate(e.date)} – ${fmtDate(e.endDate)}` : fmtDate(e.date);
    const inner = `<div class="event">
      <div class="when"><div class="m">${d.toLocaleDateString("en-CA", { month: "short" })}</div><div class="d">${d.getDate()}</div></div>
      <div class="body">
        <h3>${esc(e.name)}</h3>
        <p>${esc([e.tbc ? `${range} (TBC)` : range, e.organization, e.location].filter(Boolean).join(" · "))}</p>
        ${e.watch ? `<p class="watch">Watch for: ${esc(e.watch)}</p>` : ""}
        <span class="pill">${esc(e.type)}</span>
      </div>
    </div>`;
    return e.url ? `<a class="card" href="${esc(e.url)}" target="_blank" rel="noopener">${inner}</a>` : `<div class="card">${inner}</div>`;
  }).join("") : `<div class="empty">No strategic events in the next four weeks.</div>`;
}

function renderArchive() {
  const past = state.index.slice(1);
  $("#archive").closest(".archive").hidden = !past.length;
  $("#archive").innerHTML = `<option value="">Choose a week…</option>` +
    state.index.map((e) => `<option value="${esc(e.id)}">${esc(e.label)}</option>`).join("");
}
$("#archive").addEventListener("change", (e) => {
  if (e.target.value) location.hash = e.target.value === state.index[0]?.id ? "" : `#week-${e.target.value}`;
  scrollTo({ top: 0 });
});

// fade out the radar loading overlay; held for at least one sweep so a fast load doesn't just flash it
function hideLoader() {
  const el = $("#loader");
  setTimeout(() => {
    el.classList.add("done");
    setTimeout(() => el.remove(), 500);
  }, Math.max(0, 2400 - performance.now()));
}

// source links + event cards: show a QR code for the link in a popup instead of opening it
// (cmd/ctrl/shift-click still open it in a new tab)
const qrModal = $("#qrModal");
function openQR(ev) {
  const a = ev.target.closest("a.src-link, a.card");
  if (!a || ev.metaKey || ev.ctrlKey || ev.shiftKey || !window.qrcode) return; // no library -> plain link
  ev.preventDefault();
  const qr = qrcode(0, "L"); // lowest error correction = fewest modules; long links stay scannable
  qr.addData(a.href);
  qr.make();
  $("#qrCode").innerHTML = qr.createSvgTag({ cellSize: 4, margin: 4, scalable: true });
  $("#qrTitle").textContent = a.closest(".card")?.querySelector(".stmt, h3")?.textContent.replace(/^New since your last visit: /, "") || "";
  $("#qrUrl").textContent = a.hostname.replace(/^www\./, "");
  $("#qrHint").textContent = a.classList.contains("src-link") ? "Scan to open & read the source" : "Scan to learn more about this event";
  qrModal.showModal();
}
$("main").addEventListener("click", openQR);
qrModal.querySelector(".qr-close").addEventListener("click", () => qrModal.close());
qrModal.addEventListener("click", (e) => { if (e.target === qrModal) qrModal.close(); }); // backdrop click

// the fixed feedback bar wraps on phones: keep --fb-h at its height so content stays clear of it
const feedbackBar = $("#feedbackBar");
new ResizeObserver(() => document.documentElement.style.setProperty("--fb-h", feedbackBar.offsetHeight + "px")).observe(feedbackBar);

// money button: shows a random money emoji, bursts emoji confetti on click
const MONEY = ["💰", "💵", "💸", "🤑", "💴", "💶", "💷", "🪙", "🏦", "💎"];
const rand = (a, b) => a + Math.random() * (b - a);
const pickMoney = () => MONEY[Math.floor(Math.random() * MONEY.length)];
const moneyBtn = $("#moneyBtn");
moneyBtn.textContent = pickMoney();
// explosion physics: radial launch velocity, then gravity + air drag until off-screen
const GRAVITY = 1500; // px/s², tune for heavier/lighter feel
const DRAG = 0.6;     // fraction of velocity kept per second
let pieces = [], rafId = 0;
function step(now) {
  const t = Math.min((now - step.last) / 1000, 0.05); // clamp so a hidden tab doesn't teleport pieces
  step.last = now;
  const drag = DRAG ** t;
  pieces = pieces.filter((p) => {
    p.vy += GRAVITY * t;
    p.vx *= drag; p.vy *= drag;
    p.x += p.vx * t; p.y += p.vy * t; p.rot += p.spin * t;
    p.el.style.transform = `translate(${p.x}px, ${p.y}px) translate(-50%, -50%) rotate(${p.rot}deg)`;
    if (p.y > innerHeight + 80) { p.el.remove(); return false; }
    return true;
  });
  rafId = pieces.length ? requestAnimationFrame(step) : 0;
}

// "ching": synthesized with Web Audio (no audio file). Two bell tones.
let audio;
function kaching() {
  const AC = window.AudioContext || window.webkitAudioContext;
  if (!AC) return;
  audio ||= new AC(); // created on the first click, which browsers require before playing sound
  audio.resume();
  const t = audio.currentTime;
  const out = audio.createGain();
  out.gain.value = 0.25; // master volume
  out.connect(audio.destination);

  // "ching": bell = fundamental + inharmonic overtones, fast attack, long exponential ring-out
  const bell = (freq, at, dur) => {
    for (const [mult, vol] of [[1, 1], [2.76, 0.35], [5.4, 0.15]]) {
      const osc = audio.createOscillator(), g = audio.createGain();
      osc.frequency.value = freq * mult;
      g.gain.setValueAtTime(0.0001, at);
      g.gain.exponentialRampToValueAtTime(vol, at + 0.005);
      g.gain.exponentialRampToValueAtTime(0.0001, at + dur);
      osc.connect(g).connect(out);
      osc.start(at);
      osc.stop(at + dur);
    }
  };
  bell(1568, t, 0.9); // G6
  bell(2093, t + 0.06, 1.1); // C7
}

moneyBtn.addEventListener("click", () => {
  kaching();
  moneyBtn.textContent = pickMoney();
  if (matchMedia("(prefers-reduced-motion: reduce)").matches) return;
  const r = moneyBtn.getBoundingClientRect();
  const cx = r.left + r.width / 2, cy = r.top + r.height / 2;
  for (let i = 0; i < 112; i++) {
    const el = document.createElement("span");
    el.className = "money-piece";
    el.textContent = pickMoney();
    el.style.fontSize = Math.round(rand(32, 60)) + "px";
    document.body.appendChild(el);
    // burst in every direction from the button
    const angle = rand(0, 2 * Math.PI), speed = rand(450, 1200);
    pieces.push({
      el, x: cx, y: cy, rot: rand(0, 360), spin: rand(-540, 540),
      vx: Math.cos(angle) * speed,
      vy: Math.sin(angle) * speed - rand(150, 350), // upward kick so it pops before falling
    });
  }
  if (!rafId) { step.last = performance.now(); rafId = requestAnimationFrame(step); }
});

load();
