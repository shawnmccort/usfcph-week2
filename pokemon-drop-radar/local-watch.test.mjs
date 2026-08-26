import assert from 'node:assert/strict';
import { diffNewAvailability, normalizeBestBuyStore, queryBestBuyLocal, runCycle } from './local-watch.mjs';

const zone = { label: 'Temple Terrace', postalCode: '33617', radiusMiles: 15 };
const product = { key: 'p1', name: 'Test ETB', sku: '123', url: 'https://example.com/p1' };

const inside = normalizeBestBuyStore({ storeID: '565', name: 'University', address: 'A', city: 'Tampa', state: 'FL', postalCode: '33612', distance: 4.24, lowStock: true }, product, zone, '2026-08-25T12:00:00Z');
assert.equal(inside.status, 'low_stock');
assert.equal(inside.distanceMiles, 4.2);
assert.equal(inside.confidence, 'official');
assert.equal(normalizeBestBuyStore({ storeID: '999', distance: 16 }, product, zone, '2026-08-25T12:00:00Z'), null);

const fakeFetch = async () => ({
  ok: true,
  status: 200,
  text: async () => JSON.stringify({ ispuEligible: true, stores: [{ storeID: '565', name: 'University', city: 'Tampa', state: 'FL', postalCode: '33612', distance: 4.2, lowStock: false }] })
});
const api = await queryBestBuyLocal({ sku: '123', zone, apiKey: 'x', fetchImpl: fakeFetch });
assert.equal(api.health, 'ok');
assert.equal(api.observations.length, 1);

const config = {
  zone,
  pollIntervalMs: 120000,
  providers: {
    'Best Buy': { mode: 'official_api', enabled: true },
    Target: { mode: 'manual_official_web', enabled: true },
    Walmart: { mode: 'manual_official_web', enabled: true }
  }
};
const fastProducts = [
  { key: 'p1', name: 'Test ETB', retailer: 'Best Buy', sku: '123', url: 'https://example.com/p1', maxPrice: 70 },
  { key: 'p1', name: 'Test ETB', retailer: 'Target', sku: '456', url: 'https://example.com/t1', maxPrice: 70 },
  { key: 'p2', name: 'Other Pack', retailer: 'Target', sku: '789', url: 'https://example.com/t2', maxPrice: 10 }
];
const fetchBestBuy = async () => ({
  health: 'ok',
  observations: [
    { storeID: '565', name: 'University', address: 'A', city: 'Tampa', state: 'FL', postalCode: '33612', distance: 4.2, lowStock: false },
    { storeID: '888', name: 'Far Away', city: 'Elsewhere', state: 'FL', postalCode: '99999', distance: 30, lowStock: false }
  ]
});
const first = await runCycle({ config, fastProducts, previousState: null, fetchBestBuy, apiKey: 'x', now: new Date('2026-08-25T12:00:00Z') });
assert.equal(first.state.summary.productsChecked, 1);
assert.equal(first.state.summary.productsWithLocalStock, 1);
assert.equal(first.state.observations.length, 1);
assert.equal(first.newAvailability.length, 1);
assert.equal(first.state.providers.find((p) => p.retailer === 'Target').health, 'manual_only');

const second = await runCycle({ config, fastProducts, previousState: first.state, fetchBestBuy, apiKey: 'x', now: new Date('2026-08-25T12:02:00Z') });
assert.equal(second.newAvailability.length, 0);
assert.equal(diffNewAvailability(first.state, second.state).length, 0);

const noKey = await runCycle({ config, fastProducts, previousState: null, fetchBestBuy: queryBestBuyLocal, apiKey: '', now: new Date('2026-08-25T12:00:00Z') });
assert.equal(noKey.state.providers.find((p) => p.retailer === 'Best Buy').health, 'needs_setup');
assert.equal(noKey.state.observations.length, 0);

console.log('local-watch tests passed');
