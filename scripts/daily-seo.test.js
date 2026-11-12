import test from 'node:test';
import assert from 'node:assert/strict';
import { buildCategoryDescription, findOptimizationCandidate, getDateRange } from './daily-seo.js';
import { categoriesBySlug } from '../config/seo.js';

test('uses complete 28-day data and leaves a three-day freshness buffer', () => {
    assert.deepEqual(getDateRange(new Date('2026-11-12T17:00:00.000Z')), {
        startDate: '2026-10-13', endDate: '2026-11-09',
    });
});

test('selects only a matching, low-CTR category page with sufficient impressions', () => {
    const candidate = findOptimizationCandidate([
        { keys: ['https://pornerweb.pro/category/milf', 'milf videos'], clicks: 0, impressions: 40, position: 7 },
        { keys: ['https://pornerweb.pro/?q=milf', 'milf videos'], clicks: 0, impressions: 100, position: 5 },
        { keys: ['https://pornerweb.pro/category/asian', 'milf videos'], clicks: 0, impressions: 100, position: 5 },
    ], {}, new Date('2026-11-12T00:00:00.000Z'));

    assert.equal(candidate.category.slug, 'milf');
    assert.equal(candidate.impressions, 40);
});

test('does not change pages below thresholds or inside the cooldown window', () => {
    const category = categoriesBySlug.get('milf');
    const rows = [{ keys: ['https://pornerweb.pro/category/milf', 'milf videos'], clicks: 0, impressions: 29, position: 7 }];
    assert.equal(findOptimizationCandidate(rows), undefined);

    const enoughData = [{ ...rows[0], impressions: 40 }];
    const recentOverride = { [category.slug]: { updatedAt: '2026-10-31T00:00:00.000Z' } };
    assert.equal(findOptimizationCandidate(enoughData, recentOverride, new Date('2026-11-12T00:00:00.000Z')), undefined);
});

test('does not repeat a metadata description that is already active', () => {
    const category = categoriesBySlug.get('milf');
    const rows = [{ keys: ['https://pornerweb.pro/category/milf', 'milf videos'], clicks: 0, impressions: 40, position: 7 }];
    const existingOverride = { [category.slug]: { id: buildCategoryDescription(category), updatedAt: '2026-09-01T00:00:00.000Z' } };
    assert.equal(findOptimizationCandidate(rows, existingOverride, new Date('2026-11-12T00:00:00.000Z')), undefined);
});

test('does not match a category keyword inside an unrelated word', () => {
    const rows = [{ keys: ['https://pornerweb.pro/category/anal', 'analysis videos'], clicks: 0, impressions: 100, position: 7 }];
    assert.equal(findOptimizationCandidate(rows), undefined);
});

test('generated metadata uses a curated category label and does not include raw queries', () => {
    const description = buildCategoryDescription(categoriesBySlug.get('milf'));
    assert.match(description, /video milf dewasa 18\+/i);
    assert.doesNotMatch(description, /<script|raw search query/i);
});
