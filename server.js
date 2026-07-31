import express from 'express';
import { fileURLToPath } from 'url';
import { dirname } from 'path';
import session from 'express-session';
import passport from 'passport';
import mongoose from 'mongoose';
import cookieParser from 'cookie-parser';

import { PornHub } from './Pornhub.js-master/dist/index.mjs';
const ph = new PornHub(); 

import authRoutes from './routes/auth.js';
import configurePassport from './config/passport.js';

// --- INISIALISASI APP ---
const app = express();
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// --- MIDDLEWARE ---
app.use(cookieParser());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static('public'));

// --- KONFIGURASI DATABASE ---
const dbURI = 'mongodb://127.0.0.1:27017/PORNERWEB';
mongoose.connect(dbURI)
    .then(() => console.log('Berhasil terhubung ke MongoDB!'))
    .catch((err) => console.error('Gagal terhubung ke MongoDB:', err));

// --- KONFIGURASI AUTH & SESSION ---
configurePassport(passport);
app.use(session({
    secret: 'secret-key-anda', 
    resave: false,
    saveUninitialized: false
}));
app.use(passport.initialize());
app.use(passport.session());

// --- GLOBAL MIDDLEWARE ---
app.use((req, res, next) => {
    res.locals.user = req.user || null;
    const lang = req.cookies.lang || 'id';
    res.locals.lang = lang;
    res.locals.t = {
        id: { placeholder: "Cari video...", menu: "Menu", negara: "Negara", kategori: "Kategori", searchBtn: "Cari", langSelect: "ID" },
        en: { placeholder: "Search...", menu: "Menu", negara: "Countries", kategori: "Categories", searchBtn: "Search", langSelect: "EN" }
    }[lang];
    next();
});

app.set('view engine', 'ejs');

// --- ROUTES ---
app.use('/', authRoutes);

// Rute Halaman Utama & Pencarian (Disederhanakan & Aman)
app.get('/', async (req, res) => {
    const query = req.query.q || 'popular'; // Default ke 'popular' jika tidak ada query
    const page = parseInt(req.query.page) || 1;

    if (query) {
        // 1. Ganti tanda '-' menjadi spasi ' ' agar lebih mudah dibaca mesin pencari
        let cleanQuery = query.replace(/-/g, ' '); 

        console.log(`[Home/Search] Mencari: ${cleanQuery}, Halaman: ${page}`);

        try {
            // 2. Lakukan pencarian HANYA SATU KALI menggunakan cleanQuery
            const result = await ph.searchVideo(cleanQuery, { page: page });
            
            // Memastikan data selalu berupa array meskipun API mengembalikan null/undefined
            const videos = result?.data || [];

            // 3. Gunakan 'return' saat render agar eksekusi berhenti dengan aman
            return res.render('index', {
                data: videos,
                title: `Search Results: ${cleanQuery}`, // Lebih baik menampilkan nama yang sudah dibersihkan
                query: req.query.q || "",      // Kirim query asli jika butuh untuk mempertahankan parameter URL
                currentPage: page
            });

        } catch (err) {
            console.error("Server Error (Home):", err.message);
            
            // Gunakan 'return' di catch juga
            return res.render('index', { 
                data: [], 
                title: "Error", 
                query: "", 
                currentPage: 1 
            });
        }
    }
});

app.get('/watch', async (req, res) => {
    // 1. Ambil URL dari parameter query 'url'
    const videoUrl = req.query.url;

    if (!videoUrl) {
        return res.redirect('/'); // Kembali ke home jika tidak ada URL
    }

    try {
        // 2. Gunakan scraper Anda untuk mengambil data detail video
        const videoData = await ph.video(videoUrl);
        
        // 3. Render halaman watch dan kirim data videonya
        res.render('watch', { video: videoData });
    } catch (err) {
        console.error("Gagal memuat detail video:", err);
        res.status(500).send("Video tidak dapat ditemukan.");
    }
});

// Route Pembantu
app.get('/set-lang', (req, res) => {
    res.cookie('lang', req.query.lang, { maxAge: 30 * 24 * 60 * 60 * 1000 });
    res.redirect(req.get('Referer') || '/');
});

app.get('/pornstar', async (req, res) => {
    try {
        const query = req.query.q || 'pornstar'; // Default ke 'pornstar' jika tidak ada query
        // Ambil halaman dari query string, default ke 1 jika tidak ada
        const currentPage = parseInt(req.query.page) || 1; 

        const result = await ph.searchPornstar(query);

        return res.render('index', { 
            data: result.data || [], 
            query: query,
            title: 'Search Results: ' + query,
            currentPage: currentPage // <--- TAMBAHKAN INI
        });
    } catch (error) {
        console.error("Error:", error);
        res.status(500).send("Gagal mengambil data.");
    }
});
// Tambahkan rute ini ke dalam server.js Anda

app.get('/terms', (req, res) => {
    res.render('terms', { title: 'Terms of Service' });
});

app.get('/privacy', (req, res) => {
    res.render('privacy', { title: 'Privacy Policy' });
});

app.get('/contact', (req, res) => {
    res.render('contact', { title: 'Contact Us' });
});

// --- START SERVER ---
app.listen(3000, () => console.log("Server berjalan di http://localhost:3000"));