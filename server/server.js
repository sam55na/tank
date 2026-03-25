// ============================================
// 🚀 خادم لعبة Battle Tanks - النسخة الديناميكية المتوازنة
// ============================================
// Author: Battle Tanks Team
// Version: 4.0.0
// Description: خادم متقدم مع تحديثات ديناميكية متوازنة تلقائياً
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
    gameDuration: 5 * 60 * 1000, // 5 دقائق
    // إعدادات التحديث الديناميكي
    dynamicUpdate: {
        enabled: true,
        minRate: 16,      // 60 FPS كحد أقصى
        maxRate: 66,      // 15 FPS كحد أدنى
        targetFPS: 30,    // الهدف 30 FPS
        adaptiveThreshold: 50, // عتبة التكيف (مللي ثانية)
        networkQuality: 1.0    // جودة الشبكة (0-1)
    },
    // إعدادات الأداء
    performance: {
        maxPlayersInRoom: 16,
        updateThrottle: false,
        optimizeForMobile: true
    }
};

const players = new Map();      // socketId -> player data
const rooms = new Map();        // roomId -> room data
const performanceStats = new Map(); // roomId -> performance stats

// ============================================
// 🔧 دوال مساعدة متقدمة
// ============================================
function generateId() {
    return Math.random().toString(36).substr(2, 8);
}

function calculateDynamicRate(roomId) {
    const room = rooms.get(roomId);
    if (!room || !globalGameSettings.dynamicUpdate.enabled) {
        return 33; // القيمة الافتراضية 30 FPS
    }
    
    // جمع إحصائيات الأداء
    const stats = performanceStats.get(roomId) || {
        avgLatency: 50,
        playerCount: room.players.length,
        lastCalculated: Date.now()
    };
    
    // تحديث الإحصائيات كل 5 ثوانٍ
    if (Date.now() - stats.lastCalculated > 5000) {
        stats.playerCount = room.players.filter(p => p.health > 0).length;
        stats.lastCalculated = Date.now();
        performanceStats.set(roomId, stats);
    }
    
    // حساب المعدل الديناميكي بناءً على:
    // 1. عدد اللاعبين (كلما زاد العدد، قل معدل التحديث)
    // 2. زمن الاستجابة (كلما زاد التأخير، قل معدل التحديث)
    // 3. نشاط اللاعبين
    
    let playerFactor = Math.max(0.5, Math.min(1.5, 30 / Math.max(1, stats.playerCount)));
    let latencyFactor = Math.max(0.6, Math.min(1.2, 50 / Math.max(20, stats.avgLatency)));
    let networkFactor = globalGameSettings.dynamicUpdate.networkQuality;
    
    // حساب معدل التحديث الأمثل
    let targetRate = 33; // 30 FPS أساسي
    targetRate = targetRate / playerFactor;
    targetRate = targetRate / latencyFactor;
    targetRate = targetRate / networkFactor;
    
    // تطبيق الحدود الدنيا والعليا
    targetRate = Math.max(
        globalGameSettings.dynamicUpdate.minRate,
        Math.min(globalGameSettings.dynamicUpdate.maxRate, targetRate)
    );
    
    // تحسين للأجهزة المحمولة
    if (globalGameSettings.performance.optimizeForMobile) {
        targetRate = Math.min(targetRate, 50); // 20 FPS كحد أقصى للموبايل
    }
    
    return Math.floor(targetRate);
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

// تحسين الأداء - تجميع التحديثات
let updateBatch = new Map();

function queueUpdate(roomId, updateType, data) {
    if (!updateBatch.has(roomId)) {
        updateBatch.set(roomId, []);
    }
    updateBatch.get(roomId).push({ type: updateType, data, timestamp: Date.now() });
    
    // معالجة الدفعة بعد 16ms
    setTimeout(() => {
        processBatch(roomId);
    }, 16);
}

function processBatch(roomId) {
    const batch = updateBatch.get(roomId);
    if (!batch || batch.length === 0) return;
    
    const room = rooms.get(roomId);
    if (!room || room.status !== 'active') {
        updateBatch.delete(roomId);
        return;
    }
    
    // تجميع التحديثات من نفس النوع
    const groupedUpdates = {};
    for (const update of batch) {
        if (!groupedUpdates[update.type]) {
            groupedUpdates[update.type] = [];
        }
        groupedUpdates[update.type].push(update.data);
    }
    
    // إرسال التحديثات المجمعة
    for (const [type, updates] of Object.entries(groupedUpdates)) {
        if (updates.length > 0) {
            io.to(roomId).emit(type, { updates, count: updates.length });
        }
    }
    
    updateBatch.delete(roomId);
}

// بدء اللعبة مع نظام تحديث ديناميكي
function startGame(roomId) {
    const room = rooms.get(roomId);
    if (!room || room.status !== 'waiting') return;
    
    room.status = 'active';
    room.startTime = Date.now();
    room.lastUpdateTime = Date.now();
    room.frameCount = 0;
    room.lastFrameRate = 0;
    
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
        playersList[i].lastUpdate = Date.now();
        playersList[i].movementHistory = []; // لتتبع الحركة
    }
    
    // تهيئة إحصائيات الأداء
    performanceStats.set(roomId, {
        avgLatency: 50,
        playerCount: playersList.length,
        lastCalculated: Date.now(),
        updateRates: [],
        networkQuality: 1.0
    });
    
    // إرسال بدء اللعبة لكل لاعب
    for (const player of playersList) {
        io.to(player.socketId).emit('game_start', {
            roomId: roomId,
            players: playersList.map(p => ({ userId: p.userId, team: p.team })),
            yourTeam: player.team,
            startTime: room.startTime,
            position: player.position,
            health: player.health,
            settings: {
                updateRate: globalGameSettings.dynamicUpdate.targetFPS,
                dynamicMode: globalGameSettings.dynamicUpdate.enabled
            }
        });
    }
    
    console.log(`🎮 Game started in room ${roomId} with ${playersList.length} players`);
    
    // نظام التحديث الديناميكي المتوازن
    let gameLoopActive = true;
    
    const gameLoop = async () => {
        const currentRoom = rooms.get(roomId);
        if (!currentRoom || currentRoom.status !== 'active') {
            gameLoopActive = false;
            return;
        }
        
        const now = Date.now();
        const deltaTime = now - currentRoom.lastUpdateTime;
        
        // حساب معدل الإطارات الحالي
        currentRoom.frameCount++;
        if (now - currentRoom.lastFrameRate > 1000) {
            currentRoom.lastFrameRate = now;
            currentRoom.currentFPS = currentRoom.frameCount;
            currentRoom.frameCount = 0;
            
            // تحديث المعدل الديناميكي
            if (globalGameSettings.dynamicUpdate.enabled) {
                const newRate = calculateDynamicRate(roomId);
                if (newRate !== currentRoom.updateRate) {
                    currentRoom.updateRate = newRate;
                    io.to(roomId).emit('update_rate_changed', {
                        newRate: newRate,
                        fps: Math.floor(1000 / newRate)
                    });
                }
            }
        }
        
        // جمع تحديثات اللاعبين
        const playersUpdate = [];
        const movementUpdates = [];
        const healthUpdates = [];
        
        for (const player of currentRoom.players) {
            if (player.position && player.health > 0) {
                // التحقق من تغير الموقع لتجنب التحديثات غير الضرورية
                const lastPosition = player.lastSentPosition || {};
                const positionChanged = 
                    lastPosition.x !== player.position.x ||
                    lastPosition.z !== player.position.z ||
                    lastPosition.y !== player.position.y;
                
                if (positionChanged || deltaTime > 100) {
                    playersUpdate.push({
                        userId: player.userId,
                        position: player.position,
                        rotation: player.rotation || 0,
                        health: player.health,
                        team: player.team,
                        timestamp: now
                    });
                    
                    movementUpdates.push({
                        userId: player.userId,
                        position: player.position,
                        rotation: player.rotation,
                        velocity: player.velocity || { x: 0, z: 0 }
                    });
                    
                    player.lastSentPosition = { ...player.position };
                }
            }
            
            if (player.health !== player.lastSentHealth) {
                healthUpdates.push({
                    userId: player.userId,
                    health: player.health
                });
                player.lastSentHealth = player.health;
            }
        }
        
        // إرسال التحديثات المجمعة
        if (playersUpdate.length > 0) {
            // تحديثات متفرقة للحركة السريعة
            if (playersUpdate.length === 1 && movementUpdates.length === 1) {
                io.to(roomId).emit('player_moved', movementUpdates[0]);
            } 
            // تحديثات كاملة للحالة العامة
            else {
                io.to(roomId).emit('game_state_update', { 
                    players: playersUpdate,
                    timestamp: now,
                    frameRate: currentRoom.currentFPS
                });
            }
        }
        
        if (healthUpdates.length > 0) {
            io.to(roomId).emit('health_updates', { updates: healthUpdates });
        }
        
        currentRoom.lastUpdateTime = now;
        
        // جدولة الحلقة التالية بمعدل ديناميكي
        if (gameLoopActive) {
            const updateRate = currentRoom.updateRate || calculateDynamicRate(roomId);
            setTimeout(gameLoop, updateRate);
        }
    };
    
    // بدء الحلقة
    currentRoom.updateRate = calculateDynamicRate(roomId);
    setTimeout(gameLoop, currentRoom.updateRate);
    
    room.gameLoop = { active: true, loopFunction: gameLoop };
    
    // جدولة نهاية اللعبة
    setTimeout(() => {
        endGame(roomId, 'انتهت مدة المعركة!');
    }, globalGameSettings.gameDuration);
}

// إنهاء اللعبة مع تحسين الأداء
async function endGame(roomId, reason) {
    const room = rooms.get(roomId);
    if (!room || room.status === 'ended') return;
    
    room.status = 'ended';
    if (room.gameLoop) {
        room.gameLoop.active = false;
    }
    
    // تنظيف الإحصائيات
    performanceStats.delete(roomId);
    updateBatch.delete(roomId);
    
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
// 📡 API Routes - نظام الإدارة المتقدم
// ============================================

// التحقق من صحة الخادم
app.get('/health', (req, res) => {
    res.json({ 
        status: 'online', 
        timestamp: Date.now(), 
        version: '4.0.0',
        dynamicUpdate: globalGameSettings.dynamicUpdate.enabled,
        activeRooms: rooms.size,
        activePlayers: players.size
    });
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

// إعدادات التحديث الديناميكي
app.post('/api/admin/dynamicUpdate', async (req, res) => {
    try {
        const { adminToken, userId, enabled, minRate, maxRate, targetFPS } = req.body;
        
        if (adminToken !== 'authenticated' && adminToken !== process.env.ADMIN_SECRET) {
            return res.status(403).json({ success: false, error: 'Unauthorized' });
        }
        
        const snapshot = await db.ref(`users/${userId}`).once('value');
        if (!snapshot.val()?.isAdmin) {
            return res.status(403).json({ success: false, error: 'Not admin' });
        }
        
        if (enabled !== undefined) globalGameSettings.dynamicUpdate.enabled = enabled;
        if (minRate !== undefined) globalGameSettings.dynamicUpdate.minRate = Math.max(16, Math.min(100, minRate));
        if (maxRate !== undefined) globalGameSettings.dynamicUpdate.maxRate = Math.max(33, Math.min(100, maxRate));
        if (targetFPS !== undefined) globalGameSettings.dynamicUpdate.targetFPS = Math.max(15, Math.min(60, targetFPS));
        
        res.json({ 
            success: true, 
            dynamicUpdate: globalGameSettings.dynamicUpdate 
        });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

// الحصول على إحصائيات الأداء
app.get('/api/admin/performance', async (req, res) => {
    try {
        const { adminToken } = req.query;
        
        if (adminToken !== 'authenticated' && adminToken !== process.env.ADMIN_SECRET) {
            return res.status(403).json({ success: false, error: 'Unauthorized' });
        }
        
        const performanceData = [];
        for (const [roomId, stats] of performanceStats) {
            const room = rooms.get(roomId);
            performanceData.push({
                roomId,
                playerCount: stats.playerCount,
                avgLatency: stats.avgLatency,
                updateRate: room?.updateRate || 33,
                status: room?.status || 'ended'
            });
        }
        
        res.json({
            success: true,
            performance: {
                activeRooms: rooms.size,
                totalPlayers: players.size,
                dynamicMode: globalGameSettings.dynamicUpdate.enabled,
                rooms: performanceData,
                settings: globalGameSettings.dynamicUpdate
            }
        });
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

// تغيير عدد اللاعبين
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
        globalGameSettings.performance.maxPlayersInRoom = newMax;
        
        res.json({ success: true, maxPlayers: newMax });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

// الحصول على الإعدادات
app.get('/api/admin/settings', async (req, res) => {
    try {
        const { adminToken } = req.query;
        
        if (adminToken !== 'authenticated' && adminToken !== process.env.ADMIN_SECRET) {
            return res.status(403).json({ success: false, error: 'Unauthorized' });
        }
        
        res.json({ 
            success: true, 
            settings: globalGameSettings
        });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

// مسح جميع البيانات
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
// 🔌 أحداث Socket.io المحسنة
// ============================================
io.on('connection', (socket) => {
    console.log(`🔌 New connection: ${socket.id}`);
    
    // قياس زمن الاستجابة
    let pingInterval;
    
    players.set(socket.id, {
        socketId: socket.id,
        userId: null,
        roomId: null,
        connectedAt: Date.now(),
        latency: 0,
        lastPing: Date.now()
    });
    
    // قياس زمن الاستجابة بانتظام
    pingInterval = setInterval(() => {
        const startTime = Date.now();
        socket.emit('ping', { timestamp: startTime });
        
        socket.once('pong', (data) => {
            const latency = Date.now() - startTime;
            const player = players.get(socket.id);
            if (player) {
                player.latency = latency;
                
                // تحديث إحصائيات الأداء للغرفة
                if (player.roomId) {
                    const stats = performanceStats.get(player.roomId);
                    if (stats) {
                        stats.avgLatency = (stats.avgLatency * 0.9) + (latency * 0.1);
                        stats.networkQuality = Math.max(0.2, Math.min(1.0, 1 - (latency / 200)));
                        globalGameSettings.dynamicUpdate.networkQuality = stats.networkQuality;
                        performanceStats.set(player.roomId, stats);
                    }
                }
            }
        });
    }, 5000);
    
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
                wins: userData.wins || 0,
                settings: {
                    dynamicUpdate: globalGameSettings.dynamicUpdate.enabled,
                    updateRate: globalGameSettings.dynamicUpdate.targetFPS
                }
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
                    maxPlayers: globalGameSettings.maxPlayers,
                    dynamicUpdate: globalGameSettings.dynamicUpdate.enabled
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
    
    // إنشاء غرفة
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
        const maxSeats = Math.min(data.seats || globalGameSettings.maxPlayers, globalGameSettings.performance.maxPlayersInRoom);
        
        const room = {
            id: roomId,
            maxSeats: maxSeats,
            players: [{
                userId: player.userId,
                socketId: socket.id,
                email: player.email,
                health: 100,
                lastUpdate: Date.now()
            }],
            status: 'waiting',
            createdAt: Date.now(),
            updateRate: globalGameSettings.dynamicUpdate.targetFPS
        };
        
        rooms.set(roomId, room);
        player.roomId = roomId;
        
        socket.join(roomId);
        socket.emit('room_created', { roomId: roomId, updateRate: room.updateRate });
        
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
            email: player.email,
            health: 100,
            lastUpdate: Date.now()
        });
        player.roomId = roomId;
        
        socket.join(roomId);
        socket.emit('room_joined', { roomId: roomId, updateRate: room.updateRate });
        
        updateRoom(roomId);
        broadcastRoomsList();
        
        console.log(`👥 ${player.email} joined room ${roomId}`);
    });
    
    // ============================================
    // 🎮 أحداث اللعبة المحسنة
    // ============================================
    
    // حركة اللاعب مع تحسين الأداء
    socket.on('move', (data) => {
        const player = players.get(socket.id);
        if (player?.roomId) {
            const room = rooms.get(player.roomId);
            if (room && room.status === 'active') {
                const roomPlayer = room.players.find(p => p.socketId === socket.id);
                if (roomPlayer && roomPlayer.health > 0) {
                    // حفظ الموقع السابق لحساب السرعة
                    const oldPosition = roomPlayer.position || { x: 0, z: 0 };
                    roomPlayer.position = data.position;
                    roomPlayer.rotation = data.rotation;
                    roomPlayer.lastUpdate = Date.now();
                    
                    // حساب السرعة للتحديثات المستقبلية
                    const dx = roomPlayer.position.x - oldPosition.x;
                    const dz = roomPlayer.position.z - oldPosition.z;
                    const dt = (Date.now() - (roomPlayer.lastMoveTime || Date.now())) / 1000;
                    
                    roomPlayer.velocity = {
                        x: dt > 0 ? dx / dt : 0,
                        z: dt > 0 ? dz / dt : 0
                    };
                    roomPlayer.lastMoveTime = Date.now();
                    
                    // استخدام نظام الدفعات للحركة السريعة
                    if (globalGameSettings.dynamicUpdate.enabled && room.players.length > 4) {
                        queueUpdate(player.roomId, 'player_moved', {
                            userId: player.userId,
                            position: data.position,
                            rotation: data.rotation,
                            velocity: roomPlayer.velocity,
                            timestamp: Date.now()
                        });
                    } else {
                        socket.to(player.roomId).emit('player_moved', {
                            userId: player.userId,
                            position: data.position,
                            rotation: data.rotation,
                            velocity: roomPlayer.velocity,
                            timestamp: Date.now()
                        });
                    }
                }
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
    
    // الضرر مع تحسين الدقة
    socket.on('damage', (data) => {
        const player = players.get(socket.id);
        if (player?.roomId) {
            const room = rooms.get(player.roomId);
            if (room && room.status === 'active') {
                const targetPlayer = room.players.find(p => p.userId === data.targetId);
                
                if (targetPlayer && targetPlayer.health > 0) {
                    // التحقق من صحة الضرر (مكافحة الغش)
                    const distance = data.distance || 0;
                    const maxDistance = 100;
                    const damageMultiplier = Math.max(0.5, Math.min(1.5, 1 - (distance / maxDistance)));
                    const actualDamage = Math.min(data.damage * damageMultiplier, targetPlayer.health);
                    
                    const oldHealth = targetPlayer.health;
                    targetPlayer.health = Math.max(0, oldHealth - actualDamage);
                    
                    console.log(`💥 Damage: ${actualDamage.toFixed(1)} to ${targetPlayer.userId}. Health: ${oldHealth} -> ${targetPlayer.health}`);
                    
                    // إرسال تحديث الصحة
                    io.to(player.roomId).emit('health_update', {
                        userId: targetPlayer.userId,
                        health: targetPlayer.health,
                        damage: actualDamage,
                        from: player.userId
                    });
                    
                    // معالجة الإقصاء
                    if (targetPlayer.health <= 0) {
                        targetPlayer.health = 0;
                        
                        io.to(player.roomId).emit('player_eliminated', {
                            userId: targetPlayer.userId,
                            killerId: player.userId,
                            position: targetPlayer.position,
                            timestamp: Date.now()
                        });
                        
                        console.log(`💀 Player ${targetPlayer.userId} eliminated by ${player.userId}`);
                        
                        const targetSocket = io.sockets.sockets.get(targetPlayer.socketId);
                        if (targetSocket) {
                            targetSocket.emit('you_were_eliminated', {
                                message: 'لقد تم تدمير دبابتك!',
                                killerId: player.userId
                            });
                        }
                        
                        // التحقق من نهاية اللعبة
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
                            // تحديث قائمة اللاعبين
                            const playersUpdate = [];
                            for (const p of room.players) {
                                if (p.position && p.health > 0) {
                                    playersUpdate.push({
                                        userId: p.userId,
                                        position: p.position,
                                        rotation: p.rotation || 0,
                                        health: p.health,
                                        team: p.team
                                    });
                                }
                            }
                            io.to(player.roomId).emit('players_list_update', { players: playersUpdate });
                        }
                    }
                }
            }
        }
    });
    
    // طلب حالة اللعبة (للمزامنة)
    socket.on('request_game_state', () => {
        const player = players.get(socket.id);
        if (player?.roomId) {
            const room = rooms.get(player.roomId);
            if (room && room.status === 'active') {
                const playersUpdate = [];
                for (const p of room.players) {
                    if (p.position && p.health > 0) {
                        playersUpdate.push({
                            userId: p.userId,
                            position: p.position,
                            rotation: p.rotation || 0,
                            health: p.health,
                            team: p.team
                        });
                    }
                }
                socket.emit('game_state_full', {
                    players: playersUpdate,
                    timestamp: Date.now(),
                    yourHealth: room.players.find(p => p.socketId === socket.id)?.health || 0
                });
            }
        }
    });
    
    // ============================================
    // 🔌 انقطاع الاتصال
    // ============================================
    socket.on('disconnect', () => {
        if (pingInterval) clearInterval(pingInterval);
        
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
                            if (room.gameLoop) room.gameLoop.active = false;
                            rooms.delete(player.roomId);
                            performanceStats.delete(player.roomId);
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
║     🎮 BATTLE TANKS GAME SERVER - DYNAMIC EDITION 🎮        ║
║                      Version 4.0.0                          ║
║                                                              ║
╠══════════════════════════════════════════════════════════════╣
║  📡 Server running on port: ${PORT}
║  🌐 WebSocket: Ready with dynamic updates
║  🔥 Firebase: Connected
║  👑 Admin email: admin@boomb.com
║  💰 Seat price: ${globalGameSettings.seatPrice}$
║  👥 Max players: ${globalGameSettings.maxPlayers}
║  ⏱️  Game duration: ${globalGameSettings.gameDuration / 1000} seconds
║  🔄 Dynamic Updates: ${globalGameSettings.dynamicUpdate.enabled ? '✅ Enabled' : '❌ Disabled'}
║  🎯 Update Rate: ${globalGameSettings.dynamicUpdate.targetFPS} FPS (${Math.floor(1000 / globalGameSettings.dynamicUpdate.targetFPS)}ms)
║  📊 Adaptive Range: ${Math.floor(1000 / globalGameSettings.dynamicUpdate.maxRate)}-${Math.floor(1000 / globalGameSettings.dynamicUpdate.minRate)} FPS
║  📱 Mobile Optimized: ${globalGameSettings.performance.optimizeForMobile ? '✅ Yes' : '❌ No'}
║  🚀 Performance Mode: ${globalGameSettings.dynamicUpdate.enabled ? 'Adaptive' : 'Fixed'}
║                                                              ║
╚══════════════════════════════════════════════════════════════╝
    `);
    
    // عرض إحصائيات الأداء كل 30 ثانية
    setInterval(() => {
        const activeRooms = Array.from(rooms.values()).filter(r => r.status === 'active');
        if (activeRooms.length > 0) {
            console.log(`\n📊 Performance Stats:`);
            console.log(`   Active Rooms: ${activeRooms.length}`);
            console.log(`   Total Players: ${players.size}`);
            console.log(`   Dynamic Mode: ${globalGameSettings.dynamicUpdate.enabled}`);
            for (const room of activeRooms) {
                const stats = performanceStats.get(room.id);
                console.log(`   Room ${room.id}: ${room.players.length} players, Update Rate: ${room.updateRate || 33}ms, Latency: ${stats?.avgLatency?.toFixed(0) || 'N/A'}ms`);
            }
        }
    }, 30000);
});
