import express from 'express';
import { fileURLToPath } from 'url';
import { dirname, join, resolve } from 'path';
import cookieParser from 'cookie-parser';

import { PornHub } from './Pornhub.js-master/dist/index.mjs';
import {
    SITE_NAME, SITE_DESCRIPTION, INDEXABLE_CATEGORIES, COUNTRY_FILTERS,
    categoriesBySlug, categoriesByQuery, countriesBySlug,
    getSiteUrl, absoluteUrl, safeJson, parsePage, normalizeQuery, extractVideoId, videoPath,
    isoDuration, buildSeo, collectionJsonLd, xmlEscape,
} from './config/seo.js';

const app = express();
const ph = new PornHub();
app.locals.ph = ph;
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const PORT = Number.parseInt(process.env.PORT || '3000', 10);
const isProduction = process.env.NODE_ENV === 'production';

app.disable('x-powered-by');
app.set('trust proxy', 1);
app.set('view engine', 'ejs');
app.set('views', join(__dirname, 'views'));

app.use(cookieParser());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use((req, res, next) => {
    if (!isProduction) {
        res.set('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
        res.set('Pragma', 'no-cache');
        res.set('Expires', '0');
    }
    next();
});
app.use((req, res, next) => {
    if (!isProduction && req.path.startsWith('/css/')) {
        res.set('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
        res.set('Pragma', 'no-cache');
        res.set('Expires', '0');
    }
    next();
});
app.use(express.static(join(__dirname, 'public'), { maxAge: isProduction ? '7d' : 0 }));

app.use((req, res, next) => {
    const savedLanguage = ['id', 'en'].includes(req.cookies.lang) ? req.cookies.lang : null;
    const detectedLanguage = req.acceptsLanguages('id', 'en') || 'id';
    const lang = savedLanguage || detectedLanguage;
    res.locals.lang = lang;
    res.locals.langPreference = savedLanguage || 'auto';
    res.locals.site = {
        name: SITE_NAME, url: getSiteUrl(req),
        googleSiteVerification: process.env.GOOGLE_SITE_VERIFICATION || '',
    };
    res.locals.categories = INDEXABLE_CATEGORIES;
    res.locals.countries = COUNTRY_FILTERS;
    res.locals.currentPath = req.path;
    res.locals.adsEnabled = req.path === '/'
        || ['/recommended', '/models'].includes(req.path)
        || req.path.startsWith('/category/')
        || req.path.startsWith('/country/')
        || req.path.startsWith('/watch/');
    res.locals.isActive = (pathname) => req.path === pathname;
    res.locals.safeJson = safeJson;
    res.locals.videoPath = videoPath;
    res.locals.t = {
        id: {
            placeholder: 'Temukan video favorit Anda...', searchLabel: 'Cari video', searchBtn: 'Cari',
            all: 'Semua', featured: 'Video Pilihan', videos: 'Video', fourK: '4K', best: 'Terbaik',
            categories: 'Kategori', pornstars: 'Pornstar', countries: 'Negara', recommendations: 'Rekomendasi',
            models: 'Model', account: 'Akun', hello: 'Halo', login: 'Masuk', register: 'Daftar', logout: 'Keluar',
            language: 'Bahasa', automatic: 'Otomatis', theme: 'Tema', light: 'Terang', dark: 'Gelap',
            skip: 'Lewati ke konten', explore: 'Jelajahi', popular: 'Populer',
            discover: 'Temukan favoritmu', exploreMenu: 'Jelajahi Menu', menuHint: 'Ketuk untuk buka/tutup',
            popularIndonesia: 'Populer Indonesia', popularAmateur: 'Amateur Populer', forYou: 'Pilihan Untuk Anda',
            vintage: 'Koleksi Vintage', vr: 'Pilihan VR', popularModels: 'Model Populer', cosplayModels: 'Model Cosplay',
            collection: 'Koleksi pilihan 18+', available: 'video tersedia', watchNow: 'Tonton sekarang',
            noVideos: 'Belum ada video', tryAnother: 'Coba kategori lain atau gunakan pencarian di bagian atas.',
            previous: 'Sebelumnya', next: 'Berikutnya', back: 'Kembali ke koleksi', watching: 'Sedang ditonton',
            views: 'Views', likes: 'Likes', duration: 'Durasi', aboutVideo: 'Tentang video ini', relatedTags: 'Tag terkait',
            footerTagline: 'Jelajahi konten favoritmu dengan nyaman.', terms: 'Ketentuan Layanan',
            privacy: 'Kebijakan Privasi', contact: 'Kontak', copyright: 'Hak cipta dilindungi. Khusus pengguna 18+.',
        },
        en: {
            placeholder: 'Find your favorite video...', searchLabel: 'Search videos', searchBtn: 'Search',
            all: 'All', featured: 'Featured Videos', videos: 'Videos', fourK: '4K', best: 'Best',
            categories: 'Categories', pornstars: 'Pornstars', countries: 'Countries', recommendations: 'Recommended',
            models: 'Models', account: 'Account', hello: 'Hello', login: 'Sign in', register: 'Register', logout: 'Sign out',
            language: 'Language', automatic: 'Automatic', theme: 'Theme', light: 'Light', dark: 'Dark',
            skip: 'Skip to content', explore: 'Explore', popular: 'Popular',
            discover: 'Find your favorites', exploreMenu: 'Explore Menu', menuHint: 'Tap to open/close',
            popularIndonesia: 'Popular in Indonesia', popularAmateur: 'Popular Amateur', forYou: 'Picked For You',
            vintage: 'Vintage Collection', vr: 'VR Picks', popularModels: 'Popular Models', cosplayModels: 'Cosplay Models',
            collection: 'Curated 18+ collection', available: 'videos available', watchNow: 'Watch now',
            noVideos: 'No videos yet', tryAnother: 'Try another category or use the search bar above.',
            previous: 'Previous', next: 'Next', back: 'Back to collection', watching: 'Now watching',
            views: 'Views', likes: 'Likes', duration: 'Duration', aboutVideo: 'About this video', relatedTags: 'Related tags',
            footerTagline: 'Explore your favorite content comfortably.', terms: 'Terms of Service',
            privacy: 'Privacy Policy', contact: 'Contact', copyright: 'All rights reserved. Adults 18+ only.',
        },
    }[lang];

    res.locals.seo = buildSeo(req, {});
    if (req.path === '/set-lang') {
        res.set('X-Robots-Tag', 'noindex, nofollow');
    }
    next();
});

async function renderVideoListing(req, res, { query, heading, description, canonicalBase, indexFirstPage }) {
    const page = parsePage(req.query.page);
    const separator = canonicalBase.includes('?') ? '&' : '?';
    const canonicalPath = page > 1 ? `${canonicalBase}${separator}page=${page}` : canonicalBase;
    const paginationPath = (target) => target > 1 ? `${canonicalBase}${separator}page=${target}` : canonicalBase;

    try {
        const result = await ph.searchVideo(query, { page });
        const videos = result?.data || [];
        const shouldIndex = indexFirstPage && page === 1;
        const totalPages = Math.max(1, Math.min(Number(result?.paging?.maxPage) || 10, 100));
        const seo = buildSeo(req, {
            title: heading,
            description,
            pathname: canonicalPath,
            explicit: true,
            robots: shouldIndex ? undefined : 'noindex, follow, max-image-preview:large, max-video-preview:-1',
            image: videos[0]?.preview,
            jsonLd: shouldIndex ? collectionJsonLd(req, heading, description, videos, canonicalPath) : undefined,
            prev: page > 1 ? paginationPath(page - 1) : undefined,
            next: page < totalPages ? paginationPath(page + 1) : undefined,
        });

        if (!shouldIndex) res.set('X-Robots-Tag', 'noindex, follow');
        return res.render('index', {
            data: videos, title: heading, intro: description, query, currentPage: page,
            totalPages, paginationPath, seo,
        });
    } catch (error) {
        console.error(`[Listing] Gagal memuat ${query}:`, error.message);
        res.set('X-Robots-Tag', 'noindex, nofollow');
        return res.status(502).render('error', {
            statusCode: 502,
            message: 'Konten sedang tidak dapat dimuat. Silakan coba kembali beberapa saat lagi.',
            seo: buildSeo(req, {
                title: 'Konten Tidak Tersedia', description: 'Konten sedang tidak dapat dimuat.',
                pathname: canonicalPath, robots: 'noindex, nofollow',
            }),
        });
    }
}

app.get('/', async (req, res) => {
    const requestedQuery = normalizeQuery(req.query.q);
    const english = res.locals.lang === 'en';
    if (requestedQuery) {
        const category = categoriesByQuery.get(requestedQuery.toLowerCase());
        if (category) {
            const page = parsePage(req.query.page);
            return res.redirect(301, `/category/${category.slug}${page > 1 ? `?page=${page}` : ''}`);
        }
        return renderVideoListing(req, res, {
            query: requestedQuery,
            heading: english ? `Search results: ${requestedQuery}` : `Hasil pencarian: ${requestedQuery}`,
            description: english ? `Video search results for ${requestedQuery}.` : `Hasil pencarian video untuk ${requestedQuery}.`,
            canonicalBase: `/?q=${encodeURIComponent(requestedQuery)}`,
            indexFirstPage: false,
        });
    }
    return renderVideoListing(req, res, {
        query: 'popular', heading: english ? 'Popular Adult Videos' : 'Video Dewasa Populer',
        description: english ? 'Discover popular adult videos with simple category navigation. Adults 18+ only.' : SITE_DESCRIPTION,
        canonicalBase: '/', indexFirstPage: true,
    });
});

app.get('/category/:slug', async (req, res, next) => {
    const category = categoriesBySlug.get(req.params.slug.toLowerCase());
    if (!category) return next();
    return renderVideoListing(req, res, {
        query: category.query,
        heading: res.locals.lang === 'en' ? `${category.label} Videos` : `Video ${category.label}`,
        description: res.locals.lang === 'en'
            ? `Explore regularly updated ${category.label} adult videos. Adults 18+ only.`
            : `Jelajahi koleksi video dewasa kategori ${category.label} yang diperbarui secara berkala. Khusus pengguna berusia 18 tahun ke atas.`,
        canonicalBase: `/category/${category.slug}`,
        indexFirstPage: true,
    });
});

app.get('/country/:slug', async (req, res, next) => {
    const country = countriesBySlug.get(req.params.slug.toLowerCase());
    if (!country) return next();
    return renderVideoListing(req, res, {
        query: country.query,
        heading: res.locals.lang === 'en' ? `Videos from ${country.label}` : `Video dari ${country.label}`,
        description: res.locals.lang === 'en'
            ? `Explore popular adult videos from ${country.label}. Adults 18+ only.`
            : `Jelajahi video dewasa populer dari ${country.label}. Khusus pengguna berusia 18 tahun ke atas.`,
        canonicalBase: `/country/${country.slug}`,
        indexFirstPage: true,
    });
});

app.get('/recommended', (req, res) => renderVideoListing(req, res, {
    query: 'recommended',
    heading: res.locals.lang === 'en' ? 'Recommended Videos' : 'Video Rekomendasi',
    description: res.locals.lang === 'en'
        ? 'Recommended adult video picks, updated regularly.'
        : 'Pilihan video dewasa yang direkomendasikan dan diperbarui secara berkala.',
    canonicalBase: '/recommended',
    indexFirstPage: true,
}));

app.get('/models', (req, res) => renderVideoListing(req, res, {
    query: 'model',
    heading: res.locals.lang === 'en' ? 'Pornstars & Models' : 'Pornstar & Model',
    description: res.locals.lang === 'en'
        ? 'Explore popular adult model and pornstar videos.'
        : 'Jelajahi koleksi video pornstar dan model dewasa populer.',
    canonicalBase: '/models',
    indexFirstPage: true,
}));

app.get('/watch', (req, res) => {
    const id = extractVideoId(req.query.url || req.query.id);
    return id ? res.redirect(301, `/watch/${encodeURIComponent(id)}`) : res.redirect(301, '/');
});

app.get('/watch/:id', async (req, res, next) => {
    const id = extractVideoId(req.params.id);
    if (!id) return next();
    
    try {
        const videoData = await ph.video(id);

        let recommendations = [];
        try {
            const searchQuery = Array.isArray(videoData?.tags) && videoData.tags.filter(Boolean).length
                ? videoData.tags.find(Boolean)
                : 'popular';
            const pagesToCheck = [1, 2, 3];
            const seenIds = new Set([id]);
            const pool = [];

            for (const page of pagesToCheck) {
                const searchResult = await ph.searchVideo(searchQuery, { page });
                const results = Array.isArray(searchResult?.data) ? searchResult.data : [];

                for (const item of results) {
                    if (!item?.id || seenIds.has(item.id)) continue;
                    seenIds.add(item.id);
                    pool.push({
                        id: item.id,
                        title: item.title || (res.locals.lang === 'en' ? 'Recommended video' : 'Video rekomendasi'),
                        url: item.url || `/watch/${encodeURIComponent(item.id)}`,
                        preview: item.preview || '',
                        views: item.views,
                        duration: item.duration,
                    });

                    if (pool.length >= 12) break;
                }

                if (pool.length >= 12) break;
            }

            recommendations = [...pool].sort(() => Math.random() - 0.5).slice(0, 12);
        } catch (error) {
            console.error(`Gagal mengambil rekomendasi untuk ${id}:`, error.message);
            recommendations = [];
        }

        const thumbnail = videoData.preview || videoData.thumb || undefined;
        const tags = Array.isArray(videoData.tags) ? videoData.tags.filter(Boolean).slice(0, 8) : [];
        const description = `Tonton ${videoData.title}.${tags.length ? ` Tag: ${tags.join(', ')}.` : ''} Konten khusus dewasa 18+.`;
        const pathname = `/watch/${encodeURIComponent(id)}`;
        const embedUrl = `https://www.pornhub.com/embed/${encodeURIComponent(id)}`;
        
        const uploadDate = videoData.uploadDate instanceof Date
            && !Number.isNaN(videoData.uploadDate.valueOf())
            && videoData.uploadDate.getFullYear() > 1970
            ? videoData.uploadDate.toISOString() : undefined;

        const jsonLd = thumbnail && uploadDate ? {
            '@context': 'https://schema.org',
            '@type': 'VideoObject',
            name: videoData.title,
            description,
            thumbnailUrl: [thumbnail],
            uploadDate,
            duration: isoDuration(videoData.duration),
            embedUrl,
            url: absoluteUrl(req, pathname),
            inLanguage: 'id-ID',
            isFamilyFriendly: false,
            contentRating: '18+',
            interactionStatistic: Number.isFinite(videoData.views) ? {
                '@type': 'InteractionCounter',
                interactionType: { '@type': 'WatchAction' },
                userInteractionCount: videoData.views,
            } : undefined,
        } : undefined;
        return res.render('watch', {
            video: { ...videoData, description, },
            recommendations,
            localUrl: `/watch/${id}`,
            seo: buildSeo(req, {
                title: videoData.title, 
                description, 
                pathname, 
                image: thumbnail, 
                type: 'video.other',
                explicit: true, 
                jsonLd, 
                video: embedUrl,
            }),
        });
        
    } catch (error) {
        console.error(`Gagal memuat video ${id}:`, error.message);
        res.set('X-Robots-Tag', 'noindex, nofollow');
        return res.status(502).render('error', {
            statusCode: 502,
            message: 'Video sedang tidak dapat dimuat. Silakan coba kembali nanti.',
            seo: buildSeo(req, {
                title: 'Video Tidak Tersedia', 
                description: 'Video sedang tidak dapat dimuat.',
                pathname: `/watch/${encodeURIComponent(id)}`, 
                robots: 'noindex, nofollow',
            }),
        });
    }
});

app.get('/set-lang', (req, res) => {
    const requestedLanguage = String(req.query.lang || 'auto');
    if (requestedLanguage === 'auto') {
        res.clearCookie('lang', {
            httpOnly: true, sameSite: 'lax', secure: process.env.NODE_ENV === 'production',
        });
    } else {
        const lang = requestedLanguage === 'en' ? 'en' : 'id';
        res.cookie('lang', lang, {
            maxAge: 30 * 24 * 60 * 60 * 1000, httpOnly: true, sameSite: 'lax',
            secure: process.env.NODE_ENV === 'production',
        });
    }
    let returnPath = '/';
    try {
        const referer = new URL(req.get('Referer') || '/', `${getSiteUrl(req)}/`);
        if (referer.origin === new URL(getSiteUrl(req)).origin) returnPath = `${referer.pathname}${referer.search}`;
    } catch {
        returnPath = '/';
    }
    return res.redirect(303, returnPath);
});

app.get('/pornstar', (req, res) => res.redirect(301, '/category/pornstar'));

const contentPages = {
    '/terms': ['terms', 'Ketentuan Layanan', `Ketentuan penggunaan layanan ${SITE_NAME}.`],
    '/privacy': ['privacy', 'Kebijakan Privasi', `Pelajari cara ${SITE_NAME} mengelola dan melindungi data pengguna.`],
    '/contact': ['contact', 'Hubungi Kami', `Hubungi tim dukungan ${SITE_NAME}.`],
};
async function loadFeaturedVideos(req) {
    try {
        const result = await req.app.locals.ph.searchVideo('popular', { page: 1 });
        return Array.isArray(result?.data) ? result.data.slice(0, 6) : [];
    } catch (error) {
        console.error('[SidebarContent] Gagal memuat video unggulan:', error.message);
        return [];
    }
}

for (const [pathname, [view, title, description]] of Object.entries(contentPages)) {
    app.get(pathname, async (req, res) => {
        const featuredVideos = await loadFeaturedVideos(req);
        res.render(view, {
            seo: buildSeo(req, { title, description, pathname }),
            featuredVideos,
            pageTitle: title,
            pageIntro: description,
            pageBadge: 'Informasi',
        });
    });
}

app.get('/robots.txt', (req, res) => {
    res.type('text/plain').send([
        'User-agent: *', 'Allow: /', 'Disallow: /set-lang', '',
        `Sitemap: ${absoluteUrl(req, '/sitemap.xml')}`, '',
    ].join('\n'));
});

app.get('/sitemap.xml', (req, res) => {
    const configuredLastmod = String(process.env.SITEMAP_LASTMOD || '').trim();
    const lastmod = /^\d{4}-\d{2}-\d{2}$/.test(configuredLastmod) ? configuredLastmod : '';
    const paths = [
        { path: '/' },
        ...INDEXABLE_CATEGORIES.map(({ slug }) => ({ path: `/category/${slug}` })),
        ...COUNTRY_FILTERS.map(({ slug }) => ({ path: `/country/${slug}` })),
        { path: '/recommended' },
        { path: '/models' },
        { path: '/terms' },
        { path: '/privacy' },
        { path: '/contact' },
    ];
    const urls = paths.map(({ path }) => [
        '  <url>',
        `    <loc>${xmlEscape(absoluteUrl(req, path))}</loc>`,
        lastmod ? `    <lastmod>${lastmod}</lastmod>` : '',
        '  </url>',
    ].filter(Boolean).join('\n')).join('\n');
    res.set('Cache-Control', 'public, max-age=3600, s-maxage=86400');
    res.type('application/xml').send([
        '<?xml version="1.0" encoding="UTF-8"?>',
        '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">',
        urls, '</urlset>', '',
    ].join('\n'));
});

app.use((req, res) => {
    res.set('X-Robots-Tag', 'noindex, nofollow');
    return res.status(404).render('error', {
        statusCode: 404,
        message: 'Halaman yang Anda cari tidak ditemukan.',
        seo: buildSeo(req, {
            title: 'Halaman Tidak Ditemukan',
            description: 'Halaman yang Anda cari tidak ditemukan.',
            pathname: req.path,
            robots: 'noindex, nofollow',
        }),
    });
});

export function startServer(port = PORT) {
    return app.listen(port, '0.0.0.0', () => {
        console.log(`Server berjalan di port ${port}`);
    });
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(__filename)) {
    startServer();
}

export default app;
