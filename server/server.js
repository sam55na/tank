const express = require('express');
const cors = require('cors');
const admin = require('firebase-admin');

// ============================================
// 1. تهيئة Firebase Admin SDK باستخدام متغيرات البيئة
// ============================================

// قراءة بيانات الخدمة من متغيرات البيئة
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

admin.initializeApp({
    credential: admin.credential.cert(serviceAccount),
    databaseURL: process.env.FIREBASE_DATABASE_URL || "https://boomb-fa3e7-default-rtdb.firebaseio.com"
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
// 3. Helper: التحقق من التوكن
// ============================================
async function verifyToken(req) {
    const token = req.headers.authorization?.split(' ')[1];
    if (!token) throw new Error('No token provided');
    return await admin.auth().verifyIdToken(token);
}

// ============================================
// 4. API: جلب بيانات المستخدم
//    GET /api/user/data?uid=xxxx
// ============================================
app.get('/api/user/data', async (req, res) => {
    try {
        const { uid } = req.query;
        await verifyToken(req);

        if (!uid) {
            return res.status(400).json({ success: false, error: 'UID is required' });
        }

        const snapshot = await db.ref(`users/${uid}`).once('value');
        const userData = snapshot.val();

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
        res.status(500).json({ success: false, error: error.message });
    }
});

// ============================================
// 5. API: إنشاء مستخدم جديد
//    POST /api/user/create
// ============================================
app.post('/api/user/create', async (req, res) => {
    try {
        const { uid, email, displayName } = req.body;
        await verifyToken(req);

        if (!uid || !email) {
            return res.status(400).json({ success: false, error: 'UID and email are required' });
        }

        const snapshot = await db.ref(`users/${uid}`).once('value');
        
        if (snapshot.exists()) {
            return res.json({ success: true, message: 'User already exists' });
        }

        // توليد ID فريد من 10 أرقام
        let userIdCode;
        let codeExists = true;
        while (codeExists) {
            userIdCode = Math.floor(1000000000 + Math.random() * 9000000000).toString();
            const codeSnapshot = await db.ref(`users_by_code/${userIdCode}`).once('value');
            codeExists = codeSnapshot.exists();
        }

        await db.ref(`users/${uid}`).set({
            email: email,
            username: displayName || email.split('@')[0],
            balance: 100,
            gamesPlayed: 0,
            wins: 0,
            userIdCode: userIdCode,
            friends: [],
            friendRequests: [],
            createdAt: Date.now()
        });

        await db.ref(`users_by_code/${userIdCode}`).set(uid);

        res.json({ success: true, message: 'User created successfully', userIdCode });

    } catch (error) {
        console.error('Error creating user:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

// ============================================
// 6. API: تحديث بيانات المستخدم
//    POST /api/user/update
// ============================================
app.post('/api/user/update', async (req, res) => {
    try {
        const { uid, balance, gamesPlayed, wins } = req.body;
        await verifyToken(req);

        if (!uid) {
            return res.status(400).json({ success: false, error: 'UID is required' });
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
// 7. API: إرسال طلب صداقة
//    POST /api/friends/request
// ============================================
app.post('/api/friends/request', async (req, res) => {
    try {
        const { fromUid, toUserIdCode } = req.body;
        const decoded = await verifyToken(req);

        if (decoded.uid !== fromUid) {
            return res.status(403).json({ success: false, error: 'Unauthorized' });
        }

        // البحث عن المستخدم بواسطة الكود
        const targetUidSnapshot = await db.ref(`users_by_code/${toUserIdCode}`).once('value');
        const toUid = targetUidSnapshot.val();

        if (!toUid) {
            return res.status(404).json({ success: false, error: 'User not found' });
        }

        if (toUid === fromUid) {
            return res.status(400).json({ success: false, error: 'Cannot add yourself' });
        }

        // جلب بيانات المستخدمين
        const fromUserSnapshot = await db.ref(`users/${fromUid}`).once('value');
        const toUserSnapshot = await db.ref(`users/${toUid}`).once('value');

        const fromUser = fromUserSnapshot.val();
        const toUser = toUserSnapshot.val();

        if (!fromUser || !toUser) {
            return res.status(404).json({ success: false, error: 'User not found' });
        }

        // التحقق من وجود الصداقة مسبقاً
        if (fromUser.friends?.includes(toUid)) {
            return res.status(400).json({ success: false, error: 'Already friends' });
        }

        // التحقق من وجود طلب مسبق
        if (toUser.friendRequests?.includes(fromUid)) {
            return res.status(400).json({ success: false, error: 'Friend request already sent' });
        }

        // إضافة طلب الصداقة للمستقبل
        const currentRequests = toUser.friendRequests || [];
        currentRequests.push(fromUid);
        await db.ref(`users/${toUid}`).update({ friendRequests: currentRequests });

        res.json({ success: true, message: 'Friend request sent' });

    } catch (error) {
        console.error('Error sending friend request:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

// ============================================
// 8. API: قبول طلب صداقة
//    POST /api/friends/accept
// ============================================
app.post('/api/friends/accept', async (req, res) => {
    try {
        const { userUid, requesterUid } = req.body;
        const decoded = await verifyToken(req);

        if (decoded.uid !== userUid) {
            return res.status(403).json({ success: false, error: 'Unauthorized' });
        }

        const userSnapshot = await db.ref(`users/${userUid}`).once('value');
        const requesterSnapshot = await db.ref(`users/${requesterUid}`).once('value');

        const user = userSnapshot.val();
        const requester = requesterSnapshot.val();

        if (!user || !requester) {
            return res.status(404).json({ success: false, error: 'User not found' });
        }

        // التحقق من وجود الطلب
        if (!user.friendRequests?.includes(requesterUid)) {
            return res.status(400).json({ success: false, error: 'No friend request found' });
        }

        // إزالة الطلب من قائمة الطلبات
        const updatedRequests = user.friendRequests.filter(uid => uid !== requesterUid);
        
        // إضافة الصديقين لقائمة الأصدقاء
        const userFriends = user.friends || [];
        const requesterFriends = requester.friends || [];
        
        userFriends.push(requesterUid);
        requesterFriends.push(userUid);

        await db.ref(`users/${userUid}`).update({
            friends: userFriends,
            friendRequests: updatedRequests
        });
        
        await db.ref(`users/${requesterUid}`).update({
            friends: requesterFriends
        });

        res.json({ success: true, message: 'Friend request accepted' });

    } catch (error) {
        console.error('Error accepting friend request:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

// ============================================
// 9. API: رفض طلب صداقة
//    POST /api/friends/reject
// ============================================
app.post('/api/friends/reject', async (req, res) => {
    try {
        const { userUid, requesterUid } = req.body;
        const decoded = await verifyToken(req);

        if (decoded.uid !== userUid) {
            return res.status(403).json({ success: false, error: 'Unauthorized' });
        }

        const userSnapshot = await db.ref(`users/${userUid}`).once('value');
        const user = userSnapshot.val();

        if (!user) {
            return res.status(404).json({ success: false, error: 'User not found' });
        }

        if (!user.friendRequests?.includes(requesterUid)) {
            return res.status(400).json({ success: false, error: 'No friend request found' });
        }

        const updatedRequests = user.friendRequests.filter(uid => uid !== requesterUid);
        await db.ref(`users/${userUid}`).update({ friendRequests: updatedRequests });

        res.json({ success: true, message: 'Friend request rejected' });

    } catch (error) {
        console.error('Error rejecting friend request:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

// ============================================
// 10. API: إزالة صديق
//     POST /api/friends/remove
// ============================================
app.post('/api/friends/remove', async (req, res) => {
    try {
        const { userUid, friendUid } = req.body;
        const decoded = await verifyToken(req);

        if (decoded.uid !== userUid) {
            return res.status(403).json({ success: false, error: 'Unauthorized' });
        }

        const userSnapshot = await db.ref(`users/${userUid}`).once('value');
        const friendSnapshot = await db.ref(`users/${friendUid}`).once('value');

        const user = userSnapshot.val();
        const friend = friendSnapshot.val();

        if (!user || !friend) {
            return res.status(404).json({ success: false, error: 'User not found' });
        }

        const userFriends = (user.friends || []).filter(uid => uid !== friendUid);
        const friendFriends = (friend.friends || []).filter(uid => uid !== userUid);

        await db.ref(`users/${userUid}`).update({ friends: userFriends });
        await db.ref(`users/${friendUid}`).update({ friends: friendFriends });

        res.json({ success: true, message: 'Friend removed' });

    } catch (error) {
        console.error('Error removing friend:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

// ============================================
// 11. API: الحصول على معلومات مستخدم بواسطة الكود
//     GET /api/user/bycode/:code
// ============================================
app.get('/api/user/bycode/:code', async (req, res) => {
    try {
        const { code } = req.params;
        await verifyToken(req);

        const uidSnapshot = await db.ref(`users_by_code/${code}`).once('value');
        const uid = uidSnapshot.val();

        if (!uid) {
            return res.status(404).json({ success: false, error: 'User not found' });
        }

        const userSnapshot = await db.ref(`users/${uid}`).once('value');
        const user = userSnapshot.val();

        if (!user) {
            return res.status(404).json({ success: false, error: 'User not found' });
        }

        res.json({
            success: true,
            user: {
                uid: uid,
                username: user.username,
                email: user.email,
                userIdCode: user.userIdCode
            }
        });

    } catch (error) {
        console.error('Error finding user by code:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

// ============================================
// 12. API: الحصول على قائمة الأصدقاء مع بياناتهم
//     GET /api/friends/list/:uid
// ============================================
app.get('/api/friends/list/:uid', async (req, res) => {
    try {
        const { uid } = req.params;
        await verifyToken(req);

        const userSnapshot = await db.ref(`users/${uid}`).once('value');
        const user = userSnapshot.val();

        if (!user) {
            return res.status(404).json({ success: false, error: 'User not found' });
        }

        const friends = user.friends || [];
        const friendsData = [];

        for (const friendUid of friends) {
            const friendSnapshot = await db.ref(`users/${friendUid}`).once('value');
            const friend = friendSnapshot.val();
            if (friend) {
                friendsData.push({
                    uid: friendUid,
                    username: friend.username,
                    email: friend.email,
                    userIdCode: friend.userIdCode,
                    isActive: false
                });
            }
        }

        res.json({ success: true, friends: friendsData });

    } catch (error) {
        console.error('Error fetching friends list:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

// ============================================
// 13. API: الحصول على طلبات الصداقة
//     GET /api/friends/requests/:uid
// ============================================
app.get('/api/friends/requests/:uid', async (req, res) => {
    try {
        const { uid } = req.params;
        await verifyToken(req);

        const userSnapshot = await db.ref(`users/${uid}`).once('value');
        const user = userSnapshot.val();

        if (!user) {
            return res.status(404).json({ success: false, error: 'User not found' });
        }

        const requests = user.friendRequests || [];
        const requestsData = [];

        for (const requesterUid of requests) {
            const requesterSnapshot = await db.ref(`users/${requesterUid}`).once('value');
            const requester = requesterSnapshot.val();
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
        res.status(500).json({ success: false, error: error.message });
    }
});

// ============================================
// 14. اختبار الاتصال
// ============================================
app.get('/api/health', (req, res) => {
    res.json({ status: 'ok', timestamp: Date.now() });
});

// ============================================
// 15. تشغيل السيرفر
// ============================================
app.listen(PORT, () => {
    console.log(`✅ Server running on port ${PORT}`);
    console.log(`📡 API endpoints ready`);
});
