const express = require('express');
const cors = require('cors');
const admin = require('firebase-admin');

// ============================================
// 1. تهيئة Firebase Admin SDK
// ============================================
// قم بإنشاء ملف serviceAccountKey.json من Firebase Console
// Project Settings > Service Accounts > Generate New Private Key
const serviceAccount = require('./serviceAccountKey.json');

admin.initializeApp({
    credential: admin.credential.cert(serviceAccount),
    databaseURL: "https://boomb-fa3e7-default-rtdb.firebaseio.com"
});

const db = admin.database();
const app = express();
const PORT = process.env.PORT || 3000;

// ============================================
// 2. Middleware
// ============================================
app.use(cors());
app.use(express.json());

// ============================================
// 3. API: جلب بيانات المستخدم
//    GET /api/user/data?uid=xxxx
// ============================================
app.get('/api/user/data', async (req, res) => {
    try {
        const { uid } = req.query;
        const token = req.headers.authorization?.split(' ')[1];

        if (!uid) {
            return res.status(400).json({ success: false, error: 'UID is required' });
        }

        // التحقق من صحة التوكن (اختياري ولكن موصى به)
        if (token) {
            try {
                await admin.auth().verifyIdToken(token);
            } catch (err) {
                return res.status(401).json({ success: false, error: 'Invalid token' });
            }
        }

        const snapshot = await db.ref(`users/${uid}`).once('value');
        const userData = snapshot.val();

        if (!userData) {
            return res.json({
                success: true,
                balance: 100,
                gamesPlayed: 0,
                wins: 0
            });
        }

        res.json({
            success: true,
            balance: userData.balance || 100,
            gamesPlayed: userData.gamesPlayed || 0,
            wins: userData.wins || 0
        });

    } catch (error) {
        console.error('Error fetching user data:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

// ============================================
// 4. API: إنشاء مستخدم جديد
//    POST /api/user/create
// ============================================
app.post('/api/user/create', async (req, res) => {
    try {
        const { uid, email, displayName } = req.body;
        const token = req.headers.authorization?.split(' ')[1];

        if (!uid || !email) {
            return res.status(400).json({ success: false, error: 'UID and email are required' });
        }

        // التحقق من صحة التوكن
        if (token) {
            try {
                await admin.auth().verifyIdToken(token);
            } catch (err) {
                return res.status(401).json({ success: false, error: 'Invalid token' });
            }
        }

        // التحقق من وجود المستخدم مسبقاً
        const snapshot = await db.ref(`users/${uid}`).once('value');
        
        if (snapshot.exists()) {
            return res.json({ success: true, message: 'User already exists' });
        }

        // إنشاء مستخدم جديد
        await db.ref(`users/${uid}`).set({
            email: email,
            username: displayName || email.split('@')[0],
            balance: 100,
            gamesPlayed: 0,
            wins: 0,
            createdAt: Date.now()
        });

        res.json({ success: true, message: 'User created successfully' });

    } catch (error) {
        console.error('Error creating user:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

// ============================================
// 5. API: تحديث رصيد المستخدم (بعد اللعب)
//    POST /api/user/update
// ============================================
app.post('/api/user/update', async (req, res) => {
    try {
        const { uid, balance, gamesPlayed, wins } = req.body;
        const token = req.headers.authorization?.split(' ')[1];

        if (!uid) {
            return res.status(400).json({ success: false, error: 'UID is required' });
        }

        // التحقق من صحة التوكن
        if (token) {
            try {
                await admin.auth().verifyIdToken(token);
            } catch (err) {
                return res.status(401).json({ success: false, error: 'Invalid token' });
            }
        }

        const updates = {};
        if (balance !== undefined) updates.balance = balance;
        if (gamesPlayed !== undefined) updates.gamesPlayed = gamesPlayed;
        if (wins !== undefined) updates.wins = wins;
        updates.lastUpdated = Date.now();

        await db.ref(`users/${uid}`).update(updates);

        res.json({ success: true, message: 'User updated successfully' });

    } catch (error) {
        console.error('Error updating user:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

// ============================================
// 6. اختبار الاتصال
// ============================================
app.get('/api/health', (req, res) => {
    res.json({ status: 'ok', timestamp: Date.now() });
});

// ============================================
// 7. تشغيل السيرفر
// ============================================
app.listen(PORT, () => {
    console.log(`✅ Server running on port ${PORT}`);
    console.log(`📡 API endpoints:`);
    console.log(`   GET  /api/user/data?uid=xxx`);
    console.log(`   POST /api/user/create`);
    console.log(`   POST /api/user/update`);
    console.log(`   GET  /api/health`);
});
