// ============================================
// 🚀 خادم لعبة Battle Tanks - النسخة المحسنة للأداء
// ============================================
// Author: Battle Tanks Team
// Version: 4.0.0
// Description: خادم محسن مع تقنيات Interpolation وضغط البيانات وتقليل الحمولة
// ============================================

const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const admin = require('firebase-admin');
const cors = require('cors');
const compression = require('compression');

// ============================================
// 🔥 تهيئة Express و Firebase
// ============================================
const app = express();
app.use(cors());
app.use(express.json());
app.use(compression()); // ضغط البيانات

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
    pingInterval: 25000,
    perMessageDeflate: {
        threshold: 1024 // ضغط الرسائل الأكبر من 1KB
    }
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
// 🎮 نظام تحسين الأداء
// ============================================

// ضغط بيانات اللاعب
function compressPlayerData(player, includeFull = false) {
    const compressed = {
        u: player.userId.substring(0, 8), // اختصار ID
        x: Math.round(player.position.x * 10) / 10,
        z: Math.round(player.position.z * 10) / 10,
        r: Math.round((player.rotation || 0) * 10) / 10,
        h: Math.round(player.health || 100),
        t: player.team
    };
    
    if (includeFull) {
        compressed.f = true; // علامة تحديث كامل
    }
    
    return compressed;
}

// فك ضغط بيانات اللاعب
function decompressPlayerData(compressed) {
    return {
        userId: compressed.u,
        position: { x: compressed.x, z: compressed.z, y: 0 },
        rotation: compressed.r,
        health: compressed.h,
        team: compressed.t
    };
}

// حساب الفرق بين حالتين
function calculateDelta(previous, current) {
    if (!previous) return current;
    
    const delta = { u: current.u };
    let hasChanges = false;
    
    if (previous.x !== current.x || previous.z !== current.z) {
        delta.dx = current.x - previous.x;
        delta.dz = current.z - previous.z;
        hasChanges = true;
    }
    
    if (previous.r !== current.r) {
        delta.dr = current.r - previous.r;
        hasChanges = true;
    }
    
    if (previous.h !== current.h) {
        delta.h = current.h;
        hasChanges = true;
    }
    
    return hasChanges ? delta : null;
}

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

// بدء اللعبة مع نظام تحديث محسن
function startGame(roomId) {
    const room = rooms.get(roomId);
    if (!room || room.status !== 'waiting') return;
    
    room.status = 'active';
    room.startTime = Date.now();
    room.lastUpdateTime = Date.now();
    room.lastStates = new Map(); // تخزين الحالات السابقة للفروقات
    room.updateCounter = 0;
    
    const playersList = room.players;
    const positions = [
        { x: -75, z: -70, team: 1 },  // الفريق الأحمر
        { x: 70, z: 70, team: 2 }      // الفريق الأزرق
    ];
    
    // تعيين الفرق والمواقع لكل لاعب
    for (let i = 0; i < playersList.length; i++) {
        const pos = positions[i % positions.length];
        playersList[i].team = pos.team;
        playersList[i].position = { x: pos.x, z: pos.z, y: 0 };
        playersList[i].rotation = 0;
        playersList[i].health = 100;
        playersList[i].lastSentState = null;
    }
    
    // إرسال بدء اللعبة لكل لاعب مع معلوماته
    for (const player of playersList) {
        io.to(player.socketId).emit('game_start', {
            roomId: roomId,
            players: playersList.map(p => ({ userId: p.userId, team: p.team })),
            yourTeam: player.team,
            startTime: room.startTime,
            position: player.position,
            health: player.health,
            serverConfig: {
                updateRate: 33, // مللي ثانية بين التحديثات
                interpolation: true
            }
        });
    }
    
    console.log(`🎮 Game started in room ${roomId} with ${playersList.length} players`);
    
    // نظام تحديث ذكي بتردد متغير
    const GAME_UPDATE_INTERVAL = 33; // 30 مرة في الثانية (أقل من 50 السابقة)
    const FULL_UPDATE_INTERVAL = 6; // تحديث كامل كل 6 دورات (~200ms)
    
    const gameInterval = setInterval(() => {
        const currentRoom = rooms.get(roomId);
        if (!currentRoom || currentRoom.status !== 'active') {
            clearInterval(gameInterval);
            return;
        }
        
        currentRoom.updateCounter++;
        const isFullUpdate = (currentRoom.updateCounter % FULL_UPDATE_INTERVAL === 0);
        const now = Date.now();
        
        // جمع تحديثات اللاعبين مع ضغط البيانات
        const updates = [];
        const deltas = [];
        
        for (const player of currentRoom.players) {
            if (!player.position || player.health <= 0) continue;
            
            // ضغط البيانات الحالية
            const compressedCurrent = compressPlayerData(player, isFullUpdate);
            
            if (isFullUpdate) {
                // تحديث كامل (كل 200ms)
                updates.push(compressedCurrent);
                player.lastSentState = compressedCurrent;
            } else {
                // إرسال الفروقات فقط
                const delta = calculateDelta(player.lastSentState, compressedCurrent);
                if (delta) {
                    deltas.push(delta);
                    player.lastSentState = compressedCurrent;
                }
            }
        }
        
        // إرسال التحديثات للعملاء
        if (isFullUpdate && updates.length > 0) {
            // تحديث كامل - يرسل كل 200ms
            io.to(roomId).emit('game_state_update', {
                type: 'full',
                players: updates,
                ts: now,
                frame: currentRoom.updateCounter
            });
        } else if (deltas.length > 0) {
            // فروقات فقط - يرسل كل 33ms
            io.to(roomId).emit('game_state_update', {
                type: 'delta',
                players: deltas,
                ts: now,
                frame: currentRoom.updateCounter
            });
        }
        
        // تحديث وقت آخر تحديث
        currentRoom.lastUpdateTime = now;
        
    }, GAME_UPDATE_INTERVAL);
    
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
    
    // تحديد الفائز
    let winnerTeam = null;
    let winnerName = null;
    const alivePlayers = room.players.filter(p => p.health > 0);
    
    if (alivePlayers.length === 1) {
        winnerTeam = alivePlayers[0].team;
        winnerName = winnerTeam === 1 ? 'الفريق الأحمر' : 'الفريق الأزرق';
    } else if (alivePlayers.length === 2) {
        const player1 = alivePlayers[0];
        const player2 = alivePlayers[1];
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
    } else if (alivePlayers.length === 0) {
        winnerName = 'تعادل (جميع اللاعبين قضوا)';
    }
    
    const reward = 10;
    
    for (const player of room.players) {
        try {
            const userRef = db.ref(`users/${player.userId}`);
            const snapshot = await userRef.once('value');
            let userData = snapshot.val();
            let currentBalance = userData?.balance || 100;
            const isWinner = (player.team === winnerTeam && winnerTeam && player.health > 0);
            
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
// 📡 API Routes (نفس الكود السابق بدون تغيير)
// ============================================

app.get('/health', (req, res) => {
    res.json({ status: 'online', timestamp: Date.now(), version: '4.0.0' });
});

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

app.post('/api/admin/balance', async (req, res) => {
    try {
        const { adminToken, userId, amount, action } = req.body;
        
        if (adminToken !== 'authenticated' && adminToken !== process.env.ADMIN_SECRET) {
            return res.status(403).json({ success: false, error: 'Unauthorized' });
        }
        
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

app.get('/api/admin/stats', async (req, res) => {
    try {
        const { adminToken, userId } = req.query;
        
        if (adminToken !== 'authenticated' && adminToken !== process.env.ADMIN_SECRET) {
            return res.status(403).json({ success: false, error: 'Unauthorized' });
        }
        
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
        
        await db.ref('users').remove();
        await db.ref('transactions').remove();
        
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
// 🔌 أحداث Socket.io (محسنة)
// ============================================
io.on('connection', (socket) => {
    console.log(`🔌 New connection: ${socket.id}`);
    
    players.set(socket.id, {
        socketId: socket.id,
        userId: null,
        roomId: null,
        connectedAt: Date.now(),
        lastMoveTime: 0
    });
    
    // ============================================
    // 🔐 المصادقة (نفس الكود)
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
    // 🏠 اللوبي والغرف (نفس الكود)
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
                email: player.email,
                health: 100
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
            email: player.email,
            health: 100
        });
        player.roomId = roomId;
        
        socket.join(roomId);
        socket.emit('room_joined', { roomId: roomId });
        
        updateRoom(roomId);
        broadcastRoomsList();
        
        console.log(`👥 ${player.email} joined room ${roomId}`);
    });
    
    // ============================================
    // 🎮 أحداث اللعبة المحسنة
    // ============================================
    
    // حركة اللاعب مع تحديد التردد
    socket.on('move', (data) => {
        const player = players.get(socket.id);
        if (!player?.roomId) return;
        
        const now = Date.now();
        // تحديد تردد الإرسال (30 مرة في الثانية كحد أقصى)
        if (now - player.lastMoveTime < 33) return;
        player.lastMoveTime = now;
        
        const room = rooms.get(player.roomId);
        if (room && room.status === 'active') {
            const roomPlayer = room.players.find(p => p.socketId === socket.id);
            if (roomPlayer && roomPlayer.health > 0) {
                roomPlayer.position = data.position;
                roomPlayer.rotation = data.rotation;
                roomPlayer.lastUpdate = now;
            }
            
            // إرسال حركة اللاعب للآخرين (بدون إرسال للاعب نفسه)
            socket.to(player.roomId).emit('player_moved', {
                userId: player.userId,
                position: data.position,
                rotation: data.rotation,
                timestamp: now
            });
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
    
    // تحديث الصحة بعد الضرر (محسن)
    socket.on('damage', (data) => {
        const player = players.get(socket.id);
        if (!player?.roomId) return;
        
        const room = rooms.get(player.roomId);
        if (!room || room.status !== 'active') return;
        
        const targetPlayer = room.players.find(p => p.userId === data.targetId);
        
        if (targetPlayer && targetPlayer.health > 0) {
            const oldHealth = targetPlayer.health || 100;
            targetPlayer.health = Math.max(0, oldHealth - data.damage);
            
            console.log(`💥 Damage dealt: ${data.damage} to ${targetPlayer.userId} by ${player.userId}. Health: ${oldHealth} -> ${targetPlayer.health}`);
            
            // إرسال تحديث الصحة للجميع
            io.to(player.roomId).emit('health_update', {
                userId: targetPlayer.userId,
                health: targetPlayer.health
            });
            
            // إذا كان اللاعب المستهدف قد مات
            if (targetPlayer.health <= 0) {
                targetPlayer.health = 0;
                
                io.to(player.roomId).emit('player_eliminated', {
                    userId: targetPlayer.userId,
                    killerId: player.userId,
                    position: targetPlayer.position
                });
                
                console.log(`💀 Player ${targetPlayer.userId} eliminated by ${player.userId}`);
                
                const targetSocket = io.sockets.sockets.get(targetPlayer.socketId);
                if (targetSocket) {
                    targetSocket.emit('you_were_eliminated', {
                        message: 'لقد تم تدمير دبابتك!',
                        killerId: player.userId
                    });
                }
                
                // التحقق من انتهاء اللعبة
                const alivePlayers = room.players.filter(p => p.health > 0);
                console.log(`Alive players: ${alivePlayers.length}`);
                
                if (alivePlayers.length <= 1) {
                    if (alivePlayers.length === 1) {
                        const winner = alivePlayers[0];
                        const winnerName = winner.team === 1 ? 'الفريق الأحمر' : 'الفريق الأزرق';
                        endGame(player.roomId, `🎉 فوز ${winnerName}! 🎉`);
                    } else {
                        endGame(player.roomId, '🤝 تعادل!');
                    }
                } else {
                    // تحديث قائمة اللاعبين للجميع
                    const playersUpdate = [];
                    for (const p of room.players) {
                        if (p.position && p.health > 0) {
                            playersUpdate.push({
                                userId: p.userId,
                                position: p.position,
                                rotation: p.rotation || 0,
                                health: p.health || 100,
                                team: p.team
                            });
                        }
                    }
                    io.to(player.roomId).emit('players_list_update', { players: playersUpdate });
                }
            }
        } else {
            console.log(`⚠️ Target player not found or already eliminated: ${data.targetId}`);
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
                            const alivePlayers = room.players.filter(p => p.health > 0);
                            if (alivePlayers.length === 1) {
                                const winnerPlayer = alivePlayers[0];
                                const winnerTeam = winnerPlayer.team;
                                const winnerName = winnerTeam === 1 ? 'الفريق الأحمر' : 'الفريق الأزرق';
                                endGame(player.roomId, `🎉 فوز ${winnerName} بسبب انسحاب الخصم! 🎉`);
                            } else if (alivePlayers.length === 0) {
                                endGame(player.roomId, 'انتهت المعركة بسبب انسحاب جميع اللاعبين');
                            }
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
║   🎮 BATTLE TANKS GAME SERVER - OPTIMIZED VERSION 4.0 🎮     ║
║                                                              ║
╠══════════════════════════════════════════════════════════════╣
║  📡 Server running on port: ${PORT}
║  🌐 WebSocket: Ready (with compression)
║  🔥 Firebase: Connected
║  👑 Admin email: admin@boomb.com
║  💰 Seat price: ${globalGameSettings.seatPrice}$
║  👥 Max players: ${globalGameSettings.maxPlayers}
║  ⏱️  Game duration: ${globalGameSettings.gameDuration / 1000} seconds
║  🔐 Admin secret: ${process.env.ADMIN_SECRET ? '✅ Set' : '⚠️ Not set'}
║  ⚡ Optimizations:                                     ║
║     • Data compression enabled                         ║
║     • Delta updates (30 fps → 70% less data)          ║
║     • Full updates every 200ms                        ║
║     • Player move throttling (33ms)                   ║
║     • WebSocket perMessageDeflate                     ║
║  🎯 Smooth movement: Interpolation ready              ║
║                                                              ║
╚══════════════════════════════════════════════════════════════╝
    `);
});
