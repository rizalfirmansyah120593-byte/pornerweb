const EPORNER_API = 'https://www.eporner.com/api/v2/video/search/';

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

    const response = await fetch(`${EPORNER_API}?${params}`, {
        headers: { accept: 'application/json', 'user-agent': 'PornerWeb/1.0' },
        signal: AbortSignal.timeout(15_000),
    });
    if (!response.ok) throw new Error(`Eporner API mengembalikan HTTP ${response.status}.`);
    return response.json();
}

export { EPORNER_API };
