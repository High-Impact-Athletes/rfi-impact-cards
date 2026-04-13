// Cloudflare Pages Function — catch-all router for impact-card pages.
//
// URL shapes:
//   /                       → static index.html (hardcoded demo)
//   /:slug                  → milestone="latest" for that profile
//   /:milestone/:slug       → named milestone view of that profile
//   /something.png          → static asset (fall through)
//   anything else           → static fallback (let Pages 404 / serve index)
//
// To add a new milestone: add an entry to MILESTONES below. Each entry has a
// `pick(donations, profile)` (returns one donation) OR an `aggregate(donations,
// profile)` (returns a synthetic donation object). Both must return null when
// the data isn't available — the handler will fall back to the demo cleanly.

const RAISELY_API = 'https://api.raisely.com/v3';

// Cause areas — kebab-case end-to-end. Keep aligned with CAUSE_DATA in index.html.
const KNOWN_CAUSE_AREAS = new Set([
  'global-health',
  'mental-health',
  'womens-empowerment',
  'animal-welfare',
  'climate-change',
]);
const DEFAULT_CAUSE_AREA = 'global-health';

const CURRENCY_SYMBOLS = {
  USD: '$', EUR: '€', GBP: '£', AUD: '$', CAD: '$', NZD: '$', CHF: 'CHF', HKD: '$',
};

// ---------------------------------------------------------------------------
// Milestone registry — donations are sorted desc (newest first) when passed in
// ---------------------------------------------------------------------------

function pickAtRunningTotal(donations, threshold) {
  // donations are desc by createdAt; walk asc to find the donation that pushed
  // the running total over `threshold`.
  if (!donations.length || !threshold) return null;
  const asc = [...donations].reverse();
  let total = 0;
  for (const d of asc) {
    total += d.campaignAmount || d.amount || 0;
    if (total >= threshold) return d;
  }
  return null;
}

const MILESTONES = {
  'latest': {
    label: 'Latest donation',
    pick: (donations) => donations[0] || null,
  },
  'first-donation': {
    label: 'First donation',
    pick: (donations) => donations[donations.length - 1] || null,
  },

  // --- Scaffolded, not yet implemented (currently fall back to latest + flag).
  'milestone-1': {
    label: '25% of goal',
    pick: (donations, profile) => pickAtRunningTotal(donations, (profile?.goal || 0) * 0.25),
  },
  'milestone-2': {
    label: '50% of goal',
    pick: (donations, profile) => pickAtRunningTotal(donations, (profile?.goal || 0) * 0.50),
  },
  'milestone-3': {
    label: '75% of goal',
    pick: (donations, profile) => pickAtRunningTotal(donations, (profile?.goal || 0) * 0.75),
  },
  'goal-hit': {
    label: 'Goal reached',
    pick: (donations, profile) => pickAtRunningTotal(donations, profile?.goal || 0),
  },

  // Stubs — return null so caller falls back to demo with a clear error tag.
  '100-donors':     { label: '100th donor',    todo: true, pick: () => null },
  'halfway':        { label: 'Halfway',        todo: true, pick: () => null },
  'final-push':     { label: 'Final push',     todo: true, pick: () => null },
  'daily-summary':  { label: 'Today',          todo: true, pick: () => null },
  'weekly-summary': { label: 'This week',      todo: true, pick: () => null },
};

const DEFAULT_MILESTONE = 'latest';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function fetchJson(url) {
  const res = await fetch(url, { headers: { 'Accept': 'application/json' } });
  if (!res.ok) throw new Error(`Raisely ${res.status} for ${url}`);
  return res.json();
}

function buildDonorName(d) {
  if (!d) return 'Anonymous';
  if (d.anonymous) return 'Anonymous';
  const first = (d.firstName || '').trim();
  const last = (d.lastName || '').trim();
  const full = (d.fullName || `${first} ${last}`).trim();
  return full || 'Anonymous';
}

function buildRacerName(profile) {
  const u = profile?.user || {};
  const first = (u.firstName || '').trim();
  const last = (u.lastName || '').trim();
  const full = `${first} ${last}`.trim();
  return full || profile?.name || 'Fundraiser';
}

function buildDonation(profile, donation) {
  if (!donation) return null;
  const causeRaw = profile?.public?.causeArea || '';
  const causeArea = KNOWN_CAUSE_AREAS.has(causeRaw) ? causeRaw : DEFAULT_CAUSE_AREA;
  const currencyCode = (donation.currency || profile?.currency || 'USD').toUpperCase();
  const donorUserUuid = donation.user?.uuid || donation.userUuid;
  const profileUserUuid = profile?.user?.uuid || profile?.userUuid;

  return {
    amount: Math.round((donation.amount || 0) / 100),
    currency: donation.currencySymbol || CURRENCY_SYMBOLS[currencyCode] || currencyCode,
    donorName: buildDonorName(donation),
    donorMessage: (donation.message || '').trim(),
    isSelfDonation: !!(donorUserUuid && profileUserUuid && donorUserUuid === profileUserUuid),
    racerName: buildRacerName(profile),
    event: profile?.campaign?.name || profile?.public?.event || '',
    causeArea,
  };
}

function injectData(html, payload) {
  const tag = `<script id="rfi-data" type="application/json">${
    JSON.stringify(payload).replace(/</g, '\\u003c')
  }</script>`;
  if (html.includes('</head>')) return html.replace('</head>', `${tag}\n</head>`);
  return tag + html;
}

async function serveHtmlWithPayload(env, request, payload) {
  const assetUrl = new URL('/index.html', request.url);
  const assetResp = await env.ASSETS.fetch(assetUrl);
  const html = await assetResp.text();
  return new Response(injectData(html, payload), {
    status: 200,
    headers: {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'public, max-age=60',
      'X-RFI-Slug': payload.slug || '',
      'X-RFI-Milestone': payload.milestone || '',
      'X-RFI-Fallback': payload.fallback ? '1' : '0',
      'X-RFI-Error': payload.error || '',
    },
  });
}

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

export async function onRequest(context) {
  const { request, params, env, next } = context;
  const segments = (params.path || []).filter(Boolean);

  // Bare / → static demo. Static assets (with a dot) → static.
  if (segments.length === 0) return next();
  if (segments.some(s => s.includes('.'))) return next();

  // Parse routing.
  let milestone = DEFAULT_MILESTONE;
  let slug;
  if (segments.length === 1) {
    slug = segments[0];
  } else if (segments.length === 2) {
    milestone = segments[0];
    slug = segments[1];
  } else {
    return next();
  }

  let payload = { fallback: true, slug, milestone, error: null, donation: null };

  const def = MILESTONES[milestone];
  if (!def) {
    payload.error = 'unknown_milestone';
    return serveHtmlWithPayload(env, request, payload);
  }

  try {
    const profileResp = await fetchJson(
      `${RAISELY_API}/profiles/${encodeURIComponent(slug)}`
    );
    const profile = profileResp?.data;
    if (!profile?.uuid) throw new Error('profile_not_found');

    const donationsResp = await fetchJson(
      `${RAISELY_API}/profiles/${profile.uuid}/donations?limit=200&sort=createdAt&order=desc`
    );
    const donations = (donationsResp?.data || []).filter(d => !d.status || d.status === 'OK');

    let donation = null;
    if (def.pick) {
      donation = def.pick(donations, profile);
    } else if (def.aggregate) {
      donation = def.aggregate(donations, profile); // synthetic donation-shape object
    }

    const built = buildDonation(profile, donation);
    if (built) {
      payload = { fallback: false, slug, milestone, donation: built };
    } else {
      payload.error = def.todo ? 'milestone_not_implemented' : 'no_data_for_milestone';
    }
  } catch (err) {
    payload.error = String(err.message || err);
  }

  return serveHtmlWithPayload(env, request, payload);
}
