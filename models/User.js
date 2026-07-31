import mongoose from 'mongoose';
import bcrypt from 'bcryptjs';

// Deklarasikan schema hanya SATU KALI
const UserSchema = new mongoose.Schema({
    fullname: { type: String, required: true },
    email: { type: String, required: true, unique: true },
    username: { type: String, required: true, unique: true },
    password: { type: String, required: true }
});

// Middleware untuk hash password
UserSchema.pre('save', async function() {
    if (!this.isModified('password')) return;
    this.password = await bcrypt.hash(this.password, 10);
});

// Ekspor model
export default mongoose.model('User', UserSchema);