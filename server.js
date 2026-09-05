import express from 'express';
import { createServer } from 'http';
import { Server } from 'socket.io';
import cors from 'cors';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';

const app = express();

app.use(helmet({ contentSecurityPolicy: false }));

const allowedOrigins = [
  'http://localhost:5173',
  'http://localhost:4173',
  'http://127.0.0.1:5173',
  'capacitor://localhost',
  'https://www.theosdev.web.tr',
  'https://theosdev.web.tr',
  'https://peerora.theosdev.web.tr'
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

const limiter = rateLimit({
  windowMs: 10 * 60 * 1000,
  max: 300,
  message: 'Çok fazla istek gönderildi, lütfen bir süre bekleyin.'
});
app.use(limiter);

app.get('/ping', (req, res) => res.status(200).send('pong'));

const server = createServer(app);

const io = new Server(server, {
  cors: { origin: '*', methods: ['GET', 'POST'] },
  maxHttpBufferSize: 1e5,
  pingTimeout: 20000,
  pingInterval: 10000
});

const rooms = new Map();

function sanitizeText(str, maxLength = 250) {
  if (typeof str !== 'string') return '';
  return str.replace(/[<>]/g, '').trim().slice(0, maxLength);
}

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
  } else {
    room.users = room.users.filter((u) => u.id !== socket.id);
    socket.to(roomId).emit('room:user_left', { userId: socket.id, users: room.users });
  }

  socket.leave(roomId);
  delete socket.roomId;
  broadcastPublicRooms();
}

function resolveSpyfallVotes(room, roomId) {
  if (!room.game || room.game.phase === 'RESULT') return;
  room.game.phase = 'RESULT';

  const voteCounts = {};
  Object.values(room.game.votes || {}).forEach((targetId) => {
    voteCounts[targetId] = (voteCounts[targetId] || 0) + 1;
  });

  let maxVotes = 0;
  let eliminatedId = null;
  let isTie = false;

  Object.entries(voteCounts).forEach(([userId, count]) => {
    if (count > maxVotes) {
      maxVotes = count;
      eliminatedId = userId;
      isTie = false;
    } else if (count === maxVotes) {
      isTie = true;
    }
  });

  const eliminatedUser = room.users.find((u) => u.id === eliminatedId);
  const isSpyEliminated = !isTie && eliminatedId === room.game.spyId;
  const winner = isSpyEliminated ? 'INNOCENTS' : 'SPY';

  io.to(roomId).emit('game:spyfall_result', {
    winner,
    eliminatedName: isTie ? null : (eliminatedUser ? eliminatedUser.username : null),
    isTie,
    maxVotes,
    spyName: room.game.spyName,
    location: room.game.location,
    voteCounts
  });
}

io.on('connection', (socket) => {
  let chatRateCounter = 0;
  const rateLimitInterval = setInterval(() => { chatRateCounter = 0; }, 1000);

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

  // 1. ODA OLUŞTURMA
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
      game: null,
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
        users: initialUsers
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
        users: room.users,
        game: room.game ? { type: room.game.type, isSpectator: true, endTime: room.game.endTime } : null
      });
    }

    socket.to(roomId).emit('room:user_joined', {
      user: newUser,
      users: room.users
    });

    broadcastPublicRooms();
  });

  // 3. WEBRTC
  socket.on('webrtc:signal', ({ targetId, payload }) => {
    if (targetId) {
      io.to(targetId).emit('webrtc:signal', { sender: socket.id, payload });
    } else if (socket.roomId) {
      socket.to(socket.roomId).emit('webrtc:signal', { sender: socket.id, payload });
    }
  });

  // 4. LAZER
  socket.on('laser:point', (point) => {
    if (socket.roomId && point && typeof point.x === 'number' && typeof point.y === 'number') {
      socket.to(socket.roomId).emit('laser:point', { ...point, senderId: socket.id });
    }
  });

  // 5. ANKET
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

  // 6. MİNİ OYUN YÖNETİMİ
  socket.on('game:start', ({ gameType, lang, customConfig }) => {
    const room = rooms.get(socket.roomId);
    if (!room || socket.id !== room.host) return;

    room.mediaState.playbackState = 'PAUSED';

    if (gameType === 'DOODLE') {
      const drawer = room.users[Math.floor(Math.random() * room.users.length)];
      room.game = {
        type: 'DOODLE',
        lang: lang || 'tr',
        drawerId: drawer.id,
        drawerName: drawer.username,
        word: customConfig?.word || 'Kedi',
        wordList: customConfig?.wordList || ['Kedi', 'Gitar', 'Pizza'],
        strokes: []
      };
      io.to(socket.roomId).emit('game:started', room.game);
    } else if (gameType === 'SPYFALL') {
      const spyIndex = Math.floor(Math.random() * room.users.length);
      const spyUser = room.users[spyIndex];
      const chosenLocation = customConfig?.location || 'Sinema';
      const endTime = Date.now() + (5 * 60 * 1000);

      room.game = {
        type: 'SPYFALL',
        phase: 'PLAYING',
        lang: lang || 'tr',
        spyId: spyUser.id,
        spyName: spyUser.username,
        location: chosenLocation,
        endTime,
        votes: {}
      };

      const userSummary = room.users.map((u) => ({ id: u.id, username: u.username, avatar: u.avatar }));

      room.users.forEach((u) => {
        const isSpy = u.id === spyUser.id;
        io.to(u.id).emit('game:started', {
          type: 'SPYFALL',
          phase: 'PLAYING',
          isSpy,
          location: isSpy ? null : chosenLocation,
          endTime,
          users: userSummary
        });
      });
    }
  });

  // Çizim Vuruşunu Odadakilere Dağıt
  socket.on('game:draw_stroke', (stroke) => {
    const room = rooms.get(socket.roomId);
    if (room && room.game?.type === 'DOODLE') {
      room.game.strokes = room.game.strokes || [];
      room.game.strokes.push(stroke);
      socket.to(socket.roomId).emit('game:draw_stroke', stroke);
    }
  });

  socket.on('game:clear_canvas', () => {
    const room = rooms.get(socket.roomId);
    if (room && room.game?.type === 'DOODLE') {
      room.game.strokes = [];
      io.to(socket.roomId).emit('game:clear_canvas');
    }
  });

  socket.on('game:end', () => {
    const room = rooms.get(socket.roomId);
    if (room && socket.id === room.host) {
      room.game = null;
      io.to(socket.roomId).emit('game:ended');
    }
  });

  socket.on('game:spyfall_start_voting', () => {
    const room = rooms.get(socket.roomId);
    if (!room || room.game?.type !== 'SPYFALL') return;

    room.game.phase = 'VOTING';
    room.game.endTime = Date.now() + (60 * 1000);
    room.game.votes = {};

    io.to(socket.roomId).emit('game:spyfall_phase_change', {
      phase: 'VOTING',
      endTime: room.game.endTime,
      users: room.users.map((u) => ({ id: u.id, username: u.username, avatar: u.avatar }))
    });
  });

  socket.on('game:spyfall_vote', ({ targetId }) => {
    const room = rooms.get(socket.roomId);
    if (!room || room.game?.type !== 'SPYFALL' || room.game.phase !== 'VOTING') return;

    room.game.votes[socket.id] = targetId;

    io.to(socket.roomId).emit('game:spyfall_vote_progress', {
      votedCount: Object.keys(room.game.votes).length,
      totalCount: room.users.length
    });

    if (Object.keys(room.game.votes).length >= room.users.length) {
      resolveSpyfallVotes(room, socket.roomId);
    }
  });

  socket.on('game:spyfall_time_up', () => {
    const room = rooms.get(socket.roomId);
    if (!room || room.game?.type !== 'SPYFALL') return;

    if (room.game.phase === 'PLAYING') {
      room.game.phase = 'VOTING';
      room.game.endTime = Date.now() + (60 * 1000);
      room.game.votes = {};
      io.to(socket.roomId).emit('game:spyfall_phase_change', {
        phase: 'VOTING',
        endTime: room.game.endTime,
        users: room.users.map((u) => ({ id: u.id, username: u.username, avatar: u.avatar }))
      });
    } else if (room.game.phase === 'VOTING') {
      resolveSpyfallVotes(room, socket.roomId);
    }
  });

  // 7. MODERASYON
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

  // 8. MEDYA & VİDEO YÖNETİMİ (Video açılınca oyunu otomatik kapatır)
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
      // Video açıldığında odadaki aktif oyunu sonlandır
      if (room.game) {
        room.game = null;
        io.to(socket.roomId).emit('game:ended');
      }

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
      if (room.game) {
        room.game = null;
        io.to(socket.roomId).emit('game:ended');
      }
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

  // 9. SOHBET & OYUN TAHMİN KONTROLÜ
  socket.on('chat:send', (messageData) => {
    chatRateCounter++;
    if (chatRateCounter > 6) return;

    const room = rooms.get(socket.roomId);
    if (room) {
      const sender = room.users.find((u) => u.id === socket.id);
      if (sender && sender.isMuted) return;

      const safeMessage = {
        id: sanitizeText(messageData.id, 40) || `${Date.now()}`,
        senderId: socket.id,
        sender: sanitizeText(messageData.sender, 40),
        text: sanitizeText(messageData.text, 400),
        type: sanitizeText(messageData.type, 10) || 'TEXT',
        color: sanitizeText(messageData.color, 15),
        time: Date.now()
      };
      io.to(socket.roomId).emit('chat:message', safeMessage);

      // Çiz & Bil Otomatik Doğrulama
      if (room.game?.type === 'DOODLE' && socket.id !== room.game.drawerId && room.game.word) {
        const guess = safeMessage.text.trim().toLowerCase();
        const target = room.game.word.trim().toLowerCase();

        if (guess === target) {
          const isTr = room.game.lang === 'tr';
          const winMsg = isTr
            ? `🎉 ${sender.username} doğru tahmin etti! Kelime: "${room.game.word}"`
            : `🎉 ${sender.username} guessed correctly! Word: "${room.game.word}"`;

          io.to(socket.roomId).emit('chat:message', {
            id: `${Date.now()}-win`,
            senderId: 'system',
            sender: '🤖 Peerora Bot',
            text: winMsg,
            type: 'TEXT',
            color: '#10b981',
            time: Date.now()
          });

          const users = room.users;
          const currentDrawerIdx = users.findIndex((u) => u.id === room.game.drawerId);
          const nextDrawer = users[(currentDrawerIdx + 1) % users.length];
          const wordList = room.game.wordList || ['Kedi', 'Gitar', 'Pizza', 'Uçak'];
          const nextWord = wordList[Math.floor(Math.random() * wordList.length)];

          room.game.drawerId = nextDrawer.id;
          room.game.drawerName = nextDrawer.username;
          room.game.word = nextWord;
          room.game.strokes = [];

          io.to(socket.roomId).emit('game:started', room.game);
          io.to(socket.roomId).emit('game:clear_canvas');
        }
      }
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