import express from 'express';
import { fileURLToPath } from 'url';
import { dirname, join, resolve } from 'path';
import cookieParser from 'cookie-parser';
import { epornerSearch } from './eporner.js';

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
const SUPPORTED_LANGUAGES = ['id', 'en', 'ms', 'es', 'ja'];
const localized = (lang, values) => values[lang] || values.en;
const epornerId = (id) => `ep_${String(id).replace(/^ep_/, '')}`;
const isEpornerId = (id) => String(id || '').startsWith('ep_');
const epornerRawId = (id) => String(id || '').replace(/^ep_/, '');
function normalizeEpornerVideo(item) {
    if (!item?.id) return null;
    return { id: epornerId(item.id), source: 'eporner', title: item.title || 'Eporner video', preview: item.default_thumb?.src || item.thumbs?.[0]?.src || '', views: Number(item.views) || 0, duration: item.length_min || '', durationFormatted: item.length_min || '', url: `/watch/${encodeURIComponent(epornerId(item.id))}`, embed: item.embed || `https://www.eporner.com/embed/${encodeURIComponent(item.id)}/`, tags: String(item.keywords || '').split(',').map((tag) => tag.trim()).filter(Boolean).slice(0, 12) };
}
async function getEpornerRecommendations(excludeId) {
    const result = await epornerSearch({ query: 'all', page: 1, perPage: 24, thumbsize: 'big', order: 'most-popular' });
    return (Array.isArray(result?.videos) ? result.videos : [])
        .map(normalizeEpornerVideo).filter((item) => item && item.id !== excludeId)
        .sort(() => Math.random() - 0.5).slice(0, 16);
}

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
    const detectedLanguage = req.acceptsLanguages(...SUPPORTED_LANGUAGES) || 'id';
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
    const separator = canonicalBase.includes('?') ? '&' : '?';
    const canonicalPath = page > 1 ? `${canonicalBase}${separator}page=${page}` : canonicalBase;
    const paginationPath = (target) => target > 1 ? `${canonicalBase}${separator}page=${target}` : canonicalBase;

    try {
        const result = await ph.searchVideo(query, { page });
        let videos = (result?.data || []).map((item) => ({ ...item, source: 'pornhub' }));
        try {
            const epornerResult = await epornerSearch({ query: query || 'all', page, perPage: 12, thumbsize: 'big', order: 'latest' });
            if (req.query.source !== 'pornhub') videos.push(...(Array.isArray(epornerResult?.videos) ? epornerResult.videos.map(normalizeEpornerVideo).filter(Boolean) : []));
            videos.sort(() => Math.random() - 0.5);
        } catch (error) {
            console.error('[Eporner] Gagal memuat video tambahan:', error.message);
        }
        if (req.query.source === 'eporner') videos = videos.filter((item) => item.source === 'eporner');
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
        let trendingPornstars = [];
        try {
            const starPage = Math.floor(Math.random() * 3) + 1;
            const starResult = await ph.pornstarList({ page: starPage });
            trendingPornstars = (Array.isArray(starResult?.data) ? starResult.data : [])
                .sort(() => Math.random() - 0.5).slice(0, 4);
        } catch (error) {
            console.error('[Trending Pornstars] Gagal memuat:', error.message);
        }

        if (!shouldIndex) res.set('X-Robots-Tag', 'noindex, follow');
        return res.render('index', {
            data: videos, title: heading, intro: description, query, currentPage: page,
            totalPages, paginationPath, seo, trendingPornstars,
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

app.get('/random', async (req, res, next) => {
    try {
        const result = await ph.searchVideo('popular', { page: 1 });
        const items = Array.isArray(result?.data) ? result.data : [];
        const item = items[Math.floor(Math.random() * items.length)];
        return item?.id ? res.redirect(`/watch/${encodeURIComponent(item.id)}`) : next();
    } catch { return next(); }
});

// Media preview is loaded on demand so listing pages do not download every
// video's source before the visitor actually hovers a card.
app.get('/api/video-preview/:id', async (req, res) => {
    const id = extractVideoId(req.params.id);
    if (!id) return res.status(400).json({ error: 'Invalid video id' });

    try {
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
        console.error(`[Preview] Gagal memuat ${id}:`, error.message);
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
    const page = parsePage(req.query.page);
    const gender = ['female', 'male'].includes(String(req.query.gender)) ? String(req.query.gender) : '';
    try {
        const result = await ph.pornstarList({ page, ...(gender ? { gender } : {}) });
        const pornstars = Array.isArray(result?.data) ? result.data : [];
        const totalPages = Math.max(1, Math.min(Number(result?.paging?.maxPage) || 10, 100));
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
                robots: page > 1 ? 'noindex, follow' : undefined,
            }),
        });
    } catch (error) {
        console.error('[Pornstars] Gagal memuat daftar:', error.message);
        return res.status(502).render('error', {
            statusCode: 502,
            message: localized(res.locals.lang, { id: 'Daftar pornstar sedang tidak tersedia.', en: 'Pornstar list is temporarily unavailable.', ms: 'Senarai pornstar tidak tersedia buat sementara waktu.', es: 'La lista de pornstars no está disponible temporalmente.', ja: 'ポルノスター一覧は一時的に利用できません。' }),
            seo: buildSeo(req, { title: 'Pornstar Tidak Tersedia', description: 'Daftar pornstar tidak dapat dimuat.', pathname: '/pornstars', robots: 'noindex, nofollow' }),
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
            const description = `${localized(res.locals.lang, { id: 'Tonton', en: 'Watch', ms: 'Tonton', es: 'Mira', ja: 'Watch' })} ${videoData.title}. Adults 18+ only.`;
            let recommendations = [];
            try { recommendations = await getEpornerRecommendations(id); } catch (error) { console.error('[Eporner] Rekomendasi gagal:', error.message); }
            return res.render('watch', { video: { ...videoData, description, mediaDefinitions: [] }, recommendations, localUrl: `/watch/${id}`, seo: buildSeo(req, { title: videoData.title, description, pathname: `/watch/${id}`, image: videoData.preview, explicit: true, video: videoData.embed }) });
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
                try { recommendations.push(...(await getEpornerRecommendations(id)).slice(0, 16 - recommendations.length)); } catch (error) { console.error('[Eporner] Rekomendasi tambahan gagal:', error.message); }
            }
        } catch (error) {
            console.error(`Gagal mengambil rekomendasi untuk ${id}:`, error.message);
            try { recommendations = await getEpornerRecommendations(id); } catch (fallbackError) { console.error('[Recommendations] Semua sumber gagal:', fallbackError.message); }
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
        const lang = SUPPORTED_LANGUAGES.includes(requestedLanguage) ? requestedLanguage : 'id';
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
        { path: '/recommended' }, { path: '/models' }, { path: '/pornstars' },
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

    return [...paths, ...sitemapVideoCache.paths];
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
    });
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(__filename)) {
    startServer();
}

export default app;
