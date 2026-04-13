# Deployment & architecture

> Single source of truth for how `rfi-impact-cards` is deployed, where data
> comes from, and what's planned next. Future agents/devs: read this first.

## Live URLs

- Production: <https://rfi-impact-cards.pages.dev/>
- Custom domain (planned): `impact.raceforimpact.com` (CNAME → `rfi-impact-cards.pages.dev`, set up by Kevin in the Cloudflare dashboard)

## Repo layout

```
rfi-impact-cards/
├── index.html              # Single-file vanilla HTML/CSS/JS app (no build step)
├── assets/                 # Static images / video posters
│   ├── milestone-first-donation.png
│   └── global-health-poster.jpg
├── functions/
│   └── [[path]].js         # Catch-all Pages Function — milestone router + Raisely API connector
├── _headers                # Cache headers for /assets/*
├── _routes.json            # Tells Pages which paths hit the function
└── docs/
    └── DEPLOYMENT.md       # this file
```

No `package.json`, no bundler, no CI. The repo deploys as-is.

## Hosting: Cloudflare Pages

- Provider: Cloudflare Pages, project name `rfi-impact-cards`
- Connected to Git repo: `High-Impact-Athletes/rfi-impact-cards`
- Production branch: `main` (every push to `main` auto-deploys)
- Build command: **(empty)**
- Build output directory: `/`
- Env vars / secrets: **none** (we use the public Raisely API)

## Routing

`_routes.json` excludes `/assets/*` and favicons so they serve as plain static
files. Everything else is sent to the Pages Function.

| URL                              | Handler                          | Behavior                                                                |
|----------------------------------|----------------------------------|-------------------------------------------------------------------------|
| `/`                              | static `index.html`              | Renders the hardcoded demo donation (`Sarah Mitchell → $50 → Hugo`).    |
| `/:slug`                         | `functions/[[path]].js`          | Default milestone (`latest`). Fetches Raisely, injects JSON.            |
| `/:milestone/:slug`              | `functions/[[path]].js`          | Named milestone view of that profile (see Milestones section).          |
| `/assets/*`                      | static                           | Long-cache (`max-age=31536000, immutable`).                             |
| `*.png`, `*.css`, etc.           | static                           | Anything with a `.` falls through to static.                            |

The function falls through (`context.next()`) for any segment containing a `.`,
so `/foo.png` etc. still hit static.

### Milestones

URL shape: `/{milestone}/{slug}` — milestone is the *view*, slug is the *subject*.
Bare `/{slug}` defaults to `latest`. Live registry in `functions/[[path]].js`.

| Milestone           | Status         | What it picks                                              |
|---------------------|----------------|------------------------------------------------------------|
| `latest`            | ✅ live         | Most recent successful donation                            |
| `first-donation`    | ✅ live         | Oldest donation                                            |
| `milestone-1`       | ✅ live         | Donation that pushed running total over 25% of goal        |
| `milestone-2`       | ✅ live         | …over 50% of goal                                          |
| `milestone-3`       | ✅ live         | …over 75% of goal                                          |
| `goal-hit`          | ✅ live         | …over 100% of goal                                         |
| `100-donors`        | 🚧 stub        | Returns `milestone_not_implemented`, falls back to demo    |
| `halfway`           | 🚧 stub        | (alias for `milestone-2` — to be defined)                  |
| `final-push`        | 🚧 stub        | TBD — last 7 days, X to go                                 |
| `daily-summary`     | 🚧 stub        | Aggregate of today's donations (synthetic donation object) |
| `weekly-summary`    | 🚧 stub        | Aggregate of this week's donations                         |

To add a new milestone: add an entry to the `MILESTONES` map in
`functions/[[path]].js`. Each entry has either a `pick(donations, profile)`
returning a single Raisely donation, or an `aggregate(donations, profile)`
returning a synthetic donation-shaped object. Return `null` if data isn't
available — the handler falls back to the demo cleanly with an `X-RFI-Error`
header explaining why.

## Data flow

```
GET /:slug
  └─> functions/[slug].js
        ├─ GET https://api.raisely.com/v3/profiles/{slug}
        ├─ GET https://api.raisely.com/v3/profiles/{slug}/donations
        │       ?limit=50&sort=createdAt&order=desc&status=OK
        ├─ pickDonation()  — based on ?d= query param
        ├─ buildDonation() — maps Raisely fields to the shape index.html expects
        └─ injectData()    — inserts <script id="rfi-data" type="application/json">{...}</script>
                             before </head> in index.html, returns HTML
                             (Cache-Control: public, max-age=60)
```

In `index.html`, the IIFE reads `#rfi-data` and uses it as `DONATION`. If the
script tag is missing or unparseable, it falls back to `DEFAULT_DONATION` so
the bare `/` route keeps working for design review.

### Field mapping (Raisely → DONATION)

| `DONATION` field    | Source                                                                 |
|---------------------|------------------------------------------------------------------------|
| `amount`            | `donation.amount / 100` (Raisely stores cents)                         |
| `currency`          | symbol from `donation.currency` (`USD→$`, `EUR→€`, `GBP→£`, …)         |
| `donorName`         | `donation.fullName` or `firstName + lastName`; `Anonymous` if missing  |
| `donorMessage`      | `donation.message` (trimmed)                                           |
| `isSelfDonation`    | `donation.userUuid === profile.userUuid`                               |
| `racerName`         | `profile.user.firstName + lastName` (or `profile.name`)                |
| `event`             | `profile.campaign.name` (often empty unless campaign is included)      |
| `causeArea`         | `profile.public.causeArea` — kebab-case, validated against allow-list  |

### Cause-area enum (kebab-case, end-to-end)

Confirmed by the ferrari component (`rfi-cli-connection/components/ferrari/ferrari.js`,
`IMPACT_MULTIPLIERS_PER_EUR`). These keys must stay aligned across:
1. Raisely (`profile.public.causeArea`) — source of truth
2. `functions/[slug].js` (`KNOWN_CAUSE_AREAS`)
3. `index.html` (`CAUSE_DATA` keys)

```
global-health
mental-health
womens-empowerment
animal-welfare
climate-change
```

If Raisely returns an unknown value the function falls back to `global-health`.
**To add a new cause area**, add it in all three places above and ship a
charity list inside `CAUSE_DATA` in `index.html`.

## Reference docs (outside this repo)

- Raisely API docs (markdown): `~/Documents/ProgrammingIsFun/HIA/scale-RFI/Prod/rfi-cli-connection/reference/api-docs/`
  - `profiles/get-profile.md` — `GET /v3/profiles/{path}`
  - `profiles/all-donations.md` — `GET /v3/profiles/{path}/donations`
- Ferrari (Raisely → social asset renderer; reuse helpers/values, don't reinvent):
  `~/Documents/ProgrammingIsFun/HIA/scale-RFI/Prod/rfi-cli-connection/components/ferrari/`
  - `ferrari.js` — currency symbols, cause-area constants, name splitting
  - `CLAUDE.md` — full architecture notes

## Local development

There's no dev server in the repo. Two options:

1. Static-only (no API): `python3 -m http.server 8000` then visit
   <http://localhost:8000/> — renders the hardcoded demo.
2. Function-aware: `npx wrangler pages dev .` — serves both static files and
   the Pages Function locally; visit `http://localhost:8788/hugo-inglis-1`.

## Verification checklist (after each deploy)

- `curl -I https://rfi-impact-cards.pages.dev/` → 200, demo renders in browser.
- `curl -sI https://rfi-impact-cards.pages.dev/hugo-inglis-1 | grep -i x-rfi`
  → `X-RFI-Slug: hugo-inglis-1`, `X-RFI-Milestone: latest`, `X-RFI-Fallback: 0`.
- `curl -s https://rfi-impact-cards.pages.dev/hugo-inglis-1 | grep rfi-data`
  → injected JSON visible in source.
- Browser `/hugo-inglis-1` → cards render real donor + amount + cause area.
- `/first-donation/hugo-inglis-1` → renders the very first donation instead.
- `/milestone-2/hugo-inglis-1` → renders the donation that crossed 50% of goal.
- `/100-donors/hugo-inglis-1` → falls back to demo, header `X-RFI-Error: milestone_not_implemented`.
- `/nonexistent-slug-xyz` → falls back to demo, `X-RFI-Fallback: 1`, no 500.
- `curl -I .../assets/milestone-first-donation.png` → 200 with long-cache.

## What's done

- [x] Repo forked to High-Impact-Athletes/rfi-impact-cards
- [x] Cards screen 0/1/2 (splash, swipeable charity cards, video screen) — built by Hugo
- [x] Hardcoded demo at `/` for design review
- [x] Cloudflare Pages project connected to Git, auto-deploying `main`
- [x] Catch-all Pages Function (`functions/[[path]].js`) — milestone router + Raisely API
- [x] Milestones live: `latest`, `first-donation`, `milestone-1/2/3`, `goal-hit`
- [x] Hydration in `index.html` with safe fallback to demo
- [x] Cause-area enum unified to kebab-case (matches Raisely + ferrari)
- [x] `_headers` long-cache for `/assets/*`
- [x] `_routes.json` excludes static paths from the function

## Phase 2 (planned, not yet built)

### Custom domain
- Add `impact.raceforimpact.com` in Cloudflare Pages → Custom Domains.
- Verify CNAME and SSL provisioning.
- Update share links / replies once live.

### Polished assets
- Source the missing `assets/global-health-video.mp4` (referenced in `index.html` but absent).
- Add the other four cause-area videos + posters (`mental-health-*`, `womens-empowerment-*`, `animal-welfare-*`, `climate-change-*`).
- Pull the cause hero imagery used by ferrari (`CAUSE_HERO_IMAGES`, `CAUSE_IMAGES`) into `/assets/` and reference from `CAUSE_DATA` in `index.html`.
- Convert images to WebP, add `srcset` for retina.

### Sharing / OG image
- Generate an OG image per `/:slug` (donor name, amount, cause). Either:
  - Serve a Worker-rendered SVG/PNG, or
  - Reuse ferrari's renderer to produce the share card.
- Add `<meta property="og:*">` and `<meta name="twitter:*">` to the injected HTML.

### Microsurvey (after Hugo's review)
- Hugo wants to layer a short post-experience microsurvey. Spec TBD.

### Edge cases worth handling later
- Raisely 429 / outage — currently we fall back silently; consider showing a small banner.
- Profile with zero successful donations — currently falls back to demo; might want a "no donations yet" view instead.
- Multi-currency — symbol mapping is rudimentary (`$` shared by USD/AUD/CAD/NZD); revisit if international fundraisers join.
- Self-donation detection — relies on `donation.userUuid === profile.userUuid`; verify this field is present on public donation responses (may need `?private=true` + auth, in which case revisit the no-auth decision).
- Campaign / event name — `profile.campaign.name` may not be inlined on the profile response; might require `?campaign={uuid}` or a separate fetch.

## Operational notes

- **Cache invalidation:** function responses are cached at the edge for 60s.
  Trigger a cache purge in CF dashboard if a donor name needs to disappear faster.
- **Rate limits:** Raisely returns 429 if exceeded. The function passes the
  error through as `payload.error` and falls back to demo. Watch for this if a
  single fundraiser page goes viral.
- **No secrets to rotate** at the moment. If we ever switch to authenticated
  Raisely calls (e.g. for private fields or higher rate limits), store
  `RAISELY_API_TOKEN` as a Cloudflare Pages encrypted env var — do not commit.
