const express = require('express');
const cors = require('cors');
const admin = require('firebase-admin');
const NodeCache = require('node-cache');
const rateLimit = require('express-rate-limit');
const compression = require('compression');

// ============================================
// 1. تهيئة Firebase Admin SDK من متغيرات البيئة
// ============================================

const serviceAccount = {
    type: process.env.FIREBASE_TYPE,
    project_id: process.env.FIREBASE_PROJECT_ID,
    private_key_id: process.env.FIREBASE_PRIVATE_KEY_ID,
    private_key: process.env.FIREBASE_PRIVATE_KEY?.replace(/\\n/g, '\n'),
    client_email: process.env.FIREBASE_CLIENT_EMAIL,
    client_id: process.env.FIREBASE_CLIENT_ID,
    auth_uri: process.env.FIREBASE_AUTH_URI,
    token_uri: process.env.FIREBASE_TOKEN_URI,
    auth_provider_x509_cert_url: process.env.FIREBASE_AUTH_PROVIDER_CERT_URL,
    client_x509_cert_url: process.env.FIREBASE_CLIENT_CERT_URL,
    universe_domain: process.env.FIREBASE_UNIVERSE_DOMAIN
};

// التحقق من وجود المتغيرات الضرورية
if (!process.env.FIREBASE_PROJECT_ID) {
    console.error('❌ Firebase configuration missing! Please check environment variables.');
    process.exit(1);
}

admin.initializeApp({
    credential: admin.credential.cert(serviceAccount),
    databaseURL: process.env.FIREBASE_DATABASE_URL,
    databaseAuthVariableOverride: null
});

const db = admin.database();
const app = express();
const PORT = process.env.PORT || 3000;

// ============================================
// 2. إعداد Cache و Rate Limiting
// ============================================

// Cache للبيانات مع وقت انتهاء مختلف لكل نوع
const userCache = new NodeCache({ stdTTL: 60, checkperiod: 120 }); // 60 ثانية للمستخدمين
const codeCache = new NodeCache({ stdTTL: 300, checkperiod: 600 }); // 5 دقائق للكودات
const tokenCache = new NodeCache({ stdTTL: 300, checkperiod: 600 }); // 5 دقائق للتوكنات

// Rate limiting حسب نوع الـ endpoint
const strictLimiter = rateLimit({
    windowMs: 15 * 60 * 1000, // 15 minutes
    max: 50, // limit each IP to 50 requests per windowMs
    message: { success: false, error: 'Too many requests, please try again later.' }
});

const moderateLimiter = rateLimit({
    windowMs: 15 * 60 * 1000, // 15 minutes
    max: 200, // limit each IP to 200 requests per windowMs
    message: { success: false, error: 'Too many requests, please try again later.' }
});

// ============================================
// 3. Middleware
// ============================================

app.use(cors({
    origin: ['https://tank-yf0p.onrender.com', 'http://localhost:3000', 'http://localhost:5500'],
    credentials: true,
    optionsSuccessStatus: 200
}));

app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));
app.use(compression());

// تطبيق rate limiting على الـ API routes
app.use('/api/', moderateLimiter);
app.use('/api/friends/', strictLimiter);
app.use('/api/user/update', strictLimiter);
app.use('/api/user/batch-update', strictLimiter);

// Logging middleware
app.use((req, res, next) => {
    console.log(`${new Date().toISOString()} - ${req.method} ${req.path}`);
    next();
});

// ============================================
// 4. Helper Functions محسنة
// ============================================

/**
 * التحقق من صحة التوكن مع caching
 */
async function verifyToken(req) {
    const token = req.headers.authorization?.split(' ')[1];
    if (!token) throw new Error('No token provided');
    
    // استخدام cache للتوكنات
    let decoded = tokenCache.get(token);
    
    if (!decoded) {
        try {
            decoded = await admin.auth().verifyIdToken(token);
            tokenCache.set(token, decoded, 300); // Cache لمدة 5 دقائق
        } catch (error) {
            throw new Error('Invalid token');
        }
    }
    
    return decoded;
}

/**
 * جلب بيانات المستخدم مع caching
 */
async function getUserData(uid, useCache = true) {
    if (!uid) return null;
    
    if (useCache) {
        const cached = userCache.get(uid);
        if (cached) return cached;
    }
    
    const snapshot = await db.ref(`users/${uid}`).once('value');
    const userData = snapshot.val();
    
    if (userData && useCache) {
        userCache.set(uid, userData, 60); // Cache لمدة 60 ثانية
    }
    
    return userData;
}

/**
 * تحديث بيانات المستخدم ومسح الكاش
 */
async function updateUserData(uid, updates) {
    if (!uid || !updates || Object.keys(updates).length === 0) return false;
    
    const updateObject = {
        ...updates,
        lastUpdated: Date.now()
    };
    
    await db.ref(`users/${uid}`).update(updateObject);
    
    // مسح الكاش
    userCache.del(uid);
    
    return true;
}

/**
 * توليد كود فريد للمستخدم
 */
async function generateUniqueCode() {
    let userIdCode;
    let exists = true;
    let attempts = 0;
    const maxAttempts = 10;
    
    while (exists && attempts < maxAttempts) {
        userIdCode = Math.floor(1000000000 + Math.random() * 9000000000).toString();
        const snapshot = await db.ref(`users_by_code/${userIdCode}`).once('value');
        exists = snapshot.exists();
        attempts++;
    }
    
    if (attempts >= maxAttempts) {
        throw new Error('Failed to generate unique code');
    }
    
    return userIdCode;
}

/**
 * جلب بيانات المستخدم كاملة (مع الأصدقاء والطلبات)
 */
async function getFullUserData(uid) {
    const userData = await getUserData(uid);
    
    if (!userData) {
        return {
            user: null,
            friends: [],
            friendRequests: []
        };
    }
    
    // جلب الأصدقاء وطلبات الصداقة بشكل متوازي
    const friendsUids = userData.friends || [];
    const requestsUids = userData.friendRequests || [];
    
    const [friendsData, requestsData] = await Promise.all([
        Promise.all(friendsUids.map(async (friendUid) => {
            const friend = await getUserData(friendUid);
            return friend ? {
                uid: friendUid,
                username: friend.username,
                email: friend.email,
                userIdCode: friend.userIdCode,
                balance: friend.balance,
                isActive: false
            } : null;
        })),
        Promise.all(requestsUids.map(async (requesterUid) => {
            const requester = await getUserData(requesterUid);
            return requester ? {
                uid: requesterUid,
                username: requester.username,
                email: requester.email,
                userIdCode: requester.userIdCode
            } : null;
        }))
    ]);
    
    return {
        user: userData,
        friends: friendsData.filter(f => f !== null),
        friendRequests: requestsData.filter(r => r !== null)
    };
}

// ============================================
// 5. API: جلب جميع بيانات المستخدم دفعة واحدة
// ============================================

/**
 * GET /api/user/full-data
 * جلب جميع بيانات المستخدم (الرصيد، الأصدقاء، الطلبات) في طلب واحد
 */
app.get('/api/user/full-data', async (req, res) => {
    try {
        const { uid } = req.query;
        const decoded = await verifyToken(req);

        if (!uid || decoded.uid !== uid) {
            return res.status(403).json({ 
                success: false, 
                error: 'Unauthorized access' 
            });
        }

        const { user, friends, friendRequests } = await getFullUserData(uid);

        if (!user) {
            return res.json({
                success: true,
                user: {
                    balance: 100,
                    gamesPlayed: 0,
                    wins: 0,
                    userIdCode: null,
                    username: null,
                    email: null
                },
                friends: [],
                friendRequests: []
            });
        }

        res.json({
            success: true,
            user: {
                balance: user.balance || 100,
                gamesPlayed: user.gamesPlayed || 0,
                wins: user.wins || 0,
                userIdCode: user.userIdCode,
                username: user.username,
                email: user.email
            },
            friends: friends,
            friendRequests: friendRequests
        });

    } catch (error) {
        console.error('Error fetching full user data:', error);
        
        if (error.message === 'No token provided' || error.message === 'Invalid token') {
            return res.status(401).json({ success: false, error: 'Authentication required' });
        }
        
        res.status(500).json({ 
            success: false, 
            error: 'Internal server error' 
        });
    }
});

// ============================================
// 6. API: جلب بيانات المستخدم الأساسية
// ============================================

/**
 * GET /api/user/data
 * جلب بيانات المستخدم الأساسية (متوافق مع الإصدارات القديمة)
 */
app.get('/api/user/data', async (req, res) => {
    try {
        const { uid } = req.query;
        await verifyToken(req);

        if (!uid) {
            return res.status(400).json({ success: false, error: 'UID is required' });
        }

        const userData = await getUserData(uid);

        if (!userData) {
            return res.json({
                success: true,
                balance: 100,
                gamesPlayed: 0,
                wins: 0,
                userIdCode: null,
                friends: [],
                friendRequests: []
            });
        }

        res.json({
            success: true,
            balance: userData.balance || 100,
            gamesPlayed: userData.gamesPlayed || 0,
            wins: userData.wins || 0,
            userIdCode: userData.userIdCode || null,
            friends: userData.friends || [],
            friendRequests: userData.friendRequests || []
        });

    } catch (error) {
        console.error('Error fetching user data:', error);
        
        if (error.message === 'No token provided' || error.message === 'Invalid token') {
            return res.status(401).json({ success: false, error: 'Authentication required' });
        }
        
        res.status(500).json({ success: false, error: error.message });
    }
});

// ============================================
// 7. API: إنشاء مستخدم جديد
// ============================================

/**
 * POST /api/user/create
 * إنشاء مستخدم جديد في قاعدة البيانات
 */
app.post('/api/user/create', async (req, res) => {
    try {
        const { uid, email, displayName } = req.body;
        await verifyToken(req);

        if (!uid || !email) {
            return res.status(400).json({ success: false, error: 'UID and email are required' });
        }

        // التحقق من وجود المستخدم
        const existingUser = await getUserData(uid, false);
        
        if (existingUser) {
            return res.json({ 
                success: true, 
                message: 'User already exists',
                userIdCode: existingUser.userIdCode
            });
        }

        // توليد كود فريد
        const userIdCode = await generateUniqueCode();
        
        // إنشاء اسم المستخدم
        const username = displayName || email.split('@')[0];
        
        // حفظ بيانات المستخدم
        const userData = {
            email: email,
            username: username,
            balance: 100,
            gamesPlayed: 0,
            wins: 0,
            userIdCode: userIdCode,
            friends: [],
            friendRequests: [],
            createdAt: Date.now(),
            lastUpdated: Date.now()
        };
        
        await db.ref(`users/${uid}`).set(userData);
        await db.ref(`users_by_code/${userIdCode}`).set(uid);
        
        // تحديث الكاش
        userCache.set(uid, userData, 60);

        res.json({ 
            success: true, 
            message: 'User created successfully', 
            userIdCode 
        });

    } catch (error) {
        console.error('Error creating user:', error);
        
        if (error.message === 'No token provided' || error.message === 'Invalid token') {
            return res.status(401).json({ success: false, error: 'Authentication required' });
        }
        
        res.status(500).json({ success: false, error: error.message });
    }
});

// ============================================
// 8. API: تحديث بيانات المستخدم
// ============================================

/**
 * POST /api/user/update
 * تحديث بيانات المستخدم
 */
app.post('/api/user/update', async (req, res) => {
    try {
        const { uid, balance, gamesPlayed, wins } = req.body;
        const decoded = await verifyToken(req);

        if (decoded.uid !== uid) {
            return res.status(403).json({ success: false, error: 'Unauthorized' });
        }

        const updates = {};
        if (balance !== undefined) updates.balance = balance;
        if (gamesPlayed !== undefined) updates.gamesPlayed = gamesPlayed;
        if (wins !== undefined) updates.wins = wins;
        
        if (Object.keys(updates).length > 0) {
            await updateUserData(uid, updates);
        }

        res.json({ success: true, message: 'User updated successfully' });

    } catch (error) {
        console.error('Error updating user:', error);
        
        if (error.message === 'No token provided' || error.message === 'Invalid token') {
            return res.status(401).json({ success: false, error: 'Authentication required' });
        }
        
        res.status(500).json({ success: false, error: error.message });
    }
});

// ============================================
// 9. API: تحديث متعدد (Batch Update)
// ============================================

/**
 * POST /api/user/batch-update
 * تحديث متعدد الحقول في طلب واحد
 */
app.post('/api/user/batch-update', async (req, res) => {
    try {
        const { uid, updates } = req.body;
        const decoded = await verifyToken(req);

        if (decoded.uid !== uid) {
            return res.status(403).json({ success: false, error: 'Unauthorized' });
        }

        const validUpdates = {};
        const allowedFields = ['balance', 'gamesPlayed', 'wins', 'username'];
        
        for (const field of allowedFields) {
            if (updates[field] !== undefined) {
                validUpdates[field] = updates[field];
            }
        }
        
        if (Object.keys(validUpdates).length > 0) {
            await updateUserData(uid, validUpdates);
        }

        res.json({ success: true, message: 'Batch update successful' });

    } catch (error) {
        console.error('Error in batch update:', error);
        
        if (error.message === 'No token provided' || error.message === 'Invalid token') {
            return res.status(401).json({ success: false, error: 'Authentication required' });
        }
        
        res.status(500).json({ success: false, error: error.message });
    }
});

// ============================================
// 10. API: إرسال طلب صداقة
// ============================================

/**
 * POST /api/friends/request
 * إرسال طلب صداقة لمستخدم
 */
app.post('/api/friends/request', async (req, res) => {
    try {
        const { fromUid, toUserIdCode } = req.body;
        const decoded = await verifyToken(req);

        if (decoded.uid !== fromUid) {
            return res.status(403).json({ success: false, error: 'Unauthorized' });
        }

        // التحقق من الكود
        const targetUidSnapshot = await db.ref(`users_by_code/${toUserIdCode}`).once('value');
        const toUid = targetUidSnapshot.val();

        if (!toUid) {
            return res.status(404).json({ success: false, error: 'User not found' });
        }

        if (toUid === fromUid) {
            return res.status(400).json({ success: false, error: 'Cannot add yourself' });
        }

        // جلب بيانات المستخدمين
        const [fromUser, toUser] = await Promise.all([
            getUserData(fromUid),
            getUserData(toUid)
        ]);

        if (!fromUser || !toUser) {
            return res.status(404).json({ success: false, error: 'User not found' });
        }

        // التحقق من الصداقة
        if (fromUser.friends?.includes(toUid)) {
            return res.status(400).json({ success: false, error: 'Already friends' });
        }

        if (toUser.friendRequests?.includes(fromUid)) {
            return res.status(400).json({ success: false, error: 'Friend request already sent' });
        }

        // إضافة الطلب
        const currentRequests = toUser.friendRequests || [];
        if (!currentRequests.includes(fromUid)) {
            currentRequests.push(fromUid);
            await db.ref(`users/${toUid}`).update({ friendRequests: currentRequests });
            
            // مسح الكاش
            userCache.del(toUid);
        }

        res.json({ success: true, message: 'Friend request sent' });

    } catch (error) {
        console.error('Error sending friend request:', error);
        
        if (error.message === 'No token provided' || error.message === 'Invalid token') {
            return res.status(401).json({ success: false, error: 'Authentication required' });
        }
        
        res.status(500).json({ success: false, error: error.message });
    }
});

// ============================================
// 11. API: قبول طلب صداقة
// ============================================

/**
 * POST /api/friends/accept
 * قبول طلب صداقة
 */
app.post('/api/friends/accept', async (req, res) => {
    try {
        const { userUid, requesterUid } = req.body;
        const decoded = await verifyToken(req);

        if (decoded.uid !== userUid) {
            return res.status(403).json({ success: false, error: 'Unauthorized' });
        }

        const [user, requester] = await Promise.all([
            getUserData(userUid),
            getUserData(requesterUid)
        ]);

        if (!user || !requester) {
            return res.status(404).json({ success: false, error: 'User not found' });
        }

        if (!user.friendRequests?.includes(requesterUid)) {
            return res.status(400).json({ success: false, error: 'No friend request found' });
        }

        // تحديث القوائم
        const updatedRequests = user.friendRequests.filter(uid => uid !== requesterUid);
        const userFriends = [...(user.friends || []), requesterUid];
        const requesterFriends = [...(requester.friends || []), userUid];

        // تنفيذ التحديثات
        await Promise.all([
            db.ref(`users/${userUid}`).update({
                friends: userFriends,
                friendRequests: updatedRequests
            }),
            db.ref(`users/${requesterUid}`).update({
                friends: requesterFriends
            })
        ]);
        
        // مسح الكاش
        userCache.del(userUid);
        userCache.del(requesterUid);

        res.json({ success: true, message: 'Friend request accepted' });

    } catch (error) {
        console.error('Error accepting friend request:', error);
        
        if (error.message === 'No token provided' || error.message === 'Invalid token') {
            return res.status(401).json({ success: false, error: 'Authentication required' });
        }
        
        res.status(500).json({ success: false, error: error.message });
    }
});

// ============================================
// 12. API: رفض طلب صداقة
// ============================================

/**
 * POST /api/friends/reject
 * رفض طلب صداقة
 */
app.post('/api/friends/reject', async (req, res) => {
    try {
        const { userUid, requesterUid } = req.body;
        const decoded = await verifyToken(req);

        if (decoded.uid !== userUid) {
            return res.status(403).json({ success: false, error: 'Unauthorized' });
        }

        const user = await getUserData(userUid);
        
        if (!user) {
            return res.status(404).json({ success: false, error: 'User not found' });
        }

        if (!user.friendRequests?.includes(requesterUid)) {
            return res.status(400).json({ success: false, error: 'No friend request found' });
        }

        const updatedRequests = user.friendRequests.filter(uid => uid !== requesterUid);
        await db.ref(`users/${userUid}`).update({ friendRequests: updatedRequests });
        
        userCache.del(userUid);

        res.json({ success: true, message: 'Friend request rejected' });

    } catch (error) {
        console.error('Error rejecting friend request:', error);
        
        if (error.message === 'No token provided' || error.message === 'Invalid token') {
            return res.status(401).json({ success: false, error: 'Authentication required' });
        }
        
        res.status(500).json({ success: false, error: error.message });
    }
});

// ============================================
// 13. API: إزالة صديق
// ============================================

/**
 * POST /api/friends/remove
 * إزالة صديق من القائمة
 */
app.post('/api/friends/remove', async (req, res) => {
    try {
        const { userUid, friendUid } = req.body;
        const decoded = await verifyToken(req);

        if (decoded.uid !== userUid) {
            return res.status(403).json({ success: false, error: 'Unauthorized' });
        }

        const [user, friend] = await Promise.all([
            getUserData(userUid),
            getUserData(friendUid)
        ]);

        if (!user || !friend) {
            return res.status(404).json({ success: false, error: 'User not found' });
        }

        const userFriends = (user.friends || []).filter(uid => uid !== friendUid);
        const friendFriends = (friend.friends || []).filter(uid => uid !== userUid);

        await Promise.all([
            db.ref(`users/${userUid}`).update({ friends: userFriends }),
            db.ref(`users/${friendUid}`).update({ friends: friendFriends })
        ]);

        userCache.del(userUid);
        userCache.del(friendUid);

        res.json({ success: true, message: 'Friend removed' });

    } catch (error) {
        console.error('Error removing friend:', error);
        
        if (error.message === 'No token provided' || error.message === 'Invalid token') {
            return res.status(401).json({ success: false, error: 'Authentication required' });
        }
        
        res.status(500).json({ success: false, error: error.message });
    }
});

// ============================================
// 14. API: البحث عن مستخدم بالكود
// ============================================

/**
 * GET /api/user/bycode/:code
 * البحث عن مستخدم باستخدام الكود
 */
app.get('/api/user/bycode/:code', async (req, res) => {
    try {
        const { code } = req.params;
        await verifyToken(req);

        // استخدام cache للكودات
        let userData = codeCache.get(code);
        
        if (!userData) {
            const uidSnapshot = await db.ref(`users_by_code/${code}`).once('value');
            const uid = uidSnapshot.val();

            if (!uid) {
                return res.status(404).json({ success: false, error: 'User not found' });
            }

            const user = await getUserData(uid);

            if (!user) {
                return res.status(404).json({ success: false, error: 'User not found' });
            }

            userData = {
                uid: uid,
                username: user.username,
                email: user.email,
                userIdCode: user.userIdCode
            };
            
            codeCache.set(code, userData, 300); // Cache لمدة 5 دقائق
        }

        res.json({
            success: true,
            user: userData
        });

    } catch (error) {
        console.error('Error finding user by code:', error);
        
        if (error.message === 'No token provided' || error.message === 'Invalid token') {
            return res.status(401).json({ success: false, error: 'Authentication required' });
        }
        
        res.status(500).json({ success: false, error: error.message });
    }
});

// ============================================
// 15. API: جلب قائمة الأصدقاء
// ============================================

/**
 * GET /api/friends/list/:uid
 * جلب قائمة الأصدقاء مع بياناتهم
 */
app.get('/api/friends/list/:uid', async (req, res) => {
    try {
        const { uid } = req.params;
        await verifyToken(req);

        const user = await getUserData(uid);

        if (!user) {
            return res.status(404).json({ success: false, error: 'User not found' });
        }

        const friendsUids = user.friends || [];
        const friendsData = [];

        for (const friendUid of friendsUids) {
            const friend = await getUserData(friendUid);
            if (friend) {
                friendsData.push({
                    uid: friendUid,
                    username: friend.username,
                    email: friend.email,
                    userIdCode: friend.userIdCode,
                    balance: friend.balance,
                    isActive: false
                });
            }
        }

        res.json({ success: true, friends: friendsData });

    } catch (error) {
        console.error('Error fetching friends list:', error);
        
        if (error.message === 'No token provided' || error.message === 'Invalid token') {
            return res.status(401).json({ success: false, error: 'Authentication required' });
        }
        
        res.status(500).json({ success: false, error: error.message });
    }
});

// ============================================
// 16. API: جلب طلبات الصداقة
// ============================================

/**
 * GET /api/friends/requests/:uid
 * جلب طلبات الصداقة الواردة
 */
app.get('/api/friends/requests/:uid', async (req, res) => {
    try {
        const { uid } = req.params;
        await verifyToken(req);

        const user = await getUserData(uid);

        if (!user) {
            return res.status(404).json({ success: false, error: 'User not found' });
        }

        const requestsUids = user.friendRequests || [];
        const requestsData = [];

        for (const requesterUid of requestsUids) {
            const requester = await getUserData(requesterUid);
            if (requester) {
                requestsData.push({
                    uid: requesterUid,
                    username: requester.username,
                    email: requester.email,
                    userIdCode: requester.userIdCode
                });
            }
        }

        res.json({ success: true, requests: requestsData });

    } catch (error) {
        console.error('Error fetching friend requests:', error);
        
        if (error.message === 'No token provided' || error.message === 'Invalid token') {
            return res.status(401).json({ success: false, error: 'Authentication required' });
        }
        
        res.status(500).json({ success: false, error: error.message });
    }
});

// ============================================
// 17. API: تحديث الرصيد (خاص باللعبة)
// ============================================

/**
 * POST /api/game/update-balance
 * تحديث رصيد المستخدم بعد اللعبة
 */
app.post('/api/game/update-balance', async (req, res) => {
    try {
        const { uid, amount, gameResult } = req.body;
        const decoded = await verifyToken(req);

        if (decoded.uid !== uid) {
            return res.status(403).json({ success: false, error: 'Unauthorized' });
        }

        const user = await getUserData(uid);
        
        if (!user) {
            return res.status(404).json({ success: false, error: 'User not found' });
        }

        const newBalance = (user.balance || 0) + amount;
        
        if (newBalance < 0) {
            return res.status(400).json({ success: false, error: 'Insufficient balance' });
        }

        const updates = {
            balance: newBalance,
            gamesPlayed: (user.gamesPlayed || 0) + 1
        };
        
        if (gameResult === 'win') {
            updates.wins = (user.wins || 0) + 1;
        }
        
        await updateUserData(uid, updates);

        res.json({ 
            success: true, 
            newBalance: newBalance,
            message: 'Balance updated successfully'
        });

    } catch (error) {
        console.error('Error updating balance:', error);
        
        if (error.message === 'No token provided' || error.message === 'Invalid token') {
            return res.status(401).json({ success: false, error: 'Authentication required' });
        }
        
        res.status(500).json({ success: false, error: error.message });
    }
});

// ============================================
// 18. API: الحصول على ترتيب اللاعبين (Leaderboard)
// ============================================

/**
 * GET /api/leaderboard
 * الحصول على قائمة أفضل اللاعبين
 */
app.get('/api/leaderboard', async (req, res) => {
    try {
        const { limit = 10, sortBy = 'balance' } = req.query;
        await verifyToken(req);

        // جلب جميع المستخدمين
        const snapshot = await db.ref('users').once('value');
        const users = snapshot.val();
        
        if (!users) {
            return res.json({ success: true, leaders: [] });
        }
        
        // تحويل إلى مصفوفة وترتيبها
        const leaders = Object.entries(users)
            .map(([uid, data]) => ({
                uid,
                username: data.username,
                balance: data.balance || 0,
                wins: data.wins || 0,
                gamesPlayed: data.gamesPlayed || 0
            }))
            .sort((a, b) => (b[sortBy] || 0) - (a[sortBy] || 0))
            .slice(0, parseInt(limit));
        
        res.json({ success: true, leaders });

    } catch (error) {
        console.error('Error fetching leaderboard:', error);
        
        if (error.message === 'No token provided' || error.message === 'Invalid token') {
            return res.status(401).json({ success: false, error: 'Authentication required' });
        }
        
        res.status(500).json({ success: false, error: error.message });
    }
});

// ============================================
// 19. API: حذف حساب المستخدم
// ============================================

/**
 * DELETE /api/user/delete
 * حذف حساب المستخدم وجميع بياناته
 */
app.delete('/api/user/delete', async (req, res) => {
    try {
        const { uid } = req.body;
        const decoded = await verifyToken(req);

        if (decoded.uid !== uid) {
            return res.status(403).json({ success: false, error: 'Unauthorized' });
        }

        const user = await getUserData(uid);
        
        if (!user) {
            return res.status(404).json({ success: false, error: 'User not found' });
        }
        
        // حذف الكود من الفهرس
        if (user.userIdCode) {
            await db.ref(`users_by_code/${user.userIdCode}`).remove();
        }
        
        // حذف بيانات المستخدم
        await db.ref(`users/${uid}`).remove();
        
        // مسح الكاش
        userCache.del(uid);
        if (user.userIdCode) {
            codeCache.del(user.userIdCode);
        }
        
        res.json({ success: true, message: 'User deleted successfully' });

    } catch (error) {
        console.error('Error deleting user:', error);
        
        if (error.message === 'No token provided' || error.message === 'Invalid token') {
            return res.status(401).json({ success: false, error: 'Authentication required' });
        }
        
        res.status(500).json({ success: false, error: error.message });
    }
});

// ============================================
// 20. API: اختبار الاتصال والحالة
// ============================================

/**
 * GET /api/health
 * التحقق من حالة السيرفر
 */
app.get('/api/health', (req, res) => {
    res.json({ 
        status: 'ok', 
        timestamp: Date.now(),
        uptime: process.uptime(),
        cacheStats: {
            users: userCache.keys().length,
            codes: codeCache.keys().length,
            tokens: tokenCache.keys().length
        }
    });
});

/**
 * GET /api/stats
 * إحصائيات السيرفر (للمطورين فقط)
 */
app.get('/api/stats', async (req, res) => {
    try {
        // التحقق من التوكن (يمكن إضافة صلاحيات للمطور)
        await verifyToken(req);
        
        const snapshot = await db.ref('users').once('value');
        const users = snapshot.val();
        
        const totalUsers = users ? Object.keys(users).length : 0;
        let totalBalance = 0;
        let totalGames = 0;
        
        if (users) {
            Object.values(users).forEach(user => {
                totalBalance += user.balance || 0;
                totalGames += user.gamesPlayed || 0;
            });
        }
        
        res.json({
            success: true,
            stats: {
                totalUsers,
                totalBalance,
                totalGames,
                averageBalance: totalUsers > 0 ? totalBalance / totalUsers : 0,
                cacheHits: userCache.getStats().hits,
                cacheMisses: userCache.getStats().misses
            }
        });
        
    } catch (error) {
        console.error('Error fetching stats:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

// ============================================
// 21. معالجة الأخطاء العامة
// ============================================

// 404 Not Found
app.use((req, res) => {
    res.status(404).json({ 
        success: false, 
        error: 'API endpoint not found' 
    });
});

// Error handler
app.use((err, req, res, next) => {
    console.error('Unhandled error:', err);
    res.status(500).json({ 
        success: false, 
        error: 'Internal server error' 
    });
});

// ============================================
// 22. تشغيل السيرفر
// ============================================

app.listen(PORT, () => {
    console.log('\n=================================');
    console.log('✅ TNT WARS Server Started');
    console.log('=================================');
    console.log(`📡 Port: ${PORT}`);
    console.log(`🌐 Environment: ${process.env.NODE_ENV || 'development'}`);
    console.log(`💾 Cache: Enabled`);
    console.log(`🚀 API endpoints ready`);
    console.log('=================================\n');
});

// تنظيف الذاكرة عند إغلاق السيرفر
process.on('SIGTERM', () => {
    console.log('SIGTERM signal received: closing HTTP server');
    userCache.flushAll();
    codeCache.flushAll();
    tokenCache.flushAll();
    process.exit(0);
});

module.exports = app;
