import { appendFile, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { JWT } from 'google-auth-library';
import { INDEXABLE_CATEGORIES, normalizeQuery } from '../config/seo.js';

const SITE_ORIGIN = 'https://pornerweb.pro';
const GSC_PROPERTY = process.env.GSC_PROPERTY || 'sc-domain:pornerweb.pro';
const OVERRIDES_FILE = new URL('../config/seo-description-overrides.json', import.meta.url);
const GSC_SCOPE = 'https://www.googleapis.com/auth/webmasters.readonly';
const ROW_LIMIT = 25_000;
const MIN_IMPRESSIONS = 30;
const MAX_CTR = 0.03;
const MIN_POSITION = 3;
const MAX_POSITION = 20;
const UPDATE_COOLDOWN_DAYS = 30;

const utcDate = (date) => date.toISOString().slice(0, 10);

export function getDateRange(now = new Date()) {
    const end = new Date(now);
    end.setUTCDate(end.getUTCDate() - 3);
    const start = new Date(end);
    start.setUTCDate(start.getUTCDate() - 27);
    return { startDate: utcDate(start), endDate: utcDate(end) };
}

export function findOptimizationCandidate(rows, overrides = {}, now = new Date()) {
    const metrics = new Map();
    const categories = new Map(INDEXABLE_CATEGORIES.map((item) => [item.slug, item]));

    for (const row of rows) {
        const [pageValue, queryValue] = row.keys || [];
        if (!pageValue || !queryValue) continue;

        let page;
        try {
            page = new URL(pageValue);
        } catch {
            continue;
        }
        if (!['pornerweb.pro', 'www.pornerweb.pro'].includes(page.hostname.toLowerCase())) continue;
        const match = page.pathname.match(/^\/category\/([a-z0-9-]+)\/?$/i);
        const category = match ? categories.get(match[1].toLowerCase()) : null;
        if (!category) continue;

        const query = ` ${normalizeQuery(queryValue).toLowerCase()} `;
        const categoryQuery = ` ${normalizeQuery(category.query).toLowerCase()} `;
        if (categoryQuery.trim() === '' || !query.includes(categoryQuery)) continue;

        const impressions = Number(row.impressions);
        const clicks = Number(row.clicks);
        const position = Number(row.position);
        if (!Number.isFinite(impressions) || impressions <= 0 || !Number.isFinite(clicks) || !Number.isFinite(position)) continue;
        const current = metrics.get(category.slug) || { category, impressions: 0, clicks: 0, weightedPosition: 0 };
        current.impressions += impressions;
        current.clicks += clicks;
        current.weightedPosition += position * impressions;
        metrics.set(category.slug, current);
    }

    const cooldown = UPDATE_COOLDOWN_DAYS * 24 * 60 * 60 * 1000;
    return [...metrics.values()]
        .map((item) => ({
            ...item,
            ctr: item.clicks / item.impressions,
            position: item.weightedPosition / item.impressions,
        }))
        .filter((item) => {
            if (item.impressions < MIN_IMPRESSIONS || item.ctr > MAX_CTR
                || item.position < MIN_POSITION || item.position > MAX_POSITION) return false;
            if (overrides[item.category.slug]?.id === buildCategoryDescription(item.category)) return false;
            const lastUpdated = overrides[item.category.slug]?.updatedAt;
            const updatedAt = Date.parse(lastUpdated);
            return !lastUpdated || !Number.isFinite(updatedAt) || now.valueOf() - updatedAt >= cooldown;
        })
        .sort((a, b) => b.impressions - a.impressions)[0];
}

export function buildCategoryDescription(category) {
    return `Jelajahi pilihan video ${category.query} dewasa 18+ di PORNERWEB. Bandingkan judul, thumbnail, dan durasi, lalu temukan koleksi terkait.`;
}

async function checkEndpoint(path, { accept, expectedStatus = 200, expectedType } = {}) {
    const response = await fetch(new URL(path, SITE_ORIGIN), {
        headers: { accept: accept || '*/*' },
        signal: AbortSignal.timeout(15_000),
        redirect: 'manual',
    });
    if (response.status !== expectedStatus) throw new Error(`${path} returned HTTP ${response.status}; expected ${expectedStatus}`);
    const contentType = response.headers.get('content-type') || '';
    if (expectedType && !contentType.toLowerCase().includes(expectedType)) {
        throw new Error(`${path} returned an unexpected content type`);
    }
    return { path, status: response.status, contentType, body: await response.text(), location: response.headers.get('location') };
}

async function runHealthChecks() {
    const [home, www, robots, sitemap] = await Promise.all([
        checkEndpoint('/', { accept: 'text/html', expectedType: 'text/html' }),
        checkEndpoint('https://www.pornerweb.pro/', { expectedStatus: 301 }),
        checkEndpoint('/robots.txt', { expectedType: 'text/plain' }),
        checkEndpoint('/sitemap.xml', { expectedType: 'application/xml' }),
    ]);
    if (www.location !== `${SITE_ORIGIN}/`) throw new Error('www host does not redirect to the canonical homepage');
    if (!robots.body.includes('Sitemap:') || !sitemap.body.includes('<urlset')) throw new Error('robots.txt or sitemap.xml is incomplete');
    const sitemapUrls = (sitemap.body.match(/<loc>/g) || []).length;
    if (!sitemapUrls) throw new Error('sitemap.xml contains no URLs');
    return { home, www, robots, sitemap, sitemapUrls };
}

async function getSearchConsoleRows(credentials, dateRange) {
    const auth = new JWT({ email: credentials.client_email, key: credentials.private_key, scopes: [GSC_SCOPE] });
    let accessToken;
    try {
        ({ token: accessToken } = await auth.getAccessToken());
    } catch {
        throw new Error('Google authentication failed; check the service-account secret and Search Console permission');
    }
    if (!accessToken) throw new Error('Google authentication returned no access token');

    const endpoint = `https://searchconsole.googleapis.com/webmasters/v3/sites/${encodeURIComponent(GSC_PROPERTY)}/searchAnalytics/query`;
    const rows = [];
    for (let startRow = 0; startRow < ROW_LIMIT * 4; startRow += ROW_LIMIT) {
        const response = await fetch(endpoint, {
            method: 'POST',
            headers: { authorization: `Bearer ${accessToken}`, 'content-type': 'application/json' },
            body: JSON.stringify({ ...dateRange, dimensions: ['page', 'query'], rowLimit: ROW_LIMIT, startRow }),
            signal: AbortSignal.timeout(30_000),
        });
        if (!response.ok) throw new Error(`Search Console API returned HTTP ${response.status}; check the property and read-only permission`);
        const result = await response.json();
        const pageRows = Array.isArray(result.rows) ? result.rows : [];
        rows.push(...pageRows);
        if (pageRows.length < ROW_LIMIT) break;
    }
    return rows;
}

function getCredentials() {
    const raw = process.env.GSC_SERVICE_ACCOUNT_JSON;
    if (!raw) return null;
    let credentials;
    try {
        credentials = JSON.parse(raw);
    } catch {
        throw new Error('GSC_SERVICE_ACCOUNT_JSON is not valid JSON');
    }
    if (!credentials.client_email || !credentials.private_key) {
        throw new Error('GSC service-account secret is missing client_email or private_key');
    }
    return credentials;
}

async function appendSummary(lines) {
    if (process.env.GITHUB_STEP_SUMMARY) {
        await appendFile(process.env.GITHUB_STEP_SUMMARY, `${lines.join('\n')}\n`, 'utf8');
    }
}

export async function runDailySeo({ now = new Date() } = {}) {
    const health = await runHealthChecks();
    const lines = [
        '## Daily SEO check',
        '- Homepage: HTTP 200 HTML',
        '- Canonical host: www redirects to pornerweb.pro',
        `- Sitemap: ${health.sitemapUrls} URLs`,
    ];
    const credentials = getCredentials();
    let changedCategory = null;

    if (!credentials) {
        lines.push('- Search Console: not configured; no content changes made.');
    } else {
        const [overridesText, rows] = await Promise.all([
            readFile(OVERRIDES_FILE, 'utf8'),
            getSearchConsoleRows(credentials, getDateRange(now)),
        ]);
        let overrides;
        try {
            overrides = JSON.parse(overridesText);
        } catch {
            throw new Error('SEO description override file is invalid JSON');
        }
        const candidate = findOptimizationCandidate(rows, overrides, now);
        lines.push(`- Search Console: read-only data loaded for the latest complete 28-day window; ${rows.length} rows analyzed.`);
        if (candidate) {
            changedCategory = candidate.category.slug;
            overrides[changedCategory] = {
                id: buildCategoryDescription(candidate.category),
                updatedAt: now.toISOString(),
            };
            await writeFile(OVERRIDES_FILE, `${JSON.stringify(overrides, null, 2)}\n`, 'utf8');
            lines.push(`- Metadata: updated one Indonesian category description (${changedCategory}); no raw queries or query metrics were stored.`);
        } else {
            lines.push('- Metadata: no page met the minimum-confidence thresholds; no content changes made.');
        }
    }

    await appendSummary(lines);
    console.log(lines.join('\n'));
    return { health, changedCategory };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    runDailySeo().catch((error) => {
        console.error(`Daily SEO task failed: ${error.message}`);
        process.exitCode = 1;
    });
}
