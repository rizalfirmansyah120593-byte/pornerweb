export const SITE_NAME = process.env.SITE_NAME || 'PORNERWEB';
export const SITE_DESCRIPTION = process.env.SITE_DESCRIPTION
    || 'PORNERWEB adalah platform penemuan video dewasa 18+ dengan koleksi populer dari berbagai sumber. Jelajahi video berdasarkan kategori, negara, popularitas, dan kata kunci dalam pengalaman browsing yang rapi, cepat, dan nyaman.';

const configuredSiteUrl = (process.env.SITE_URL || '').replace(/\/+$/, '');

export const INDEXABLE_CATEGORIES = Object.freeze([
    ['amateur', 'amateur', 'Amateur'], ['anal', 'anal', 'Anal'],
    ['asian', 'asian', 'Asian'], ['bdsm', 'BDSM', 'BDSM'],
    ['big-ass', 'big ass', 'Big Ass'], ['big-tits', 'big tits', 'Big Tits'],
    ['blowjob', 'blowjob', 'Blowjob'], ['compilation', 'compilation', 'Compilation'],
    ['cosplay', 'cosplay', 'Cosplay'], ['ebony', 'ebony', 'Ebony'],
    ['fetish', 'fetish', 'Fetish'], ['hardcore', 'hardcore', 'Hardcore'],
    ['hentai', 'hentai', 'Hentai'], ['homemade', 'homemade', 'Homemade'],
    ['indian', 'indian', 'Indian'], ['indonesia', 'indonesia', 'Indonesia'],
    ['japanese', 'japanese', 'Japanese'], ['latina', 'latina', 'Latina'],
    ['lesbian', 'lesbian', 'Lesbian'], ['massage', 'massage', 'Massage'],
    ['mature', 'mature', 'Mature'], ['milf', 'milf', 'MILF'],
    ['pornstar', 'pornstar', 'Pornstar'], ['pov', 'pov', 'POV'],
    ['redhead', 'redhead', 'Redhead'], ['threesome', 'threesome', 'Threesome'],
    ['vintage', 'vintage', 'Vintage'], ['vr-porn', 'vr porn', 'VR Porn'],
].map(([slug, query, label]) => ({ slug, query, label })));

export const categoriesBySlug = new Map(INDEXABLE_CATEGORIES.map((item) => [item.slug, item]));
export const categoriesByQuery = new Map(INDEXABLE_CATEGORIES.map((item) => [item.query.toLowerCase(), item]));

export const COUNTRY_FILTERS = Object.freeze([
    ['indonesia', 'indonesia', 'Indonesia'],
    ['japan', 'japanese', 'Jepang'],
    ['korea', 'korean', 'Korea'],
    ['india', 'indian', 'India'],
    ['united-states', 'american', 'Amerika Serikat'],
    ['united-kingdom', 'british', 'Inggris'],
    ['brazil', 'brazilian', 'Brasil'],
    ['france', 'french', 'Prancis'],
    ['germany', 'german', 'Jerman'],
    ['spain', 'spanish', 'Spanyol'],
].map(([slug, query, label]) => ({ slug, query, label })));

export const countriesBySlug = new Map(COUNTRY_FILTERS.map((item) => [item.slug, item]));

export function getSiteUrl(req) {
    if (configuredSiteUrl) return configuredSiteUrl;
    return `${req.protocol}://${req.get('host')}`.replace(/\/+$/, '');
}

export function absoluteUrl(req, pathname = '/') {
    return new URL(pathname, `${getSiteUrl(req)}/`).toString();
}

export function safeJson(value) {
    return JSON.stringify(value).replace(/</g, '\\u003c').replace(/>/g, '\\u003e').replace(/&/g, '\\u0026');
}

export function parsePage(value) {
    const page = Number.parseInt(value, 10);
    return Number.isInteger(page) && page > 0 ? Math.min(page, 100) : 1;
}

export function normalizeQuery(value) {
    return String(value || '').replace(/[-_]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 80);
}

export function extractVideoId(value) {
    if (!value) return null;
    const rawValue = String(value).trim();
    let candidate = rawValue;
    try {
        const parsedUrl = new URL(rawValue);
        candidate = parsedUrl.searchParams.get('viewkey') || parsedUrl.pathname.split('/').filter(Boolean).pop() || '';
    } catch {
        const match = rawValue.match(/[?&]viewkey=([a-zA-Z0-9_-]+)/);
        if (match) candidate = match[1];
    }
    return /^[a-zA-Z0-9_-]{4,80}$/.test(candidate) ? candidate : null;
}

export function videoPath(video) {
    const id = extractVideoId(video?.id || video?.viewKey || video?.video_id || video?.url);
    return id ? `/watch/${encodeURIComponent(id)}` : '/';
}

export function isoDuration(seconds) {
    const total = Number(seconds);
    if (!Number.isFinite(total) || total <= 0) return undefined;
    const hours = Math.floor(total / 3600);
    const minutes = Math.floor((total % 3600) / 60);
    const remaining = Math.floor(total % 60);
    return `PT${hours ? `${hours}H` : ''}${minutes ? `${minutes}M` : ''}${remaining || (!hours && !minutes) ? `${remaining}S` : ''}`;
}

export function buildSeo(req, {
    title, description = SITE_DESCRIPTION, pathname = req.originalUrl,
    robots = 'index, follow, max-image-preview:large, max-snippet:-1, max-video-preview:-1',
    image, type = 'website', explicit = false, jsonLd, prev, next, video,
} = {}) {
    const fullTitle = title?.includes(SITE_NAME) ? title : `${title || SITE_NAME} | ${SITE_NAME}`;
    return {
        title: fullTitle, description, canonical: absoluteUrl(req, pathname), robots, image, type,
        explicit, jsonLd, prev: prev ? absoluteUrl(req, prev) : undefined,
        next: next ? absoluteUrl(req, next) : undefined, video,
    };
}

export function collectionJsonLd(req, title, description, videos, pathname) {
    const canonical = absoluteUrl(req, pathname);
    const items = videos.map((video) => ({ video, path: videoPath(video) }))
        .filter(({ path }) => path !== '/').slice(0, 30)
        .map(({ video, path }, index) => ({
            '@type': 'ListItem', position: index + 1, url: absoluteUrl(req, path), name: video.title,
        }));
    return {
        '@context': 'https://schema.org',
        '@graph': [
            {
                '@type': 'WebSite', '@id': `${getSiteUrl(req)}/#website`, url: `${getSiteUrl(req)}/`,
                name: SITE_NAME, description: SITE_DESCRIPTION, inLanguage: 'id-ID',
            },
            {
                '@type': 'CollectionPage', '@id': `${canonical}#webpage`, url: canonical, name: title,
                description, isPartOf: { '@id': `${getSiteUrl(req)}/#website` }, inLanguage: 'id-ID',
                mainEntity: { '@type': 'ItemList', numberOfItems: items.length, itemListElement: items },
            },
        ],
    };
}

export function xmlEscape(value) {
    return String(value).replace(/&/g, '&amp;').replace(/</g, '&lt;')
        .replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;');
}
