// ============================================
// 🚀 خادم لعبة Battle Tanks - النسخة الاحترافية
// ============================================

const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const admin = require('firebase-admin');
const cors = require('cors');

// ============================================
// 🔥 تهيئة Express و Firebase
// ============================================
const app = express();
app.use(cors());
app.use(express.json());

// Firebase Admin SDK - استخدام متغير البيئة
let serviceAccount;
try {
    serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
    console.log('✅ Firebase: Using environment variable');
} catch (e) {
    try {
        serviceAccount = require('./serviceAccountKey.json');
        console.log('✅ Firebase: Using local file');
    } catch (err) {
        console.error('❌ Firebase: No service account found');
        process.exit(1);
    }
}

admin.initializeApp({
    credential: admin.credential.cert(serviceAccount),
    databaseURL: "https://boomb-fa3e7-default-rtdb.firebaseio.com"
});

const db = admin.database();

// ============================================
// 🌐 خادم HTTP و WebSocket
// ============================================
const server = http.createServer(app);
const io = socketIo(server, {
    cors: {
        origin: "*",
        methods: ["GET", "POST"],
        credentials: true
    },
    transports: ['websocket', 'polling'],
    pingTimeout: 60000,
    pingInterval: 25000
});

// ============================================
// 📦 API Routes
// ============================================

// التحقق من صحة الخادم
app.get('/health', (req, res) => {
    res.json({ status: 'online', timestamp: Date.now() });
});

// الحصول على رصيد المستخدم
app.get('/api/balance/:userId', async (req, res) => {
    try {
        const { userId } = req.params;
        const snapshot = await db.ref(`users/${userId}`).once('value');
        const userData = snapshot.val();
        res.json({ success: true, balance: userData?.balance || 100 });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

// إيداع رصيد (للاستخدام من قبل الآدمن)
app.post('/api/deposit', async (req, res) => {
    try {
        const { adminToken, userId, amount } = req.body;
        
        // التحقق من صلاحية الآدمن
        if (adminToken !== process.env.ADMIN_SECRET) {
            return res.status(403).json({ success: false, error: 'Unauthorized' });
        }
        
        const userRef = db.ref(`users/${userId}`);
        const snapshot = await userRef.once('value');
        let currentBalance = snapshot.val()?.balance || 100;
        currentBalance += amount;
        await userRef.update({ balance: currentBalance });
        
        // تسجيل المعاملة
        const transactionRef = db.ref(`transactions/${userId}`).push();
        await transactionRef.set({
            type: 'deposit',
            amount: amount,
            balanceAfter: currentBalance,
            timestamp: Date.now(),
            admin: true
        });
        
        res.json({ success: true, newBalance: currentBalance });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

// سحب رصيد (للاستخدام من قبل الآدمن)
app.post('/api/withdraw', async (req, res) => {
    try {
        const { adminToken, userId, amount } = req.body;
        
        if (adminToken !== process.env.ADMIN_SECRET) {
            return res.status(403).json({ success: false, error: 'Unauthorized' });
        }
        
        const userRef = db.ref(`users/${userId}`);
        const snapshot = await userRef.once('value');
        let currentBalance = snapshot.val()?.balance || 100;
        
        if (currentBalance < amount) {
            return res.json({ success: false, error: 'Insufficient balance' });
        }
        
        currentBalance -= amount;
        await userRef.update({ balance: currentBalance });
        
        const transactionRef = db.ref(`transactions/${userId}`).push();
        await transactionRef.set({
            type: 'withdraw',
            amount: amount,
            balanceAfter: currentBalance,
            timestamp: Date.now(),
            admin: true
        });
        
        res.json({ success: true, newBalance: currentBalance });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

// الحصول على إحصائيات اللاعبين (للآدمن)
app.get('/api/admin/stats', async (req, res) => {
    try {
        const { adminToken } = req.query;
        if (adminToken !== process.env.ADMIN_SECRET) {
            return res.status(403).json({ success: false, error: 'Unauthorized' });
        }
        
        const snapshot = await db.ref('users').once('value');
        const users = snapshot.val();
        const stats = {
            totalUsers: users ? Object.keys(users).length : 0,
            totalBalance: 0,
            usersList: []
        };
        
        if (users) {
            for (const [id, data] of Object.entries(users)) {
                stats.totalBalance += data.balance || 0;
                stats.usersList.push({
                    id: id,
                    email: data.email,
                    balance: data.balance || 100,
                    username: data.username,
                    isAdmin: data.isAdmin || false
                });
            }
        }
        
        res.json({ success: true, stats });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

// ============================================
// 📦 تخزين البيانات المؤقتة
// ============================================
const players = new Map();
const rooms = new Map();

function generateId() {
    return Math.random().toString(36).substr(2, 8);
}

function broadcastRoomsList() {
    const roomsList = [];
    for (const [roomId, room] of rooms) {
        if (room.status === 'waiting') {
            roomsList.push({
                id: roomId,
                players: room.players.length,
                maxSeats: room.maxSeats
            });
        }
    }
    io.emit('rooms_list', { rooms: roomsList });
}

function updateRoom(roomId) {
    const room = rooms.get(roomId);
    if (!room) return;
    
    io.to(roomId).emit('room_update', {
        players: room.players.map(p => p.userId),
        maxSeats: room.maxSeats,
        count: room.players.length
    });
    
    if (room.players.length === room.maxSeats && room.status === 'waiting') {
        startGame(roomId);
    }
}

function startGame(roomId) {
    const room = rooms.get(roomId);
    if (!room || room.status !== 'waiting') return;
    
    room.status = 'active';
    room.startTime = Date.now();
    
    const playersList = room.players;
    const half = Math.floor(playersList.length / 2);
    const team1 = playersList.slice(0, half);
    const team2 = playersList.slice(half);
    
    for (const player of playersList) {
        const team = team1.includes(player) ? 1 : 2;
        io.to(player.socketId).emit('game_start', {
            roomId: roomId,
            players: playersList.map(p => p.userId),
            yourTeam: team,
            startTime: room.startTime
        });
    }
    
    console.log(`🎮 Game started in room ${roomId} with ${playersList.length} players`);
    
    setTimeout(() => {
        endGame(roomId, 'انتهت مدة المعركة!');
    }, 5 * 60 * 1000);
}

async function endGame(roomId, reason) {
    const room = rooms.get(roomId);
    if (!room || room.status === 'ended') return;
    
    room.status = 'ended';
    const duration = Math.floor((Date.now() - (room.startTime || Date.now())) / 1000);
    const reward = 10;
    
    for (const player of room.players) {
        try {
            const userRef = db.ref(`users/${player.userId}`);
            const snapshot = await userRef.once('value');
            let currentBalance = snapshot.val()?.balance || 100;
            currentBalance += reward;
            await userRef.update({ 
                balance: currentBalance,
                lastGame: Date.now(),
                gamesPlayed: (snapshot.val()?.gamesPlayed || 0) + 1
            });
            
            io.to(player.socketId).emit('game_ended', {
                message: reason || 'انتهت المعركة!',
                reward: reward,
                duration: duration,
                yourBalance: currentBalance
            });
        } catch (error) {
            console.error('Error updating balance:', error);
            io.to(player.socketId).emit('game_ended', {
                message: 'انتهت المعركة!',
                reward: reward,
                duration: duration
            });
        }
    }
    
    console.log(`🏆 Game ended in room ${roomId}, reward: ${reward}$ each`);
    
    setTimeout(() => {
        rooms.delete(roomId);
        broadcastRoomsList();
    }, 10000);
}

// ============================================
// 🔌 أحداث Socket.io
// ============================================
io.on('connection', (socket) => {
    console.log(`🔌 New connection: ${socket.id}`);
    
    players.set(socket.id, {
        socketId: socket.id,
        userId: null,
        roomId: null,
        connectedAt: Date.now()
    });
    
    socket.on('auth', async (data) => {
        try {
            const { token } = data;
            if (!token) {
                socket.emit('auth_error', { message: 'No token provided' });
                return;
            }
            
            const decodedToken = await admin.auth().verifyIdToken(token);
            const userId = decodedToken.uid;
            const email = decodedToken.email;
            
            const player = players.get(socket.id);
            if (player) {
                player.userId = userId;
                player.email = email;
            }
            
            const userRef = db.ref(`users/${userId}`);
            const snapshot = await userRef.once('value');
            let userData = snapshot.val();
            
            // تحديد حساب الآدمن
            const isAdmin = (email === 'admin2613857@boomb.com');
            
            if (!userData) {
                userData = { 
                    balance: 100, 
                    username: email.split('@')[0],
                    email: email,
                    isAdmin: isAdmin,
                    createdAt: Date.now(),
                    gamesPlayed: 0,
                    totalWins: 0
                };
                await userRef.set(userData);
            } else if (isAdmin && !userData.isAdmin) {
                // تحديث صلاحية الآدمن إذا كان البريد مطابقاً
                await userRef.update({ isAdmin: true });
                userData.isAdmin = true;
            }
            
            socket.emit('auth_success', {
                userId: userId,
                email: email,
                balance: userData.balance || 100,
                username: userData.username,
                isAdmin: userData.isAdmin || false
            });
            
            console.log(`✅ User authenticated: ${email} (Admin: ${userData.isAdmin || false})`);
            
        } catch (error) {
            console.error('❌ Auth error:', error);
            socket.emit('auth_error', { message: 'Invalid token: ' + error.message });
        }
    });
    
    socket.on('join_lobby', async () => {
        const player = players.get(socket.id);
        if (!player?.userId) {
            socket.emit('error', { message: 'Not authenticated' });
            return;
        }
        
        try {
            const userRef = db.ref(`users/${player.userId}`);
            const snapshot = await userRef.once('value');
            const userData = snapshot.val();
            const balance = userData?.balance || 100;
            
            socket.emit('lobby_joined', {
                balance: balance,
                userId: player.userId,
                isAdmin: userData?.isAdmin || false
            });
            
            broadcastRoomsList();
            console.log(`🏠 ${player.email} joined lobby`);
        } catch (error) {
            console.error('Error getting balance:', error);
            socket.emit('error', { message: 'Could not get user data' });
        }
    });
    
    socket.on('list_rooms', () => {
        broadcastRoomsList();
    });
    
    socket.on('create_room', (data) => {
        const player = players.get(socket.id);
        if (!player?.userId) {
            socket.emit('error', { message: 'Not authenticated' });
            return;
        }
        
        if (player.roomId) {
            socket.emit('error', { message: 'You are already in a room' });
            return;
        }
        
        const roomId = generateId();
        const maxSeats = data.seats || 8;
        
        const room = {
            id: roomId,
            maxSeats: maxSeats,
            players: [{
                userId: player.userId,
                socketId: socket.id,
                email: player.email
            }],
            status: 'waiting',
            createdAt: Date.now()
        };
        
        rooms.set(roomId, room);
        player.roomId = roomId;
        
        socket.join(roomId);
        socket.emit('room_created', { roomId: roomId });
        
        updateRoom(roomId);
        broadcastRoomsList();
        
        console.log(`📦 Room created: ${roomId} by ${player.email}`);
    });
    
    socket.on('join_room', (data) => {
        const player = players.get(socket.id);
        if (!player?.userId) {
            socket.emit('error', { message: 'Not authenticated' });
            return;
        }
        
        const { roomId } = data;
        const room = rooms.get(roomId);
        
        if (!room) {
            socket.emit('error', { message: 'Room not found' });
            return;
        }
        
        if (room.status !== 'waiting') {
            socket.emit('error', { message: 'Game already started' });
            return;
        }
        
        if (room.players.length >= room.maxSeats) {
            socket.emit('error', { message: 'Room is full' });
            return;
        }
        
        if (player.roomId) {
            socket.emit('error', { message: 'You are already in a room' });
            return;
        }
        
        room.players.push({
            userId: player.userId,
            socketId: socket.id,
            email: player.email
        });
        player.roomId = roomId;
        
        socket.join(roomId);
        socket.emit('room_joined', { roomId: roomId });
        
        updateRoom(roomId);
        broadcastRoomsList();
        
        console.log(`👥 ${player.email} joined room ${roomId}`);
    });
    
    socket.on('move', (data) => {
        const player = players.get(socket.id);
        if (player?.roomId) {
            socket.to(player.roomId).emit('player_moved', {
                userId: player.userId,
                position: data,
                timestamp: Date.now()
            });
        }
    });
    
    socket.on('shoot', (data) => {
        const player = players.get(socket.id);
        if (player?.roomId) {
            socket.to(player.roomId).emit('player_shot', {
                userId: player.userId,
                timestamp: Date.now()
            });
        }
    });
    
    socket.on('disconnect', () => {
        const player = players.get(socket.id);
        if (player) {
            if (player.roomId) {
                const room = rooms.get(player.roomId);
                if (room) {
                    const index = room.players.findIndex(p => p.socketId === socket.id);
                    if (index !== -1) {
                        room.players.splice(index, 1);
                        socket.to(player.roomId).emit('player_left', {
                            userId: player.userId
                        });
                        
                        if (room.players.length === 0) {
                            rooms.delete(player.roomId);
                        } else if (room.status === 'waiting') {
                            updateRoom(player.roomId);
                        }
                    }
                }
            }
            players.delete(socket.id);
            broadcastRoomsList();
        }
        console.log(`🔌 Disconnected: ${socket.id}`);
    });
});

// ============================================
// 🚀 تشغيل الخادم
// ============================================
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`🎮 Tanks Game Server running on port ${PORT}`);
    console.log(`📡 WebSocket ready`);
    console.log(`🔥 Firebase connected`);
    console.log(`👑 Admin email: admin@boomb.com`);
    console.log(`🔐 Admin secret: ${process.env.ADMIN_SECRET || 'set-in-env'}`);
});
