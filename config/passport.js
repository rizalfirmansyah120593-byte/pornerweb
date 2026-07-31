import { Strategy as LocalStrategy } from 'passport-local';
import User from '../models/User.js';
import bcrypt from 'bcryptjs';

export default function(passport) {
    passport.use(new LocalStrategy(async (username, password, done) => {
        try {
            const user = await User.findOne({ username: username });
            if (!user) return done(null, false, { message: 'User tidak ditemukan' });
            
            const isMatch = await bcrypt.compare(password, user.password);
            if (isMatch) return done(null, user);
            else return done(null, false, { message: 'Password salah' });
        } catch (err) {
            return done(err);
        }
    }));

    passport.serializeUser((user, done) => done(null, user.id));
    passport.deserializeUser(async (id, done) => {
        try {
            const user = await User.findById(id);
            done(null, user);
        } catch (err) {
            done(err, null);
        }
    });
}