// ============================================
// 🚀 خادم لعبة Battle Tanks - النسخة الاحترافية الكاملة
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
// 📦 تخزين البيانات المؤقتة
// ============================================
const players = new Map();
const rooms = new Map();
let globalGameSettings = {
    seatPrice: 1,
    maxPlayers: 2,  // تغيير إلى 2 لاعبين فقط
    gameDuration: 5 * 60 * 1000 // 5 دقائق
};

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
        { x: -70, z: -70, team: 1 },  // الفريق الأحمر (الموقع الأيسر)
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
    const reward = 10;
    
    // تحديد الفائز (الفريق الذي بقي فيه لاعبون)
    let winnerTeam = null;
    let winnerName = null;
    
    if (room.players.length === 1) {
        winnerTeam = room.players[0].team;
        winnerName = winnerTeam === 1 ? 'الفريق الأحمر' : 'الفريق الأزرق';
    } else if (room.players.length === 2) {
        // مقارنة الصحة لتحديد الفائز
        const player1 = room.players[0];
        const player2 = room.players[1];
        if (player1.health > player2.health) {
            winnerTeam = player1.team;
            winnerName = winnerTeam === 1 ? 'الفريق الأحمر' : 'الفريق الأزرق';
        } else if (player2.health > player1.health) {
            winnerTeam = player2.team;
            winnerName = winnerTeam === 1 ? 'الفريق الأحمر' : 'الفريق الأزرق';
        } else {
            winnerName = 'تعادل';
        }
    }
    
    for (const player of room.players) {
        try {
            const userRef = db.ref(`users/${player.userId}`);
            const snapshot = await userRef.once('value');
            let currentBalance = snapshot.val()?.balance || 100;
            const isWinner = (player.team === winnerTeam);
            
            // إضافة مكافأة للفائز فقط
            if (isWinner && winnerTeam) {
                currentBalance += reward;
            }
            
            await userRef.update({ 
                balance: currentBalance,
                lastGame: Date.now(),
                gamesPlayed: (snapshot.val()?.gamesPlayed || 0) + 1,
                wins: (snapshot.val()?.wins || 0) + (isWinner ? 1 : 0)
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
// 📊 دوال إدارة المدير (Admin Functions)
// ============================================

// التحقق من صلاحية المدير
async function isAdminUser(userId) {
    const snapshot = await db.ref(`users/${userId}`).once('value');
    const userData = snapshot.val();
    return userData?.isAdmin === true;
}

// تغيير سعر المقعد
async function setSeatPrice(userId, price) {
    if (!await isAdminUser(userId)) return { success: false, error: 'Unauthorized' };
    if (price < 1) price = 1;
    if (price > 1000) price = 1000;
    globalGameSettings.seatPrice = price;
    return { success: true, seatPrice: price };
}

// تغيير عدد اللاعبين في الجولة
async function setMaxPlayers(userId, maxPlayers) {
    if (!await isAdminUser(userId)) return { success: false, error: 'Unauthorized' };
    if (maxPlayers < 2) maxPlayers = 2;
    if (maxPlayers > 16) maxPlayers = 16;
    globalGameSettings.maxPlayers = maxPlayers;
    return { success: true, maxPlayers: maxPlayers };
}

// الحصول على تقرير كامل عن اللاعبين
async function getFullReport(userId) {
    if (!await isAdminUser(userId)) return { success: false, error: 'Unauthorized' };
    
    const snapshot = await db.ref('users').once('value');
    const users = snapshot.val();
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
                createdAt: data.createdAt,
                lastGame: data.lastGame
            });
        }
    }
    
    return { success: true, report };
}

// مسح جميع بيانات اللاعبين (تهيئة قاعدة البيانات)
async function resetAllData(userId, adminSecret) {
    if (adminSecret !== process.env.ADMIN_SECRET) {
        return { success: false, error: 'Invalid admin secret' };
    }
    if (!await isAdminUser(userId)) {
        return { success: false, error: 'Unauthorized' };
    }
    
    try {
        // حذف جميع المستخدمين
        await db.ref('users').remove();
        await db.ref('transactions').remove();
        
        // إنشاء مستخدم المدير الافتراضي
        const adminEmail = 'admin@boomb.com';
        const adminUser = {
            email: adminEmail,
            username: 'Admin',
            balance: 9999,
            isAdmin: true,
            createdAt: Date.now(),
            gamesPlayed: 0,
            wins: 0
        };
        
        // الحصول على UID من Firebase Auth للمدير (يتم إنشاؤه عند التسجيل)
        await db.ref('users/admin_default').set(adminUser);
        
        console.log('🗑️ All user data has been reset');
        return { success: true, message: 'تم مسح جميع بيانات اللاعبين بنجاح' };
    } catch (error) {
        console.error('Reset error:', error);
        return { success: false, error: error.message };
    }
}

// ============================================
// 📡 API Routes للإدارة
// ============================================

app.get('/health', (req, res) => {
    res.json({ status: 'online', timestamp: Date.now() });
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

// API للمدير: تعديل رصيد لاعب
app.post('/api/admin/balance', async (req, res) => {
    try {
        const { adminToken, userId, amount, action } = req.body;
        
        if (adminToken !== process.env.ADMIN_SECRET) {
            return res.status(403).json({ success: false, error: 'Unauthorized' });
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
        
        res.json({ success: true, newBalance: currentBalance });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

// API للمدير: الحصول على إحصائيات
app.get('/api/admin/stats', async (req, res) => {
    try {
        const { adminToken, userId } = req.query;
        
        if (adminToken !== process.env.ADMIN_SECRET) {
            return res.status(403).json({ success: false, error: 'Unauthorized' });
        }
        
        const result = await getFullReport(userId);
        res.json(result);
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

// API للمدير: تغيير سعر المقعد
app.post('/api/admin/setSeatPrice', async (req, res) => {
    try {
        const { adminToken, userId, price } = req.body;
        
        if (adminToken !== process.env.ADMIN_SECRET) {
            return res.status(403).json({ success: false, error: 'Unauthorized' });
        }
        
        const result = await setSeatPrice(userId, price);
        res.json(result);
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

// API للمدير: تغيير عدد اللاعبين
app.post('/api/admin/setMaxPlayers', async (req, res) => {
    try {
        const { adminToken, userId, maxPlayers } = req.body;
        
        if (adminToken !== process.env.ADMIN_SECRET) {
            return res.status(403).json({ success: false, error: 'Unauthorized' });
        }
        
        const result = await setMaxPlayers(userId, maxPlayers);
        res.json(result);
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

// API للمدير: مسح جميع البيانات
app.post('/api/admin/resetData', async (req, res) => {
    try {
        const { adminToken, userId } = req.body;
        
        if (adminToken !== process.env.ADMIN_SECRET) {
            return res.status(403).json({ success: false, error: 'Unauthorized' });
        }
        
        const result = await resetAllData(userId, adminToken);
        res.json(result);
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

// API للمدير: الحصول على الإعدادات الحالية
app.get('/api/admin/settings', async (req, res) => {
    try {
        const { adminToken } = req.query;
        
        if (adminToken !== process.env.ADMIN_SECRET) {
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
    
    // المصادقة
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
            const isAdmin = (email === 'admin@boomb.com');
            
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
                await userRef.update({ isAdmin: true });
                userData.isAdmin = true;
            }
            
            socket.emit('auth_success', {
                userId: userId,
                email: email,
                balance: userData.balance || 100,
                username: userData.username,
                isAdmin: userData.isAdmin || false,
                gamesPlayed: userData.gamesPlayed || 0
            });
            
            console.log(`✅ User authenticated: ${email} (Admin: ${userData.isAdmin || false})`);
            
        } catch (error) {
            console.error('❌ Auth error:', error);
            socket.emit('auth_error', { message: 'Invalid token: ' + error.message });
        }
    });
    
    // الانضمام إلى اللوبي
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
    
    // حركة اللاعب (مع تحديث الموقع في الغرفة)
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
                    roomPlayer.health = (roomPlayer.health || 100) - data.damage;
                    if (roomPlayer.health <= 0) {
                        // اللاعب مات
                        roomPlayer.health = 0;
                        io.to(player.roomId).emit('player_destroyed', {
                            userId: player.userId,
                            killerId: data.killerId
                        });
                    }
                }
            }
        }
    });
    
    // انقطاع الاتصال
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
                            // إذا كان اللاعب في لعبة وانسحب، أعلن فوز الخصم
                            const winnerTeam = room.players[0]?.team === 1 ? 2 : 1;
                            endGame(player.roomId, `الفريق ${winnerTeam === 1 ? 'الأحمر' : 'الأزرق'} فوز بسبب انسحاب الخصم`);
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
    console.log(`💰 Seat price: ${globalGameSettings.seatPrice}$`);
    console.log(`👥 Max players per game: ${globalGameSettings.maxPlayers}`);
    console.log(`🔐 Admin secret: ${process.env.ADMIN_SECRET || 'set-in-env'}`);
});
