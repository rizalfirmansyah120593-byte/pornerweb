const EPORNER_API = 'https://www.eporner.com/api/v2/video/search/';
const EPORNER_ID_API = 'https://www.eporner.com/api/v2/video/id/';
const titleCache = new Map();

const allowedOrders = new Set([
    'latest', 'longest', 'shortest', 'top-rated',
    'most-popular', 'top-weekly', 'top-monthly',
]);

function positiveInteger(value, fallback, max) {
    const number = Number.parseInt(value, 10);
    return Number.isInteger(number) && number > 0 ? Math.min(number, max) : fallback;
}

export async function epornerSearch({ query, id, page = 1, perPage = 24, thumbsize = 'big', order } = {}) {
    const params = new URLSearchParams();
    if (id) params.set('id', String(id).trim());
    else if (query) params.set('query', String(query).trim());
    else throw new Error('Eporner membutuhkan parameter query atau id.');

    params.set('page', String(positiveInteger(page, 1, 1_000_000)));
    params.set('per_page', String(positiveInteger(perPage, 24, 100)));
    params.set('thumbsize', ['small', 'medium', 'big'].includes(thumbsize) ? thumbsize : 'big');
    if (allowedOrders.has(order)) params.set('order', order);

    const endpoint = id ? EPORNER_ID_API : EPORNER_API;
    const response = await fetch(`${endpoint}?${params}`, {
        headers: { accept: 'application/json', 'user-agent': 'PornerWeb/1.0' },
        signal: AbortSignal.timeout(15_000),
    });
    if (!response.ok) throw new Error(`Eporner API mengembalikan HTTP ${response.status}.`);
    const data = await response.json();
    return id ? { videos: data?.id ? [data] : [] } : data;
}

export async function epornerPageTitle(id) {
    const rawId = String(id || '').replace(/^ep_/, '').trim();
    if (!rawId) return '';
    const cached = titleCache.get(rawId);
    if (cached && cached.expiresAt > Date.now()) return cached.title;
    const response = await fetch(`https://www.eporner.com/video-${encodeURIComponent(rawId)}/`, {
        headers: { accept: 'text/html', 'user-agent': 'Mozilla/5.0 (compatible; PornerWeb/1.0)' },
        signal: AbortSignal.timeout(8_000),
    });
    if (!response.ok) return '';
    const html = await response.text();
    const match = html.match(/<meta[^>]+property=["']og:title["'][^>]+content=["']([^"']+)["']/i)
        || html.match(/<title[^>]*>([^<]+)<\/title>/i);
    const title = String(match?.[1] || '').replace(/\s+/g, ' ').replace(/\s*[-|]\s*Eporner.*$/i, '').trim();
    titleCache.set(rawId, { title, expiresAt: Date.now() + 30 * 60 * 1000 });
    return title;
}

export { EPORNER_API };
