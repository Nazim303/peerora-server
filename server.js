import express from 'express';
import { createServer } from 'http';
import { Server } from 'socket.io';
import cors from 'cors';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';

const app = express();

// 1. HTTP Güvenlik Başlıkları (Clickjacking & XSS Koruması)
app.use(helmet({ contentSecurityPolicy: false }));

// 2. İzin Verilen Kaynaklar (CORS)
const allowedOrigins = [
  'http://localhost:5173',
  'http://localhost:4173',
  'http://127.0.0.1:5173',
  'capacitor://localhost',
  'https://www.theosdev.web.tr',
  'https://theosdev.web.tr',
  'https://peerora.theosdev.web.tr' // İleride alt alan adı açarsanız
];
app.use(cors({
  origin: (origin, callback) => {
    if (!origin || allowedOrigins.includes(origin) || origin.startsWith('http://localhost:')) {
      callback(null, true);
    } else {
      callback(new Error('CORS Politikası: Yetkisiz Kaynak.'));
    }
  },
  credentials: true
}));

// 3. HTTP DDoS / Flood Koruması
const limiter = rateLimit({
  windowMs: 10 * 60 * 1000,
  max: 300,
  message: 'Çok fazla istek gönderildi, lütfen bir süre bekleyin.'
});
app.use(limiter);

const server = createServer(app);

// 4. Socket.io Bellek ve Bağlantı Sınırları (DoS Koruması)
const io = new Server(server, {
  cors: { origin: '*', methods: ['GET', 'POST'] },
  maxHttpBufferSize: 1e5, // Maksimum paket boyutu: 100 KB (Bellek şişirme saldırılarını engeller)
  pingTimeout: 20000,
  pingInterval: 10000
});

const rooms = new Map();

// XSS ve Zararlı Karakter Temizleyici
function sanitizeText(str, maxLength = 250) {
  if (typeof str !== 'string') return '';
  return str.replace(/[<>]/g, '').trim().slice(0, maxLength);
}

// Açık odaları istemcilere yayınlayan yardımcı fonksiyon
function broadcastPublicRooms() {
  const publicList = [];
  rooms.forEach((room, id) => {
    if (room.isPublic) {
      publicList.push({
        roomId: id,
        title: room.title || `${room.users[0]?.username || 'Host'}'in Odası`,
        hostAvatar: room.users[0]?.avatar || '🐱',
        hostName: room.users[0]?.username || 'Host',
        userCount: room.users.length,
        maxUsers: room.maxUsers,
        mediaType: room.mediaState.sourceType,
        theme: room.presetTheme || 'neo_brutalism'
      });
    }
  });
  io.emit('rooms:public_list', publicList);
}

function handleLeave(socket) {
  const roomId = socket.roomId;
  if (!roomId || !rooms.has(roomId)) return;

  const room = rooms.get(roomId);

  if (socket.id === room.host) {
    socket.to(roomId).emit('room:closed', {
      message: 'Oda yöneticisi ayrıldığı için oturum sonlandırıldı.'
    });
    rooms.delete(roomId);
    console.log(`[Oda Kapatıldı] ID: ${roomId} (Host ayrıldı)`);
  } else {
    room.users = room.users.filter((u) => u.id !== socket.id);
    socket.to(roomId).emit('room:user_left', { userId: socket.id, users: room.users });
    console.log(`[Misafir Ayrıldı] ID: ${roomId} | Kalan: ${room.users.length}`);
  }

  socket.leave(roomId);
  delete socket.roomId;
  broadcastPublicRooms();
}

io.on('connection', (socket) => {
  // Soket Spam / Flood Koruması
  let chatRateCounter = 0;
  const rateLimitInterval = setInterval(() => { chatRateCounter = 0; }, 1000);

  // Açık odaların güncel listesini gönder
  socket.on('rooms:get_public', (callback) => {
    const publicList = [];
    rooms.forEach((room, id) => {
      if (room.isPublic) {
        publicList.push({
          roomId: id,
          title: room.title || `${room.users[0]?.username || 'Host'}'in Odası`,
          hostAvatar: room.users[0]?.avatar || '🐱',
          hostName: room.users[0]?.username || 'Host',
          userCount: room.users.length,
          maxUsers: room.maxUsers,
          mediaType: room.mediaState.sourceType,
          theme: room.presetTheme || 'neo_brutalism'
        });
      }
    });
    if (callback) callback(publicList);
  });

// 1. ODA OLUŞTURMA (Düzeltildi: users dizisi callback ile geri dönüyor)
  socket.on('room:create', ({ username, avatar, maxUsers, initialMediaUrl, isPublic, roomTitle, presetTheme }, callback) => {
    const roomId = Math.floor(100000 + Math.random() * 900000).toString();
    const limit = Math.min(Math.max(parseInt(maxUsers) || 10, 2), 10);
    const cleanUsername = sanitizeText(username, 30) || 'Kullanıcı';
    const cleanTitle = sanitizeText(roomTitle, 60) || `${cleanUsername}'in Partisi`;
    const cleanAvatar = sanitizeText(avatar, 10) || '🐱';

    let initialType = 'NONE';
    let cleanUrl = '';
    if (initialMediaUrl && typeof initialMediaUrl === 'string') {
      cleanUrl = initialMediaUrl.trim();
      initialType = (cleanUrl.includes('youtube.com') || cleanUrl.includes('youtu.be')) ? 'YOUTUBE' : 'DIRECT';
    }

    const initialUsers = [{ id: socket.id, username: cleanUsername, avatar: cleanAvatar, isHost: true, isMuted: false }];

    rooms.set(roomId, {
      host: socket.id,
      title: cleanTitle,
      isPublic: isPublic ?? true,
      presetTheme: sanitizeText(presetTheme, 30) || 'neo_brutalism',
      maxUsers: limit,
      users: initialUsers,
      mediaState: {
        sourceType: initialType,
        sourceUrl: cleanUrl,
        playbackState: initialType !== 'NONE' ? 'PLAYING' : 'PAUSED',
        currentTime: 0,
        playbackRate: 1.0,
        lastUpdated: Date.now()
      },
      playlist: [],
      poll: null
    });

    socket.join(roomId);
    socket.roomId = roomId;

    if (callback) {
      callback({ 
        success: true, 
        roomId, 
        isHost: true, 
        maxUsers: limit,
        mediaState: rooms.get(roomId).mediaState,
        users: initialUsers // <-- ARTIK 1/2 DOĞRU GÖSTERİR
      });
    }

    broadcastPublicRooms();
  });

  // 2. ODAYA KATILMA
  socket.on('room:join', ({ roomId, username, avatar }, callback) => {
    const room = rooms.get(roomId);
    if (!room) return callback && callback({ success: false, message: 'Oda bulunamadı.' });
    if (room.users.length >= room.maxUsers) {
      return callback && callback({ success: false, message: `Oda dolu (${room.maxUsers} kişi).` });
    }

    const cleanUsername = sanitizeText(username, 30) || 'Misafir';
    const cleanAvatar = sanitizeText(avatar, 10) || '🐱';

    const newUser = { id: socket.id, username: cleanUsername, avatar: cleanAvatar, isHost: false, isMuted: false };
    room.users.push(newUser);
    socket.join(roomId);
    socket.roomId = roomId;

    let calculatedTime = room.mediaState.currentTime;
    if (room.mediaState.playbackState === 'PLAYING' && room.mediaState.lastUpdated) {
      calculatedTime += (Date.now() - room.mediaState.lastUpdated) / 1000;
    }

    if (callback) {
      callback({
        success: true,
        roomId,
        isHost: false,
        maxUsers: room.maxUsers,
        mediaState: { ...room.mediaState, currentTime: calculatedTime },
        playlist: room.playlist,
        poll: room.poll,
        users: room.users
      });
    }

    socket.to(roomId).emit('room:user_joined', {
      user: newUser,
      users: room.users
    });

    broadcastPublicRooms();
  });

  // 3. WEBRTC SİNYALLEŞMESİ
  socket.on('webrtc:signal', ({ targetId, payload }) => {
    if (targetId) {
      io.to(targetId).emit('webrtc:signal', { sender: socket.id, payload });
    } else if (socket.roomId) {
      socket.to(socket.roomId).emit('webrtc:signal', { sender: socket.id, payload });
    }
  });

  // 4. LAZER İMLEÇ
  socket.on('laser:point', (point) => {
    if (socket.roomId && point && typeof point.x === 'number' && typeof point.y === 'number') {
      socket.to(socket.roomId).emit('laser:point', { ...point, senderId: socket.id });
    }
  });

  // 5. ANKET SİSTEMİ
  socket.on('poll:create', (pollData) => {
    const room = rooms.get(socket.roomId);
    if (room && pollData?.question && Array.isArray(pollData?.options)) {
      room.poll = {
        id: `${Date.now()}`,
        question: sanitizeText(pollData.question, 120),
        options: pollData.options.slice(0, 5).map((opt, idx) => ({ 
          id: idx, 
          text: sanitizeText(opt, 60), 
          votes: [] 
        })),
        creator: socket.id
      };
      io.to(socket.roomId).emit('poll:updated', room.poll);
    }
  });

  socket.on('poll:vote', ({ optionId }) => {
    const room = rooms.get(socket.roomId);
    if (room && room.poll) {
      room.poll.options.forEach((opt) => {
        opt.votes = opt.votes.filter((id) => id !== socket.id);
      });
      const targetOpt = room.poll.options.find((o) => o.id === optionId);
      if (targetOpt) targetOpt.votes.push(socket.id);

      io.to(socket.roomId).emit('poll:updated', room.poll);
    }
  });

  socket.on('poll:end', () => {
    const room = rooms.get(socket.roomId);
    if (room && (socket.id === room.host || socket.id === room.poll?.creator)) {
      room.poll = null;
      io.to(socket.roomId).emit('poll:updated', null);
    }
  });

  // 6. MODERASYON
  socket.on('room:kick_user', ({ targetId }) => {
    const room = rooms.get(socket.roomId);
    if (room && socket.id === room.host && targetId !== socket.id) {
      io.to(targetId).emit('room:kicked');
      const targetSocket = io.sockets.sockets.get(targetId);
      if (targetSocket) handleLeave(targetSocket);
    }
  });

  socket.on('room:toggle_mute', ({ targetId }) => {
    const room = rooms.get(socket.roomId);
    if (room && socket.id === room.host) {
      const target = room.users.find((u) => u.id === targetId);
      if (target) {
        target.isMuted = !target.isMuted;
        io.to(socket.roomId).emit('room:users_updated', room.users);
      }
    }
  });

  socket.on('room:transfer_host', ({ newHostId }) => {
    const room = rooms.get(socket.roomId);
    if (room && socket.id === room.host) {
      const targetHost = room.users.find((u) => u.id === (newHostId || socket.id));
      if (targetHost) {
        let accurateTime = room.mediaState.currentTime;
        if (room.mediaState.playbackState === 'PLAYING' && room.mediaState.lastUpdated) {
          accurateTime += (Date.now() - room.mediaState.lastUpdated) / 1000;
        }

        room.mediaState.currentTime = accurateTime;
        room.mediaState.lastUpdated = Date.now();
        room.host = targetHost.id;
        room.users.forEach((u) => { u.isHost = (u.id === targetHost.id); });

        io.to(socket.roomId).emit('room:host_transferred', { 
          newHostId: targetHost.id,
          mediaState: room.mediaState,
          users: room.users
        });
      }
    }
  });

  // 7. MEDYA SENKRONİZASYONU
  socket.on('media:sync_state', (payload) => {
    const room = rooms.get(socket.roomId);
    if (room && typeof payload === 'object') {
      room.mediaState = { 
        ...room.mediaState, 
        ...payload, 
        currentTime: Number(payload.currentTime) || 0,
        lastUpdated: Date.now() 
      };
      socket.to(socket.roomId).emit('media:sync_state', { ...payload, senderId: socket.id });
    }
  });

  socket.on('media:change_source', (payload) => {
    const room = rooms.get(socket.roomId);
    if (room && socket.id === room.host && payload?.type) {
      room.mediaState = {
        sourceType: sanitizeText(payload.type, 20),
        sourceUrl: typeof payload.url === 'string' ? payload.url.trim() : '',
        playbackState: 'PAUSED',
        currentTime: 0,
        playbackRate: 1.0,
        lastUpdated: Date.now()
      };
      io.to(socket.roomId).emit('media:change_source', payload);
      broadcastPublicRooms();
    }
  });

  // 8. OYNATMA LİSTESİ
  socket.on('playlist:add', (item) => {
    const room = rooms.get(socket.roomId);
    if (room && item && room.playlist.length < 50) {
      const cleanItem = {
        id: sanitizeText(item.id, 40) || `${Date.now()}`,
        title: sanitizeText(item.title, 100) || 'Video',
        url: typeof item.url === 'string' ? item.url.trim() : '',
        type: sanitizeText(item.type, 20) || 'DIRECT'
      };
      room.playlist.push(cleanItem);
      io.to(socket.roomId).emit('playlist:updated', room.playlist);
    }
  });

  socket.on('playlist:remove', ({ itemId }) => {
    const room = rooms.get(socket.roomId);
    if (room && socket.id === room.host) {
      room.playlist = room.playlist.filter((i) => i.id !== itemId);
      io.to(socket.roomId).emit('playlist:updated', room.playlist);
    }
  });

  socket.on('playlist:play_next', () => {
    const room = rooms.get(socket.roomId);
    if (room && socket.id === room.host && room.playlist.length > 0) {
      const nextItem = room.playlist.shift();
      room.mediaState = {
        sourceType: nextItem.type,
        sourceUrl: nextItem.url,
        playbackState: 'PLAYING',
        currentTime: 0,
        playbackRate: 1.0,
        lastUpdated: Date.now()
      };
      io.to(socket.roomId).emit('playlist:updated', room.playlist);
      io.to(socket.roomId).emit('media:change_source', { type: nextItem.type, url: nextItem.url });
    }
  });

  // 9. SOHBET & FLOOD KORUMASI
  socket.on('chat:send', (messageData) => {
    chatRateCounter++;
    if (chatRateCounter > 6) return; // Saniyede 6'dan fazla mesaj spam olarak reddedilir

    const room = rooms.get(socket.roomId);
    if (room) {
      const sender = room.users.find((u) => u.id === socket.id);
      if (sender && sender.isMuted) return;

      const safeMessage = {
        id: sanitizeText(messageData.id, 40) || `${Date.now()}`,
        sender: sanitizeText(messageData.sender, 40),
        text: sanitizeText(messageData.text, 400),
        type: sanitizeText(messageData.type, 10) || 'TEXT',
        color: sanitizeText(messageData.color, 15),
        time: Date.now()
      };
      io.to(socket.roomId).emit('chat:message', safeMessage);
    }
  });

  socket.on('chat:typing', ({ isTyping, username }) => {
    if (socket.roomId) {
      socket.to(socket.roomId).emit('chat:typing', { 
        isTyping: !!isTyping, 
        username: sanitizeText(username, 30) 
      });
    }
  });

  socket.on('chat:reaction', (reactionData) => {
    if (socket.roomId && reactionData) {
      io.to(socket.roomId).emit('chat:reaction', {
        emoji: sanitizeText(reactionData.emoji, 10),
        sender: sanitizeText(reactionData.sender, 30),
        x: Number(reactionData.x) || 50
      });
    }
  });

  socket.on('room:leave', () => handleLeave(socket));
  
  socket.on('disconnect', () => {
    clearInterval(rateLimitInterval);
    handleLeave(socket);
  });
});

const PORT = process.env.PORT || 4000;
server.listen(PORT, () => {
  console.log(`[Peerora Server] Port ${PORT} üzerinde güvenli modda hazır.`);
});