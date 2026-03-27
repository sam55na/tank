// ============================================
// 🚀 خادم لعبة Battle Tanks - النسخة النهائية للإنتاج
// ============================================
// Author: Battle Tanks Team
// Version: 3.6.0
// Description: خادم متكامل للألعاب متعددة اللاعبين - 10 غرف من كل نوع
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
// 🏠 نظام الغرف - 10 غرف من كل نوع
// ============================================
const ROOM_TYPES = [
    { name: 'غرفة المبتدئين', maxSeats: 2, seatPrice: 1, prefix: 'beginner' },
    { name: 'غرفة المتقدمين', maxSeats: 4, seatPrice: 5, prefix: 'advanced' },
    { name: 'غرفة المحترفين', maxSeats: 6, seatPrice: 10, prefix: 'pro' }
];

const ROOMS_PER_TYPE = 10; // 10 غرف من كل نوع

// تهيئة 10 غرف من كل نوع
function initializeRooms() {
    for (const type of ROOM_TYPES) {
        for (let i = 1; i <= ROOMS_PER_TYPE; i++) {
            const roomId = `${type.prefix}_room_${i}`;
            const room = {
                id: roomId,
                name: `${type.name} ${i}`,
                maxSeats: type.maxSeats,
                seatPrice: type.seatPrice,
                players: [],
                status: 'waiting', // waiting, active, ended
                createdAt: Date.now(),
                typeName: type.name,
                gameInterval: null,
                startTime: null,
                roomNumber: i
            };
            rooms.set(roomId, room);
            console.log(`🏠 Created room: ${room.name} (${type.maxSeats} players, ${type.seatPrice}$)`);
        }
    }
    console.log(`✅ Total rooms: ${rooms.size} (${ROOM_TYPES.length} types × ${ROOMS_PER_TYPE} rooms each = ${ROOM_TYPES.length * ROOMS_PER_TYPE} rooms)`);
}

// إعادة تعيين الغرفة بعد انتهاء المعركة وإنشاء غرفة جديدة
function resetRoom(roomId) {
    const oldRoom = rooms.get(roomId);
    if (!oldRoom) return;
    
    // تنظيف الغرفة المنتهية
    if (oldRoom.gameInterval) {
        clearInterval(oldRoom.gameInterval);
        oldRoom.gameInterval = null;
    }
    
    // إزالة الغرفة المنتهية
    rooms.delete(roomId);
    
    // إنشاء غرفة جديدة من نفس النوع
    const type = ROOM_TYPES.find(t => t.name === oldRoom.typeName);
    if (type) {
        // البحث عن رقم الغرفة التالي المتاح
        let roomNumber = 1;
        let newRoomId = `${type.prefix}_room_${roomNumber}`;
        
        // العثور على رقم غرفة غير مستخدم
        while (rooms.has(newRoomId)) {
            roomNumber++;
            newRoomId = `${type.prefix}_room_${roomNumber}`;
        }
        
        const newRoom = {
            id: newRoomId,
            name: `${type.name} ${roomNumber}`,
            maxSeats: type.maxSeats,
            seatPrice: type.seatPrice,
            players: [],
            status: 'waiting',
            createdAt: Date.now(),
            typeName: type.name,
            gameInterval: null,
            startTime: null,
            roomNumber: roomNumber
        };
        
        rooms.set(newRoomId, newRoom);
        console.log(`🔄 Created new room: ${newRoom.name} (replacing finished room ${oldRoom.name})`);
        
        // إخطار اللاعبين بالغرفة الجديدة
        io.emit('room_created', {
            roomId: newRoomId,
            name: newRoom.name,
            maxSeats: newRoom.maxSeats,
            seatPrice: newRoom.seatPrice
        });
    }
    
    // بث تحديث قائمة الغرف
    broadcastRoomsList();
    
    console.log(`✅ Room reset complete: ${oldRoom.name} ended, new room created`);
}

// استدعاء التهيئة
initializeRooms();

// ============================================
// 🔧 دوال مساعدة
// ============================================
function generateId() {
    return Math.random().toString(36).substr(2, 8);
}

function broadcastRoomsList() {
    const roomsList = [];
    for (const [roomId, room] of rooms) {
        // فقط الغرف في حالة waiting تظهر في اللوبي
        if (room.status === 'waiting') {
            roomsList.push({
                id: roomId,
                name: room.name,
                players: room.players.length,
                maxSeats: room.maxSeats,
                seatPrice: room.seatPrice,
                status: room.status,
                needed: room.maxSeats - room.players.length // عدد اللاعبين المطلوبين
            });
        }
    }
    io.emit('rooms_list', { rooms: roomsList });
    console.log(`📢 Broadcast rooms: ${roomsList.length} waiting rooms (total rooms: ${rooms.size})`);
}

function updateRoom(roomId) {
    const room = rooms.get(roomId);
    if (!room) return;
    
    io.to(roomId).emit('room_update', {
        players: room.players.map(p => ({ userId: p.userId, email: p.email })),
        maxSeats: room.maxSeats,
        count: room.players.length,
        seatPrice: room.seatPrice,
        needed: room.maxSeats - room.players.length
    });
    
    // إذا اكتملت الغرفة ووصل عدد اللاعبين إلى الحد الأقصى، ابدأ المعركة
    if (room.players.length === room.maxSeats && room.status === 'waiting') {
        console.log(`🎯 ${room.name} is full (${room.players.length}/${room.maxSeats})! Starting game...`);
        startGame(roomId);
    }
}

// إضافة اللاعب إلى الغرفة مع خصم الرصيد وإرسال إشعار
async function addPlayerToRoom(socket, player, room) {
    // التحقق من الرصيد
    const userRef = db.ref(`users/${player.userId}`);
    const snapshot = await userRef.once('value');
    const userData = snapshot.val();
    const balance = userData?.balance || 100;
    const seatPrice = room.seatPrice || 1;
    
    if (balance < seatPrice) {
        return { success: false, error: `⚠️ رصيدك غير كافٍ! سعر المقعد: ${seatPrice}$` };
    }
    
    // خصم الرصيد
    await userRef.update({ balance: balance - seatPrice });
    player.balance = balance - seatPrice;
    
    // إضافة اللاعب إلى الغرفة مع حفظ المبلغ المدفوع
    const newPlayer = {
        userId: player.userId,
        socketId: socket.id,
        email: player.email,
        health: 100,
        paidAmount: seatPrice
    };
    room.players.push(newPlayer);
    player.roomId = room.id;
    
    socket.join(room.id);
    
    return { 
        success: true, 
        balance: balance - seatPrice,
        playersCount: room.players.length,
        maxSeats: room.maxSeats,
        needed: room.maxSeats - room.players.length
    };
}

// إزالة اللاعب من الغرفة مع إعادة الرصيد
async function removePlayerFromRoom(socket, player, room) {
    const index = room.players.findIndex(p => p.socketId === socket.id);
    if (index !== -1) {
        const removedPlayer = room.players[index];
        const paidAmount = removedPlayer.paidAmount || room.seatPrice;
        
        // إعادة الرصيد فقط إذا كانت الغرفة لا تزال في حالة انتظار
        if (room.status === 'waiting' && paidAmount > 0) {
            try {
                const userRef = db.ref(`users/${player.userId}`);
                const snapshot = await userRef.once('value');
                const userData = snapshot.val();
                const currentBalance = userData?.balance || 0;
                await userRef.update({ balance: currentBalance + paidAmount });
                console.log(`💰 Refunded ${paidAmount}$ to ${player.email} for leaving ${room.name}`);
                return { success: true, refunded: paidAmount };
            } catch (error) {
                console.error('Error refunding balance:', error);
                return { success: false, refunded: 0 };
            }
        }
        
        room.players.splice(index, 1);
        socket.leave(room.id);
        
        return { success: true, refunded: 0 };
    }
    return { success: false, refunded: 0 };
}

// بدء اللعبة مع إعدادات الفرق والمواقع
function startGame(roomId) {
    const room = rooms.get(roomId);
    if (!room || room.status !== 'waiting') return;
    
    room.status = 'active';
    room.startTime = Date.now();
    
    const playersList = room.players;
    const positions = [
        { x: -120, z: -80, team: 1 },
        { x: 120, z: 80, team: 2 }
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
    
    console.log(`🎮 Game started in ${room.name} with ${playersList.length} players`);
    
    // بث أن الغرفة بدأت
    io.emit('game_started', {
        roomId: roomId,
        roomName: room.name,
        playersCount: playersList.length
    });
    
    // بدء بث حالة اللعبة كل 50ms (20 مرة في الثانية)
    const gameInterval = setInterval(() => {
        const currentRoom = rooms.get(roomId);
        if (!currentRoom || currentRoom.status !== 'active') {
            clearInterval(gameInterval);
            return;
        }
        
        // جمع تحديثات اللاعبين (اللاعبين الأحياء فقط)
        const playersUpdate = [];
        for (const player of currentRoom.players) {
            if (player.position && player.health > 0) {
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
    if (room.gameInterval) {
        clearInterval(room.gameInterval);
        room.gameInterval = null;
    }
    
    const duration = Math.floor((Date.now() - (room.startTime || Date.now())) / 1000);
    
    // تحديد الفائز
    let winnerTeam = null;
    let winnerName = null;
    const alivePlayers = room.players.filter(p => p.health > 0);
    
    if (alivePlayers.length === 1) {
        winnerTeam = alivePlayers[0].team;
        winnerName = winnerTeam === 1 ? 'فريقك' : 'الفريق الخصم';
    } else if (alivePlayers.length === 2) {
        const player1 = alivePlayers[0];
        const player2 = alivePlayers[1];
        const health1 = player1.health || 100;
        const health2 = player2.health || 100;
        
        if (health1 > health2) {
            winnerTeam = player1.team;
            winnerName = winnerTeam === 1 ? 'فريقك' : 'الفريق الخصم';
        } else if (health2 > health1) {
            winnerTeam = player2.team;
            winnerName = winnerTeam === 1 ? 'فريقك' : 'الفريق الخصم';
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
                yourTeam: player.team === 1 ? 'فريقك' : 'الفريق الخصم'
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
    
    console.log(`🏆 Game ended in ${room.name}, winner: ${winnerName}`);
    
    // إعادة تعيين الغرفة بعد 5 ثوانٍ لتصبح جاهزة لمعركة جديدة
    setTimeout(() => {
        resetRoom(roomId);
    }, 5000);
    
    // تحديث قائمة الغرف
    broadcastRoomsList();
}

// ============================================
// 📡 API Routes - نظام الإدارة المتقدم
// ============================================

// التحقق من صحة الخادم
app.get('/health', (req, res) => {
    res.json({ status: 'online', timestamp: Date.now(), version: '3.6.0' });
});

app.get('/api/health', (req, res) => {
    res.json({ 
        status: 'healthy',
        timestamp: Date.now(),
        connections: io.engine.clientsCount,
        rooms: rooms.size
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

// ============================================
// 🏷️ إدارة أنواع الغرف (API)
// ============================================

// الحصول على أنواع الغرف
app.get('/api/admin/roomTypes', async (req, res) => {
    try {
        const { adminToken, userId } = req.query;
        
        if (adminToken !== 'authenticated' && adminToken !== process.env.ADMIN_SECRET) {
            return res.status(403).json({ success: false, error: 'Unauthorized' });
        }
        
        // التحقق من صلاحيات المشرف
        const adminSnapshot = await db.ref(`users/${userId}`).once('value');
        if (!adminSnapshot.val()?.isAdmin) {
            return res.status(403).json({ success: false, error: 'Not admin' });
        }
        
        // إعداد أنواع الغرف مع الإحصائيات الحية
        const roomTypesWithStats = ROOM_TYPES.map(type => {
            // حساب عدد الغرف من هذا النوع
            const typeRooms = Array.from(rooms.values()).filter(r => r.typeName === type.name);
            const waitingRooms = typeRooms.filter(r => r.status === 'waiting').length;
            const activeRooms = typeRooms.filter(r => r.status === 'active').length;
            
            return {
                name: type.name,
                maxSeats: type.maxSeats,
                seatPrice: type.seatPrice,
                maxRooms: ROOMS_PER_TYPE,
                availableRooms: waitingRooms,
                activeRooms: activeRooms,
                totalRooms: typeRooms.length
            };
        });
        
        res.json({ success: true, types: roomTypesWithStats });
    } catch (error) {
        console.error('Error fetching room types:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

// تحديث إعدادات نوع الغرفة
app.post('/api/admin/updateRoomType', async (req, res) => {
    try {
        const { adminToken, userId, typeName, maxSeats, seatPrice } = req.body;
        
        if (adminToken !== 'authenticated' && adminToken !== process.env.ADMIN_SECRET) {
            return res.status(403).json({ success: false, error: 'Unauthorized' });
        }
        
        // التحقق من صلاحيات المشرف
        const adminSnapshot = await db.ref(`users/${userId}`).once('value');
        if (!adminSnapshot.val()?.isAdmin) {
            return res.status(403).json({ success: false, error: 'Not admin' });
        }
        
        // التحقق من القيم
        const newMaxSeats = Math.max(2, Math.min(16, maxSeats || 2));
        const newSeatPrice = Math.max(1, Math.min(1000, seatPrice || 1));
        
        // البحث عن نوع الغرفة
        const roomType = ROOM_TYPES.find(t => t.name === typeName);
        if (!roomType) {
            return res.status(404).json({ success: false, error: 'Room type not found' });
        }
        
        // تحديث الإعدادات في ROOM_TYPES
        roomType.maxSeats = newMaxSeats;
        roomType.seatPrice = newSeatPrice;
        
        // تحديث جميع الغرف من هذا النوع
        const typeRooms = Array.from(rooms.values()).filter(r => r.typeName === typeName);
        for (const room of typeRooms) {
            room.maxSeats = newMaxSeats;
            room.seatPrice = newSeatPrice;
            
            // إرسال إشعار للاعبين في الغرف المنتظرة
            if (room.status === 'waiting') {
                io.to(room.id).emit('room_settings_updated', {
                    maxSeats: newMaxSeats,
                    seatPrice: newSeatPrice,
                    message: `تم تحديث إعدادات الغرفة: ${newMaxSeats} لاعبين، ${newSeatPrice}$ للمقعد`
                });
            }
        }
        
        // بث تحديث قائمة الغرف
        broadcastRoomsList();
        
        console.log(`📝 Admin updated room type: ${typeName} -> ${newMaxSeats} players, ${newSeatPrice}$ (applied to ${typeRooms.length} rooms)`);
        res.json({ 
            success: true, 
            message: `تم تحديث ${typeName} بنجاح لـ ${typeRooms.length} غرفة`,
            maxSeats: newMaxSeats,
            seatPrice: newSeatPrice
        });
    } catch (error) {
        console.error('Error updating room type:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

// الحصول على تفاصيل غرفة محددة (للوحة التحكم)
app.get('/api/admin/room/:roomId', async (req, res) => {
    try {
        const { adminToken, userId } = req.query;
        const { roomId } = req.params;
        
        if (adminToken !== 'authenticated' && adminToken !== process.env.ADMIN_SECRET) {
            return res.status(403).json({ success: false, error: 'Unauthorized' });
        }
        
        // التحقق من صلاحيات المشرف
        const adminSnapshot = await db.ref(`users/${userId}`).once('value');
        if (!adminSnapshot.val()?.isAdmin) {
            return res.status(403).json({ success: false, error: 'Not admin' });
        }
        
        const room = rooms.get(roomId);
        if (!room) {
            return res.status(404).json({ success: false, error: 'Room not found' });
        }
        
        res.json({ 
            success: true, 
            room: {
                id: room.id,
                name: room.name,
                maxSeats: room.maxSeats,
                seatPrice: room.seatPrice,
                status: room.status,
                players: room.players.map(p => ({
                    userId: p.userId,
                    email: p.email,
                    health: p.health,
                    team: p.team,
                    paidAmount: p.paidAmount
                })),
                createdAt: room.createdAt,
                startTime: room.startTime
            }
        });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

// إدارة الأرصدة (للمدير)
app.post('/api/admin/balance', async (req, res) => {
    try {
        const { adminToken, userId, adminId, amount, action } = req.body;
        
        if (adminToken !== 'authenticated' && adminToken !== process.env.ADMIN_SECRET) {
            return res.status(403).json({ success: false, error: 'Unauthorized' });
        }
        
        const adminSnapshot = await db.ref(`users/${adminId}`).once('value');
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
            admin: true,
            adminId: adminId
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
        const { adminToken, userId } = req.query;
        
        if (adminToken !== 'authenticated' && adminToken !== process.env.ADMIN_SECRET) {
            return res.status(403).json({ success: false, error: 'Unauthorized' });
        }
        
        const snapshot = await db.ref(`users/${userId}`).once('value');
        if (!snapshot.val()?.isAdmin) {
            return res.status(403).json({ success: false, error: 'Not admin' });
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

// مسح جميع بيانات اللاعبين
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
            email: 'admin2613857@boomb.com',
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

// الحصول على قائمة الغرف (للوحة التحكم)
app.get('/api/admin/rooms', async (req, res) => {
    try {
        const { adminToken, userId } = req.query;
        
        if (adminToken !== 'authenticated' && adminToken !== process.env.ADMIN_SECRET) {
            return res.status(403).json({ success: false, error: 'Unauthorized' });
        }
        
        const snapshot = await db.ref(`users/${userId}`).once('value');
        if (!snapshot.val()?.isAdmin) {
            return res.status(403).json({ success: false, error: 'Not admin' });
        }
        
        const roomsList = [];
        for (const [id, room] of rooms) {
            roomsList.push({
                id: id,
                name: room.name,
                maxSeats: room.maxSeats,
                seatPrice: room.seatPrice,
                status: room.status,
                playersCount: room.players.length,
                players: room.players.map(p => ({ userId: p.userId, email: p.email, health: p.health }))
            });
        }
        
        res.json({ success: true, rooms: roomsList });
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
        email: null,
        roomId: null,
        isAdmin: false,
        balance: 0,
        connectedAt: Date.now()
    });
    
    // إضافة حدث ping
    socket.on('ping', (data) => {
        socket.emit('pong', { timestamp: data.timestamp });
    });
    
    // ============================================
    // 🔐 المصادقة
    // ============================================
    socket.on('auth', async (data) => {
        const authTimeout = setTimeout(() => {
            socket.emit('auth_error', { message: 'Authentication timeout' });
        }, 15000);
        
        try {
            const { token } = data;
            if (!token) {
                clearTimeout(authTimeout);
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
            
            if (player) {
                player.isAdmin = userData.isAdmin || false;
                player.balance = userData.balance || 100;
            }
            
            clearTimeout(authTimeout);
            
            socket.emit('auth_success', {
                userId: userId,
                email: email,
                balance: userData.balance || 100,
                username: userData.username,
                isAdmin: userData.isAdmin || false,
                gamesPlayed: userData.gamesPlayed || 0,
                wins: userData.wins || 0,
                timestamp: Date.now()
            });
            
            console.log(`✅ User authenticated: ${email} (Admin: ${userData.isAdmin || false})`);
            
        } catch (error) {
            clearTimeout(authTimeout);
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
            player.balance = balance;
            
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
    
    // الانضمام إلى غرفة
    socket.on('join_room', async (data) => {
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
            socket.emit('error', { message: 'Game in progress, please wait for next match' });
            return;
        }
        
        if (room.players.length >= room.maxSeats) {
            socket.emit('error', { message: 'Room is full' });
            return;
        }
        
        if (player.roomId) {
            socket.emit('error', { message: 'You are already in a room. Please leave current room first.' });
            return;
        }
        
        // إضافة اللاعب إلى الغرفة مع خصم الرصيد
        const result = await addPlayerToRoom(socket, player, room);
        
        if (!result.success) {
            socket.emit('error', { message: result.error });
            return;
        }
        
        // إرسال تأكيد الانضمام مع تفاصيل الخصم
        socket.emit('room_joined', { 
            roomId: roomId, 
            balance: result.balance,
            roomName: room.name,
            playersCount: result.playersCount,
            maxSeats: result.maxSeats,
            seatPrice: room.seatPrice,
            needed: result.needed,
            message: `✅ تم الانضمام إلى ${room.name}\n💰 تم خصم ${room.seatPrice}$ من رصيدك\n👥 عدد اللاعبين: ${result.playersCount}/${result.maxSeats}\n⏳ ينتظر ${result.needed} لاعب(ين) لبدء المعركة`
        });
        
        // إرسال إشعار لجميع اللاعبين في الغرفة
        io.to(roomId).emit('player_joined', {
            userId: player.userId,
            username: player.email.split('@')[0],
            playersCount: room.players.length,
            maxSeats: room.maxSeats,
            needed: room.maxSeats - room.players.length
        });
        
        updateRoom(roomId);
        broadcastRoomsList();
        
        console.log(`👥 ${player.email} joined ${room.name} (${room.players.length}/${room.maxSeats}) - Paid: ${room.seatPrice}$`);
    });
    
    // مغادرة الغرفة مع إعادة الرصيد
    socket.on('leave_room', async () => {
        const player = players.get(socket.id);
        if (!player || !player.roomId) {
            socket.emit('error', { message: 'You are not in any room' });
            return;
        }
        
        const room = rooms.get(player.roomId);
        if (!room) {
            player.roomId = null;
            socket.emit('error', { message: 'Room not found' });
            return;
        }
        
        // لا يمكن مغادرة الغرفة أثناء المعركة
        if (room.status !== 'waiting') {
            socket.emit('error', { message: 'Cannot leave room during active battle' });
            return;
        }
        
        // إزالة اللاعب وإعادة الرصيد
        const result = await removePlayerFromRoom(socket, player, room);
        
        if (result.success) {
            const oldRoomId = player.roomId;
            player.roomId = null;
            
            // إرسال تأكيد المغادرة مع تفاصيل إعادة الرصيد
            socket.emit('room_left', {
                roomName: room.name,
                refunded: result.refunded,
                message: result.refunded > 0 
                    ? `🚪 تم مغادرة ${room.name}\n💰 تم إعادة ${result.refunded}$ إلى رصيدك`
                    : `🚪 تم مغادرة ${room.name}`
            });
            
            // إرسال إشعار لجميع اللاعبين المتبقين
            io.to(room.id).emit('player_left', {
                userId: player.userId,
                username: player.email.split('@')[0],
                playersCount: room.players.length,
                maxSeats: room.maxSeats,
                needed: room.maxSeats - room.players.length
            });
            
            updateRoom(room.id);
            broadcastRoomsList();
            
            console.log(`🚪 ${player.email} left ${room.name} - Refunded: ${result.refunded}$`);
        } else {
            socket.emit('error', { message: 'Failed to leave room' });
        }
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
                const roomPlayer = room.players.find(p => p.socketId === socket.id);
                if (roomPlayer && roomPlayer.health > 0) {
                    roomPlayer.position = data.position;
                    roomPlayer.rotation = data.rotation;
                }
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
            io.to(player.roomId).emit('player_shot', {
                userId: player.userId,
                position: data.position,
                direction: data.direction,
                bulletId: data.bulletId,
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
                const targetPlayer = room.players.find(p => p.userId === data.targetId);
                
                if (targetPlayer && targetPlayer.health > 0) {
                    const oldHealth = targetPlayer.health || 100;
                    targetPlayer.health = Math.max(0, oldHealth - data.damage);
                    
                    console.log(`💥 Damage: ${data.damage} to ${targetPlayer.userId}. Health: ${oldHealth} -> ${targetPlayer.health}`);
                    
                    io.to(player.roomId).emit('health_update', {
                        userId: targetPlayer.userId,
                        health: targetPlayer.health
                    });
                    
                    if (targetPlayer.health <= 0) {
                        targetPlayer.health = 0;
                        
                        io.to(player.roomId).emit('player_eliminated', {
                            userId: targetPlayer.userId,
                            killerId: player.userId,
                            position: targetPlayer.position
                        });
                        
                        console.log(`💀 Player ${targetPlayer.userId} eliminated`);
                        
                        const targetSocket = io.sockets.sockets.get(targetPlayer.socketId);
                        if (targetSocket) {
                            targetSocket.emit('you_were_eliminated', {
                                message: 'لقد تم تدمير دبابتك!',
                                killerId: player.userId
                            });
                        }
                        
                        const alivePlayers = room.players.filter(p => p.health > 0);
                        
                        if (alivePlayers.length <= 1) {
                            if (alivePlayers.length === 1) {
                                const winner = alivePlayers[0];
                                const winnerName = winner.team === 1 ? 'فريقك' : 'الفريق الخصم';
                                endGame(player.roomId, `🎉 فوز ${winnerName}! 🎉`);
                            } else {
                                endGame(player.roomId, '🤝 تعادل!');
                            }
                        } else {
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
                }
            }
        }
    });
    
    socket.on('game_cleanup', () => {
        const player = players.get(socket.id);
        if (player && player.roomId) {
            const room = rooms.get(player.roomId);
            if (room && room.status === 'ended') {
                const index = room.players.findIndex(p => p.socketId === socket.id);
                if (index !== -1) {
                    room.players.splice(index, 1);
                }
                player.roomId = null;
                socket.emit('cleanup_complete', { success: true });
                console.log(`🧹 Player cleaned up after game`);
            }
        }
    });
    
    // ============================================
    // 🔌 انقطاع الاتصال
    // ============================================
    socket.on('disconnect', async () => {
        const player = players.get(socket.id);
        if (player) {
            if (player.roomId) {
                const room = rooms.get(player.roomId);
                if (room) {
                    // إعادة الرصيد عند انقطاع الاتصال
                    if (room.status === 'waiting') {
                        await removePlayerFromRoom(socket, player, room);
                    } else {
                        const index = room.players.findIndex(p => p.socketId === socket.id);
                        if (index !== -1) {
                            room.players.splice(index, 1);
                        }
                    }
                    socket.to(player.roomId).emit('player_left', {
                        userId: player.userId
                    });
                    
                    if (room.status === 'active') {
                        const alivePlayers = room.players.filter(p => p.health > 0);
                        if (alivePlayers.length === 1) {
                            const winner = alivePlayers[0];
                            endGame(player.roomId, `🎉 فوز ${winner.team === 1 ? 'فريقك' : 'الفريق الخصم'} بسبب انسحاب الخصم! 🎉`);
                        } else if (alivePlayers.length === 0) {
                            endGame(player.roomId, 'انتهت المعركة بسبب انسحاب جميع اللاعبين');
                        }
                    } else if (room.status === 'waiting') {
                        updateRoom(player.roomId);
                        broadcastRoomsList();
                    }
                }
            }
            players.delete(socket.id);
            broadcastRoomsList();
        }
        console.log(`🔌 Disconnected: ${socket.id}`);
    });
});

// تنظيف الغرف المنتهية
setInterval(() => {
    broadcastRoomsList();
}, 10000);

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
║  ⏱️  Game duration: ${globalGameSettings.gameDuration / 1000} seconds
║  🏠 Multi-room system (${ROOMS_PER_TYPE} rooms per type, total ${ROOM_TYPES.length * ROOMS_PER_TYPE} rooms):
${ROOM_TYPES.map(type => `║     - ${type.name}: ${type.maxSeats} players, ${type.seatPrice}$ (${ROOMS_PER_TYPE} rooms)`).join('\n║     ')}
║  🔄 Rooms start when full, new room created after match
║  💰 Balance deducted on join, refunded on leave (before game starts)
║  🛡️ Admin Panel APIs: 
║     - GET /api/admin/stats
║     - GET /api/admin/rooms
║     - GET /api/admin/roomTypes
║     - POST /api/admin/balance
║     - POST /api/admin/updateRoomType
║     - POST /api/admin/resetData
║                                                              ║
╚══════════════════════════════════════════════════════════════╝
    `);
});
