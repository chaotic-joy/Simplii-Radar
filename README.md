# Simplii Strategic Market Intelligence

**Live: [simplii-radar.vercel.app](https://simplii-radar.vercel.app)**

A curated weekly market-intelligence dashboard for Simplii Financial's senior leaders. It is not a
news feed: each item has to pass one test, *"Is this important enough, and relevant enough to
Simplii, that a senior Simplii leader should know about it?"* Quiet weeks show fewer items.

- **Weekly Brief** (default): the last completed Monday–Friday, Eastern Time. Weekend developments
  roll into the next week. Published Monday morning and never changed afterwards; past editions stay
  in the archive at the bottom of the page.
- **Last 7 Days**: the same bar applied to the 7 days up to the latest daily refresh. Items not yet in
  a published Weekly Brief are marked **New this week**.
- Two tiers, ranked by importance to Simplii (Canada first): **Top Strategic Developments** and
  **Broader Strategic Signals**. Each item is one 20–40 word statement with its date, tags and
  sources. **Update** marks a new phase of an earlier development.
- **Week in brief**: 2–3 factual sentences, with theme chips that filter the page.
- **Filters**: geography, company, development type, tier, search.
- **Upcoming Strategic Calendar**: verified events in the next 4 weeks with a "watch for" note.
  No earnings calls.
- A small dot marks items added since your last visit (stored in your browser only).

## How it works

```
RSS feeds ─► Haiku drops noise ─► candidate pool (21 days)
                                        │
                prompt.md ─► Opus + web search ─┬─► Weekly Brief  data/editions/<monday>.json (once a week)
                                                ├─► Last 7 Days   data/rolling.json (every run)
                                                └─► Calendar      data/calendar.json (every run)
                     (all in scripts/aggregate.mjs)
```

- **`prompt.md`** is the master prompt: what qualifies, what to exclude (including routine earnings),
  scope, tiers, ranking, dedupe, writing style and the final quality check. **Edit it to change what
  the dashboard picks; no code changes needed.**
- **RSS** (`feeds.json`) supplies leads. Claude Haiku drops obvious noise (earnings, price moves,
  opinion pieces), keeping anything that might qualify. Leads stay in `data/candidates.json` for 21 days.
- **Curation** (Claude Opus with web search) checks the leads, finds the primary sources, adds
  qualifying developments the feeds missed, and writes the statements, tiers, tags and summary.
  It sees what's already on the dashboard, so a development isn't repeated in a later Weekly Brief
  unless it has moved forward (then it's marked Update), and items keep their ids between runs.
- **Code checks** every answer: dates inside the period, at least one source link, valid tags, tier
  caps (8 top, 10 broader, 15 in all), calendar events inside the next 4 weeks with no earnings.
- Each step is best-effort: if one fails, its previous data stays.

| File | Contents |
|---|---|
| `data/editions/index.json` | Published Weekly Briefs, newest first: `id` (the Monday), `label` |
| `data/editions/<monday>.json` | One Weekly Brief: `label`, `from`/`to`, `summary`, `themes` (`label`, item `ids`), `items` |
| `data/rolling.json` | Last 7 Days: same shape plus `updated`; items have `newThisWeek` |
| `data/calendar.json` | `events`: `date`, `endDate`, `tbc`, `name`, `organization`, `location`, `type`, `watch`, `url` |
| `data/candidates.json` | The lead pool (not shown on the site) |

Each item: `statement`, `tier` (1 or 2), `rank`, `date` (of the development), `geography`,
`companies`, `peerGroup`, `type`, `update`, `sources` (`url`, `publisher`; primary first), `firstSeen`.

## Refresh schedule

`.github/workflows/refresh.yml` runs the pipeline daily at **4:30am Eastern** and commits the new data,
which redeploys the site. The Monday run also publishes the Weekly Brief for the week before. If a
Monday run fails, the next run publishes it.

- GitHub's schedule is UTC-only, so the workflow is scheduled at both 08:30 and 09:30 UTC, and a
  small `when` job keeps whichever one is 4:30am in New York. One short **skipped** run per day is expected.
- **On demand:** Actions → **Refresh dashboard data** → **Run workflow**, or `gh workflow run refresh.yml`.
- **Setup:** add `ANTHROPIC_API_KEY` under repo Settings → Secrets and variables → Actions.

## Run locally

```bash
npm install
npm run selftest                            # dedupe, date, validation and calendar logic
npm run dev                                 # serve at http://localhost:3000
ANTHROPIC_API_KEY=sk-... npm run refresh    # pull live data into data/
```

## Deploy

Static files from the repo root, no build step. Any static host works.

- **Search engines are kept out:** `index.html` sets `<meta name="robots" content="noindex, nofollow">`,
  and `robots.txt` blocks crawlers.
- **Link previews still work:** `robots.txt` allows the preview bots (X, LinkedIn, Facebook, Slack,
  Discord) so shared links unfurl with the preview image.

## Link preview image

`og-image.jpg` (1200×630) is rendered from `docs/og-image.html`. After editing that page, re-render
it with the command in its header comment. To refresh LinkedIn's cached preview, use
[Post Inspector](https://www.linkedin.com/post-inspector/).

## Tuning

- **`prompt.md`**: what qualifies and how items are written (no code).
- **`feeds.json`**: RSS sources for leads (no code).
- **`scripts/aggregate.mjs`**: `MODEL_FAST` (first-pass filter) and `MODEL` (curation + calendar), and
  the tier caps.

## Front-end notes

- Follows the system light/dark setting.
- Source links and calendar entries open a QR code popup, for reading on a phone at the kiosk
  (cmd/ctrl-click opens the link instead).
- A radar loading screen shows until the data has rendered. It stays still if the visitor has
  reduced motion turned on.
- **Easter egg:** the money emoji in the footer plays a "ching" and bursts emoji confetti on click.
