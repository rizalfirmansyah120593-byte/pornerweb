import express from 'express';
import passport from 'passport';
import User from '../models/User.js'; // Penting: Harus pakai .js di akhir

const router = express.Router();

// Halaman Signup
router.get('/signup', (req, res) => res.render('signup'));

// Proses Signup
router.post('/signup', async (req, res) => {
    try {
        const { username, password } = req.body;
        const newUser = new User({ username, password });
        await newUser.save();
        res.redirect('/login');
    } catch (err) {
        res.status(400).send('Gagal mendaftar: ' + err.message);
    }
});

// Halaman Login
router.get('/login', (req, res) => res.render('login'));

// Proses Login
router.post('/login', passport.authenticate('local', {
    successRedirect: '/',
    failureRedirect: '/login',
    failureFlash: false
}));

// Logout
router.get('/logout', (req, res) => {
    req.logout((err) => {
        if (err) return next(err);
        res.redirect('/');
    });
});

export default router; // Ini wajib diganti dari module.exports