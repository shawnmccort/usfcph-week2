import fs from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

const OWNER = 'shawnmccort';
const REPO = 'usfcph-week2';
const STATE_BRANCH = 'pokemon-fast-state';
const STATE_PATH = 'pokemon-drop-radar/local-state.json';
const GH = 'https://api.github.com';
const SUPABASE_URL = 'https://avtjrtqzwjiefpowboqo.supabase.co';
const SUPABASE_KEY = 'sb_publishable_yPWA8Ghh-UpxNGt-wSVkvw_3sOkdFTr';
const RUN_MS = 5 * 60 * 60 * 1000 + 45 * 60 * 1000;
const ONCE = process.env.LOCAL_WATCH_ONCE === '1';
const token = process.env.GITHUB_TOKEN || '';
const ntfyTopic = process.env.NTFY_TOPIC || '';
const NTFY_SERVER = (process.env.NTFY_SERVER || 'https://ntfy.sh').replace(/\/$/, '');
const bestBuyApiKey = process.env.BESTBUY_API_KEY || '';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export function observationKey(o) {
  return [o.productKey, o.retailer, o.storeId].join('|');
}

export function diffNewAvailability(previousState, nextState) {
  const old = new Map((previousState?.observations || []).map((o) => [observationKey(o), o]));
  return (nextState?.observations || []).filter((o) => !old.has(observationKey(o)));
}

export function normalizeBestBuyStore(raw, product, zone, nowIso) {
  const distance = Number(raw?.distance);
  if (!Number.isFinite(distance) || distance > Number(zone.radiusMiles)) return null;
  const storeId = String(raw?.storeID ?? raw?.storeId ?? '').trim();
  if (!storeId) return null;
  return {
    productKey: product.key,
    productName: product.name,
    retailer: 'Best Buy',
    sku: String(product.sku),
    productUrl: product.url,
    storeId,
    storeName: String(raw?.name || `Best Buy #${storeId}`),
    address: String(raw?.address || ''),
    city: String(raw?.city || ''),
    region: String(raw?.state || ''),
    postalCode: String(raw?.postalCode || ''),
    distanceMiles: Math.round(distance * 10) / 10,
    status: raw?.lowStock === true ? 'low_stock' : 'in_stock',
    lowStock: raw?.lowStock === true,
    observedAt: nowIso,
    source: 'bestbuy_official_api',
    confidence: 'official'
  };
}

export function mergeCanonicalProducts(fastProducts) {
  const byKey = new Map();
  for (const row of fastProducts || []) {
    if (!row?.key) continue;
    const existing = byKey.get(row.key) || {
      key: row.key,
      name: row.name || row.key,
      maxPrice: row.maxPrice ?? null,
      retailerIds: {},
      retailerUrls: {}
    };
    if (row.name && !existing.name) existing.name = row.name;
    if (row.maxPrice != null && existing.maxPrice == null) existing.maxPrice = row.maxPrice;
    if (row.retailer && row.sku) existing.retailerIds[row.retailer] = String(row.sku);
    if (row.retailer && row.url) existing.retailerUrls[row.retailer] = String(row.url);
    byKey.set(row.key, existing);
  }
  return [...byKey.values()];
}

async function timedFetch(url, options = {}, timeoutMs = 9000) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: ctrl.signal });
  } finally {
    clearTimeout(timer);
  }
}

export async function queryBestBuyLocal({ sku, zone, apiKey, fetchImpl = timedFetch }) {
  if (!apiKey) return { health: 'needs_setup', observations: [], error: 'BESTBUY_API_KEY is not configured' };
  const url = `https://api.bestbuy.com/v1/products/${encodeURIComponent(sku)}/stores.json?postalCode=${encodeURIComponent(zone.postalCode)}&apiKey=${encodeURIComponent(apiKey)}`;
  try {
    const res = await fetchImpl(url, {
      headers: {
        accept: 'application/json',
        'user-agent': 'PokemonDropRadar/1.0 local availability monitor'
      }
    });
    const text = await res.text();
    if (!res.ok) {
      return {
        health: res.status === 403 ? 'rate_limited_or_auth' : 'error',
        observations: [],
        error: `Best Buy API HTTP ${res.status}: ${text.slice(0, 180)}`
      };
    }
    let data;
    try {
      data = JSON.parse(text);
    } catch {
      return { health: 'error', observations: [], error: 'Best Buy API returned non-JSON data' };
    }
    return { health: 'ok', observations: Array.isArray(data?.stores) ? data.stores : [], ispuEligible: data?.ispuEligible === true };
  } catch (error) {
    return { health: 'error', observations: [], error: String(error?.message || error) };
  }
}

function ghHeaders() {
  return {
    authorization: `Bearer ${token}`,
    accept: 'application/vnd.github+json',
    'x-github-api-version': '2022-11-28',
    'user-agent': 'pokemon-local-restock-watch'
  };
}

async function gh(path, opts = {}) {
  if (!token) throw new Error('GITHUB_TOKEN missing');
  const res = await timedFetch(`${GH}${path}`, {
    ...opts,
    headers: { ...ghHeaders(), ...(opts.headers || {}) }
  }, 12000);
  if (!res.ok) throw new Error(`GitHub ${res.status}: ${(await res.text().catch(() => '')).slice(0, 220)}`);
  if (res.status === 204) return null;
  return res.json();
}

async function ghMaybe(path, opts = {}) {
  if (!token) return null;
  const res = await timedFetch(`${GH}${path}`, {
    ...opts,
    headers: { ...ghHeaders(), ...(opts.headers || {}) }
  }, 12000);
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`GitHub ${res.status}: ${(await res.text().catch(() => '')).slice(0, 220)}`);
  if (res.status === 204) return null;
  return res.json();
}

async function ensureStateBranch() {
  const existing = await ghMaybe(`/repos/${OWNER}/${REPO}/git/ref/heads/${encodeURIComponent(STATE_BRANCH)}`);
  if (existing) return;
  const master = await gh(`/repos/${OWNER}/${REPO}/git/ref/heads/master`);
  await gh(`/repos/${OWNER}/${REPO}/git/refs`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ ref: `refs/heads/${STATE_BRANCH}`, sha: master.object.sha })
  });
}

async function readPreviousState() {
  if (!token) return null;
  await ensureStateBranch();
  const x = await ghMaybe(`/repos/${OWNER}/${REPO}/contents/${STATE_PATH}?ref=${encodeURIComponent(STATE_BRANCH)}`);
  if (!x?.content) return null;
  try {
    return JSON.parse(Buffer.from(x.content.replace(/\n/g, ''), 'base64').toString('utf8'));
  } catch {
    return null;
  }
}

async function writeStateFile(state) {
  if (!token) return;
  await ensureStateBranch();
  const current = await ghMaybe(`/repos/${OWNER}/${REPO}/contents/${STATE_PATH}?ref=${encodeURIComponent(STATE_BRANCH)}`);
  const body = {
    message: 'Update local Pokemon restock state [skip ci]',
    content: Buffer.from(`${JSON.stringify(state, null, 2)}\n`).toString('base64'),
    branch: STATE_BRANCH
  };
  if (current?.sha) body.sha = current.sha;
  await gh(`/repos/${OWNER}/${REPO}/contents/${STATE_PATH}`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body)
  });
}

async function publishSupabase(state) {
  if (!ntfyTopic) return false;
  try {
    const res = await timedFetch(`${SUPABASE_URL}/rest/v1/rpc/ingest_pokemon_local_state`, {
      method: 'POST',
      headers: { apikey: SUPABASE_KEY, 'content-type': 'application/json' },
      body: JSON.stringify({ p_secret: ntfyTopic, p_state: state })
    }, 8000);
    if (!res.ok) throw new Error(`Supabase HTTP ${res.status}: ${(await res.text().catch(() => '')).slice(0, 180)}`);
    return true;
  } catch (error) {
    console.log('local state Supabase publish failed', String(error?.message || error));
    return false;
  }
}

async function sendNtfy(observation, zone) {
  if (!ntfyTopic) return false;
  const statusText = observation.lowStock ? 'LOW STOCK' : 'IN STOCK';
  const location = [observation.storeName, observation.city, observation.region].filter(Boolean).join(' · ');
  const body = {
    topic: ntfyTopic,
    title: `📍 Local Pokémon restock · ${observation.retailer}`,
    message: [
      observation.productName,
      `${statusText} · ${observation.distanceMiles} mi from ${zone.postalCode}`,
      location,
      'Source: official Best Buy store availability API'
    ].filter(Boolean).join('\n'),
    priority: 4,
    tags: ['round_pushpin', 'card_index_dividers'],
    click: observation.productUrl
  };
  try {
    const res = await timedFetch(NTFY_SERVER, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body)
    }, 7000);
    if (!res.ok) throw new Error(`ntfy HTTP ${res.status}`);
    return true;
  } catch (error) {
    console.log('local restock ntfy failed', String(error?.message || error));
    return false;
  }
}

function providerTemplate(config) {
  return Object.entries(config.providers || {}).map(([retailer, provider]) => ({
    retailer,
    mode: provider.mode,
    health: provider.mode === 'official_api' ? (bestBuyApiKey ? 'pending' : 'needs_setup') : 'manual_only',
    note: provider.note || null,
    lastCheckedAt: null,
    lastError: provider.mode === 'official_api' && !bestBuyApiKey ? 'BESTBUY_API_KEY is not configured' : null
  }));
}

export async function runCycle({
  config,
  fastProducts,
  previousState = null,
  fetchBestBuy = queryBestBuyLocal,
  apiKey = bestBuyApiKey,
  now = new Date()
}) {
  const nowIso = now.toISOString();
  const canonical = mergeCanonicalProducts(fastProducts);
  const providerRows = providerTemplate(config);
  const bestBuyProvider = providerRows.find((p) => p.retailer === 'Best Buy');
  const observations = [];
  let bestBuyErrors = 0;
  let bestBuyChecks = 0;

  for (const product of canonical) {
    const sku = product.retailerIds['Best Buy'];
    if (!sku) continue;
    bestBuyChecks += 1;
    const result = await fetchBestBuy({ sku, zone: config.zone, apiKey });
    if (result.health !== 'ok') {
      bestBuyErrors += 1;
      if (bestBuyProvider) {
        bestBuyProvider.health = result.health;
        bestBuyProvider.lastError = result.error || null;
      }
      continue;
    }
    if (bestBuyProvider) {
      bestBuyProvider.health = 'ok';
      bestBuyProvider.lastError = null;
      bestBuyProvider.lastCheckedAt = nowIso;
    }
    const sourceProduct = fastProducts.find((r) => r.key === product.key && r.retailer === 'Best Buy');
    const normalizedProduct = {
      key: product.key,
      name: product.name,
      sku,
      url: sourceProduct?.url || product.retailerUrls['Best Buy'] || null
    };
    for (const store of result.observations) {
      const normalized = normalizeBestBuyStore(store, normalizedProduct, config.zone, nowIso);
      if (normalized) observations.push(normalized);
    }
  }

  if (bestBuyProvider && bestBuyChecks > 0 && bestBuyErrors === bestBuyChecks && bestBuyProvider.health === 'pending') {
    bestBuyProvider.health = 'error';
  }

  observations.sort((a, b) => a.distanceMiles - b.distanceMiles || a.productName.localeCompare(b.productName));
  const productsWithLocalStock = new Set(observations.map((o) => o.productKey)).size;
  const storesWithStock = new Set(observations.map((o) => `${o.retailer}|${o.storeId}`)).size;

  const state = {
    version: 1,
    updatedAt: nowIso,
    zone: config.zone,
    providers: providerRows,
    summary: {
      automaticRetailers: providerRows.filter((p) => p.mode === 'official_api' && p.health === 'ok').length,
      productsChecked: bestBuyChecks,
      productsWithLocalStock,
      storesWithStock,
      observations: observations.length
    },
    observations
  };
  return { state, newAvailability: diffNewAvailability(previousState, state) };
}

async function loadConfigFiles() {
  const [localRaw, fastRaw] = await Promise.all([
    fs.readFile('pokemon-drop-radar/local-restock-config.json', 'utf8'),
    fs.readFile('pokemon-drop-radar/fast-products.json', 'utf8')
  ]);
  return {
    config: JSON.parse(localRaw),
    fastProducts: JSON.parse(fastRaw).products || []
  };
}

export async function main() {
  const { config, fastProducts } = await loadConfigFiles();
  const started = Date.now();
  let previousState = await readPreviousState();
  do {
    const { state, newAvailability } = await runCycle({ config, fastProducts, previousState });
    await publishSupabase(state);
    await writeStateFile(state);
    for (const observation of newAvailability) await sendNtfy(observation, config.zone);
    console.log(JSON.stringify({
      at: state.updatedAt,
      zone: state.zone,
      summary: state.summary,
      providerHealth: state.providers.map((p) => [p.retailer, p.health]),
      newAvailability: newAvailability.length
    }));
    previousState = state;
    if (ONCE) break;
    const elapsed = Date.now() - started;
    if (elapsed >= RUN_MS) break;
    await sleep(Math.max(30000, Number(config.pollIntervalMs || 120000)));
  } while (Date.now() - started < RUN_MS);
}

const isDirect = process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url;
if (isDirect) {
  main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
