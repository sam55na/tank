const express = require('express');
const cors = require('cors');
const admin = require('firebase-admin');
const { getAuth } = require('firebase-admin/auth');
const http = require('http');
const { Server } = require('socket.io');

// ============================================
// 🔧 قراءة متغيرات البيئة من Render
// ============================================

// مفتاح الخدمة - متغير بيئة في Render
const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);

// تهيئة Firebase Admin
admin.initializeApp({
    credential: admin.credential.cert(serviceAccount),
    databaseURL: process.env.FIREBASE_DATABASE_URL || "https://boomb-fa3e7-default-rtdb.firebaseio.com"
});

const auth = getAuth();
const db = admin.database();

// ============================================
// 🚀 إعداد Express و Socket.io
// ============================================
const app = express();
const server = http.createServer(app);
const io = new Server(server, {
    cors: {
        origin: "*",
        methods: ["GET", "POST"]
    }
});

// Middleware
app.use(cors());
app.use(express.json());

// متغيرات البيئة المهمة
const PORT = process.env.PORT || 3000;
const ADMIN_SECRET_KEY = process.env.ADMIN_SECRET_KEY;

// ============================================
// 📊 تخزين الجلسات النشطة
// ============================================
const activeSessions = new Map(); // token -> { uid, email, name, photoURL, isAdmin, createdAt }
const players = new Map(); // socketId -> player data

// ============================================
// 🔐 API المصادقة
// ============================================

/**
 * POST /api/auth/google
 * تسجيل الدخول باستخدام Google
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
        
        // التحقق من صلاحيات المدير (من خلال البريد الإلكتروني أو توكن خاص)
        const isAdmin = (email === 'admin2613857@boomb.com' || 
                        email === 'admin@boomb.com' ||
                        userData?.isAdmin === true);
        
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
            isAdmin: userRecord.isAdmin || false,
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
                isAdmin: userRecord.isAdmin || false
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

// ============================================
// 👑 API المشرف (Admin)
// ============================================

/**
 * POST /api/admin/verify
 * التحقق من صلاحيات المشرف
 */
app.post('/api/admin/verify', async (req, res) => {
    try {
        const { adminToken, userId } = req.body;
        
        // التحقق من توكن المشرف السري
        if (adminToken === ADMIN_SECRET_KEY) {
            return res.json({ success: true, isAdmin: true });
        }
        
        // أو التحقق من أن المستخدم مشرف في قاعدة البيانات
        if (userId) {
            const userRef = db.ref(`users/${userId}`);
            const snapshot = await userRef.once('value');
            const userData = snapshot.val();
            
            if (userData?.isAdmin === true) {
                return res.json({ success: true, isAdmin: true });
            }
        }
        
        res.status(403).json({ success: false, isAdmin: false });
        
    } catch (error) {
        console.error('Admin verify error:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

/**
 * GET /api/admin/stats
 * إحصائيات عامة (للمشرف فقط)
 */
app.get('/api/admin/stats', async (req, res) => {
    try {
        const { adminToken, userId } = req.query;
        
        // التحقق من صلاحيات المشرف
        if (adminToken !== ADMIN_SECRET_KEY) {
            const userRef = db.ref(`users/${userId}`);
            const snapshot = await userRef.once('value');
            if (!snapshot.val()?.isAdmin) {
                return res.status(403).json({ success: false, error: 'Unauthorized' });
            }
        }
        
        const usersSnapshot = await db.ref('users').once('value');
        const users = usersSnapshot.val() || {};
        
        let totalUsers = 0;
        let totalBalance = 0;
        let totalGames = 0;
        let totalWins = 0;
        const usersList = [];
        
        for (const [id, data] of Object.entries(users)) {
            totalUsers++;
            totalBalance += data.balance || 0;
            totalGames += data.gamesPlayed || 0;
            totalWins += data.wins || 0;
            usersList.push({
                uid: id,
                email: data.email,
                username: data.username,
                balance: data.balance,
                gamesPlayed: data.gamesPlayed,
                wins: data.wins,
                isAdmin: data.isAdmin || false,
                lastLogin: data.lastLogin
            });
        }
        
        res.json({
            success: true,
            stats: {
                totalUsers,
                totalBalance,
                totalGames,
                totalWins,
                activeSessions: activeSessions.size,
                users: usersList
            }
        });
        
    } catch (error) {
        console.error('Admin stats error:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

/**
 * POST /api/admin/balance
 * تعديل رصيد المستخدم (للمشرف فقط)
 */
app.post('/api/admin/balance', async (req, res) => {
    try {
        const { adminToken, userId, targetUserId, amount, action } = req.body;
        
        // التحقق من صلاحيات المشرف
        if (adminToken !== ADMIN_SECRET_KEY) {
            const userRef = db.ref(`users/${userId}`);
            const snapshot = await userRef.once('value');
            if (!snapshot.val()?.isAdmin) {
                return res.status(403).json({ success: false, error: 'Unauthorized' });
            }
        }
        
        if (!targetUserId || !amount) {
            return res.status(400).json({ success: false, error: 'Missing required fields' });
        }
        
        const targetRef = db.ref(`users/${targetUserId}`);
        const snapshot = await targetRef.once('value');
        let currentBalance = snapshot.val()?.balance || 100;
        
        if (action === 'deposit') {
            currentBalance += amount;
        } else if (action === 'withdraw') {
            if (currentBalance < amount) {
                return res.json({ success: false, error: 'Insufficient balance' });
            }
            currentBalance -= amount;
        } else {
            return res.json({ success: false, error: 'Invalid action' });
        }
        
        await targetRef.update({ balance: currentBalance });
        
        // تسجيل المعاملة
        const transactionRef = db.ref(`transactions/${targetUserId}`).push();
        await transactionRef.set({
            type: action,
            amount: amount,
            balanceAfter: currentBalance,
            timestamp: Date.now(),
            adminId: userId
        });
        
        res.json({ success: true, newBalance: currentBalance });
        
    } catch (error) {
        console.error('Admin balance error:', error);
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
        activeSessions: activeSessions.size,
        uptime: process.uptime()
    });
});

// ============================================
// 🔌 أحداث Socket.io (للمشاريع المستقبلية)
// ============================================

io.on('connection', (socket) => {
    console.log(`🔌 New connection: ${socket.id}`);
    
    // حفظ بيانات اللاعب
    players.set(socket.id, {
        socketId: socket.id,
        userId: null,
        email: null,
        roomId: null,
        connectedAt: Date.now()
    });
    
    // المصادقة عبر Socket (اختياري)
    socket.on('auth', async (data) => {
        const { token } = data;
        
        if (!token) {
            socket.emit('auth_error', { message: 'No token provided' });
            return;
        }
        
        const session = activeSessions.get(token);
        
        if (!session) {
            socket.emit('auth_error', { message: 'Invalid session' });
            return;
        }
        
        const player = players.get(socket.id);
        if (player) {
            player.userId = session.uid;
            player.email = session.email;
            player.isAdmin = session.isAdmin;
        }
        
        socket.emit('auth_success', {
            userId: session.uid,
            email: session.email,
            name: session.name,
            isAdmin: session.isAdmin
        });
        
        console.log(`✅ Socket authenticated: ${session.email}`);
    });
    
    socket.on('disconnect', () => {
        console.log(`🔌 Disconnected: ${socket.id}`);
        players.delete(socket.id);
    });
});

// ============================================
// 🚀 تشغيل السيرفر
// ============================================

server.listen(PORT, () => {
    console.log(`
    ╔════════════════════════════════════════════════════╗
    ║                                                     ║
    ║     🚀 SERVER IS RUNNING!                           ║
    ║     📡 Port: ${PORT}                                    ║
    ║     🔐 Auth: Google Only                            ║
    ║     👑 Admin: ${ADMIN_SECRET_KEY ? 'Enabled' : 'Disabled'}                            ║
    ║     👥 Active Sessions: 0                          ║
    ║                                                     ║
    ║     📍 Ready to accept connections                  ║
    ║                                                     ║
    ╚════════════════════════════════════════════════════╝
    `);
});

// تصدير للاستخدام
module.exports = { app, server, io, activeSessions, players, db };
