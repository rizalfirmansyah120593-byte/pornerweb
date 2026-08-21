import express from 'express';
import { fileURLToPath } from 'url';
import { dirname, join, resolve } from 'path';
import { createReadStream, existsSync, readFileSync } from 'fs';
import { createInterface } from 'readline';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { createGzip, createBrotliCompress, constants as zlibConstants } from 'zlib';
import cookieParser from 'cookie-parser';
import { epornerSearch, epornerPageTitle } from './eporner.js';

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
// Hostinger datacenter IP sering diblokir Pornhub untuk halaman detail.
// Aktifkan hanya jika server Anda memang diizinkan upstream.
const allowPornhubDetailScrape = process.env.PORNHUB_SERVER_SCRAPE === 'true';
const SUPPORTED_LANGUAGES = ['id', 'en', 'ms', 'es', 'ja'];
const localized = (lang, values) => values[lang] || values.en;
const epornerId = (id) => `ep_${String(id).replace(/^ep_/, '')}`;
const isEpornerId = (id) => String(id || '').startsWith('ep_');
const epornerRawId = (id) => String(id || '').replace(/^ep_/, '');
function normalizeEpornerVideo(item) {
    if (!item?.id) return null;
    const title = item.title || item.video_title || item.name || item.caption || '';
    return { id: epornerId(item.id), source: 'eporner', title: String(title).trim() || 'Eporner video', preview: item.default_thumb?.src || item.thumbs?.[0]?.src || '', views: Number(item.views) || 0, duration: item.length_min || '', durationFormatted: item.length_min || '', url: `/watch/${encodeURIComponent(epornerId(item.id))}`, embed: item.embed || `https://www.eporner.com/embed/${encodeURIComponent(item.id)}/`, tags: String(item.keywords || '').split(',').map((tag) => tag.trim()).filter(Boolean).slice(0, 12) };
}
function fallbackPornstars(gender = '') {
    const names = gender === 'male'
        ? ['Johnny Sins', 'James Deen', 'Manuel Ferrara', 'Rocco Siffredi', 'Keiran Lee', 'Jordi El Nino Polla']
        : ['Angela White', 'Mia Khalifa', 'Lana Rhoades', 'Riley Reid', 'Abella Danger', 'Adriana Chechik', 'Alexis Texas', 'Eva Elfie', 'Jenna Jameson', 'Lisa Ann', 'Kendra Lust', 'Asa Akira'];
    return names.map((name, index) => ({ name, rank: index + 1, videoNum: 0, likes: 'N/A', photo: '/images/placeholder.svg' }));
}
async function hydratePornstarPhotos(stars, limit = 4) {
    // Ambil cadangan untuk semua kartu, karena avatar yang ada tetap bisa
    // mengembalikan 403/404 ketika dirender oleh browser.
    const missing = stars.filter((star) => star?.name).slice(0, limit);
    const results = await Promise.allSettled(missing.map(async (star) => {
        const [detail, phVideos, epVideos] = await Promise.allSettled([
            ph.pornstar(star.name),
            ph.searchVideo(star.name, { page: 1 }),
            epornerSearch({ query: star.name, page: 1, perPage: 8, thumbsize: 'big', order: 'most-popular' }),
        ]);
        const detailValue = detail.status === 'fulfilled' ? detail.value : null;
        const videoPhotos = [
            ...(phVideos.status === 'fulfilled' ? (phVideos.value?.data || []) : []),
            ...(epVideos.status === 'fulfilled' ? (epVideos.value?.videos || []) : []),
        ].map((video) => video.preview || video.default_thumb?.src || video.thumbs?.[0]?.src).filter(Boolean);
        return { detail: detailValue, photos: [...new Set([detailValue?.avatar, ...videoPhotos].filter(Boolean))] };
    }));
    results.forEach((result, index) => {
        if (result.status !== 'fulfilled') return;
        const { detail, photos } = result.value;
        if (photos.length) {
            missing[index].photo = photos[0];
            missing[index].photoFallbacks = photos;
        }
        if (!missing[index].videoNum && detail) missing[index].videoNum = Number(detail.uploadedVideoCount || 0) + Number(detail.taggedVideoCount || 0);
        if ((missing[index].likes === 'N/A' || missing[index].likes == null) && detail?.profileViews != null) missing[index].likes = detail.profileViews;
    });
    return stars;
}
const wait = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));
const isExpectedUpstreamStatus = (error) => /\b(?:403|404)\b/.test(String(error?.message || error || ''));
const isExpectedNetworkFailure = (error) => /fetch failed|certificate has expired|certificate expired|unable to verify|aborted due to timeout|timed out|timeout|network/i.test(String(error?.message || error || ''));
async function getPornhubOembed(viewkey) {
    const id = String(viewkey || '').trim();
    if (!id) return null;
    const endpoint = `https://www.pornhub.com/oembed?url=${encodeURIComponent(`https://www.pornhub.com/view_video.php?viewkey=${id}`)}&format=json`;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 5000);
    try {
        const response = await fetch(endpoint, {
            signal: controller.signal,
            headers: {
                accept: 'application/json,text/plain,*/*',
                'user-agent': 'Mozilla/5.0',
            },
        });
        if (!response.ok) return null;
        const data = await response.json();
        if (!data || typeof data !== 'object') return null;
        return {
            title: typeof data.title === 'string' ? data.title.trim() : null,
            thumbnailUrl: typeof data.thumbnail_url === 'string' ? data.thumbnail_url : null,
        };
    } catch {
        return null;
    } finally {
        clearTimeout(timeout);
    }
}
async function getPornhubPageTitle(viewkey) {
    try {
        const response = await fetch(`https://www.pornhub.com/view_video.php?viewkey=${encodeURIComponent(viewkey)}`, {
            headers: { accept: 'text/html', 'user-agent': 'Mozilla/5.0 (compatible; PornerWeb/1.0)' },
            signal: AbortSignal.timeout(8_000),
        });
        if (!response.ok) return '';
        const html = await response.text();
        const match = html.match(/<meta[^>]+property=["']og:title["'][^>]+content=["']([^"']+)["']/i) || html.match(/<title[^>]*>([^<]+)<\/title>/i);
        return String(match?.[1] || '').replace(/\s+/g, ' ').replace(/\s*[-|]\s*Pornhub.*$/i, '').trim();
    } catch { return ''; }
}
const pornstarListCache = new Map();
const PORNSTAR_CACHE_TTL = 15 * 60 * 1000;

// CSV Webmasters berukuran sangat besar, jadi diproses sekali secara streaming.
// Kolom CSV: embed|thumbnail|preview|title|tags|categories|models|...
const PORNSTAR_THUMB_INDEX_FILE = join(__dirname, 'config', 'pornstar-thumbnails.json');
const PORNSTAR_CSV_FILE = join(__dirname, 'pornhub.com-db.csv');
const PORNSTAR_ZIP_FILE = join(__dirname, 'pornhub.com-db.zip');
const PORNSTAR_ZIP_TEMP_DIR = join(__dirname, '.pornhub-csv-extract');
const execFileAsync = promisify(execFile);
let pornstarThumbIndex = {};
let pornstarThumbIndexBuilding = false;
try {
    if (existsSync(PORNSTAR_THUMB_INDEX_FILE)) pornstarThumbIndex = JSON.parse(readFileSync(PORNSTAR_THUMB_INDEX_FILE, 'utf8'));
} catch (error) {
    console.error('[Pornstar thumbnails] Cache tidak dapat dibaca:', error.message);
}
const normalizePornstarName = (name) => String(name || '').trim().toLowerCase().replace(/[^a-z0-9]+/gi, ' ').trim();
async function buildPornstarThumbnailIndex() {
    if (pornstarThumbIndexBuilding || (!existsSync(PORNSTAR_CSV_FILE) && !existsSync(PORNSTAR_ZIP_FILE))) return;
    pornstarThumbIndexBuilding = true;
    let extractedTemporarily = false;
    try {
        let csvFile = PORNSTAR_CSV_FILE;
        if (!existsSync(csvFile)) {
            const fsPromises = await import('fs/promises');
            await fsPromises.rm(PORNSTAR_ZIP_TEMP_DIR, { recursive: true, force: true });
            await fsPromises.mkdir(PORNSTAR_ZIP_TEMP_DIR, { recursive: true });
            await execFileAsync('powershell.exe', [
                '-NoProfile', '-NonInteractive', '-Command',
                `Expand-Archive -LiteralPath '${PORNSTAR_ZIP_FILE.replace(/'/g, "''")}' -DestinationPath '${PORNSTAR_ZIP_TEMP_DIR.replace(/'/g, "''")}' -Force`,
            ], { windowsHide: true, maxBuffer: 1024 * 1024 });
            const csvEntries = [];
            async function findCsv(directory) {
                for (const entry of await fsPromises.readdir(directory, { withFileTypes: true })) {
                    const fullPath = join(directory, entry.name);
                    if (entry.isDirectory()) await findCsv(fullPath);
                    else if (entry.name.toLowerCase().endsWith('.csv')) csvEntries.push(fullPath);
                }
            }
            await findCsv(PORNSTAR_ZIP_TEMP_DIR);
            if (!csvEntries.length) throw new Error('CSV tidak ditemukan di dalam ZIP.');
            csvFile = csvEntries[0];
            extractedTemporarily = true;
        }
        const next = { ...pornstarThumbIndex };
        const input = createInterface({ input: createReadStream(csvFile, { encoding: 'utf8' }), crlfDelay: Infinity });
        let rows = 0;
        for await (const line of input) {
            const fields = line.split('|');
            const thumbnail = String(fields[1] || '').trim();
            if (!thumbnail) continue;
            for (const model of String(fields[6] || '').split(';')) {
                const key = normalizePornstarName(model);
                if (key && !next[key]) next[key] = thumbnail;
            }
            rows += 1;
            if (rows % 100000 === 0) {
                pornstarThumbIndex = next;
                const fsPromises = await import('fs/promises');
                await fsPromises.writeFile(PORNSTAR_THUMB_INDEX_FILE, JSON.stringify(next), 'utf8');
            }
        }
        pornstarThumbIndex = next;
        const fsPromises = await import('fs/promises');
        await fsPromises.writeFile(PORNSTAR_THUMB_INDEX_FILE, JSON.stringify(next), 'utf8');
        console.log(`[Pornstar thumbnails] Index selesai: ${Object.keys(next).length} model.`);
    } catch (error) {
        console.error('[Pornstar thumbnails] Gagal membuat index:', error.message);
    } finally {
        if (extractedTemporarily) {
            try { await (await import('fs/promises')).rm(PORNSTAR_ZIP_TEMP_DIR, { recursive: true, force: true }); } catch (error) { console.error('[Pornstar thumbnails] Gagal membersihkan folder sementara:', error.message); }
        }
        pornstarThumbIndexBuilding = false;
    }
}
function applyPornstarThumbnailFallback(stars) {
    return stars.map((star) => ({
        ...star,
        photo: star.photo && !star.photo.endsWith('/placeholder.svg')
            ? star.photo
            : (pornstarThumbIndex[normalizePornstarName(star.name)] || '/images/placeholder.svg'),
    }));
}

async function loadPornstarListWithRetry(options, attempts = 3) {
    const cacheKey = JSON.stringify(options);
    const cached = pornstarListCache.get(cacheKey);
    if (cached && cached.expiresAt > Date.now()) return cached.value;
    let lastError;
    for (let attempt = 1; attempt <= attempts; attempt += 1) {
        try {
            const result = await ph.pornstarList(options);
            // An empty parser result is also retried: it commonly means the
            // upstream returned a transient challenge/interstitial page.
            if (Array.isArray(result?.data) && result.data.length) {
                pornstarListCache.set(cacheKey, { value: result, expiresAt: Date.now() + PORNSTAR_CACHE_TTL });
                return result;
            }
            if (attempt === attempts) {
                pornstarListCache.set(cacheKey, { value: result, expiresAt: Date.now() + 60 * 1000 });
                return result;
            }
        } catch (error) {
            lastError = error;
            if (attempt === attempts) throw error;
        }
        await wait(700 * attempt);
    }
    throw lastError || new Error('Pornstar list unavailable');
}
async function getEpornerRecommendations(excludeId) {
    const result = await epornerSearch({ query: 'all', page: 1, perPage: 24, thumbsize: 'big', order: 'most-popular' });
    return (Array.isArray(result?.videos) ? result.videos : [])
        .map(normalizeEpornerVideo).filter((item) => item && item.id !== excludeId)
        .sort(() => Math.random() - 0.5).slice(0, 16);
}

async function hydrateGenericVideoTitles(videos) {
    if (!allowPornhubDetailScrape) return videos;
    const isGenericTitle = (title) => {
        const value = String(title || '').trim();
        return /on popular demand|^popular video\b|^ep\s+[a-z0-9_-]{6,}$/i.test(value);
    };
    const generic = videos.filter((item) => item?.id && isGenericTitle(item.title)).slice(0, 24);
    const results = await Promise.allSettled(generic.map((item) => ph.video(item.id)));
    results.forEach((result, index) => {
        if (result.status === 'fulfilled' && result.value?.title) {
            generic[index].title = result.value.title;
            generic[index].preview = generic[index].preview || result.value.preview || result.value.thumb || '';
        }
        if (isGenericTitle(generic[index].title)) {
            const sourceUrl = String(generic[index].url || '');
            const slug = sourceUrl.split('/').filter(Boolean).pop() || '';
            const readable = decodeURIComponent(slug)
                .replace(/[-_]+/g, ' ')
                .replace(/\b\w/g, (letter) => letter.toUpperCase())
                .trim();
            generic[index].title = readable && !/^[a-z0-9_-]{4,80}$/i.test(readable)
                ? readable
                : 'Video populer';
        }
    });
    return videos;
}

// Eporner search results can occasionally return the catalogue placeholder
// "On Popular Demand". Fetch the detail record so cards use the source title.
async function hydrateEpornerTitles(videos) {
    const generic = videos.filter((item) => item?.source === 'eporner' && item?.id && /on popular demand|^popular video$/i.test(String(item.title || '').trim()));
    const results = await Promise.allSettled(generic.map((item) => epornerSearch({ id: epornerRawId(item.id) })));
    results.forEach((result, index) => {
        const title = result.status === 'fulfilled' ? result.value?.videos?.[0]?.title : '';
        if (typeof title === 'string' && title.trim() && !/on popular demand|^popular video$/i.test(title.trim())) generic[index].title = title.trim();
        if (/on popular demand|^popular video$/i.test(String(generic[index].title || ''))) {
            generic[index].title = `Eporner video ${epornerRawId(generic[index].id)}`;
        }
    });
    // Resolve a small visible batch during SSR; remaining cards keep their API
    // title and can be corrected when opened on the watch page.
    const stillGeneric = generic.filter((item) => /on popular demand|^popular video$|^eporner video /i.test(String(item.title || ''))).slice(0, 8);
    const pageTitles = await Promise.allSettled(stillGeneric.map((item) => epornerPageTitle(item.id)));
    pageTitles.forEach((result, index) => {
        const title = result.status === 'fulfilled' ? result.value : '';
        if (title && !/on popular demand|^popular video$|^eporner video /i.test(title)) stillGeneric[index].title = title;
    });
    return videos;
}

app.disable('x-powered-by');
app.set('trust proxy', 1);
app.set('view engine', 'ejs');
app.set('views', join(__dirname, 'views'));

app.use(cookieParser());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
// Compress server-rendered HTML and JSON before sending it to mobile users.
// This is intentionally middleware-only so no extra dependency is needed.
app.use((req, res, next) => {
    if (req.method === 'HEAD' || req.headers['x-no-compression']) return next();
    const originalWrite = res.write.bind(res);
    const originalEnd = res.end.bind(res);
    let chunks = [];
    let finished = false;
    const flush = () => {
        if (finished) return;
        finished = true;
        const body = Buffer.concat(chunks);
        chunks = [];
        const type = String(res.getHeader('content-type') || '');
        const accepts = String(req.headers['accept-encoding'] || '');
        if (body.length < 1024 || !/(text\/|application\/json|application\/javascript)/i.test(type)) return originalEnd(body);
        const compressor = accepts.includes('br')
            ? createBrotliCompress({ params: { [zlibConstants.BROTLI_PARAM_QUALITY]: 4 } })
            : accepts.includes('gzip') ? createGzip({ level: 6 }) : null;
        if (!compressor) return originalEnd(body);
        const output = [];
        compressor.on('data', (chunk) => output.push(chunk));
        compressor.on('end', () => { res.removeHeader('Content-Length'); res.setHeader('Content-Encoding', accepts.includes('br') ? 'br' : 'gzip'); res.setHeader('Vary', 'Accept-Encoding'); originalEnd(Buffer.concat(output)); });
        compressor.end(body);
    };
    res.write = (chunk, encoding) => { chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, encoding)); return true; };
    res.end = (chunk, encoding) => { if (chunk) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, encoding)); flush(); return res; };
    next();
});
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
app.use(express.static(join(__dirname, 'public'), {
    maxAge: isProduction ? '1y' : 0,
    immutable: isProduction,
}));

// Proxy terkontrol ke Eporner API v2. Parameter dibatasi agar endpoint tidak
// dapat dipakai untuk meneruskan URL arbitrer atau membebani upstream.
app.get('/api/eporner/search', async (req, res) => {
    try {
        const data = await epornerSearch({
            query: req.query.query,
            id: req.query.id,
            page: req.query.page,
            perPage: req.query.per_page,
            thumbsize: req.query.thumbsize,
            order: req.query.order,
        });
        res.set('Cache-Control', 'public, max-age=60');
        res.json(data);
    } catch (error) {
        const message = error instanceof Error ? error.message : 'Gagal mengakses Eporner API.';
        const status = message.includes('membutuhkan parameter') ? 400 : 502;
        res.status(status).json({ error: message });
    }
});

app.use((req, res, next) => {
    const savedLanguage = SUPPORTED_LANGUAGES.includes(req.cookies.lang) ? req.cookies.lang : null;
    const detectedLanguage = req.acceptsLanguages(...SUPPORTED_LANGUAGES) || 'en';
    const lang = savedLanguage || detectedLanguage;
    res.locals.lang = lang;
    res.locals.langPreference = savedLanguage || 'auto';
    res.locals.localized = localized;
    res.locals.site = {
        name: SITE_NAME, url: getSiteUrl(req),
        googleSiteVerification: process.env.GOOGLE_SITE_VERIFICATION || '',
    };
    // Adsterra occasionally rotates its delivery domains. Keep the host
    // configurable so a provider-issued code can be adopted without editing
    // every view partial again.
    res.locals.adScriptHost = String(process.env.ADSTERRA_SCRIPT_HOST || 'www.highperformanceformat.com')
        .trim()
        .replace(/^https?:\/\//i, '')
        .replace(/\/+$/, '');
    res.locals.categories = INDEXABLE_CATEGORIES;
    res.locals.countries = COUNTRY_FILTERS;
    res.locals.currentPath = req.path;
    const requestedSource = String(req.query.source || '');
    const isRandomRoute = req.path === '/random' && !['pornhub', 'eporner'].includes(requestedSource);
    res.locals.sourceFilter = isRandomRoute
        ? 'random'
        : (['pornhub', 'eporner'].includes(requestedSource) ? requestedSource : 'all');
    res.locals.isRandomListing = isRandomRoute;
    res.locals.sourceFilterBase = req.path === '/' && req.query.q
        ? `/?q=${encodeURIComponent(String(req.query.q))}&source=` : '?source=';
    const pathSlug = String(req.path).split('/')[2] || '';
    const activeCategory = categoriesBySlug.get(pathSlug.toLowerCase());
    const activeCountry = countriesBySlug.get(pathSlug.toLowerCase());
    res.locals.activeMenuQuery = activeCategory?.query || activeCountry?.query || normalizeQuery(req.query.q).toLowerCase();
    res.locals.searchQuery = normalizeQuery(req.query.q);
    res.locals.adsEnabled = req.path === '/'
        || ['/recommended', '/models'].includes(req.path)
        || req.path.startsWith('/category/')
        || req.path.startsWith('/country/')
        || req.path.startsWith('/watch/');
    res.locals.isActive = (pathname) => req.path === pathname;
    res.locals.safeJson = safeJson;
    res.locals.videoPath = videoPath;
    const translationCatalog = {
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
    };

    translationCatalog.ms = {
        ...translationCatalog.id,
        placeholder: 'Cari video kegemaran anda...', searchLabel: 'Cari video', searchBtn: 'Cari',
        all: 'Semua', featured: 'Video Pilihan', recommendations: 'Cadangan', countries: 'Negara',
        account: 'Akaun', hello: 'Helo', login: 'Log masuk', register: 'Daftar', logout: 'Log keluar',
        language: 'Bahasa', automatic: 'Automatik', theme: 'Tema', light: 'Cerah', dark: 'Gelap',
        skip: 'Langkau ke kandungan', explore: 'Terokai', popular: 'Popular', discover: 'Cari kegemaran anda',
        exploreMenu: 'Terokai Menu', menuHint: 'Ketik untuk buka/tutup', popularModels: 'Model Popular',
        collection: 'Koleksi pilihan 18+', available: 'video tersedia', watchNow: 'Tonton sekarang',
        noVideos: 'Tiada video lagi', tryAnother: 'Cuba kategori lain atau gunakan kotak carian di atas.',
        previous: 'Sebelumnya', next: 'Seterusnya', back: 'Kembali ke koleksi', watching: 'Sedang ditonton',
        aboutVideo: 'Tentang video ini', relatedTags: 'Tag berkaitan', footerTagline: 'Terokai kandungan kegemaran anda dengan selesa.',
    };
    translationCatalog.es = {
        ...translationCatalog.en,
        placeholder: 'Encuentra tu vídeo favorito...', searchLabel: 'Buscar vídeos', searchBtn: 'Buscar',
        all: 'Todo', featured: 'Vídeos destacados', recommendations: 'Recomendados', countries: 'Países',
        account: 'Cuenta', login: 'Iniciar sesión', register: 'Registrarse', logout: 'Cerrar sesión',
        language: 'Idioma', automatic: 'Automático', theme: 'Tema', light: 'Claro', dark: 'Oscuro',
        skip: 'Ir al contenido', explore: 'Explorar', popular: 'Popular', discover: 'Encuentra tus favoritos',
        exploreMenu: 'Explorar menú', menuHint: 'Toca para abrir/cerrar', popularModels: 'Modelos populares',
        collection: 'Colección seleccionada para adultos', available: 'vídeos disponibles', watchNow: 'Ver ahora',
        noVideos: 'Aún no hay vídeos', tryAnother: 'Prueba otra categoría o usa el buscador.',
        previous: 'Anterior', next: 'Siguiente', back: 'Volver a la colección', watching: 'Viendo ahora',
        aboutVideo: 'Sobre este vídeo', relatedTags: 'Etiquetas relacionadas', footerTagline: 'Explora tu contenido favorito cómodamente.',
    };
    translationCatalog.ja = {
        ...translationCatalog.en,
        placeholder: 'お気に入りの動画を検索...', searchLabel: '動画を検索', searchBtn: '検索',
        all: 'すべて', featured: '注目の動画', recommendations: 'おすすめ', countries: '国',
        account: 'アカウント', login: 'ログイン', register: '登録', logout: 'ログアウト',
        language: '言語', automatic: '自動', theme: 'テーマ', light: 'ライト', dark: 'ダーク',
        skip: 'コンテンツへ移動', explore: '見る', popular: '人気', discover: 'お気に入りを探す',
        exploreMenu: 'メニュー', menuHint: 'タップして開閉', popularModels: '人気モデル',
        collection: '厳選アダルトコレクション', available: '本の動画', watchNow: '今すぐ見る',
        noVideos: '動画がありません', tryAnother: '別のカテゴリーまたは検索をお試しください。',
        previous: '前へ', next: '次へ', back: 'コレクションに戻る', watching: '再生中',
        aboutVideo: 'この動画について', relatedTags: '関連タグ', footerTagline: 'お気に入りのコンテンツを快適に楽しめます。',
    };
    res.locals.t = translationCatalog[lang] || translationCatalog.en;
    res.locals.sidebarText = {
        introTitle: localized(lang, { id: 'Perpustakaan premium', en: 'Premium library', ms: 'Perpustakaan premium', es: 'Biblioteca premium', ja: 'プレミアムライブラリ' }),
        introBody: localized(lang, { id: 'Kategori pilihan, penjelajahan cepat, dan cara mudah menemukan konten yang Anda inginkan.', en: 'Curated categories, instant browsing, and a cleaner way to jump straight into what you want.', ms: 'Kategori pilihan, carian pantas, dan cara mudah mencari kandungan yang anda mahu.', es: 'Categorías seleccionadas, navegación rápida y una forma sencilla de encontrar lo que buscas.', ja: '厳選されたカテゴリーから、目的のコンテンツをすぐに見つけられます。' }),
        collapse: localized(lang, { id: 'Tutup semua', en: 'Collapse all', ms: 'Tutup semua', es: 'Contraer todo', ja: 'すべて閉じる' }),
        recommendations: localized(lang, { id: 'REKOMENDASI', en: 'RECOMMENDATIONS', ms: 'CADANGAN', es: 'RECOMENDACIONES', ja: 'おすすめ' }), popular: localized(lang, { id: 'POPULER', en: 'POPULAR', ms: 'POPULAR', es: 'POPULAR', ja: '人気' }), country: localized(lang, { id: 'NEGARA', en: 'COUNTRY', ms: 'NEGARA', es: 'PAÍS', ja: '国' }), category: localized(lang, { id: 'KATEGORI', en: 'CATEGORY', ms: 'KATEGORI', es: 'CATEGORÍA', ja: 'カテゴリー' }),
    };

    res.locals.seo = buildSeo(req, {});
    if (req.path === '/set-lang') {
        res.set('X-Robots-Tag', 'noindex, nofollow');
    }
    next();
});

async function renderVideoListing(req, res, { query, heading, description, canonicalBase, indexFirstPage }) {
    const page = parsePage(req.query.page);
    const pageSize = 24;
    // Eporner's search endpoint may return an empty set for the synthetic
    // homepage query "popular". The source-only filter needs a real catalog
    // query so /?source=eporner is useful without requiring q.
    const upstreamQuery = req.query.source === 'eporner' && !normalizeQuery(req.query.q) ? 'all' : query;
    // Build pagination URLs from the listing's canonical query every time.
    // This keeps q/source intact on mobile too, where the next/previous links
    // are commonly the only way users navigate after a search.
    const buildListingPath = (targetPage) => {
        const url = new URL(canonicalBase, 'https://pornerweb.local');
        if (targetPage > 1) url.searchParams.set('page', String(targetPage));
        else url.searchParams.delete('page');
        const source = String(req.query.source || '');
        if (['pornhub', 'eporner'].includes(source)) url.searchParams.set('source', source);
        else url.searchParams.delete('source');
        return `${url.pathname}${url.search}`;
    };
    const canonicalPath = buildListingPath(page);
    const paginationPath = (target) => buildListingPath(target);

    try {
        // Build the unified listing from all source pages up to the requested
        // page. Some upstream/proxy combinations ignore `page` and return
        // page 1 repeatedly; collecting the range and slicing by the unified
        // offset makes page navigation deterministic in that case as well.
        const sourcePages = Array.from({ length: page }, (_, index) => index + 1);
        // A single failed upstream page must not turn the entire listing into
        // a 502. Keep successful sources and let the other source fill gaps.
        const pornHubResults = req.query.source === 'eporner'
            ? []
            : await Promise.allSettled(sourcePages.map((sourcePage) => ph.searchVideo(query, { page: sourcePage })));
        const results = pornHubResults
            .filter((item) => item.status === 'fulfilled')
            .map((item) => item.value);
        const result = [...results].pop();
        let reportedPages = Math.max(0, ...results.map((item) => Number(item?.paging?.maxPage) || 0));
        let allVideos = results.flatMap((item) => (item?.data || []).map((video) => ({ ...video, source: 'pornhub' })));
        let usedSourceFallback = false;
        if (req.query.source !== 'pornhub') {
            try {
                const epornerResults = await Promise.allSettled(sourcePages.map((sourcePage) => epornerSearch({ query: upstreamQuery || 'all', page: sourcePage, perPage: 24, thumbsize: 'big', order: 'latest' })));
                reportedPages = Math.max(reportedPages, ...epornerResults
                    .filter((item) => item.status === 'fulfilled')
                    .map((item) => Number(item.value?.total_pages || item.value?.totalPages || item.value?.pages) || 0));
                allVideos.push(...epornerResults
                    .filter((item) => item.status === 'fulfilled')
                    .flatMap((item) => (Array.isArray(item.value?.videos) ? item.value.videos : []).map(normalizeEpornerVideo).filter(Boolean)));
            } catch (error) {
                if (!isExpectedNetworkFailure(error)) console.error('[Eporner] Gagal memuat video tambahan:', error.message);
            }
        }
        // Pornhub dapat mengembalikan halaman anti-bot dengan HTTP 200 tetapi
        // tanpa data. Jika hasil utama kosong, ambil sumber lainnya.
        if (!allVideos.length && req.query.source === 'pornhub') {
            try {
                const fallbackResults = await Promise.allSettled(sourcePages.map((sourcePage) => epornerSearch({ query: upstreamQuery || 'all', page: sourcePage, perPage: 24, thumbsize: 'big', order: 'latest' })));
                allVideos = fallbackResults
                    .filter((item) => item.status === 'fulfilled')
                    .flatMap((item) => (Array.isArray(item.value?.videos) ? item.value.videos : []).map(normalizeEpornerVideo).filter(Boolean));
                usedSourceFallback = allVideos.length > 0;
            } catch (error) {
                if (!isExpectedNetworkFailure(error)) console.error('[Fallback] Eporner gagal:', error.message);
            }
        }
        // Jika filter Eporner dipilih tetapi Eporner sedang gagal, gunakan
        // Pornhub agar halaman tetap berisi konten.
        if (!allVideos.length && req.query.source === 'eporner') {
            const fallbackResults = await Promise.allSettled(sourcePages.map((sourcePage) => ph.searchVideo(query, { page: sourcePage })));
            allVideos = fallbackResults
                .filter((item) => item.status === 'fulfilled')
                .flatMap((item) => (item.value?.data || []).map((video) => ({ ...video, source: 'pornhub' })));
            usedSourceFallback = allVideos.length > 0;
        }
        if (req.query.source === 'eporner' && !usedSourceFallback) allVideos = allVideos.filter((item) => item.source === 'eporner');
        const uniqueVideos = [...new Map(allVideos.map((item) => [`${item.source}:${item.id}`, item])).values()];
        await hydrateEpornerTitles(uniqueVideos.slice(0, pageSize));
        await hydrateGenericVideoTitles(uniqueVideos.slice(0, pageSize));
        const pageStart = (page - 1) * pageSize;
        const videos = uniqueVideos.slice(pageStart, pageStart + pageSize);
        if (!videos.length && page > 1) {
            // Do not render a blank page when an upstream reports fewer pages
            // than its metadata suggests. Keep navigation usable by stepping
            // back one page.
            return res.redirect(302, paginationPath(page - 1));
        }
        const shouldIndex = indexFirstPage && page === 1;
        // If the API omits maxPage, keep a next link while this page contains
        // results. The total is based on the actual upstream page count.
        const totalPages = reportedPages > 0
            ? Math.max(page, reportedPages)
            : Math.max(page, page + (videos.length === pageSize ? 1 : 0));
        const totalVideos = reportedPages > 0
            ? reportedPages * pageSize
            : Math.max(uniqueVideos.length, totalPages * pageSize);
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
        let trendingPornstars = [];
        try {
            const starPage = Math.floor(Math.random() * 3) + 1;
            const starResult = await loadPornstarListWithRetry({ page: starPage });
            trendingPornstars = (Array.isArray(starResult?.data) ? starResult.data : [])
                .sort(() => Math.random() - 0.5).slice(0, 4);
        } catch (error) {
            if (!isExpectedUpstreamStatus(error) && !isExpectedNetworkFailure(error)) console.error('[Trending Pornstars] Gagal memuat:', error.message);
            trendingPornstars = fallbackPornstars('').slice(0, 4);
        }
        if (!trendingPornstars.length) trendingPornstars = fallbackPornstars('').slice(0, 4);
        await hydratePornstarPhotos(trendingPornstars, 4);

        // Keep the HTTP signal in sync with the meta robots tag.
        if (!shouldIndex) res.set('X-Robots-Tag', 'noindex, follow');
        return res.render('index', {
            data: videos, totalVideos, title: heading, intro: description, query, currentPage: page,
            totalPages, paginationPath, seo, trendingPornstars,
            blogPosts: typeof BLOG_POSTS !== 'undefined' ? BLOG_POSTS.map((post) => ({ slug: post.slug, title: localized(res.locals.lang, post.title), summary: localized(res.locals.lang, post.summary) })) : [],
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
    if (requestedQuery) {
        const category = categoriesByQuery.get(requestedQuery.toLowerCase());
        if (category) {
            const page = parsePage(req.query.page);
            return res.redirect(301, `/category/${category.slug}${page > 1 ? `?page=${page}` : ''}`);
        }
        return renderVideoListing(req, res, {
            query: requestedQuery,
            heading: `${localized(res.locals.lang, { id: 'Hasil pencarian', en: 'Search results', ms: 'Hasil carian', es: 'Resultados de búsqueda', ja: '検索結果' })}: ${requestedQuery}`,
            description: `${localized(res.locals.lang, { id: 'Hasil pencarian video untuk', en: 'Video search results for', ms: 'Hasil carian video untuk', es: 'Resultados de vídeo para', ja: '動画の検索結果' })} ${requestedQuery}.`,
            canonicalBase: `/?q=${encodeURIComponent(requestedQuery)}`,
            indexFirstPage: false,
        });
    }
    return renderVideoListing(req, res, {
        query: 'popular', heading: localized(res.locals.lang, { id: 'Video Dewasa Populer', en: 'Popular Adult Videos', ms: 'Video Dewasa Popular', es: 'Vídeos para Adultos Populares', ja: '人気のアダルト動画' }),
        description: localized(res.locals.lang, { id: SITE_DESCRIPTION, en: 'Discover popular adult videos with simple category navigation. Adults 18+ only.', ms: 'Terokai video dewasa popular dengan navigasi kategori yang mudah. Untuk dewasa 18+ sahaja.', es: 'Descubre vídeos para adultos populares con una navegación sencilla. Solo mayores de 18 años.', ja: 'シンプルなカテゴリーで人気のアダルト動画を楽しめます。18歳以上限定。' }),
        canonicalBase: '/', indexFirstPage: true,
    });
});

app.get('/category/:slug', async (req, res, next) => {
    const category = categoriesBySlug.get(req.params.slug.toLowerCase());
    if (!category) return next();
    return renderVideoListing(req, res, {
        query: category.query,
        heading: res.locals.lang === 'en' ? `${category.label} Videos` : `${localized(res.locals.lang, { id: 'Video', ms: 'Video', es: 'Vídeos de', ja: '' })} ${category.label}`,
        description: localized(res.locals.lang, { id: `Jelajahi koleksi video dewasa kategori ${category.label} yang diperbarui secara berkala. Khusus pengguna berusia 18 tahun ke atas.`, en: `Explore regularly updated ${category.label} adult videos. Adults 18+ only.`, ms: `Terokai video dewasa kategori ${category.label} yang dikemas kini secara berkala. Untuk dewasa 18+ sahaja.`, es: `Explora vídeos para adultos de ${category.label} actualizados regularmente. Solo mayores de 18 años.`, ja: `${category.label}のアダルト動画をお楽しみください。18歳以上限定。` }),
        canonicalBase: `/category/${category.slug}`,
        indexFirstPage: true,
    });
});

app.get('/country/:slug', async (req, res, next) => {
    const country = countriesBySlug.get(req.params.slug.toLowerCase());
    if (!country) return next();
    return renderVideoListing(req, res, {
        query: country.query,
        heading: localized(res.locals.lang, { id: `Video dari ${country.label}`, en: `Videos from ${country.label}`, ms: `Video dari ${country.label}`, es: `Vídeos de ${country.label}`, ja: `${country.label}の動画` }),
        description: localized(res.locals.lang, { id: `Jelajahi video dewasa populer dari ${country.label}. Khusus pengguna berusia 18 tahun ke atas.`, en: `Explore popular adult videos from ${country.label}. Adults 18+ only.`, ms: `Terokai video dewasa popular dari ${country.label}. Untuk dewasa 18+ sahaja.`, es: `Explora vídeos para adultos populares de ${country.label}. Solo mayores de 18 años.`, ja: `${country.label}の人気アダルト動画です。18歳以上限定。` }),
        canonicalBase: `/country/${country.slug}`,
        indexFirstPage: true,
    });
});

app.get('/recommended', (req, res) => renderVideoListing(req, res, {
    query: 'recommended',
    heading: localized(res.locals.lang, { id: 'Video Rekomendasi', en: 'Recommended Videos', ms: 'Video Cadangan', es: 'Vídeos recomendados', ja: 'おすすめ動画' }),
    description: localized(res.locals.lang, { id: 'Pilihan video dewasa yang direkomendasikan dan diperbarui secara berkala.', en: 'Recommended adult video picks, updated regularly.', ms: 'Pilihan video dewasa yang disyorkan dan dikemas kini secara berkala.', es: 'Selección de vídeos para adultos recomendados y actualizados regularmente.', ja: '定期的に更新されるおすすめアダルト動画。' }),
    canonicalBase: '/recommended',
    indexFirstPage: true,
}));

app.get('/live-sex', (req, res) => renderVideoListing(req, res, {
    query: 'live sex',
    heading: localized(res.locals.lang, { id: 'Live Sex', en: 'Live Sex', ms: 'Live Sex', es: 'Live Sex', ja: 'Live Sex' }),
    description: localized(res.locals.lang, { id: 'Temukan video live sex terbaru dari Pornhub dan Eporner.', en: 'Discover live sex videos from Pornhub and Eporner.', ms: 'Temui video live sex terbaru dari Pornhub dan Eporner.', es: 'Descubre vídeos live sex de Pornhub y Eporner.', ja: 'PornhubとEpornerのライブ動画。' }),
    canonicalBase: '/live-sex',
    indexFirstPage: true,
}));

app.get('/random', (req, res) => renderVideoListing(req, res, {
    query: 'popular',
    heading: localized(res.locals.lang, { id: 'Video Viral', en: 'Viral Videos', ms: 'Video Viral', es: 'Vídeos virales', ja: 'バイラル動画' }),
    description: localized(res.locals.lang, { id: 'Temukan konten video populer dan viral dari sumber yang tersedia.', en: 'Discover popular and viral videos from available sources.', ms: 'Temui kandungan video popular dan viral daripada sumber yang tersedia.', es: 'Descubre vídeos populares y virales de las fuentes disponibles.', ja: '人気で話題の動画を見つけます。' }),
    canonicalBase: '/random',
    indexFirstPage: false,
}));

// Infinite recommendations for watch pages. Each request uses a new source
// page and excludes the video currently being watched.
app.get('/api/watch-more/:id', async (req, res) => {
    const currentId = extractVideoId(req.params.id);
    const page = parsePage(req.query.page);
    if (!currentId) return res.status(400).json({ error: 'Invalid video id' });
    try {
        const [pornhubResult, epornerResult] = await Promise.allSettled([
            ph.searchVideo('popular', { page }),
            epornerSearch({ query: 'popular', page, perPage: 12, thumbsize: 'big', order: 'most-popular' }),
        ]);
        const videos = [];
        if (pornhubResult.status === 'fulfilled') {
            videos.push(...(pornhubResult.value?.data || []).map((item) => ({ ...item, source: 'pornhub' })));
        }
        if (epornerResult.status === 'fulfilled') {
            videos.push(...(epornerResult.value?.videos || []).map(normalizeEpornerVideo).filter(Boolean));
        }
        const unique = [...new Map(videos
            .filter((item) => item?.id && String(item.id) !== String(currentId))
            .map((item) => [`${item.source || 'pornhub'}:${item.id}`, item])).values()];
        res.set('Cache-Control', 'public, max-age=60');
        return res.json({ videos: unique.slice(0, 24), page, hasMore: unique.length > 0 });
    } catch (error) {
        console.error('[Watch more] Gagal memuat:', error.message);
        return res.json({ videos: [], page, hasMore: false });
    }
});

app.get('/api/search-suggestions', async (req, res) => {
    const query = normalizeQuery(req.query.q).slice(0, 80);
    if (query.length < 2) return res.json([]);
    try {
        const result = await ph.autoComplete(query);
        const suggestions = [
            ...(result?.models || []).map((item) => ({ label: item.name || item.title, type: 'Model' })),
            ...(result?.pornstars || []).map((item) => ({ label: item.name || item.title, type: 'Pornstar' })),
            ...(result?.channels || []).map((item) => ({ label: item.name || item.title, type: 'Channel' })),
        ].filter((item) => item.label).filter((item, index, list) => list.findIndex((other) => other.label.toLowerCase() === item.label.toLowerCase()) === index).slice(0, 8);
        res.set('Cache-Control', 'public, max-age=60');
        return res.json(suggestions);
    } catch (error) {
        if (!isExpectedNetworkFailure(error)) console.error('[Search suggestions] Gagal memuat:', error.message);
        return res.json([]);
    }
});

// Media preview is loaded on demand so listing pages do not download every
// video's source before the visitor actually hovers a card.
app.get('/api/video-preview/:id', async (req, res) => {
    const id = extractVideoId(req.params.id);
    if (!id) return res.status(400).json({ error: 'Invalid video id' });

    try {
        if (!allowPornhubDetailScrape) throw new Error('403 Forbidden at Pornhub detail endpoint');
        const detail = await ph.video(id);
        const media = Array.isArray(detail?.mediaDefinitions)
            ? detail.mediaDefinitions
                .filter((item) => ['mp4', 'webm', 'ogg'].includes(String(item.format || '').toLowerCase()) && item.videoUrl)
                // The smallest source starts showing frames much sooner on hover.
                .sort((a, b) => Number(a.quality || 0) - Number(b.quality || 0))[0]
            : null;
        if (!media) return res.status(404).json({ error: 'Preview unavailable' });
        res.set('Cache-Control', 'public, max-age=3600');
        return res.json({ url: media.videoUrl, type: `video/${String(media.format).toLowerCase()}` });
    } catch (error) {
        if (!isExpectedUpstreamStatus(error)) console.error(`[Preview] Gagal memuat ${id}:`, error.message);
        return res.status(502).json({ error: 'Preview unavailable' });
    }
});

app.get('/models', (req, res) => renderVideoListing(req, res, {
    query: 'model',
    heading: localized(res.locals.lang, { id: 'Pornstar & Model', en: 'Pornstars & Models', ms: 'Pornstar & Model', es: 'Pornstars y modelos', ja: 'ポルノスターとモデル' }),
    description: localized(res.locals.lang, { id: 'Jelajahi koleksi video pornstar dan model dewasa populer.', en: 'Explore popular adult model and pornstar videos.', ms: 'Terokai koleksi video pornstar dan model dewasa popular.', es: 'Explora vídeos populares de modelos y pornstars.', ja: '人気のポルノスターとモデルの動画を探しましょう。' }),
    canonicalBase: '/models',
    indexFirstPage: true,
}));

app.get('/pornstars', async (req, res) => {
    // Bangun di latar belakang agar request pertama tetap cepat.
    void buildPornstarThumbnailIndex();
    const page = parsePage(req.query.page);
    const gender = ['female', 'male'].includes(String(req.query.gender)) ? String(req.query.gender) : '';
    const shouldIndex = page === 1 && !gender;
    if (!shouldIndex) res.set('X-Robots-Tag', 'noindex, follow');
    try {
        const result = await loadPornstarListWithRetry({ page, ...(gender ? { gender } : {}) });
        // Keep compatibility with library/provider response variants.
        let pornstars = Array.isArray(result?.data)
            ? result.data
            : Array.isArray(result?.pornstars) ? result.pornstars : [];

        // The upstream page occasionally changes its HTML card selectors and
        // returns an empty list without throwing. Keep the page useful with a
        // safe local fallback instead of showing a blank “not found” state.
        if (!pornstars.length && page === 1) {
            pornstars = fallbackPornstars(gender);
        }
        pornstars = pornstars.map((star) => ({
            ...star,
            photo: star.photo || star.thumb_url || star.thumbUrl || star.image || '/images/placeholder.svg',
            videoNum: star.videoNum ?? star.videoCount ?? star.videos ?? 0,
            likes: star.likes ?? star.likeCount ?? star.likesCount ?? 'N/A',
        }));
        // Jika avatar profil tidak tersedia, pakai thumbnail video dari CSV.
        pornstars = applyPornstarThumbnailFallback(pornstars);
        // The list parser can lose image attributes when the provider changes
        // markup. Resolve missing avatars through the library's profile page
        // parser, which reads #getAvatar/topProfileHeader directly.
        const missingAvatars = await Promise.allSettled(pornstars
            .filter((star) => !star.photo || star.photo.endsWith('/placeholder.svg'))
            .slice(0, 24)
            .map(async (star) => ({ star, detail: await ph.pornstar(star.name) })));
        for (const item of missingAvatars) {
            if (item.status !== 'fulfilled') continue;
            const { star, detail } = item.value;
            if (detail?.avatar) star.photo = detail.avatar;
            if (!star.videoNum && detail) {
                star.videoNum = Number(detail.uploadedVideoCount || 0) + Number(detail.taggedVideoCount || 0);
            }
            if ((star.likes === 'N/A' || star.likes == null) && detail?.profileViews != null) star.likes = detail.profileViews;
        }
        const reportedPages = Number(result?.paging?.maxPage);
        const totalPages = Number.isInteger(reportedPages) && reportedPages > 0
            ? Math.max(10, page, reportedPages) : Math.max(10, page + (pornstars.length ? 1 : 0));
        const paginationPath = (target) => {
            const params = new URLSearchParams();
            if (gender) params.set('gender', gender);
            if (target > 1) params.set('page', target);
            const query = params.toString();
            return `/pornstars${query ? `?${query}` : ''}`;
        };
        return res.render('pornstars', {
            pornstars,
            gender,
            currentPage: page,
            totalPages,
            paginationPath,
            seo: buildSeo(req, {
                title: localized(res.locals.lang, { id: 'Pornstar Populer', en: 'Popular Pornstars', ms: 'Pornstar Popular', es: 'Pornstars populares', ja: '人気のポルノスター' }),
                description: localized(res.locals.lang, { id: 'Jelajahi profil pornstar populer dan video mereka.', en: 'Browse popular pornstar profiles and their videos.', ms: 'Terokai profil pornstar popular dan video mereka.', es: 'Explora perfiles de pornstars populares y sus vídeos.', ja: '人気のポルノスターのプロフィールと動画をご覧ください。' }),
                pathname: paginationPath(page),
                explicit: true,
                robots: shouldIndex ? undefined : 'noindex, follow',
            }),
        });
    } catch (error) {
        if (!isExpectedUpstreamStatus(error)) console.error('[Pornstars] Gagal memuat daftar:', error.message);
        // Provider outages must not turn this navigational page into a 502.
        // Render a usable fallback and preserve gender/page navigation.
        const fallback = fallbackPornstars(gender);
        const indexedFallback = applyPornstarThumbnailFallback(fallback);
        const profileResults = await Promise.allSettled(indexedFallback.map((star) => ph.pornstar(star.name)));
        profileResults.forEach((item, index) => {
            if (item.status !== 'fulfilled' || !item.value) return;
            const detail = item.value;
            indexedFallback[index].photo = detail.avatar || indexedFallback[index].photo;
            indexedFallback[index].videoNum = Number(detail.uploadedVideoCount || 0) + Number(detail.taggedVideoCount || 0);
            fallback[index].likes = detail.profileViews ?? 'N/A';
        });
        const paginationPath = (target) => `/pornstars?${new URLSearchParams({ ...(gender ? { gender } : {}), ...(target > 1 ? { page: String(target) } : {}) })}`;
        return res.status(200).render('pornstars', {
            pornstars: indexedFallback, gender, currentPage: page, totalPages: 10, paginationPath,
            seo: buildSeo(req, { title: 'Pornstar Populer', description: 'Jelajahi profil pornstar populer dan video mereka.', pathname: paginationPath(page), explicit: true, robots: shouldIndex ? undefined : 'noindex, follow' }),
        });
    }
});

app.get('/watch', (req, res) => {
    const id = extractVideoId(req.query.url || req.query.id);
    return id ? res.redirect(301, `/watch/${encodeURIComponent(id)}`) : res.redirect(301, '/');
});

app.get('/watch/:id', async (req, res, next) => {
    const id = extractVideoId(req.params.id);
    if (!id) return next();
    
    try {
        if (isEpornerId(id)) {
            const result = await epornerSearch({ id: epornerRawId(id), perPage: 1, thumbsize: 'big' });
            const videoData = normalizeEpornerVideo(result?.videos?.[0]);
            if (!videoData) return next();
            if (/on popular demand|^popular video$|^eporner video /i.test(videoData.title)) {
                const title = await epornerPageTitle(id);
                if (title && !/on popular demand|^popular video$|^eporner video /i.test(title)) videoData.title = title;
            }
            const description = `${localized(res.locals.lang, { id: 'Tonton', en: 'Watch', ms: 'Tonton', es: 'Mira', ja: 'Watch' })} ${videoData.title}. Adults 18+ only.`;
            let recommendations = [];
            try { recommendations = await getEpornerRecommendations(id); } catch (error) { if (!isExpectedNetworkFailure(error)) console.error('[Eporner] Rekomendasi gagal:', error.message); }
            return res.render('watch', { video: { ...videoData, description, mediaDefinitions: [] }, recommendations, localUrl: `/watch/${id}`, seo: buildSeo(req, { title: videoData.title, description, pathname: `/watch/${id}`, image: videoData.preview, explicit: true, video: videoData.embed }) });
        }
        if (!allowPornhubDetailScrape) {
            const embedUrl = `https://www.pornhub.com/embed/${encodeURIComponent(id)}`;
            const description = `${localized(res.locals.lang, { id: 'Tonton video dari sumber resmi.', en: 'Watch this video from the official source.', ms: 'Tonton video daripada sumber rasmi.', es: 'Mira este vídeo desde la fuente oficial.', ja: '公式ソースから動画をご覧ください。' })} ${localized(res.locals.lang, { id: 'Khusus dewasa 18+.', en: 'Adults 18+ only.', ms: 'Untuk dewasa 18+ sahaja.', es: 'Solo para mayores de 18 años.', ja: '18歳以上限定。' })}`;
            const oembed = await getPornhubOembed(id);
            const pageTitle = !oembed?.title ? await getPornhubPageTitle(id) : '';
            const title = oembed?.title || pageTitle || `Pornhub video ${id}`;
            const preview = oembed?.thumbnailUrl || '';
            let recommendations = [];
            try { recommendations = await getEpornerRecommendations(id); } catch (error) { if (!isExpectedNetworkFailure(error)) console.error('[Recommendations] Eporner fallback gagal:', error.message); }
            return res.status(200).render('watch', {
                video: { id, source: 'pornhub', title, preview, embed: embedUrl, description, mediaDefinitions: [] },
                recommendations,
                localUrl: `/watch/${id}`,
                seo: buildSeo(req, { title, description, pathname: `/watch/${encodeURIComponent(id)}`, explicit: true, robots: 'noindex, nofollow', image: preview || undefined, video: embedUrl }),
            });
        }
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

                    if (pool.length >= 16) break;
                }

                if (pool.length >= 16) break;
            }

            recommendations = [...pool].sort(() => Math.random() - 0.5).slice(0, 16);
            if (recommendations.length < 16) {
                try { recommendations.push(...(await getEpornerRecommendations(id)).slice(0, 16 - recommendations.length)); } catch (error) { if (!isExpectedNetworkFailure(error)) console.error('[Eporner] Rekomendasi tambahan gagal:', error.message); }
            }
        } catch (error) {
            if (!isExpectedUpstreamStatus(error)) console.error(`Gagal mengambil rekomendasi untuk ${id}:`, error.message);
            try { recommendations = await getEpornerRecommendations(id); } catch (fallbackError) {
                if (!isExpectedUpstreamStatus(fallbackError)) console.error('[Recommendations] Semua sumber gagal:', fallbackError.message);
            }
        }
        recommendations = [...new Map(recommendations
            .filter((item) => item?.id)
            .map((item) => [`${item.source || 'pornhub'}:${item.id}`, item])).values()]
            .slice(0, 16);

        const thumbnail = videoData.preview || videoData.thumb || undefined;
        const tags = Array.isArray(videoData.tags) ? videoData.tags.filter(Boolean).slice(0, 8) : [];
        const description = `${localized(res.locals.lang, { id: 'Tonton', en: 'Watch', ms: 'Tonton', es: 'Mira', ja: '視聴' })} ${videoData.title}.${tags.length ? ` ${localized(res.locals.lang, { id: 'Tag', en: 'Tags', ms: 'Tag', es: 'Etiquetas', ja: 'タグ' })}: ${tags.join(', ')}.` : ''} ${localized(res.locals.lang, { id: 'Konten khusus dewasa 18+.', en: 'Adults 18+ only.', ms: 'Kandungan untuk dewasa 18+ sahaja.', es: 'Solo para mayores de 18 años.', ja: '18歳以上限定。' })}`;
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
        // Hostinger sering gagal menjangkau halaman detail Eporner dari
        // datacenter. Ini bukan error aplikasi dan tidak perlu memenuhi log.
        if (!isExpectedUpstreamStatus(error) && !isExpectedNetworkFailure(error)) {
            console.error(`Gagal memuat video ${id}:`, error.message);
        }
        // Pornhub dapat memblokir IP datacenter Hostinger dengan 403. Tetap
        // tampilkan player embed resmi agar halaman tidak berubah menjadi 502.
        if (!isEpornerId(id) && /403\s+Forbidden/i.test(String(error?.message || ''))) {
            const fallbackTitle = `Pornhub video ${id}`;
            const fallbackEmbed = `https://www.pornhub.com/embed/${encodeURIComponent(id)}`;
            const fallbackDescription = `${localized(res.locals.lang, { id: 'Tonton video dari sumber resmi.', en: 'Watch this video from the official source.', ms: 'Tonton video daripada sumber rasmi.', es: 'Mira este vídeo desde la fuente oficial.', ja: '公式ソースから動画をご覧ください。' })} ${localized(res.locals.lang, { id: 'Khusus dewasa 18+.', en: 'Adults 18+ only.', ms: 'Untuk dewasa 18+ sahaja.', es: 'Solo para mayores de 18 años.', ja: '18歳以上限定。' })}`;
            let recommendations = [];
            try { recommendations = await getEpornerRecommendations(id); } catch (recError) { if (!isExpectedNetworkFailure(recError)) console.error('[Recommendations] Eporner fallback gagal:', recError.message); }
            return res.status(200).render('watch', {
                video: { id, title: fallbackTitle, preview: '', embed: fallbackEmbed, description: fallbackDescription, mediaDefinitions: [] },
                recommendations,
                localUrl: `/watch/${id}`,
                seo: buildSeo(req, { title: fallbackTitle, description: fallbackDescription, pathname: `/watch/${encodeURIComponent(id)}`, explicit: true, robots: 'noindex, nofollow', video: fallbackEmbed }),
            });
        }
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
        const lang = SUPPORTED_LANGUAGES.includes(requestedLanguage) ? requestedLanguage : 'en';
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

app.get('/pornstar', (req, res) => res.redirect(301, '/pornstars'));

const contentPages = {
    '/terms': ['terms', 'Ketentuan Layanan', `Ketentuan penggunaan layanan ${SITE_NAME}.`],
    '/privacy': ['privacy', 'Kebijakan Privasi', `Pelajari cara ${SITE_NAME} mengelola dan melindungi data pengguna.`],
    '/contact': ['contact', 'Hubungi Kami', `Hubungi tim dukungan ${SITE_NAME}.`],
};

const BLOG_POSTS = Object.freeze([
    {
        slug: 'cara-menemukan-video-yang-sesuai',
        title: {
            id: 'Cara menemukan video yang sesuai',
            en: 'How to find videos that match your taste',
            ms: 'Cara mencari video yang sesuai',
            es: 'Cómo encontrar vídeos que se adapten a tus gustos',
            ja: '好みに合う動画の見つけ方',
        },
        summary: {
            id: 'Gunakan kata kunci, kategori, negara, dan filter sumber untuk mempersempit hasil. Temukan video lebih cepat dengan pengalaman browsing yang rapi.',
            en: 'Use keywords, categories, countries, and source filters to narrow results and discover videos faster in a clean browsing experience.',
            ms: 'Gunakan kata kunci, kategori, negara dan penapis sumber untuk memperincikan hasil carian dengan lebih cepat.',
            es: 'Usa palabras clave, categorías, países y filtros de fuente para afinar resultados y descubrir vídeos más rápido.',
            ja: 'キーワード、カテゴリー、国、ソースフィルターを使って絞り込み、効率よく動画を見つけましょう。',
        },
        body: {
            id: [
                { h: 'Ringkasnya: cari dengan niat, filter dengan cerdas', p: 'Di PORNERWEB, pencarian yang bagus dimulai dari kata kunci yang tepat, lalu dipersempit dengan kategori, negara, dan sumber video. Dengan pendekatan ini, Anda tidak “tersesat” di lautan hasil pencarian—Anda langsung menuju konten yang sesuai preferensi.' },
                { h: 'Gunakan kata kunci yang spesifik', p: 'Alih-alih mencari kata yang terlalu umum, gunakan kombinasi kata kunci yang menggambarkan minat Anda. Misalnya: “asian amateur”, “japanese milf”, atau “cosplay compilation”. Kata kunci spesifik cenderung menghasilkan daftar yang lebih relevan dan mengurangi hasil yang tidak sesuai.' },
                { h: 'Manfaatkan kategori dan negara', p: 'Kategori dan negara membantu mengelompokkan konten yang serupa. Jika Anda menyukai gaya tertentu, mulai dari kategori, lalu kembangkan pencarian dengan kata kunci tambahan. Untuk konten regional, filter negara mengurangi noise dan membuat hasil lebih konsisten.' },
                { h: 'Pilih sumber video: Pornhub, Eporner, atau gabungan', p: 'PORNERWEB menggabungkan beberapa sumber. Jika Anda ingin hasil lebih “stabil” atau ingin membandingkan variasi konten, gunakan filter sumber. Ini juga membantu saat salah satu sumber sedang lambat atau hasilnya kurang beragam.' },
                { h: 'Gunakan fitur: Watch Later, Continue Watching, dan Random Video', p: 'Untuk pengalaman yang lebih cepat: simpan video menarik ke Watch Later, lanjutkan video terakhir melalui Continue Watching, atau gunakan Random Video saat ingin eksplorasi tanpa memasukkan kata kunci. Kombinasi fitur ini membuat Anda bisa berpindah konten tanpa harus mengulang pencarian dari awal.' },
                { h: 'Catatan SEO & tanggung jawab', p: 'PORNERWEB ditujukan untuk pengguna berusia 18+. Gunakan website secara bertanggung jawab dan patuhi hukum di wilayah Anda. Jika Anda ingin pengalaman yang lebih aman, gunakan kontrol orang tua dan pembatasan akses pada perangkat.' },
            ],
            en: [
                { h: 'In short: search with intent, filter smartly', p: 'On PORNERWEB, great discovery starts with the right keywords and becomes powerful when you narrow results by category, country, and source. This approach keeps browsing focused and helps you reach content that matches your preferences faster.' },
                { h: 'Use specific keywords', p: 'Avoid overly broad searches. Combine keywords that describe what you want, such as “asian amateur”, “japanese milf”, or “cosplay compilation”. Specific queries generally produce more relevant results and reduce clutter.' },
                { h: 'Use categories and countries', p: 'Categories and countries help you group similar content. Start from a category when your taste is clear, then refine with additional keywords. If you prefer regional content, filtering by country removes noise and makes results more consistent.' },
                { h: 'Choose your source: Pornhub, Eporner, or both', p: 'PORNERWEB aggregates multiple sources. If you want more predictable results—or simply want variety—use the source filter. It also helps when one source is slow or temporarily returns fewer results.' },
                { h: 'Use Watch Later, Continue Watching, and Random Video', p: 'Save interesting picks to Watch Later, resume the last video through Continue Watching, or use Random Video when you want quick discovery without typing. Together, these features keep your session smooth and organized.' },
                { h: 'Responsibility note', p: 'PORNERWEB is intended for visitors aged 18+. Browse responsibly and follow the laws in your region. For added safety, consider device-level parental controls and access restrictions.' },
            ],
        },
    },
    {
        slug: 'menjelajahi-koleksi-dari-berbagai-sumber',
        title: {
            id: 'Menjelajahi koleksi dari berbagai sumber',
            en: 'Exploring collections from multiple sources',
            ms: 'Meneroka koleksi daripada pelbagai sumber',
            es: 'Explorar colecciones de varias fuentes',
            ja: '複数ソースのコレクションを探索',
        },
        summary: {
            id: 'PORNERWEB menggabungkan Pornhub dan Eporner dalam satu tampilan agar Anda bisa menemukan variasi konten dengan lebih cepat.',
            en: 'PORNERWEB brings Pornhub and Eporner together in one interface so you can discover variety faster.',
            ms: 'PORNERWEB menghimpunkan Pornhub dan Eporner dalam satu paparan untuk memudahkan penemuan kandungan.',
            es: 'PORNERWEB reúne Pornhub y Eporner en una sola interfaz para descubrir variedad más rápido.',
            ja: 'PORNERWEBはPornhubとEpornerを1つの画面にまとめ、探しやすさを高めます。',
        },
        body: {
            id: [
                { h: 'Kenapa multi-sumber itu berguna', p: 'Setiap sumber memiliki katalog dan pola konten yang berbeda. Dengan multi-sumber, Anda mendapatkan variasi lebih besar, dan peluang menemukan video yang “pas” meningkat—terutama untuk kata kunci tertentu yang hasilnya bisa sangat berbeda antar platform.' },
                { h: 'Konsistensi: metadata yang diseragamkan', p: 'PORNERWEB menampilkan judul, thumbnail, jumlah views, dan durasi dalam format yang konsisten. Ini membantu Anda membandingkan video dari sumber yang berbeda dengan cepat tanpa berpindah website.' },
                { h: 'Filter sumber untuk kontrol penuh', p: 'Gunakan filter sumber jika Anda ingin fokus pada satu platform, atau pilih gabungan untuk variasi. Saat eksplorasi, gabungan lebih cocok. Saat Anda sudah tahu preferensi gaya konten, sumber tertentu mungkin lebih konsisten.' },
                { h: 'Rekomendasi yang selalu ada', p: 'Di halaman watch, rekomendasi diambil dari dua sumber dan dideduplikasi agar tidak ada video yang muncul dua kali. Ini membuat rekomendasi lebih stabil, lebih banyak pilihan, dan tidak terasa kosong.' },
                { h: 'Kinerja dan kenyamanan', p: 'Karena data diambil dari layanan pihak ketiga, terkadang salah satu sumber bisa lambat. PORNERWEB menggunakan fallback agar hasil tetap muncul. Ini menjaga pengalaman browsing tetap nyaman.' },
            ],
            en: [
                { h: 'Why multiple sources help', p: 'Each source has its own catalog and content patterns. With multi-source discovery, you get more variety and a higher chance of finding the “right” video—especially for queries that behave differently across platforms.' },
                { h: 'Consistency through normalized metadata', p: 'PORNERWEB presents titles, thumbnails, view counts, and durations in a consistent format. That makes comparing content across sources fast and frictionless.' },
                { h: 'Source filters give you control', p: 'Filter by source when you want to focus on one platform, or use both for variety. “Both” is best for exploration; a single source can be better when you want a familiar style.' },
                { h: 'Reliable recommendations on watch pages', p: 'Watch-page recommendations pull from both sources and are deduplicated to avoid repeats. This keeps the section populated and useful.' },
                { h: 'Performance and comfort', p: 'Because data comes from third-party services, one source can occasionally slow down. PORNERWEB uses fallbacks so results still load and your session stays smooth.' },
            ],
        },
    },
    {
        slug: 'tips-menikmati-browsing-yang-nyaman',
        title: {
            id: 'Tips menikmati pengalaman browsing yang nyaman',
            en: 'Tips for a smoother browsing experience',
            ms: 'Tip untuk pengalaman browsing yang selesa',
            es: 'Consejos para una navegación más cómoda',
            ja: '快適にブラウジングするコツ',
        },
        summary: {
            id: 'Gunakan Continue Watching, Watch Later, Random Video, dan rekomendasi agar Anda bisa menemukan konten tanpa repetisi.',
            en: 'Use Continue Watching, Watch Later, Random Video, and recommendations to keep exploring without repetition.',
            ms: 'Gunakan Continue Watching, Watch Later dan Random Video untuk terus meneroka tanpa mengulang carian.',
            es: 'Usa Continue Watching, Watch Later y Random Video para seguir explorando sin repetir búsquedas.',
            ja: 'Continue Watching / Watch Later / Random Videoで、検索の繰り返しを減らします。',
        },
        body: {
            id: [
                { h: 'Simpan dulu, tonton nanti', p: 'Saat browsing, Anda akan menemukan banyak video menarik. Gunakan Watch Later agar Anda bisa mengumpulkan pilihan tanpa kehilangan jejak. Ini membantu sesi menonton terasa terstruktur.' },
                { h: 'Lanjutkan dari terakhir ditonton', p: 'Continue Watching menyimpan video yang terakhir Anda buka. Jika Anda berpindah halaman atau kembali lagi nanti, Anda bisa melanjutkan tanpa mencari ulang.' },
                { h: 'Random Video untuk eksplorasi cepat', p: 'Ketika tidak punya kata kunci tertentu, Random Video adalah cara tercepat untuk menemukan hal baru. Ini cocok untuk “mood browsing” dan memperluas variasi konten yang Anda temukan.' },
                { h: 'Gunakan rekomendasi sebagai jalur penjelajahan', p: 'Rekomendasi di halaman watch dibuat agar selalu terisi dan tidak duplikat. Anda bisa memakai rekomendasi sebagai “jalur” untuk berpindah video, mirip seperti autoplay discovery namun tetap di tangan Anda.' },
                { h: 'Atur tema & bahasa untuk kenyamanan mata', p: 'Gunakan tema terang/gelap sesuai preferensi dan kondisi pencahayaan. Bahasa UI juga dapat diubah agar navigasi lebih nyaman.' },
            ],
            en: [
                { h: 'Save now, watch later', p: 'During browsing, you’ll find plenty of interesting videos. Watch Later lets you bookmark picks without losing track, keeping sessions organized.' },
                { h: 'Resume where you left off', p: 'Continue Watching remembers the last video you opened. Return later and continue without repeating the same search.' },
                { h: 'Use Random Video for quick discovery', p: 'When you don’t have a specific query, Random Video is the fastest way to explore. It’s great for broadening variety and finding something new.' },
                { h: 'Follow recommendations as a discovery path', p: 'Watch-page recommendations are designed to be populated and deduplicated. Use them as a guided path to keep watching while staying in control.' },
                { h: 'Adjust theme and language for comfort', p: 'Switch between light/dark themes based on lighting and preference. Change the UI language to browse more comfortably.' },
            ],
        },
    },
    {
        slug: 'konten-khusus-pengunjung-dewasa',
        title: {
            id: 'Konten khusus pengunjung dewasa',
            en: 'Adults-only content and responsible browsing',
            ms: 'Kandungan untuk pengunjung dewasa',
            es: 'Contenido solo para adultos y navegación responsable',
            ja: '成人向けコンテンツと責任ある利用',
        },
        summary: {
            id: 'PORNERWEB ditujukan untuk pengguna 18+. Pelajari cara menggunakan website secara bertanggung jawab dan aman.',
            en: 'PORNERWEB is intended for 18+ visitors. Learn how to browse responsibly and safely.',
            ms: 'PORNERWEB untuk pengunjung 18+. Gunakan secara bertanggungjawab dan selamat.',
            es: 'PORNERWEB es para mayores de 18. Navega de forma responsable y segura.',
            ja: 'PORNERWEBは18歳以上向け。責任を持って利用しましょう。',
        },
        body: {
            id: [
                { h: 'Untuk usia 18+ saja', p: 'PORNERWEB menampilkan konten dewasa yang dibatasi usia. Dengan mengakses website ini, Anda menyatakan telah berusia 18 tahun atau mencapai usia dewasa sesuai wilayah hukum Anda.' },
                { h: 'Gunakan kontrol orang tua bila diperlukan', p: 'Jika perangkat digunakan bersama keluarga, aktifkan parental control dan pembatasan situs di browser/perangkat. Ini adalah cara paling efektif untuk mencegah akses tidak sengaja.' },
                { h: 'Privasi dan kebiasaan browsing', p: 'Pertimbangkan mode private browsing, pengaturan cookie, dan keamanan perangkat. Jaga privasi Anda sesuai kebutuhan.' },
                { h: 'Kepatuhan hukum', p: 'Selalu patuhi peraturan dan hukum yang berlaku. Jika suatu konten tidak sesuai dengan wilayah Anda, hindari akses terhadap konten tersebut.' },
                { h: 'Tujuan PORNERWEB', p: 'PORNERWEB bertujuan menyediakan pengalaman penemuan konten yang lebih rapi, bukan mendorong perilaku berisiko. Gunakan secara bertanggung jawab.' },
            ],
            en: [
                { h: 'Adults (18+) only', p: 'PORNERWEB contains age-restricted adult content. By accessing this website, you confirm that you are at least 18 years old or have reached the age of majority in your jurisdiction.' },
                { h: 'Use parental controls when needed', p: 'If devices are shared, enable browser or device-level parental controls and site restrictions to prevent accidental access.' },
                { h: 'Privacy and browsing habits', p: 'Consider private browsing, cookie settings, and device security. Protect your privacy as needed.' },
                { h: 'Legal compliance', p: 'Always follow applicable laws and regulations. If certain content is restricted in your region, avoid accessing it.' },
                { h: 'PORNERWEB’s goal', p: 'PORNERWEB is built to provide a cleaner discovery experience—not to encourage risky behavior. Browse responsibly.' },
            ],
        },
    },
    {
        slug: 'filter-sumber-pornhub-eporner',
        title: {
            id: 'Filter sumber: Pornhub vs Eporner (dan kapan memilih gabungan)',
            en: 'Source filters: Pornhub vs Eporner (and when to use both)',
            ms: 'Penapis sumber: Pornhub vs Eporner',
            es: 'Filtro de fuentes: Pornhub vs Eporner',
            ja: 'ソースフィルター：PornhubとEporner',
        },
        summary: {
            id: 'Pelajari cara memilih sumber video agar hasil lebih stabil, cepat, dan sesuai preferensi—termasuk kapan sebaiknya memakai gabungan.',
            en: 'Learn how to choose sources for more stable, faster, and more relevant results—including when “both” is the best option.',
            ms: 'Ketahui cara memilih sumber video untuk hasil yang lebih stabil dan sesuai.',
            es: 'Aprende a elegir la fuente para resultados más estables y relevantes.',
            ja: '好みに合わせてソースを選び、結果を安定させる方法。',
        },
        body: {
            id: [
                { h: 'Kenapa filter sumber penting', p: 'PORNERWEB menggabungkan beberapa sumber video. Walau ini meningkatkan variasi, terkadang Anda ingin hasil yang lebih “konsisten” dari satu platform. Filter sumber memberi kontrol: fokus pada Pornhub, fokus pada Eporner, atau gunakan gabungan untuk eksplorasi.' },
                { h: 'Kapan memilih Pornhub saja', p: 'Pilih Pornhub saat Anda ingin pola hasil yang familiar, embed yang stabil, atau saat kata kunci tertentu terasa lebih cocok di Pornhub. Ini juga berguna saat Anda ingin membatasi variasi hasil supaya browsing terasa lebih terarah.' },
                { h: 'Kapan memilih Eporner saja', p: 'Pilih Eporner saat Anda ingin variasi thumbnail yang berbeda, variasi katalog yang lebih cocok untuk kata kunci tertentu, atau saat Anda ingin membandingkan konten dari sumber alternatif. Durasi dari Eporner ditampilkan dari metadata sehingga Anda tetap bisa memfilter secara visual.' },
                { h: 'Kapan memilih gabungan', p: 'Gabungan cocok untuk sesi eksplorasi. Anda mendapatkan lebih banyak pilihan, rekomendasi cenderung lebih penuh, dan kemungkinan “ketemu video yang pas” meningkat. Gunakan gabungan saat Anda belum yakin kata kunci yang paling tepat.' },
                { h: 'Tips SEO-friendly untuk pencarian internal', p: 'Gunakan kata kunci yang konsisten dan ringkas, misalnya “japanese milf”, “asian amateur”, atau “cosplay”. Tambahkan satu penanda saja (kategori/negara/sumber) agar hasil tidak terlalu sempit. Jika hasil terlalu banyak, barulah perketat secara bertahap.' },
            ],
            en: [
                { h: 'Why source filters matter', p: 'PORNERWEB aggregates multiple video sources. While this increases variety, you may prefer more predictable results from a single platform. Source filters give you control: focus on Pornhub, focus on Eporner, or use both for exploration.' },
                { h: 'When to choose Pornhub only', p: 'Pick Pornhub when you want a familiar result pattern, stable embeds, or when specific queries perform better there. Limiting sources can also keep your browsing more focused.' },
                { h: 'When to choose Eporner only', p: 'Pick Eporner when you want different catalog variety, different thumbnail sets, or when certain keywords perform better there. Duration is shown from Eporner metadata so you still have clear cues while browsing.' },
                { h: 'When to use both', p: 'Both sources are ideal for exploration. You get more options, recommendations stay populated, and the chance of finding a perfect match increases—especially when you’re still refining your search terms.' },
                { h: 'Better internal search habits', p: 'Use compact, consistent keywords such as “japanese milf”, “asian amateur”, or “cosplay”. Add just one extra constraint (category/country/source) at a time to avoid over-filtering, then tighten gradually.' },
            ],
        },
    },
    {
        slug: 'watch-later-dan-continue-watching',
        title: {
            id: 'Watch Later & Continue Watching: cara menjaga sesi menonton tetap rapi',
            en: 'Watch Later & Continue Watching: keep sessions organized',
            ms: 'Watch Later & Continue Watching: kekalkan sesi teratur',
            es: 'Watch Later y Continue Watching: mantén tu sesión organizada',
            ja: 'Watch Later / Continue Watchingで整理する',
        },
        summary: {
            id: 'Dua fitur sederhana yang membuat browsing terasa jauh lebih nyaman: simpan pilihan dan lanjutkan dari video terakhir.',
            en: 'Two simple features that dramatically improve comfort: save picks and resume the last video you opened.',
            ms: 'Dua ciri mudah: simpan pilihan dan sambung video terakhir.',
            es: 'Dos funciones simples: guarda y reanuda.',
            ja: '保存と再開で快適に。',
        },
        body: {
            id: [
                { h: 'Mengapa sesi browsing sering “berantakan”', p: 'Saat menjelajah, Anda mungkin membuka banyak tab atau lupa video mana yang tadi menarik. Ini membuat sesi terasa melelahkan, terutama jika Anda kembali beberapa jam kemudian.' },
                { h: 'Watch Later: simpan tanpa harus menonton sekarang', p: 'Gunakan tombol simpan untuk mengumpulkan video pilihan. Ini cocok untuk riset cepat: Anda bisa menandai beberapa kandidat, lalu menonton satu per satu tanpa kehilangan jejak.' },
                { h: 'Continue Watching: kembali ke video terakhir', p: 'Continue Watching menyimpan video terakhir yang Anda buka sehingga Anda bisa melanjutkan tanpa mencari ulang. Ini sangat membantu ketika Anda berpindah perangkat atau kembali setelah jeda.' },
                { h: 'Kebiasaan yang membuat fitur ini makin berguna', p: 'Saat menemukan video menarik, simpan dulu lalu lanjutkan browsing. Setelah Anda punya daftar kecil, baru mulai menonton. Jika Anda keluar, Continue Watching membantu Anda kembali dengan cepat.' },
                { h: 'Privasi: data tersimpan di perangkat Anda', p: 'Watch Later dan Continue Watching disimpan di browser (localStorage). Artinya daftar ini bersifat lokal di perangkat yang sama dan tidak otomatis tersinkron antar perangkat.' },
            ],
            en: [
                { h: 'Why browsing sessions get messy', p: 'It’s easy to open multiple tabs and lose track of what looked interesting. That makes sessions tiring—especially when you come back hours later.' },
                { h: 'Watch Later: save without committing', p: 'Use the save button to collect picks. It’s perfect for quick exploration: bookmark candidates first, then watch them in a clean sequence.' },
                { h: 'Continue Watching: resume the last video', p: 'Continue Watching remembers the last video you opened so you can return without repeating the same search. It’s especially useful after a break.' },
                { h: 'Habits that make it even better', p: 'When a video looks promising, save it and keep browsing. Once you have a shortlist, start watching. If you leave, Continue Watching brings you back quickly.' },
                { h: 'Privacy: stored locally', p: 'Watch Later and Continue Watching are stored in your browser (localStorage). Lists are local to the device and won’t automatically sync across devices.' },
            ],
        },
    },
    {
        slug: 'random-video-untuk-eksplorasi',
        title: {
            id: 'Random Video: cara cepat menemukan konten baru tanpa mengetik',
            en: 'Random Video: discover new content without typing',
            ms: 'Random Video: temui kandungan baharu tanpa menaip',
            es: 'Random Video: descubre sin escribir',
            ja: 'Random Videoで手早く発見',
        },
        summary: {
            id: 'Saat Anda tidak punya kata kunci, Random Video bisa menjadi pintu masuk eksplorasi yang cepat, ringan, dan seru.',
            en: 'When you don’t have a query, Random Video is a fast, lightweight way to explore.',
            ms: 'Jika tiada kata kunci, Random Video memudahkan penerokaan.',
            es: 'Si no tienes búsqueda, Random Video facilita explorar.',
            ja: '検索しなくても探索できます。',
        },
        body: {
            id: [
                { h: 'Kapan Random Video paling berguna', p: 'Random Video cocok saat Anda ingin variasi cepat tanpa memikirkan kata kunci. Ini juga berguna untuk menemukan kategori baru yang sebelumnya tidak Anda cari.' },
                { h: 'Gunakan Random sebagai “pemanasan”', p: 'Mulai dengan beberapa video acak. Jika Anda menemukan pola yang Anda suka (misalnya gaya, negara, atau tag tertentu), barulah pindah ke pencarian dengan kata kunci yang lebih spesifik.' },
                { h: 'Simpan yang menarik', p: 'Saat menemukan video yang potensial, gunakan Watch Later. Dengan begitu, Random Video menjadi alat eksplorasi, sementara daftar Watch Later menjadi tempat kurasi pribadi Anda.' },
                { h: 'Gabungkan dengan rekomendasi', p: 'Setelah membuka video dari Random, gunakan kotak rekomendasi untuk berpindah dengan halus. Ini membuat sesi terasa seperti playlist eksplorasi, tanpa kehilangan kontrol.' },
                { h: 'Catatan pengalaman', p: 'Karena Random mengambil sampel dari koleksi populer, hasilnya bisa berubah-ubah. Jika Anda ingin hasil lebih terkendali, gunakan filter sumber atau kategori.' },
            ],
            en: [
                { h: 'When Random Video shines', p: 'Random Video is perfect when you want variety without thinking about keywords. It can also introduce you to categories you would not normally search for.' },
                { h: 'Use Random as a warm-up', p: 'Start with a few random picks. Once you notice patterns you like (style, country, tags), switch to a more specific keyword search.' },
                { h: 'Save what looks promising', p: 'When something looks good, use Watch Later. Random becomes your discovery tool; Watch Later becomes your personal shortlist.' },
                { h: 'Combine with recommendations', p: 'After opening a random video, use recommendations to move smoothly to the next pick. It feels like an exploration playlist while keeping you in control.' },
                { h: 'A quick note', p: 'Because Random samples popular collections, results vary. For more control, use source filters or categories.' },
            ],
        },
    },
    {
        slug: 'live-sex-page-dan-cara-mencari',
        title: {
            id: 'Halaman LIVE SEX: cara mencari konten live dengan lebih cepat',
            en: 'LIVE SEX page: how to find live content faster',
            ms: 'Halaman LIVE SEX: cara mencari lebih cepat',
            es: 'Página LIVE SEX: cómo buscar más rápido',
            ja: 'LIVE SEXページの使い方',
        },
        summary: {
            id: 'PORNERWEB punya halaman khusus LIVE SEX untuk eksplorasi cepat—gunakan kata kunci, sumber, dan rekomendasi agar hasil lebih relevan.',
            en: 'PORNERWEB has a dedicated LIVE SEX page—use keywords, sources, and recommendations for more relevant results.',
            ms: 'PORNERWEB ada halaman LIVE SEX untuk penerokaan cepat.',
            es: 'PORNERWEB tiene una página LIVE SEX para explorar rápido.',
            ja: '専用ページで素早く探索。',
        },
        body: {
            id: [
                { h: 'Apa itu halaman LIVE SEX', p: 'Halaman LIVE SEX adalah halaman kurasi untuk menemukan video yang relevan dengan pencarian “live sex”. Ini memudahkan Anda mengakses topik tertentu tanpa harus mengetik ulang kata kunci setiap kali.' },
                { h: 'Cara mempersempit hasil', p: 'Jika hasil terlalu banyak, gunakan filter sumber. Jika hasil terlalu sedikit, gunakan gabungan sumber atau ganti kata kunci menjadi lebih umum. Anda juga bisa mencoba variasi seperti “live cam”, “webcam”, atau “live show”.' },
                { h: 'Gunakan Watch Later', p: 'Konten live sering memiliki gaya yang beragam. Simpan beberapa kandidat ke Watch Later, lalu pilih yang paling sesuai. Ini membuat sesi terasa lebih terstruktur.' },
                { h: 'Perhatikan pengalaman di player', p: 'Setiap sumber memiliki embed player sendiri. Jika satu embed terasa berat, coba video lain atau ganti sumber untuk hasil yang lebih stabil.' },
                { h: 'Konten dewasa 18+', p: 'Pastikan Anda memenuhi batas usia dan mematuhi aturan setempat. Gunakan website ini secara bertanggung jawab.' },
            ],
            en: [
                { h: 'What the LIVE SEX page is', p: 'The LIVE SEX page is a curated view designed around “live sex” discovery. It helps you reach a specific topic without re-typing the same query every time.' },
                { h: 'How to narrow results', p: 'If results feel too broad, use source filters. If results are limited, try both sources or broaden keywords. Variations like “live cam”, “webcam”, or “live show” can also help.' },
                { h: 'Use Watch Later', p: 'Live-related content can vary widely. Save a shortlist to Watch Later, then pick what fits best. It keeps the session structured.' },
                { h: 'Player experience tips', p: 'Each source uses its own embed. If one embed feels heavy, try another video or switch sources for a more stable session.' },
                { h: 'Adults (18+) only', p: 'Confirm your age eligibility and follow local rules. Browse responsibly.' },
            ],
        },
    },
    {
        slug: 'pencarian-kategori-negara-yang-efektif',
        title: {
            id: 'Pencarian kategori & negara yang efektif (tanpa hasil yang terlalu luas)',
            en: 'Effective category & country discovery (without noisy results)',
            ms: 'Carian kategori & negara yang efektif',
            es: 'Búsqueda por categoría y país (sin ruido)',
            ja: 'カテゴリー・国で効率よく探す',
        },
        summary: {
            id: 'Strategi sederhana untuk mendapatkan hasil yang relevan: mulai dari kategori/negara, lalu refine dengan kata kunci dan sumber.',
            en: 'A simple strategy: start with category/country, then refine with keywords and sources.',
            ms: 'Mulakan dengan kategori/negara, kemudian perincikan dengan kata kunci dan sumber.',
            es: 'Empieza con categoría/país y refina con palabras clave y fuente.',
            ja: 'まず大枠→次に絞り込み。',
        },
        body: {
            id: [
                { h: 'Mulai dari satu dimensi', p: 'Agar hasil tidak terlalu luas, mulai dari satu dimensi: kategori atau negara. Misalnya: mulai dari “Japanese” lalu cari “amateur” sebagai refinemen.' },
                { h: 'Refine bertahap', p: 'Jika hasil masih banyak, tambahkan satu kata kunci lagi. Hindari menambahkan terlalu banyak kata sekaligus karena bisa membuat hasil kosong atau tidak stabil.' },
                { h: 'Gunakan sumber untuk stabilitas', p: 'Jika Anda mendapati hasil campuran terlalu “acak”, pilih satu sumber. Ini sering membuat hasil terasa lebih konsisten dan mudah dipahami.' },
                { h: 'Simpan jalur eksplorasi', p: 'Saat Anda menemukan jalur yang bagus (misalnya kategori → kata kunci → sumber), simpan video menarik ke Watch Later. Ini membuat Anda bisa kembali dengan cepat tanpa mengulang langkah filter dari awal.' },
                { h: 'Kombinasikan dengan Random', p: 'Jika jalur terasa mentok, gunakan Random Video untuk menemukan ide kata kunci baru. Setelah itu, kembali ke jalur kategori/negara dengan kata kunci yang lebih tepat.' },
            ],
            en: [
                { h: 'Start with one dimension', p: 'To avoid noisy results, start with a single dimension: category or country. Example: start with “Japanese”, then refine with “amateur”.' },
                { h: 'Refine step-by-step', p: 'If results are still broad, add one more keyword. Avoid stacking too many constraints at once, as it can produce empty or unstable results.' },
                { h: 'Use source filters for stability', p: 'If mixed results feel too random, focus on one source. It often makes the list more consistent and easier to browse.' },
                { h: 'Save your discovery path', p: 'When you find a good path (category → keyword → source), save interesting picks to Watch Later so you can return quickly without repeating the full process.' },
                { h: 'Use Random for fresh ideas', p: 'If you hit a dead end, use Random Video to discover new keyword ideas, then return to your category/country flow with improved terms.' },
            ],
        },
    },
    {
        slug: 'trending-pornstars-dan-cara-menemukan-model',
        title: {
            id: 'Trending Pornstars: cara menemukan model populer dan video terkait',
            en: 'Trending Pornstars: find popular models and related videos',
            ms: 'Trending Pornstars: cari model popular dan video',
            es: 'Trending Pornstars: encuentra modelos populares',
            ja: 'Trending Pornstarsの使い方',
        },
        summary: {
            id: 'Gunakan blok Trending Pornstars untuk menemukan model yang sedang ramai dan langsung mencari video terkait dengan satu klik.',
            en: 'Use the Trending Pornstars block to discover popular models and jump into related videos with one click.',
            ms: 'Gunakan Trending Pornstars untuk jumpa model popular dan video berkaitan.',
            es: 'Usa Trending Pornstars para descubrir modelos y vídeos relacionados.',
            ja: '人気モデルから関連動画へ。',
        },
        body: {
            id: [
                { h: 'Kenapa trending membantu discovery', p: 'Trending adalah cara cepat untuk melihat siapa yang sedang populer. Ini membantu Anda menemukan model yang mungkin belum Anda kenal, lalu menjelajah video terkait lewat pencarian nama.' },
                { h: 'Klik model untuk mencari video', p: 'Di PORNERWEB, kartu model mengarah ke pencarian nama. Ini membuat Anda langsung melihat video terkait tanpa harus menulis nama secara manual.' },
                { h: 'Gabungkan dengan filter sumber', p: 'Setelah membuka hasil pencarian nama, gunakan filter sumber untuk membandingkan variasi video dari Pornhub dan Eporner. Kadang satu sumber punya katalog yang lebih lengkap untuk nama tertentu.' },
                { h: 'Buat daftar Watch Later', p: 'Saat menemukan beberapa video menarik dari satu model, simpan ke Watch Later. Ini mempercepat sesi menonton dan mengurangi tab yang berantakan.' },
                { h: 'Temukan pola preferensi Anda', p: 'Jika Anda menyukai model dari negara atau kategori tertentu, gunakan itu sebagai kata kunci tambahan. Misalnya: nama model + “japanese” atau nama model + kategori.' },
            ],
            en: [
                { h: 'Why trending helps discovery', p: 'Trending is a quick way to see who is popular right now. It helps you discover new models and explore related videos through name-based search.' },
                { h: 'Click a model to search', p: 'On PORNERWEB, model cards lead to a name query, so you can browse related videos without typing names manually.' },
                { h: 'Combine with source filters', p: 'After opening a model search, use source filters to compare results from Pornhub and Eporner. One source may have better coverage for certain names.' },
                { h: 'Build a Watch Later shortlist', p: 'When you find good picks from a model, save them. It keeps sessions clean and reduces tab overload.' },
                { h: 'Spot your preference patterns', p: 'If you notice patterns (country/category), use them as extra keywords with the model name to refine results.' },
            ],
        },
    },
    {
        slug: 'privasi-keamanan-dan-kenyamanan',
        title: {
            id: 'Privasi, keamanan, dan kenyamanan saat browsing konten dewasa',
            en: 'Privacy, safety, and comfort while browsing adult content',
            ms: 'Privasi dan keselamatan semasa browsing',
            es: 'Privacidad y seguridad al navegar',
            ja: 'プライバシーと安全',
        },
        summary: {
            id: 'Panduan praktis untuk menjaga privasi dan pengalaman browsing tetap aman: dari kontrol perangkat hingga kebiasaan yang lebih sehat.',
            en: 'Practical guidance to keep browsing safer: device controls, privacy habits, and comfort tips.',
            ms: 'Panduan praktikal untuk privasi dan keselamatan semasa browsing.',
            es: 'Guía práctica para navegar de forma más segura.',
            ja: '安全に利用するための実用ガイド。',
        },
        body: {
            id: [
                { h: 'Gunakan perangkat dengan bijak', p: 'Jika perangkat digunakan bersama, aktifkan pembatasan situs dan kontrol orang tua. Ini mencegah akses tidak sengaja oleh pengguna yang belum memenuhi batas usia.' },
                { h: 'Pahami penyimpanan lokal', p: 'Fitur seperti Watch Later dan Continue Watching disimpan secara lokal di browser. Jika Anda tidak ingin jejak tersimpan, Anda bisa menghapus data situs melalui pengaturan browser.' },
                { h: 'Atur kenyamanan visual', p: 'Pilih tema terang/gelap sesuai kondisi. Gunakan bahasa UI yang paling nyaman agar navigasi lebih cepat dan mengurangi kesalahan klik.' },
                { h: 'Hindari kebiasaan yang mengganggu pengalaman', p: 'Jika Anda merasa hasil terlalu acak, gunakan filter sumber dan kata kunci yang lebih spesifik. Disiplin filter membuat sesi lebih rapi dan tidak melelahkan.' },
                { h: 'Tanggung jawab dan batasan', p: 'PORNERWEB dibuat untuk pengguna 18+. Gunakan secara bertanggung jawab, patuhi hukum setempat, dan prioritaskan keamanan perangkat Anda.' },
            ],
            en: [
                { h: 'Use shared devices responsibly', p: 'If devices are shared, enable site restrictions and parental controls to prevent accidental access by underage users.' },
                { h: 'Understand local storage', p: 'Features like Watch Later and Continue Watching are stored locally in your browser. If you prefer no traces, clear site data in your browser settings.' },
                { h: 'Tune visual comfort', p: 'Pick light/dark themes based on lighting. Use the UI language you’re most comfortable with to navigate faster and reduce misclicks.' },
                { h: 'Avoid habits that create friction', p: 'If results feel too random, use source filters and more specific keywords. A disciplined filter flow makes sessions cleaner and less tiring.' },
                { h: 'Responsibility and limits', p: 'PORNERWEB is for 18+ visitors. Browse responsibly, follow local laws, and prioritize device security.' },
            ],
        },
    },
    {
        slug: 'cara-menggunakan-pencarian-video-online',
        title: { id: 'Cara menggunakan pencarian video online dengan lebih efektif', en: 'How to use online video search more effectively' },
        summary: { id: 'Panduan praktis memilih kata kunci, membaca hasil, dan menemukan video relevan tanpa membuang waktu.', en: 'A practical guide to choosing keywords, reading results, and finding relevant videos faster.' },
        body: {
            id: [
                { h: 'Mulai dari tujuan pencarian', p: 'Tentukan terlebih dahulu jenis video yang ingin ditemukan. Tujuan yang jelas membantu Anda memilih kata kunci yang lebih relevan dan mengurangi hasil yang tidak sesuai.' },
                { h: 'Pilih kata kunci yang spesifik', p: 'Gabungkan topik, gaya, kategori, atau negara dalam dua sampai tiga kata. Kata kunci yang terlalu umum biasanya menghasilkan daftar yang panjang dan sulit disaring.' },
                { h: 'Bandingkan judul, thumbnail, dan durasi', p: 'Gunakan metadata yang tersedia sebagai panduan awal. Judul memberi konteks, thumbnail membantu mengenali tema, sedangkan durasi membantu memilih format yang sesuai.' },
                { h: 'Persempit hasil secara bertahap', p: 'Tambahkan satu filter pada satu waktu. Cara ini membuat Anda lebih mudah mengetahui filter mana yang benar-benar meningkatkan relevansi hasil.' },
            ],
            en: [
                { h: 'Start with a clear search goal', p: 'Define what you want to find before searching. A clear goal leads to better keywords and fewer irrelevant results.' },
                { h: 'Use specific keywords', p: 'Combine a topic, style, category, or country in two or three words. Broad queries usually create noisy result pages.' },
                { h: 'Compare title, thumbnail, and duration', p: 'Use available metadata as a quick guide before opening a video.' },
                { h: 'Refine results gradually', p: 'Add one filter at a time so you can see which refinement improves relevance.' },
            ],
        },
    },
    {
        slug: 'panduan-memilih-kata-kunci-video',
        title: { id: 'Panduan memilih kata kunci video yang relevan', en: 'Guide to choosing relevant video keywords' },
        summary: { id: 'Pelajari teknik membuat kata kunci pencarian yang singkat, jelas, dan mudah menghasilkan video sesuai minat.', en: 'Learn how to create short, clear search phrases that lead to more relevant videos.' },
        body: {
            id: [
                { h: 'Gunakan frasa, bukan daftar kata acak', p: 'Frasa seperti “japanese amateur” atau “cosplay compilation” memberi konteks lebih baik dibandingkan banyak kata yang tidak berhubungan.' },
                { h: 'Gabungkan kata utama dan penjelas', p: 'Kata utama menjelaskan topik, sementara kata penjelas memberi batasan gaya, negara, atau kategori.' },
                { h: 'Hindari terlalu banyak batasan', p: 'Pencarian yang terlalu panjang dapat mempersempit hasil secara berlebihan. Mulai sederhana lalu perbaiki berdasarkan hasil pertama.' },
                { h: 'Coba variasi sinonim', p: 'Jika hasil sedikit, ubah satu kata dengan istilah yang mirip. Setiap platform dapat mengindeks istilah dengan cara yang berbeda.' },
            ],
            en: [
                { h: 'Use phrases instead of random words', p: 'A phrase provides more context than a long list of unrelated terms.' },
                { h: 'Combine a main term with a qualifier', p: 'The main term describes the topic; the qualifier defines style, country, or category.' },
                { h: 'Avoid too many restrictions', p: 'Start simple and refine after reviewing the first results.' },
                { h: 'Try synonym variations', p: 'Replace one term when results are limited because platforms may index similar ideas differently.' },
            ],
        },
    },
    {
        slug: 'strategi-browsing-video-tanpa-mengulang-hasil',
        title: { id: 'Strategi browsing video tanpa mengulang hasil yang sama', en: 'How to browse videos without repeating the same results' },
        summary: { id: 'Temukan cara memakai pagination, filter sumber, dan daftar simpanan agar eksplorasi video lebih beragam.', en: 'Use pagination, source filters, and saved lists to keep video discovery varied.' },
        body: {
            id: [
                { h: 'Gunakan halaman berikutnya secara berurutan', p: 'Pagination membantu Anda berpindah ke kumpulan hasil berikutnya. Hindari membuka ulang halaman pertama ketika ingin melanjutkan eksplorasi.' },
                { h: 'Pilih sumber yang berbeda', p: 'Filter Pornhub atau Eporner dapat membantu menemukan katalog yang berbeda ketika hasil gabungan terasa berulang.' },
                { h: 'Simpan video yang sudah dipilih', p: 'Watch Later membuat Anda tidak perlu mencari video yang sama lagi dan membantu membedakan konten yang sudah Anda lihat.' },
                { h: 'Ganti pendekatan pencarian', p: 'Jika hasil mulai berulang, tambahkan kategori, negara, atau sinonim yang masih relevan.' },
            ],
            en: [
                { h: 'Move through pagination in order', p: 'Pagination takes you to the next result set. Avoid reopening the first page when continuing discovery.' },
                { h: 'Try a different source', p: 'Source filters can reveal a different catalog when combined results feel repetitive.' },
                { h: 'Save videos you already selected', p: 'Watch Later helps you avoid searching for the same picks again.' },
                { h: 'Change your search angle', p: 'Add a relevant category, country, or synonym when results begin to repeat.' },
            ],
        },
    },
    {
        slug: 'tips-menilai-kualitas-thumbnail-video',
        title: { id: 'Tips menilai kualitas thumbnail dan metadata video', en: 'Tips for evaluating video thumbnails and metadata' },
        summary: { id: 'Kenali informasi penting pada thumbnail, judul, durasi, dan jumlah views sebelum membuka video.', en: 'Understand the value of thumbnails, titles, duration, and views before opening a video.' },
        body: {
            id: [
                { h: 'Thumbnail sebagai petunjuk visual', p: 'Thumbnail memberi gambaran awal tentang tema video, tetapi tetap gunakan bersama judul dan informasi lain agar tidak mengambil kesimpulan terlalu cepat.' },
                { h: 'Judul membantu memahami konteks', p: 'Baca judul secara utuh untuk melihat kata kunci utama dan detail tambahan yang membedakan satu hasil dengan hasil lainnya.' },
                { h: 'Durasi sesuai kebutuhan', p: 'Durasi dapat membantu Anda memilih video singkat atau panjang sesuai waktu yang tersedia.' },
                { h: 'Views bukan satu-satunya ukuran', p: 'Jumlah views berguna sebagai sinyal popularitas, tetapi relevansi terhadap pencarian tetap menjadi pertimbangan utama.' },
            ],
            en: [
                { h: 'Use thumbnails as visual clues', p: 'Thumbnails offer an initial idea, but review them together with titles and other details.' },
                { h: 'Titles provide context', p: 'Read the full title to identify the main keyword and differentiating details.' },
                { h: 'Choose a suitable duration', p: 'Duration helps you select content that fits the time available.' },
                { h: 'Views are not the only signal', p: 'View counts indicate popularity, while relevance should remain the deciding factor.' },
            ],
        },
    },
    {
        slug: 'cara-membuat-sesi-menonton-lebih-teratur',
        title: { id: 'Cara membuat sesi menonton video lebih teratur', en: 'How to organize a better video-watching session' },
        summary: { id: 'Atur alur pencarian, daftar Watch Later, dan Continue Watching untuk pengalaman yang lebih fokus.', en: 'Organize search, Watch Later, and Continue Watching for a more focused experience.' },
        body: {
            id: [
                { h: 'Tentukan tema sesi', p: 'Mulai dengan satu tema atau kata kunci agar daftar hasil tetap fokus dan mudah dipilih.' },
                { h: 'Buat shortlist terlebih dahulu', p: 'Simpan beberapa pilihan ke Watch Later sebelum membuka terlalu banyak tab atau halaman.' },
                { h: 'Manfaatkan Continue Watching', p: 'Gunakan fitur ini untuk kembali ke video terakhir tanpa mengulangi proses pencarian.' },
                { h: 'Tutup pilihan yang tidak relevan', p: 'Kurangi daftar yang tidak sesuai agar rekomendasi dan pilihan berikutnya tetap lebih terarah.' },
            ],
            en: [
                { h: 'Choose a session theme', p: 'Start with one topic or keyword so the result list stays focused.' },
                { h: 'Create a shortlist first', p: 'Save a few picks to Watch Later before opening too many tabs.' },
                { h: 'Use Continue Watching', p: 'Return to your last video without repeating the entire search.' },
                { h: 'Remove irrelevant choices', p: 'Keep your shortlist focused so the next decision is easier.' },
            ],
        },
    },
    {
        slug: 'perbedaan-video-populer-dan-video-terbaru',
        title: { id: 'Perbedaan video populer dan video terbaru', en: 'Popular videos vs. latest videos: what is the difference?' },
        summary: { id: 'Pahami kapan memilih video populer untuk validasi minat dan kapan memilih video terbaru untuk menemukan konten segar.', en: 'Learn when popular videos are useful and when latest videos are better for fresh discovery.' },
        body: {
            id: [
                { h: 'Kelebihan video populer', p: 'Video populer biasanya memiliki banyak interaksi dan dapat menjadi titik awal ketika Anda belum mengetahui topik yang ingin dicari.' },
                { h: 'Kelebihan video terbaru', p: 'Video terbaru membantu Anda menemukan tambahan katalog dan tema yang baru diperbarui.' },
                { h: 'Gunakan keduanya secara bergantian', p: 'Mulai dari populer untuk memahami pola minat, lalu beralih ke terbaru untuk memperluas pilihan.' },
                { h: 'Tetap gunakan kata kunci', p: 'Urutan populer atau terbaru tetap akan lebih efektif jika dipadukan dengan pencarian yang spesifik.' },
            ],
            en: [
                { h: 'Benefits of popular videos', p: 'Popular videos are a useful starting point when you are still exploring a topic.' },
                { h: 'Benefits of latest videos', p: 'Latest videos help you discover newly updated catalog entries and fresh themes.' },
                { h: 'Use both approaches', p: 'Start with popular results, then switch to latest results for broader discovery.' },
                { h: 'Keep keywords involved', p: 'Sorting works best when combined with a specific search phrase.' },
            ],
        },
    },
    {
        slug: 'panduan-menjelajah-video-di-perangkat-mobile',
        title: { id: 'Panduan menjelajah video dengan nyaman di perangkat mobile', en: 'Guide to browsing videos comfortably on mobile devices' },
        summary: { id: 'Optimalkan pengalaman pencarian video di ponsel dengan koneksi stabil, tampilan yang nyaman, dan navigasi sederhana.', en: 'Improve mobile video discovery with a stable connection, comfortable display, and simple navigation.' },
        body: {
            id: [
                { h: 'Gunakan koneksi yang stabil', p: 'Koneksi yang baik membantu thumbnail, metadata, dan player dimuat lebih konsisten saat Anda berpindah halaman.' },
                { h: 'Atur tema sesuai lingkungan', p: 'Tema gelap dapat terasa lebih nyaman di tempat minim cahaya, sementara tema terang dapat membantu pada siang hari.' },
                { h: 'Gunakan pagination dengan sabar', p: 'Tunggu halaman selesai dimuat sebelum menekan navigasi berikutnya agar tidak terjadi klik ganda.' },
                { h: 'Simpan pilihan penting', p: 'Watch Later membantu Anda melanjutkan eksplorasi ketika waktu atau koneksi sedang terbatas.' },
            ],
            en: [
                { h: 'Use a stable connection', p: 'A reliable connection helps thumbnails, metadata, and players load consistently.' },
                { h: 'Choose a comfortable theme', p: 'Dark mode can be easier in low light, while light mode may suit daytime browsing.' },
                { h: 'Use pagination carefully', p: 'Let each page finish loading before tapping the next navigation control.' },
                { h: 'Save important picks', p: 'Watch Later lets you continue discovery when time or connectivity is limited.' },
            ],
        },
    },
    {
        slug: 'checklist-pencarian-video-yang-relevan',
        title: { id: 'Checklist pencarian video yang relevan dan efisien', en: 'A checklist for relevant and efficient video searches' },
        summary: { id: 'Checklist singkat untuk memeriksa kata kunci, filter, sumber, pagination, dan daftar video sebelum memulai sesi browsing.', en: 'A quick checklist covering keywords, filters, sources, pagination, and saved videos.' },
        body: {
            id: [
                { h: 'Periksa kata kunci', p: 'Pastikan kata kunci menggambarkan topik utama dan tidak terlalu umum.' },
                { h: 'Pilih filter yang diperlukan', p: 'Gunakan kategori, negara, atau sumber hanya jika memang membantu mempersempit hasil.' },
                { h: 'Bandingkan beberapa halaman', p: 'Jelajahi pagination untuk mendapatkan variasi, bukan hanya memilih hasil pertama.' },
                { h: 'Simpan dan evaluasi', p: 'Masukkan pilihan terbaik ke Watch Later, lalu evaluasi apakah kata kunci Anda sudah menghasilkan konten yang relevan.' },
                { h: 'Gunakan secara bertanggung jawab', p: 'Layanan ini hanya untuk pengguna 18 tahun ke atas. Patuhi hukum dan peraturan yang berlaku di wilayah Anda.' },
            ],
            en: [
                { h: 'Check your keywords', p: 'Make sure the phrase describes the main topic without being too broad.' },
                { h: 'Choose only useful filters', p: 'Use category, country, or source filters when they genuinely improve relevance.' },
                { h: 'Review multiple pages', p: 'Explore pagination for variety instead of choosing only the first results.' },
                { h: 'Save and evaluate', p: 'Save the best picks, then assess whether your query is producing relevant content.' },
                { h: 'Browse responsibly', p: 'This service is for adults 18 and over. Follow the laws and regulations in your region.' },
            ],
        },
    },
]);
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

app.get('/blog', (req, res) => {
    const posts = BLOG_POSTS.map((post) => ({
        slug: post.slug,
        title: localized(res.locals.lang, post.title),
        summary: localized(res.locals.lang, post.summary),
    }));
    res.render('blog', {
        posts,
        seo: buildSeo(req, {
            title: localized(res.locals.lang, { id: 'Blog PORNERWEB', en: 'PORNERWEB Blog', ms: 'Blog PORNERWEB', es: 'Blog de PORNERWEB', ja: 'PORNERWEB ブログ' }),
            description: localized(res.locals.lang, { id: 'Panduan dan informasi untuk menemukan video dewasa 18+ dengan lebih cepat dan nyaman.', en: 'Guides and insights to discover adult videos (18+) faster and more comfortably.', ms: 'Panduan untuk menemui video dewasa 18+ dengan lebih cepat.', es: 'Guías para descubrir vídeos para adultos (18+) más rápido.', ja: '18歳以上向けの動画を探すためのガイド。' }),
            pathname: '/blog',
            explicit: true,
        }),
    });
});

app.get('/blog/:slug', (req, res, next) => {
    const post = BLOG_POSTS.find((item) => item.slug === String(req.params.slug || '').trim());
    if (!post) return next();
    const title = localized(res.locals.lang, post.title);
    const summary = localized(res.locals.lang, post.summary);
    const blocks = (post.body && (post.body[res.locals.lang] || post.body.en)) || [];
    const jsonLd = {
        '@context': 'https://schema.org',
        '@type': 'Article',
        headline: title,
        description: summary,
        author: { '@type': 'Organization', name: SITE_NAME },
        publisher: { '@type': 'Organization', name: SITE_NAME },
        mainEntityOfPage: absoluteUrl(req, `/blog/${post.slug}`),
        inLanguage: res.locals.lang,
        isAccessibleForFree: true,
    };
    return res.render('blog-post', {
        post: { slug: post.slug, title, summary, blocks },
        seo: buildSeo(req, {
            title,
            description: summary,
            pathname: `/blog/${post.slug}`,
            explicit: true,
            jsonLd,
        }),
    });
});

app.get('/robots.txt', (req, res) => {
    res.type('text/plain').send([
        'User-agent: *', 'Allow: /', 'Disallow: /set-lang', '',
        `Sitemap: ${absoluteUrl(req, '/sitemap.xml')}`, '',
    ].join('\n'));
});

let sitemapVideoCache = { expiresAt: 0, paths: [] };

async function getSitemapPaths() {
    // Hanya URL kanonis halaman yang boleh diindeks. Jangan masukkan URL
    // pencarian, pagination, redirect, /set-lang, atau halaman noindex.
    const paths = [
        { path: '/' },
        ...INDEXABLE_CATEGORIES.map(({ slug }) => ({ path: `/category/${slug}` })),
        ...COUNTRY_FILTERS.map(({ slug }) => ({ path: `/country/${slug}` })),
        { path: '/recommended' }, { path: '/live-sex' }, { path: '/models' }, { path: '/pornstars' },
        { path: '/terms' }, { path: '/privacy' }, { path: '/contact' },
        { path: '/blog' },
        ...BLOG_POSTS.map(({ slug }) => ({ path: `/blog/${slug}` })),
    ];

    // Tambahkan URL video nyata dari feed yang memang tersedia di situs.
    // Cache mencegah sitemap melakukan puluhan request API pada setiap crawl.
    if (sitemapVideoCache.expiresAt <= Date.now()) {
        const queries = [
            'popular', 'recommended', 'model',
            ...INDEXABLE_CATEGORIES.map(({ query }) => query),
            ...COUNTRY_FILTERS.map(({ query }) => query),
        ];
        const uniqueQueries = [...new Set(queries)];
        // Ambil beberapa halaman per feed agar sitemap berisi ratusan URL
        // nyata, bukan hanya hasil halaman pertama yang sering berulang.
        const requests = uniqueQueries.flatMap((query) =>
            [1, 2, 3].map((page) => ({ query, page }))
        );
        const results = await Promise.allSettled([
            ...requests.map(({ query, page }) => ph.searchVideo(query, { page })),
            // Feed umum memberi variasi video yang lebih besar daripada
            // pencarian kategori yang sering mengembalikan item berulang.
            ...Array.from({ length: 10 }, (_, index) => ph.videoList({ page: index + 1 })),
        ]);
        const videos = results.flatMap((result) =>
            result.status === 'fulfilled' && Array.isArray(result.value?.data)
                ? result.value.data : []
        );
        const seen = new Set();
        sitemapVideoCache.paths = videos
            .map((video) => videoPath(video))
            .filter((path) => path !== '/' && !seen.has(path) && seen.add(path))
            .slice(0, 45000)
            .map((path) => ({ path }));
        sitemapVideoCache.expiresAt = Date.now() + 6 * 60 * 60 * 1000;
    }

    // Pastikan tidak ada URL ganda bila feed atau konfigurasi kategori berubah.
    return [...new Map([...paths, ...sitemapVideoCache.paths].map((item) => [item.path, item])).values()];
}

app.get('/sitemap.xml', async (req, res) => {
    const configuredLastmod = String(process.env.SITEMAP_LASTMOD || '').trim();
    const lastmod = /^\d{4}-\d{2}-\d{2}$/.test(configuredLastmod) ? configuredLastmod : '';
    let paths;
    try {
        paths = await getSitemapPaths();
    } catch (error) {
        console.error('Sitemap data refresh failed:', error);
        paths = [{ path: '/' }];
    }
    const urls = paths.map(({ path }) => [
        '  <url>',
        `    <loc>${xmlEscape(absoluteUrl(req, path))}</loc>`,
        // lastmod hanya dikirim bila tanggal deploy dikonfigurasi, supaya
        // sitemap tidak memberi sinyal pembaruan palsu ke Google.
        lastmod ? `    <lastmod>${lastmod}</lastmod>` : '',
        '  </url>',
    ].filter(Boolean).join('\n')).join('\n');
    res.set('Cache-Control', 'public, max-age=3600, s-maxage=86400');
    res.status(200).type('application/xml').send([
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
        console.log(`Buka di browser: http://localhost:${port}`);
    });
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(__filename)) {
    startServer();
}

export default app;
