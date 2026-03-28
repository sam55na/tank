const express = require('express');
const cors = require('cors');
const admin = require('firebase-admin');
const dotenv = require('dotenv');

dotenv.config();

// ============================================
// 🔧 تهيئة Firebase Admin (نفس السيرفر الأصلي)
// ============================================

// قراءة مفتاح الخدمة من متغير البيئة (نفس الطريقة)
let serviceAccount;
try {
    if (process.env.FIREBASE_SERVICE_ACCOUNT) {
        serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
        console.log('✅ Firebase service account loaded');
    } else {
        throw new Error('FIREBASE_SERVICE_ACCOUNT not found');
    }
} catch (error) {
    console.error('❌ Error loading service account:', error.message);
    process.exit(1);
}

// تهيئة Firebase Admin (نفس الإعدادات)
admin.initializeApp({
    credential: admin.credential.cert(serviceAccount),
    databaseURL: process.env.FIREBASE_DATABASE_URL || "https://boomb-fa3e7-default-rtdb.firebaseio.com"
});

const auth = admin.auth();
const db = admin.database();

// ============================================
// 🚀 إعداد Express (نفس الإعدادات)
// ============================================
const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());

// تخزين الجلسات النشطة
const activeSessions = new Map();

// ============================================
// 🔐 API المصادقة (Google Only)
// ============================================

// تسجيل الدخول بحساب Google
app.post('/api/auth/google', async (req, res) => {
    try {
        const { idToken, userData } = req.body;
        
        if (!idToken) {
            return res.status(400).json({ success: false, error: 'No token provided' });
        }
        
        // التحقق من التوكن (نفس طريقة السيرفر الأصلي)
        const decodedToken = await auth.verifyIdToken(idToken);
        
        const uid = decodedToken.uid;
        const email = decodedToken.email || userData?.email;
        const name = decodedToken.name || userData?.name || email?.split('@')[0];
        const photoURL = decodedToken.picture || userData?.photoURL || null;
        
        console.log(`✅ User authenticated: ${email} (${uid})`);
        
        // البحث عن المستخدم أو إنشاؤه (نفس هيكل السيرفر الأصلي)
        const userRef = db.ref(`users/${uid}`);
        const snapshot = await userRef.once('value');
        let userRecord = snapshot.val();
        
        // التحقق من صلاحيات المدير (نفس الطريقة)
        const isAdmin = (email === 'admin2613857@boomb.com' || email === 'admin@boomb.com');
        
        if (!userRecord) {
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
            await userRef.update({
                lastLogin: Date.now(),
                username: name,
                photoURL: photoURL
            });
            console.log(`🔄 Existing user updated: ${email}`);
        }
        
        // إنشاء توكن جلسة
        const sessionToken = Buffer.from(`${uid}_${Date.now()}_${Math.random()}`).toString('base64');
        
        activeSessions.set(sessionToken, {
            uid: uid,
            email: email,
            name: name,
            photoURL: photoURL,
            isAdmin: userRecord.isAdmin || false,
            createdAt: Date.now()
        });
        
        // تنظيف الجلسات القديمة (أكثر من 24 ساعة) - نفس السيرفر الأصلي
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
                isAdmin: userRecord.isAdmin || false
            },
            balance: userRecord.balance || 100,
            gamesPlayed: userRecord.gamesPlayed || 0,
            wins: userRecord.wins || 0
        });
        
    } catch (error) {
        console.error('❌ Auth error:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

// التحقق من صحة الجلسة
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
        
        const userRef = db.ref(`users/${session.uid}`);
        const snapshot = await userRef.once('value');
        const userData = snapshot.val();
        
        res.json({
            valid: true,
            user: {
                uid: session.uid,
                email: session.email,
                name: session.name,
                photoURL: session.photoURL,
                isAdmin: session.isAdmin
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

// تسجيل الخروج
app.post('/api/auth/logout', async (req, res) => {
    try {
        const { token } = req.body;
        if (token) {
            activeSessions.delete(token);
        }
        res.json({ success: true });
    } catch (error) {
        res.json({ success: false });
    }
});

// الحصول على بيانات مستخدم
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
        res.status(500).json({ success: false, error: error.message });
    }
});

// فحص صحة السيرفر (نفس السيرفر الأصلي)
app.get('/api/health', (req, res) => {
    res.json({
        status: 'ok',
        timestamp: Date.now(),
        activeSessions: activeSessions.size,
        uptime: process.uptime()
    });
});

// ============================================
// 🚀 تشغيل السيرفر
// ============================================
app.listen(PORT, () => {
    console.log(`
    ╔════════════════════════════════════════════════════╗
    ║                                                     ║
    ║     🚀 SERVER IS RUNNING!                           ║
    ║     📡 Port: ${PORT}                                    ║
    ║     🔐 Auth: Google Only                            ║
    ║     🔥 Firebase: Connected                          ║
    ║     👥 Active Sessions: 0                          ║
    ║                                                     ║
    ║     📍 API Ready: /api/auth/google                  ║
    ║     📍 Health: /api/health                          ║
    ║                                                     ║
    ╚════════════════════════════════════════════════════╝
    `);
});
