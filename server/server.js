const express = require('express');
const cors = require('cors');
const admin = require('firebase-admin');
const { getAuth } = require('firebase-admin/auth');

// ============================================
// 🔧 تهيئة Firebase Admin SDK (نفس البيانات)
// ============================================
const serviceAccount = {
    // هنا يجب وضع بيانات خدمة Firebase Admin SDK
    // يمكن الحصول عليها من Firebase Console > Project Settings > Service Accounts
    // "type": "service_account",
    // "project_id": "boomb-fa3e7",
    // ...
};

// إذا لم يكن لديك serviceAccount، يمكن استخدام متغيرات البيئة
// ولكن للاختبار، يمكن تفعيل وضع بدون مصادقة كاملة
const USE_EMULATOR = true; // ضع false عند وجود serviceAccount حقيقي

let auth;
if (!USE_EMULATOR && serviceAccount.project_id) {
    admin.initializeApp({
        credential: admin.credential.cert(serviceAccount),
        databaseURL: "https://boomb-fa3e7-default-rtdb.firebaseio.com"
    });
    auth = getAuth();
} else {
    // وضع التطوير - تحقق بسيط
    console.log('⚠️ WARNING: Running in development mode without full Firebase Admin');
    admin.initializeApp({
        projectId: "boomb-fa3e7",
        databaseURL: "https://boomb-fa3e7-default-rtdb.firebaseio.com"
    });
    auth = {
        verifyIdToken: async (token) => {
            // في وضع التطوير، نقبل أي توكن صالح الشكل
            if (token && token.length > 10) {
                return { uid: 'test_user_' + Date.now(), email: 'test@example.com' };
            }
            throw new Error('Invalid token');
        }
    };
}

const db = admin.database();
const app = express();

// Middleware
app.use(cors());
app.use(express.json());

// ============================================
// 📊 تخزين الجلسات النشطة
// ============================================
const activeSessions = new Map(); // token -> { uid, email, name, photoURL, createdAt }

// ============================================
// 🔐 API المصادقة
// ============================================

/**
 * POST /api/auth/google
 * تسجيل الدخول باستخدام Google
 * يرسل العميل idToken من Firebase Auth
 */
app.post('/api/auth/google', async (req, res) => {
    try {
        const { idToken, userData } = req.body;
        
        if (!idToken) {
            return res.status(400).json({ success: false, error: 'No token provided' });
        }
        
        // التحقق من التوكن باستخدام Firebase Admin
        let decodedToken;
        try {
            decodedToken = await auth.verifyIdToken(idToken);
        } catch (error) {
            console.error('Token verification failed:', error);
            return res.status(401).json({ success: false, error: 'Invalid token' });
        }
        
        const uid = decodedToken.uid;
        const email = decodedToken.email || userData?.email;
        const name = decodedToken.name || userData?.name || email?.split('@')[0];
        const photoURL = decodedToken.picture || userData?.photoURL || null;
        
        console.log(`✅ User authenticated: ${email} (${uid})`);
        
        // البحث عن المستخدم في قاعدة البيانات أو إنشاؤه
        const userRef = db.ref(`users/${uid}`);
        const snapshot = await userRef.once('value');
        let userRecord = snapshot.val();
        
        // التحقق من صلاحيات المدير
        const isAdmin = (email === 'admin2613857@boomb.com' || email === 'admin@boomb.com');
        
        if (!userRecord) {
            // إنشاء مستخدم جديد
            userRecord = {
                uid: uid,
                email: email,
                username: name,
                photoURL: photoURL,
                balance: 100,
                isAdmin: isAdmin,
                gamesPlayed: 0,
                wins: 0,
                createdAt: Date.now(),
                lastLogin: Date.now()
            };
            await userRef.set(userRecord);
            console.log(`🆕 New user created: ${email}`);
        } else {
            // تحديث آخر تسجيل دخول
            await userRef.update({
                lastLogin: Date.now(),
                username: name,
                photoURL: photoURL
            });
            console.log(`🔄 Existing user updated: ${email}`);
        }
        
        // إنشاء توكن جلسة للسيرفر
        const sessionToken = Buffer.from(`${uid}_${Date.now()}_${Math.random()}`).toString('base64');
        
        // تخزين الجلسة
        activeSessions.set(sessionToken, {
            uid: uid,
            email: email,
            name: name,
            photoURL: photoURL,
            isAdmin: isAdmin,
            createdAt: Date.now()
        });
        
        // تنظيف الجلسات القديمة (أكثر من 24 ساعة)
        const ONE_DAY = 24 * 60 * 60 * 1000;
        for (const [token, session] of activeSessions) {
            if (Date.now() - session.createdAt > ONE_DAY) {
                activeSessions.delete(token);
            }
        }
        
        res.json({
            success: true,
            token: sessionToken,
            user: {
                uid: uid,
                email: email,
                name: name,
                photoURL: photoURL,
                isAdmin: isAdmin
            },
            balance: userRecord.balance || 100,
            gamesPlayed: userRecord.gamesPlayed || 0,
            wins: userRecord.wins || 0
        });
        
    } catch (error) {
        console.error('Google auth error:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

/**
 * POST /api/auth/verify
 * التحقق من صحة توكن الجلسة
 */
app.post('/api/auth/verify', async (req, res) => {
    try {
        const { token } = req.body;
        
        if (!token) {
            return res.json({ valid: false });
        }
        
        const session = activeSessions.get(token);
        
        if (!session) {
            return res.json({ valid: false });
        }
        
        // الحصول على أحدث بيانات المستخدم
        const userRef = db.ref(`users/${session.uid}`);
        const snapshot = await userRef.once('value');
        const userData = snapshot.val();
        
        res.json({
            valid: true,
            user: {
                uid: session.uid,
                email: session.email,
                name: session.name,
                photoURL: session.photoURL
            },
            balance: userData?.balance || 100,
            gamesPlayed: userData?.gamesPlayed || 0,
            wins: userData?.wins || 0
        });
        
    } catch (error) {
        console.error('Verify error:', error);
        res.json({ valid: false });
    }
});

/**
 * POST /api/auth/logout
 * تسجيل الخروج
 */
app.post('/api/auth/logout', async (req, res) => {
    try {
        const { token } = req.body;
        
        if (token) {
            activeSessions.delete(token);
        }
        
        res.json({ success: true });
        
    } catch (error) {
        console.error('Logout error:', error);
        res.json({ success: false });
    }
});

/**
 * GET /api/user/:uid
 * الحصول على بيانات مستخدم
 */
app.get('/api/user/:uid', async (req, res) => {
    try {
        const { uid } = req.params;
        const userRef = db.ref(`users/${uid}`);
        const snapshot = await userRef.once('value');
        const userData = snapshot.val();
        
        if (!userData) {
            return res.status(404).json({ success: false, error: 'User not found' });
        }
        
        res.json({
            success: true,
            user: {
                uid: uid,
                email: userData.email,
                username: userData.username,
                photoURL: userData.photoURL,
                balance: userData.balance,
                gamesPlayed: userData.gamesPlayed,
                wins: userData.wins,
                isAdmin: userData.isAdmin || false
            }
        });
        
    } catch (error) {
        console.error('Get user error:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

/**
 * GET /api/health
 * التحقق من صحة السيرفر
 */
app.get('/api/health', (req, res) => {
    res.json({
        status: 'ok',
        timestamp: Date.now(),
        activeSessions: activeSessions.size
    });
});

// ============================================
// 🚀 تشغيل السيرفر
// ============================================
const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
    console.log(`
    ╔════════════════════════════════════════╗
    ║     🚀 Server is running!              ║
    ║     📡 Port: ${PORT}                      ║
    ║     🔐 Auth: Google Only               ║
    ║     👥 Active Sessions: 0              ║
    ╚════════════════════════════════════════╝
    `);
});

// تصدير للاستخدام في ملفات أخرى إذا لزم الأمر
module.exports = { app, activeSessions, db };
