const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const { v4: uuidv4 } = require('uuid');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: '*' },
  pingTimeout: 60000,
  pingInterval: 25000
});

app.use(express.static(path.join(__dirname, 'public')));

// ===== IN-MEMORY STORE =====
const rooms = new Map(); // roomId -> roomData

function generateRoomId() {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let id = '';
  for (let i = 0; i < 6; i++) {
    id += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return id;
}

function createRoom() {
  const roomId = generateRoomId();
  const hostToken = uuidv4();
  const room = {
    id: roomId,
    hostToken: hostToken,
    state: 'IDLE', // IDLE | STARTED | STOPPED
    keywords: [],
    results: [], // [{ keyword, timestamp }]
    players: new Set(),
    createdAt: Date.now()
  };
  rooms.set(roomId, room);
  return { roomId, hostToken };
}

function isHost(socket, room) {
  return socket.hostToken && socket.hostToken === room.hostToken;
}

// ===== ROUTES =====
app.get('/create-room', (req, res) => {
  const { roomId, hostToken } = createRoom();
  res.redirect(`/host/${roomId}?token=${hostToken}`);
});

app.get('/host/:roomId', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'host.html'));
});

app.get('/room/:roomId', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'room.html'));
});

// ===== SOCKET.IO =====
io.on('connection', (socket) => {
  console.log('Client connected:', socket.id);

  // --- Host tạo/join room ---
  socket.on('join-host', ({ roomId, token }) => {
    const room = rooms.get(roomId);
    if (!room) {
      socket.emit('error-msg', 'Room không tồn tại');
      return;
    }
    if (room.hostToken !== token) {
      socket.emit('error-msg', 'Host token không hợp lệ');
      return;
    }
    
    socket.hostToken = token;
    socket.roomId = roomId;
    socket.join(roomId);
    
    socket.emit('joined', { role: 'host', roomId, state: room.state });
    socket.emit('keywords-updated', room.keywords);
    socket.emit('result-update', room.results);
  });

  // --- Player join room ---
  socket.on('join-player', ({ roomId }) => {
    const room = rooms.get(roomId);
    if (!room) {
      socket.emit('error-msg', 'Room không tồn tại');
      return;
    }
    
    socket.roomId = roomId;
    socket.join(roomId);
    room.players.add(socket.id);
    
    socket.emit('joined', { role: 'player', roomId, state: room.state });
    socket.emit('keywords-updated', room.keywords);
    if (room.state === 'STOPPED') {
      socket.emit('game-ended', room.results);
    }
  });

  // --- Host cập nhật keywords ---
  socket.on('update-keywords', ({ roomId, keywords }) => {
    const room = rooms.get(roomId);
    if (!room || !isHost(socket, room)) {
      socket.emit('error-msg', 'Không có quyền cập nhật keyword');
      return;
    }
    if (room.state !== 'IDLE') {
      socket.emit('error-msg', 'Chỉ được sửa keyword khi đang IDLE');
      return;
    }
    
    room.keywords = keywords.map(k => k.trim()).filter(k => k);
    io.to(roomId).emit('keywords-updated', room.keywords);
  });

  // --- Host START ---
  socket.on('start', ({ roomId }) => {
    const room = rooms.get(roomId);
    if (!room || !isHost(socket, room)) {
      socket.emit('error-msg', 'Không có quyền START');
      return;
    }
    if (room.state !== 'IDLE') {
      socket.emit('error-msg', 'Chỉ START được khi đang IDLE');
      return;
    }
    
    room.state = 'STARTED';
    room.results = []; // Reset kết quả cũ khi start mới
    io.to(roomId).emit('state-changed', 'STARTED');
  });

  // --- Host STOP ---
  socket.on('stop', ({ roomId }) => {
    const room = rooms.get(roomId);
    if (!room || !isHost(socket, room)) {
      socket.emit('error-msg', 'Không có quyền STOP');
      return;
    }
    if (room.state !== 'STARTED') {
      socket.emit('error-msg', 'Chỉ STOP được khi đang STARTED');
      return;
    }
    
    room.state = 'STOPPED';
    io.to(roomId).emit('state-changed', 'STOPPED');
    io.to(roomId).emit('game-ended', room.results);
  });

  // --- Host RESET ---
  socket.on('reset', ({ roomId }) => {
    const room = rooms.get(roomId);
    if (!room || !isHost(socket, room)) {
      socket.emit('error-msg', 'Không có quyền RESET');
      return;
    }
    
    room.state = 'IDLE';
    room.results = [];
    io.to(roomId).emit('state-changed', 'IDLE');
    io.to(roomId).emit('result-update', []);
  });

  // --- Player gửi transcript từ Web Speech API ---
  socket.on('speech-result', ({ roomId, transcript }) => {
    const room = rooms.get(roomId);
    if (!room || room.state !== 'STARTED') return;
    
    const text = transcript.trim().toLowerCase();
    if (!text) return;
    
    // Kiểm tra keyword đầu tiên chưa được ghi nhận
    for (const keyword of room.keywords) {
      const keyLower = keyword.toLowerCase();
      if (text.includes(keyLower)) {
        const alreadyFound = room.results.find(r => r.keyword.toLowerCase() === keyLower);
        if (!alreadyFound) {
          const entry = {
            keyword: keyword,
            timestamp: Date.now(),
            order: room.results.length + 1
          };
          room.results.push(entry);
          // Broadcast ngay để Host thấy realtime
          io.to(roomId).emit('result-update', room.results);
        }
        break; // Chỉ tính 1 keyword đầu tiên trong cùng 1 transcript
      }
    }
  });

  socket.on('disconnect', () => {
    if (socket.roomId) {
      const room = rooms.get(socket.roomId);
      if (room) {
        room.players.delete(socket.id);
      }
    }
    console.log('Client disconnected:', socket.id);
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
