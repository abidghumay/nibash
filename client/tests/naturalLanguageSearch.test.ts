import assert from 'node:assert/strict';
import test from 'node:test';
import { mergeSearchFilters, buildStrictSearchParams, getNaturalSearchBlock, type SearchInterpretation } from '../src/utils/naturalLanguageSearch.ts';

test('manual filters intersect mandatory AI constraints without relaxing them', () => {
  const result = mergeSearchFilters({ areaId: 2, minRent: 20000, maxRent: 40000, minBedrooms: 3, amenityNames: ['Lift'], pets: true },
    { areaId: 2, maxRent: 30000, bedrooms: 4, amenityNames: ['Parking'] });
  assert.deepEqual(result.errors, []);
  assert.deepEqual(result.filters, { areaId: 2, minRent: 20000, maxRent: 30000, bedrooms: 4, minBedrooms: 3, pets: true, amenityNames: ['Lift', 'Parking'] });
});

test('incompatible areas, bedrooms, pets and budgets block search', () => {
  for (const [ai, manual] of [
    [{ areaId: 2 }, { areaId: 4 }],
    [{ bedrooms: 2 }, { bedrooms: 3 }],
    [{ minBedrooms: 3 }, { bedrooms: 2 }],
    [{ pets: true }, { pets: false }],
    [{ minRent: 40000 }, { maxRent: 30000 }],
  ] as const) assert.ok(mergeSearchFilters(ai, manual).errors.length);
});

test('pagination preserves exact structured request and never sends natural text as q', () => {
  const filters = { areaId: 2, minRent: 10000, maxRent: 30000, minBedrooms: 2, bathrooms: 2, floor: 0, pets: false, amenityNames: ['Lift'], keywords: 'balcony' };
  const first = buildStrictSearchParams(filters);
  const next = buildStrictSearchParams(filters, 'next-page');
  assert.equal(next.get('cursor'), 'next-page');
  next.delete('cursor');
  assert.equal(next.toString(), first.toString());
  assert.equal(first.get('strict'), '1');
  assert.equal(first.get('q'), null);
  assert.equal(first.get('pets'), 'false');
  assert.equal(first.get('floor'), '0');
  assert.equal(first.get('amenities'), 'Lift');
});

test('unresolved named areas conflict rather than silently overriding', () => {
  assert.ok(mergeSearchFilters({ areaName: 'Banani' }, { areaName: 'Mirpur' }).errors.length);
});

test('canonical area names avoid cached frontend ID mismatches', () => {
  const result = mergeSearchFilters({ areaId: 99, areaName: 'Dhanmondi' }, { areaName: 'Dhanmondi' });
  assert.deepEqual(result.errors, []);
  assert.equal(result.filters.areaId, 99);
  assert.equal(buildStrictSearchParams(mergeSearchFilters({}, { areaName: 'Banani' }).filters).get('area'), 'Banani');
});

test('fallback, unfinished interpretation and mandatory unsupported requirements never show matches', () => {
  const interpretation: SearchInterpretation = { status: 'interpreted', filters: { maxRent: 30000 }, preferences: ['quiet'], unsupported: [{ requirement: 'near my office', mandatory: true, reason: 'No office location' }], warnings: [], latencyMs: 1 };
  assert.ok(getNaturalSearchBlock({ phase: 'idle', interpretation: null }));
  assert.ok(getNaturalSearchBlock({ phase: 'interpreting', interpretation: null }));
  assert.ok(getNaturalSearchBlock({ phase: 'ready', interpretation: { ...interpretation, status: 'fallback' } }));
  assert.ok(getNaturalSearchBlock({ phase: 'ready', interpretation }));
  const explicitlyRemoved = { ...interpretation, unsupported: [] };
  assert.equal(getNaturalSearchBlock({ phase: 'ready', interpretation: explicitlyRemoved }), '');
  assert.ok(getNaturalSearchBlock({ phase: 'ready', interpretation: explicitlyRemoved }, ['Budget conflict']));
});

test('amenity editing preserves and normalizes every required amenity', () => {
  const merged = mergeSearchFilters({ amenityNames: [' Lift ', '', 'Parking'] }, { amenityNames: ['Lift', 'Security'] });
  assert.deepEqual(merged.filters.amenityNames, ['Lift', 'Parking', 'Security']);
  assert.equal(buildStrictSearchParams(merged.filters).get('amenities'), 'Lift,Parking,Security');
});
