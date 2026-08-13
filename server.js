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
