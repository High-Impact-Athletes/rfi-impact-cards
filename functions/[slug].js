// Cloudflare Pages Function — /:slug
//
// Resolves a Raisely fundraiser profile path (e.g. /hugo-inglis) to a real
// donation, then serves the static index.html with a <script id="rfi-data">
// JSON blob injected before </head>. The page hydrates from that blob; if
// hydration fails it falls back to the hardcoded demo donation.
//
// Query params:
//   ?d=latest   (default) — most recent donation on the profile
//   ?d=first              — the very first donation on the profile
//   ?d=N                  — the Nth donation, 1-indexed (1 = newest)
//
// Uses the public Raisely API. No auth, no secrets.

const RAISELY_API = 'https://api.raisely.com/v3';

// Cause areas are kebab-case end-to-end (Raisely → ferrari → index.html CAUSE_DATA keys).
// Keep this list in sync with the keys in CAUSE_DATA inside index.html.
const KNOWN_CAUSE_AREAS = new Set([
  'global-health',
  'mental-health',
  'womens-empowerment',
  'animal-welfare',
  'climate-change',
]);
const DEFAULT_CAUSE_AREA = 'global-health';

const CURRENCY_SYMBOLS = {
  USD: '$', EUR: '€', GBP: '£', AUD: '$', CAD: '$', NZD: '$', CHF: 'CHF',
};

function pickDonation(donations, dParam) {
  if (!donations || donations.length === 0) return null;
  const p = (dParam || 'latest').toLowerCase();
  if (p === 'first') return donations[donations.length - 1];
  if (p === 'latest') return donations[0];
  const n = parseInt(p, 10);
  if (Number.isFinite(n) && n >= 1 && n <= donations.length) return donations[n - 1];
  return donations[0];
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

async function fetchJson(url) {
  const res = await fetch(url, { headers: { 'Accept': 'application/json' } });
  if (!res.ok) {
    throw new Error(`Raisely ${res.status} for ${url}`);
  }
  return res.json();
}

function buildDonation(profile, donation) {
  if (!donation) return null;
  const causeRaw = profile?.public?.causeArea || '';
  const causeArea = KNOWN_CAUSE_AREAS.has(causeRaw) ? causeRaw : DEFAULT_CAUSE_AREA;
  const currencyCode = (donation.currency || profile?.currency || 'USD').toUpperCase();

  return {
    amount: Math.round((donation.amount || 0) / 100),
    currency: CURRENCY_SYMBOLS[currencyCode] || currencyCode,
    donorName: buildDonorName(donation),
    donorMessage: (donation.message || '').trim(),
    isSelfDonation: !!(donation.userUuid && profile?.userUuid && donation.userUuid === profile.userUuid),
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

export async function onRequest(context) {
  const { request, params, env, next } = context;
  const slug = params.slug;

  // Static asset fall-through (anything with a "." — favicon, .png, .css, etc.)
  if (!slug || slug.includes('.')) return next();

  const url = new URL(request.url);
  const dParam = url.searchParams.get('d');

  let payload = { fallback: true, slug, error: null, donation: null };

  try {
    const profileUrl = `${RAISELY_API}/profiles/${encodeURIComponent(slug)}`;
    const donationsUrl = `${RAISELY_API}/profiles/${encodeURIComponent(slug)}/donations?limit=50&sort=createdAt&order=desc&status=OK`;

    const [profileResp, donationsResp] = await Promise.all([
      fetchJson(profileUrl),
      fetchJson(donationsUrl),
    ]);

    const profile = profileResp?.data;
    const donations = donationsResp?.data || [];
    const donation = pickDonation(donations, dParam);
    const built = buildDonation(profile, donation);

    if (built) {
      payload = { fallback: false, slug, donation: built };
    } else {
      payload.error = 'no_donations';
    }
  } catch (err) {
    payload.error = String(err.message || err);
  }

  // Fetch the static index.html and inject our data
  const assetUrl = new URL('/index.html', request.url);
  const assetResp = await env.ASSETS.fetch(assetUrl);
  const html = await assetResp.text();
  const injected = injectData(html, payload);

  return new Response(injected, {
    status: 200,
    headers: {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'public, max-age=60',
      'X-RFI-Slug': slug,
      'X-RFI-Fallback': payload.fallback ? '1' : '0',
    },
  });
}
