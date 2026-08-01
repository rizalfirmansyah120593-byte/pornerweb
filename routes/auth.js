import express from 'express';
import passport from 'passport';
import User from '../models/User.js'; // Penting: Harus pakai .js di akhir

const router = express.Router();

async function loadFeaturedVideos(req) {
    try {
        const ph = req.app.locals.ph;
        const result = await ph.searchVideo('popular', { page: 1 });
        return Array.isArray(result?.data) ? result.data.slice(0, 6) : [];
    } catch (error) {
        console.error('[SidebarContent] Gagal memuat video unggulan:', error.message);
        return [];
    }
}

// Halaman Signup
router.get('/signup', async (req, res) => {
    const featuredVideos = await loadFeaturedVideos(req);
    res.render('signup', {
        error: null,
        featuredVideos,
        pageTitle: 'Buat akun',
        pageIntro: 'Daftar sekarang untuk pengalaman browsing yang lebih personal dan nyaman.',
        pageBadge: 'Akun',
    });
});

// Proses Signup
router.post('/signup', async (req, res) => {
    try {
        const { fullname, email, username, password, confirmPassword } = req.body;
        if (password !== confirmPassword) {
            return res.status(400).render('signup', { error: 'Konfirmasi password tidak cocok.' });
        }
        const newUser = new User({ fullname, email, username, password });
        await newUser.save();
        res.redirect('/login');
    } catch (err) {
        const message = err?.code === 11000
            ? 'Email atau username sudah digunakan.'
            : 'Pendaftaran gagal. Periksa kembali data Anda.';
        const featuredVideos = await loadFeaturedVideos(req);
        res.status(400).render('signup', {
            error: message,
            featuredVideos,
            pageTitle: 'Buat akun',
            pageIntro: 'Daftar sekarang untuk pengalaman browsing yang lebih personal dan nyaman.',
            pageBadge: 'Akun',
        });
    }
});

// Halaman Login
router.get('/login', async (req, res) => {
    const featuredVideos = await loadFeaturedVideos(req);
    res.render('login', {
        featuredVideos,
        pageTitle: 'Masuk ke akun',
        pageIntro: 'Akses akun Anda dan lanjutkan menjelajahi konten favorit.',
        pageBadge: 'Akun',
    });
});

// Proses Login
router.post('/login', passport.authenticate('local', {
    successRedirect: '/',
    failureRedirect: '/login',
    failureFlash: false
}));

// Logout
router.get('/logout', (req, res, next) => {
    req.logout((err) => {
        if (err) return next(err);
        res.redirect('/');
    });
});

export default router; // Ini wajib diganti dari module.exports
