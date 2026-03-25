// ============================================
// 🚀 خادم لعبة Battle Tanks - النسخة النهائية للإنتاج
// ============================================
// Author: Battle Tanks Team
// Version: 3.0.0
// Description: خادم متكامل للألعاب متعددة اللاعبين مع نظام إدارة متقدم
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
// 📦 الإعدادات العامة والتخزين المؤقت
// ============================================
let globalGameSettings = {
    seatPrice: 1,
    maxPlayers: 2,
    gameDuration: 5 * 60 * 1000 // 5 دقائق
};

const players = new Map();      // socketId -> player data
const rooms = new Map();        // roomId -> room data

// ============================================
// 🔧 دوال مساعدة
// ============================================
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

// بدء اللعبة مع إعدادات الفرق والمواقع
function startGame(roomId) {
    const room = rooms.get(roomId);
    if (!room || room.status !== 'waiting') return;
    
    room.status = 'active';
    room.startTime = Date.now();
    
    const playersList = room.players;
    const positions = [
        { x: -75, z: -70, team: 1 },  // الفريق الأحمر (الموقع الأيسر)
        { x: 70, z: 70, team: 2 }      // الفريق الأزرق (الموقع الأيمن)
    ];
    
    // تعيين الفرق والمواقع لكل لاعب
    for (let i = 0; i < playersList.length; i++) {
        const pos = positions[i % positions.length];
        playersList[i].team = pos.team;
        playersList[i].position = { x: pos.x, z: pos.z, y: 0 };
        playersList[i].rotation = 0;
        playersList[i].health = 100;
    }
    
    // إرسال بدء اللعبة لكل لاعب مع معلوماته
    for (const player of playersList) {
        io.to(player.socketId).emit('game_start', {
            roomId: roomId,
            players: playersList.map(p => ({ userId: p.userId, team: p.team })),
            yourTeam: player.team,
            startTime: room.startTime,
            position: player.position,
            health: player.health
        });
    }
    
    console.log(`🎮 Game started in room ${roomId} with ${playersList.length} players`);
    
    // بدء بث حالة اللعبة كل 50ms (20 مرة في الثانية)
    const gameInterval = setInterval(() => {
        const currentRoom = rooms.get(roomId);
        if (!currentRoom || currentRoom.status !== 'active') {
            clearInterval(gameInterval);
            return;
        }
        
        // جمع تحديثات اللاعبين
        const playersUpdate = [];
        for (const player of currentRoom.players) {
            if (player.position) {
                playersUpdate.push({
                    userId: player.userId,
                    position: player.position,
                    rotation: player.rotation || 0,
                    health: player.health || 100,
                    team: player.team
                });
            }
        }
        
        // بث التحديثات لجميع اللاعبين في الغرفة
        io.to(roomId).emit('game_state_update', { players: playersUpdate });
    }, 50);
    
    room.gameInterval = gameInterval;
    
    // جدولة نهاية اللعبة
    setTimeout(() => {
        endGame(roomId, 'انتهت مدة المعركة!');
    }, globalGameSettings.gameDuration);
}

// إنهاء اللعبة وتوزيع المكافآت
async function endGame(roomId, reason) {
    const room = rooms.get(roomId);
    if (!room || room.status === 'ended') return;
    
    room.status = 'ended';
    if (room.gameInterval) clearInterval(room.gameInterval);
    
    const duration = Math.floor((Date.now() - (room.startTime || Date.now())) / 1000);
    
    // تحديد الفائز (اللاعب المتبقي)
    let winnerTeam = null;
    let winnerName = null;
    
    if (room.players.length === 1) {
        winnerTeam = room.players[0].team;
        winnerName = winnerTeam === 1 ? 'الفريق الأحمر' : 'الفريق الأزرق';
    } else if (room.players.length === 2) {
        const player1 = room.players[0];
        const player2 = room.players[1];
        const health1 = player1.health || 100;
        const health2 = player2.health || 100;
        
        if (health1 > health2) {
            winnerTeam = player1.team;
            winnerName = winnerTeam === 1 ? 'الفريق الأحمر' : 'الفريق الأزرق';
        } else if (health2 > health1) {
            winnerTeam = player2.team;
            winnerName = winnerTeam === 1 ? 'الفريق الأحمر' : 'الفريق الأزرق';
        } else {
            winnerName = 'تعادل';
        }
    }
    
    const reward = 10;
    
    for (const player of room.players) {
        try {
            const userRef = db.ref(`users/${player.userId}`);
            const snapshot = await userRef.once('value');
            let userData = snapshot.val();
            let currentBalance = userData?.balance || 100;
            const isWinner = (player.team === winnerTeam && winnerTeam);
            
            if (isWinner) {
                currentBalance += reward;
            }
            
            await userRef.update({ 
                balance: currentBalance,
                lastGame: Date.now(),
                gamesPlayed: (userData?.gamesPlayed || 0) + 1,
                wins: (userData?.wins || 0) + (isWinner ? 1 : 0)
            });
            
            io.to(player.socketId).emit('game_ended', {
                message: reason || 'انتهت المعركة!',
                reward: isWinner ? reward : 0,
                duration: duration,
                yourBalance: currentBalance,
                winner: winnerName,
                yourTeam: player.team === 1 ? 'الأحمر' : 'الأزرق'
            });
        } catch (error) {
            console.error('Error updating balance:', error);
            io.to(player.socketId).emit('game_ended', {
                message: 'انتهت المعركة!',
                reward: 0,
                duration: duration
            });
        }
    }
    
    console.log(`🏆 Game ended in room ${roomId}, winner: ${winnerName}`);
    
    setTimeout(() => {
        rooms.delete(roomId);
        broadcastRoomsList();
    }, 10000);
}

// ============================================
// 📡 API Routes - نظام الإدارة المتقدم
// ============================================

// التحقق من صحة الخادم
app.get('/health', (req, res) => {
    res.json({ status: 'online', timestamp: Date.now(), version: '3.0.0' });
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

// إدارة الأرصدة (للمدير)
app.post('/api/admin/balance', async (req, res) => {
    try {
        const { adminToken, userId, amount, action } = req.body;
        
        if (adminToken !== 'authenticated' && adminToken !== process.env.ADMIN_SECRET) {
            return res.status(403).json({ success: false, error: 'Unauthorized' });
        }
        
        // التحقق من صلاحية المدير
        const adminSnapshot = await db.ref(`users/${userId}`).once('value');
        if (!adminSnapshot.val()?.isAdmin) {
            return res.status(403).json({ success: false, error: 'Not admin' });
        }
        
        const userRef = db.ref(`users/${userId}`);
        const snapshot = await userRef.once('value');
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
        
        await userRef.update({ balance: currentBalance });
        
        // تسجيل المعاملة
        const transactionRef = db.ref(`transactions/${userId}`).push();
        await transactionRef.set({
            type: action,
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

// الحصول على إحصائيات اللاعبين
app.get('/api/admin/stats', async (req, res) => {
    try {
        const { adminToken, userId } = req.query;
        
        if (adminToken !== 'authenticated' && adminToken !== process.env.ADMIN_SECRET) {
            return res.status(403).json({ success: false, error: 'Unauthorized' });
        }
        
        // التحقق من صلاحية المدير
        const adminSnapshot = await db.ref(`users/${userId}`).once('value');
        if (!adminSnapshot.val()?.isAdmin) {
            return res.status(403).json({ success: false, error: 'Not admin' });
        }
        
        const usersSnapshot = await db.ref('users').once('value');
        const users = usersSnapshot.val();
        const report = {
            totalUsers: 0,
            totalBalance: 0,
            totalGames: 0,
            totalWins: 0,
            users: []
        };
        
        if (users) {
            for (const [id, data] of Object.entries(users)) {
                report.totalUsers++;
                report.totalBalance += data.balance || 0;
                report.totalGames += data.gamesPlayed || 0;
                report.totalWins += data.wins || 0;
                report.users.push({
                    id: id,
                    email: data.email,
                    username: data.username,
                    balance: data.balance || 100,
                    gamesPlayed: data.gamesPlayed || 0,
                    wins: data.wins || 0,
                    isAdmin: data.isAdmin || false,
                    lastGame: data.lastGame,
                    createdAt: data.createdAt
                });
            }
        }
        
        res.json({ success: true, report });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

// تغيير سعر المقعد
app.post('/api/admin/setSeatPrice', async (req, res) => {
    try {
        const { adminToken, userId, price } = req.body;
        
        if (adminToken !== 'authenticated' && adminToken !== process.env.ADMIN_SECRET) {
            return res.status(403).json({ success: false, error: 'Unauthorized' });
        }
        
        const snapshot = await db.ref(`users/${userId}`).once('value');
        if (!snapshot.val()?.isAdmin) {
            return res.status(403).json({ success: false, error: 'Not admin' });
        }
        
        const newPrice = Math.max(1, Math.min(1000, price));
        globalGameSettings.seatPrice = newPrice;
        
        res.json({ success: true, seatPrice: newPrice });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

// تغيير عدد اللاعبين في الجولة
app.post('/api/admin/setMaxPlayers', async (req, res) => {
    try {
        const { adminToken, userId, maxPlayers } = req.body;
        
        if (adminToken !== 'authenticated' && adminToken !== process.env.ADMIN_SECRET) {
            return res.status(403).json({ success: false, error: 'Unauthorized' });
        }
        
        const snapshot = await db.ref(`users/${userId}`).once('value');
        if (!snapshot.val()?.isAdmin) {
            return res.status(403).json({ success: false, error: 'Not admin' });
        }
        
        const newMax = Math.max(2, Math.min(16, maxPlayers));
        globalGameSettings.maxPlayers = newMax;
        
        res.json({ success: true, maxPlayers: newMax });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

// الحصول على الإعدادات الحالية
app.get('/api/admin/settings', async (req, res) => {
    try {
        const { adminToken } = req.query;
        
        if (adminToken !== 'authenticated' && adminToken !== process.env.ADMIN_SECRET) {
            return res.status(403).json({ success: false, error: 'Unauthorized' });
        }
        
        res.json({ 
            success: true, 
            settings: {
                seatPrice: globalGameSettings.seatPrice,
                maxPlayers: globalGameSettings.maxPlayers,
                gameDuration: globalGameSettings.gameDuration
            }
        });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

// مسح جميع بيانات اللاعبين (تهيئة قاعدة البيانات)
app.post('/api/admin/resetData', async (req, res) => {
    try {
        const { adminToken, userId } = req.body;
        
        if (adminToken !== 'authenticated' && adminToken !== process.env.ADMIN_SECRET) {
            return res.status(403).json({ success: false, error: 'Unauthorized' });
        }
        
        const snapshot = await db.ref(`users/${userId}`).once('value');
        if (!snapshot.val()?.isAdmin) {
            return res.status(403).json({ success: false, error: 'Not admin' });
        }
        
        // حذف جميع المستخدمين
        await db.ref('users').remove();
        await db.ref('transactions').remove();
        
        // إعادة إنشاء مستخدم المدير الافتراضي
        await db.ref('users/admin_default').set({
            email: 'admin@boomb.com',
            username: 'Admin',
            balance: 9999,
            isAdmin: true,
            createdAt: Date.now(),
            gamesPlayed: 0,
            wins: 0
        });
        
        console.log('🗑️ All user data has been reset by admin');
        res.json({ success: true, message: 'تم مسح جميع بيانات اللاعبين بنجاح' });
    } catch (error) {
        console.error('Reset error:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

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
    
    // ============================================
    // 🔐 المصادقة
    // ============================================
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
            const isAdmin = (email === 'admin@boomb.com' || email === 'admin2613857@boomb.com');
            
            if (!userData) {
                userData = { 
                    balance: 100, 
                    username: email.split('@')[0],
                    email: email,
                    isAdmin: isAdmin,
                    createdAt: Date.now(),
                    gamesPlayed: 0,
                    wins: 0
                };
                await userRef.set(userData);
            } else if (isAdmin && !userData.isAdmin) {
                await userRef.update({ isAdmin: true });
                userData.isAdmin = true;
            }
            
            socket.emit('auth_success', {
                userId: userId,
                email: email,
                balance: userData.balance || 100,
                username: userData.username,
                isAdmin: userData.isAdmin || false,
                gamesPlayed: userData.gamesPlayed || 0,
                wins: userData.wins || 0
            });
            
            console.log(`✅ User authenticated: ${email} (Admin: ${userData.isAdmin || false})`);
            
        } catch (error) {
            console.error('❌ Auth error:', error);
            socket.emit('auth_error', { message: 'Invalid token: ' + error.message });
        }
    });
    
    // ============================================
    // 🏠 اللوبي والغرف
    // ============================================
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
                isAdmin: userData?.isAdmin || false,
                settings: {
                    seatPrice: globalGameSettings.seatPrice,
                    maxPlayers: globalGameSettings.maxPlayers
                }
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
    
    // إنشاء غرفة جديدة
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
        const maxSeats = data.seats || globalGameSettings.maxPlayers;
        
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
    
    // الانضمام إلى غرفة
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
    
    // ============================================
    // 🎮 أحداث اللعبة (مزامنة كاملة)
    // ============================================
    
    // حركة اللاعب
    socket.on('move', (data) => {
        const player = players.get(socket.id);
        if (player?.roomId) {
            const room = rooms.get(player.roomId);
            if (room && room.status === 'active') {
                // تحديث موقع اللاعب في الغرفة
                const roomPlayer = room.players.find(p => p.socketId === socket.id);
                if (roomPlayer) {
                    roomPlayer.position = data.position;
                    roomPlayer.rotation = data.rotation;
                }
                // إرسال حركة اللاعب لجميع اللاعبين الآخرين في الغرفة
                socket.to(player.roomId).emit('player_moved', {
                    userId: player.userId,
                    position: data.position,
                    rotation: data.rotation,
                    timestamp: Date.now()
                });
            }
        }
    });
    
    // إطلاق النار
    socket.on('shoot', (data) => {
        const player = players.get(socket.id);
        if (player?.roomId) {
            socket.to(player.roomId).emit('player_shot', {
                userId: player.userId,
                position: data.position,
                direction: data.direction,
                timestamp: Date.now()
            });
        }
    });
    
    // تحديث الصحة بعد الضرر
    socket.on('damage', (data) => {
        const player = players.get(socket.id);
        if (player?.roomId) {
            const room = rooms.get(player.roomId);
            if (room && room.status === 'active') {
                const roomPlayer = room.players.find(p => p.socketId === socket.id);
                if (roomPlayer) {
                    roomPlayer.health = Math.max(0, (roomPlayer.health || 100) - data.damage);
                    
                    // إرسال تحديث الصحة للجميع
                    io.to(player.roomId).emit('health_update', {
                        userId: player.userId,
                        health: roomPlayer.health
                    });
                    
                    if (roomPlayer.health <= 0) {
                        roomPlayer.health = 0;
                        io.to(player.roomId).emit('player_destroyed', {
                            userId: player.userId,
                            killerId: data.killerId,
                            position: roomPlayer.position
                        });
                        
                        // التحقق من انتهاء اللعبة
                        const alivePlayers = room.players.filter(p => (p.health || 100) > 0);
                        if (alivePlayers.length <= 1) {
                            const winner = alivePlayers[0];
                            const winnerName = winner.team === 1 ? 'الفريق الأحمر' : 'الفريق الأزرق';
                            endGame(player.roomId, `🎉 فوز ${winnerName}! 🎉`);
                        }
                    }
                }
            }
        }
    });
    
    // ============================================
    // 🔌 انقطاع الاتصال
    // ============================================
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
                            if (room.gameInterval) clearInterval(room.gameInterval);
                            rooms.delete(player.roomId);
                        } else if (room.status === 'active') {
                            // إذا كان هناك لاعب واحد متبقي، أعلن فوزه
                            const winnerPlayer = room.players[0];
                            const winnerTeam = winnerPlayer.team;
                            const winnerName = winnerTeam === 1 ? 'الفريق الأحمر' : 'الفريق الأزرق';
                            
                            // إنهاء اللعبة للاعب المتبقي
                            endGame(player.roomId, `🎉 فوز ${winnerName} بسبب انسحاب الخصم! 🎉`);
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
    console.log(`
╔══════════════════════════════════════════════════════════════╗
║                                                              ║
║     🎮 BATTLE TANKS GAME SERVER - READY FOR PRODUCTION 🎮    ║
║                                                              ║
╠══════════════════════════════════════════════════════════════╣
║  📡 Server running on port: ${PORT}
║  🌐 WebSocket: Ready
║  🔥 Firebase: Connected
║  👑 Admin email: admin@boomb.com
║  💰 Seat price: ${globalGameSettings.seatPrice}$
║  👥 Max players: ${globalGameSettings.maxPlayers}
║  ⏱️  Game duration: ${globalGameSettings.gameDuration / 1000} seconds
║  🔐 Admin secret: ${process.env.ADMIN_SECRET ? '✅ Set' : '⚠️ Not set'}
║                                                              ║
╚══════════════════════════════════════════════════════════════╝
    `);
});
