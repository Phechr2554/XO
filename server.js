/* ============================================================
 * XO ARENA — Game Server
 * Express + Socket.IO : matchmaking, private room, Elo, chat,
 * turn timer, reconnect grace, leaderboard, persistence
 * ============================================================ */
'use strict';

const path = require('path');
const fs = require('fs');
const http = require('http');
const express = require('express');
const { Server } = require('socket.io');
const E = require('./public/js/engine.js');

// Bot-Hosting exposes the published application port through PORT.
// Keep a safe fallback for deployments where PORT is not injected.
const PORT = Number(
  process.env.PORT ||
  process.env.SERVER_PORT ||
  process.env.APP_PORT ||
  25118
);
const HOST = process.env.HOST || '0.0.0.0';
const DATA_DIR = path.join(__dirname, 'data');
const DB_FILE = path.join(DATA_DIR, 'db.json');

const TURN_GRACE_MS = 1500;      // เผื่อ latency
const RECONNECT_MS = 30000;      // เวลาให้กลับเข้าเกม
const CHAT_COOLDOWN = 700;
const CHAT_MAX = 200;
const BANNED_WORDS = [];         // เพิ่มคำที่ต้องการกรองได้เอง

/* ---------------- Persistence ---------------- */
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
let DB = { players: {} };
try { if (fs.existsSync(DB_FILE)) DB = JSON.parse(fs.readFileSync(DB_FILE, 'utf8')); }
catch (e) { console.error('[db] อ่านไฟล์ไม่ได้ ใช้ค่าเริ่มต้น:', e.message); }

let dirty = false;
const markDirty = () => { dirty = true; };
function saveDB() {
  if (!dirty) return;
  try {
    const tmp = DB_FILE + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(DB), 'utf8');
    fs.renameSync(tmp, DB_FILE);
    dirty = false;
  } catch (e) {
    console.error('[db] เขียนไม่สำเร็จ:', e.message);
  }
}
setInterval(saveDB, 15000);
['SIGINT', 'SIGTERM'].forEach(s => process.on(s, () => { dirty = true; saveDB(); process.exit(0); }));

function getProfile(id, name, avatar) {
  if (!DB.players[id]) {
    DB.players[id] = { id, name: name || 'ผู้เล่น', avatar: avatar || '🐱', elo: 1000, wins: 0, losses: 0, draws: 0, games: 0, streak: 0, best: 0, lastSeen: Date.now() };
    markDirty();
  }
  const p = DB.players[id];
  if (name) p.name = String(name).slice(0, 16);
  if (avatar) p.avatar = String(avatar).slice(0, 4);
  p.lastSeen = Date.now();
  markDirty();
  return p;
}

/* ---------------- Elo ---------------- */
function kFactor(games, elo) {
  if (games < 15) return 40;
  if (elo >= 1800) return 16;
  return 24;
}
function applyElo(a, b, resultA) {          // resultA: 1 ชนะ / 0.5 เสมอ / 0 แพ้
  const ea = 1 / (1 + Math.pow(10, (b.elo - a.elo) / 400));
  const eb = 1 - ea;
  const da = Math.round(kFactor(a.games, a.elo) * (resultA - ea));
  const db = Math.round(kFactor(b.games, b.elo) * ((1 - resultA) - eb));
  a.elo = Math.max(100, a.elo + da);
  b.elo = Math.max(100, b.elo + db);
  a.games++; b.games++;
  if (resultA === 1) { a.wins++; b.losses++; a.streak++; b.streak = 0; }
  else if (resultA === 0) { b.wins++; a.losses++; b.streak++; a.streak = 0; }
  else { a.draws++; b.draws++; }
  a.best = Math.max(a.best || 0, a.streak);
  b.best = Math.max(b.best || 0, b.streak);
  markDirty();
  return { da, db };
}

/* ---------------- App ---------------- */
const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public'), { etag: true, lastModified: true, maxAge: 0 }));

app.get('/api/health', (_req, res) => res.json({ ok: true, uptime: process.uptime(), rooms: rooms.size, online: io.engine.clientsCount }));

app.get('/api/leaderboard', (_req, res) => {
  const list = Object.values(DB.players)
    .filter(p => p.games > 0)
    .sort((a, b) => b.elo - a.elo || b.wins - a.wins)
    .slice(0, 50)
    .map((p, i) => ({ rank: i + 1, name: p.name, avatar: p.avatar, elo: p.elo, wins: p.wins, losses: p.losses, draws: p.draws, games: p.games, best: p.best || 0 }));
  res.json({ list, total: Object.keys(DB.players).length });
});

app.get('/api/player/:id', (req, res) => {
  const p = DB.players[req.params.id];
  if (!p) return res.status(404).json({ error: 'not found' });
  res.json(p);
});

const server = http.createServer(app);
const io = new Server(server, { pingTimeout: 20000, transports: ['websocket', 'polling'] });

/* ---------------- State ---------------- */
const rooms = new Map();                    // code -> room
const queues = new Map();                   // presetId -> [entry]
const socketsByPlayer = new Map();          // playerId -> socket.id

const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
function newCode() {
  let code;
  do { code = Array.from({ length: 5 }, () => CODE_ALPHABET[Math.floor(Math.random() * CODE_ALPHABET.length)]).join(''); }
  while (rooms.has(code));
  return code;
}

function createRoom(preset, isPrivate) {
  const code = newCode();
  const room = {
    code, preset, private: !!isPrivate, friendly: false,
    size: preset.size, winLen: preset.winLen, turnMs: preset.turnMs,
    board: E.create(preset.size),
    turn: E.X, players: [], spectators: [],
    moves: [], over: false, winner: 0, line: [],
    scores: {}, rematch: new Set(), round: 1,
    turnDeadline: 0, timer: null, createdAt: Date.now()
  };
  rooms.set(code, room);
  return room;
}

function destroyRoom(room) {
  if (!room) return;
  clearTimeout(room.timer);
  room.players.forEach(p => clearTimeout(p.dcTimer));
  rooms.delete(room.code);
}

function publicState(room) {
  return {
    code: room.code, presetId: room.preset.id, size: room.size, winLen: room.winLen,
    board: room.board, turn: room.turn, over: room.over, winner: room.winner, line: room.line,
    round: room.round, moves: room.moves, turnMs: room.turnMs,
    turnDeadline: room.turnDeadline, serverNow: Date.now(),
    scores: room.scores,
    players: room.players.map(p => ({
      id: p.id, name: p.name, avatar: p.avatar, symbol: p.symbol,
      elo: getProfile(p.id).elo, connected: p.connected,
      rematch: room.rematch.has(p.id)
    }))
  };
}

function broadcast(room, event, payload) { io.to('room:' + room.code).emit(event, payload); }
function pushState(room) { broadcast(room, 'game:state', publicState(room)); }

/* ---------------- Turn timer ---------------- */
function startTurnTimer(room) {
  clearTimeout(room.timer);
  if (room.over || room.players.length < 2) return;
  room.turnDeadline = Date.now() + room.turnMs;
  room.timer = setTimeout(() => {
    if (room.over) return;
    const loser = room.players.find(p => p.symbol === room.turn);
    const winner = room.players.find(p => p.symbol !== room.turn);
    finishGame(room, winner ? winner.symbol : 0, [], 'timeout', loser && loser.id);
  }, room.turnMs + TURN_GRACE_MS);
}

/* ---------------- Finish ---------------- */
function finishGame(room, winnerSymbol, line, reason, loserId) {
  if (room.over) return;
  clearTimeout(room.timer);
  room.over = true;
  room.winner = winnerSymbol;
  room.line = line || [];
  room.turnDeadline = 0;

  const result = { reason, winner: winnerSymbol, line: room.line, delta: {} };

  if (room.players.length === 2 && !room.friendly) {
    const [a, b] = room.players.map(p => getProfile(p.id));
    let ra = 0.5;
    if (winnerSymbol) ra = room.players[0].symbol === winnerSymbol ? 1 : 0;
    const { da, db } = applyElo(a, b, ra);
    result.delta[room.players[0].id] = da;
    result.delta[room.players[1].id] = db;
    result.elo = { [a.id]: a.elo, [b.id]: b.elo };
  }

  if (winnerSymbol) room.scores[winnerSymbol] = (room.scores[winnerSymbol] || 0) + 1;
  else room.scores.draw = (room.scores.draw || 0) + 1;

  room.rematch.clear();
  pushState(room);
  broadcast(room, 'game:over', result);
  if (loserId) { /* hook สำหรับ log/anti-abuse */ }
}

/* ---------------- Matchmaking ---------------- */
function joinQueue(socket, presetId) {
  const preset = E.PRESETS[presetId] || E.PRESETS.classic;
  leaveQueue(socket);
  const q = queues.get(preset.id) || [];
  const me = { socketId: socket.id, playerId: socket.data.playerId, elo: getProfile(socket.data.playerId).elo, at: Date.now() };

  // เลือกคู่ที่ Elo ใกล้ที่สุด (ขยายช่วงตามเวลารอ)
  let bestIdx = -1, bestDiff = Infinity;
  q.forEach((e, i) => {
    if (e.playerId === me.playerId) return;
    if (!io.sockets.sockets.get(e.socketId)) return;
    const waited = (Date.now() - e.at) / 1000;
    const range = 120 + waited * 40;
    const diff = Math.abs(e.elo - me.elo);
    if (diff <= range && diff < bestDiff) { bestDiff = diff; bestIdx = i; }
  });

  if (bestIdx >= 0) {
    const other = q.splice(bestIdx, 1)[0];
    queues.set(preset.id, q);
    const otherSock = io.sockets.sockets.get(other.socketId);
    if (otherSock) return startMatch(otherSock, socket, preset);
  }

  q.push(me);
  queues.set(preset.id, q);
  socket.data.queue = preset.id;
  socket.emit('queue:status', { inQueue: true, preset: preset.id, size: q.length });
}

function leaveQueue(socket) {
  const pid = socket.data.queue;
  if (!pid) return;
  const q = (queues.get(pid) || []).filter(e => e.socketId !== socket.id);
  queues.set(pid, q);
  socket.data.queue = null;
  socket.emit('queue:status', { inQueue: false });
}

function makePlayer(socket, symbol) {
  const p = getProfile(socket.data.playerId);
  return { id: p.id, name: p.name, avatar: p.avatar, symbol, socketId: socket.id, connected: true, dcTimer: null };
}

function startMatch(sockA, sockB, preset) {
  const room = createRoom(preset, false);
  const firstIsA = Math.random() < 0.5;
  room.players = firstIsA
    ? [makePlayer(sockA, E.X), makePlayer(sockB, E.O)]
    : [makePlayer(sockB, E.X), makePlayer(sockA, E.O)];

  [sockA, sockB].forEach(s => {
    s.data.queue = null;
    s.data.room = room.code;
    s.join('room:' + room.code);
    s.emit('match:found', { code: room.code, you: room.players.find(p => p.id === s.data.playerId).symbol });
  });
  startTurnTimer(room);
  pushState(room);
}

/* ---------------- Socket handlers ---------------- */
io.on('connection', (socket) => {
  io.emit('online:count', io.engine.clientsCount);

  socket.on('hello', (payload = {}, ack) => {
    const id = String(payload.playerId || '').slice(0, 40) || ('anon-' + socket.id);
    socket.data.playerId = id;
    socket.data.chatAt = 0;
    socketsByPlayer.set(id, socket.id);
    const profile = getProfile(id, payload.name, payload.avatar);

    // กลับเข้าเกมเดิมถ้ายังค้างอยู่
    let resumed = null;
    for (const room of rooms.values()) {
      const p = room.players.find(x => x.id === id);
      if (p) {
        clearTimeout(p.dcTimer);
        p.connected = true; p.socketId = socket.id;
        socket.data.room = room.code;
        socket.join('room:' + room.code);
        broadcast(room, 'opponent:reconnected', { id });
        pushState(room);
        resumed = { code: room.code, you: p.symbol };
        break;
      }
    }
    const res = { profile, online: io.engine.clientsCount, resumed, presets: E.PRESETS };
    socket.emit('welcome', res);
    if (typeof ack === 'function') ack(res);
  });

  socket.on('queue:join', ({ preset } = {}) => joinQueue(socket, preset));
  socket.on('queue:leave', () => leaveQueue(socket));

  socket.on('room:create', ({ preset, friendly } = {}, ack) => {
    const cfg = E.PRESETS[preset] || E.PRESETS.classic;
    const room = createRoom(cfg, true);
    room.friendly = !!friendly;                 // ห้องเพื่อน = ไม่คิด Elo
    room.players = [makePlayer(socket, E.X)];
    socket.data.room = room.code;
    socket.join('room:' + room.code);
    const res = { code: room.code, you: E.X, friendly: room.friendly };
    socket.emit('room:created', res);
    if (typeof ack === 'function') ack(res);
    pushState(room);
  });

  socket.on('room:join', ({ code } = {}, ack) => {
    const room = rooms.get(String(code || '').toUpperCase().trim());
    const fail = (msg) => { socket.emit('error:msg', msg); if (typeof ack === 'function') ack({ error: msg }); };
    if (!room) return fail('ไม่พบห้องนี้ หรือห้องถูกปิดไปแล้ว');

    const already = room.players.find(p => p.id === socket.data.playerId);
    if (already) {
      already.connected = true; already.socketId = socket.id;
    } else if (room.players.length >= 2) {
      // เข้าเป็นผู้ชม
      room.spectators.push(socket.data.playerId);
      socket.data.room = room.code;
      socket.join('room:' + room.code);
      socket.emit('room:spectate', { code: room.code });
      pushState(room);
      if (typeof ack === 'function') ack({ spectator: true });
      return;
    } else {
      room.players.push(makePlayer(socket, E.O));
    }

    socket.data.room = room.code;
    socket.join('room:' + room.code);
    const you = room.players.find(p => p.id === socket.data.playerId).symbol;
    socket.emit('match:found', { code: room.code, you });
    broadcast(room, 'room:player-joined', { code: room.code });
    if (room.players.length === 2 && !room.over) startTurnTimer(room);
    pushState(room);
    if (typeof ack === 'function') ack({ code: room.code, you });
  });

  socket.on('game:move', ({ index } = {}) => {
    const room = rooms.get(socket.data.room);
    if (!room || room.over) return;
    const me = room.players.find(p => p.id === socket.data.playerId);
    if (!me) return socket.emit('error:msg', 'คุณเป็นผู้ชม ไม่สามารถเดินได้');
    if (room.players.length < 2) return socket.emit('error:msg', 'รอคู่แข่งเข้าห้องก่อน');
    if (me.symbol !== room.turn) return socket.emit('error:msg', 'ยังไม่ถึงตาคุณ');

    const i = Number(index);
    if (!Number.isInteger(i) || i < 0 || i >= room.board.length) return;
    if (room.board[i] !== E.EMPTY) return socket.emit('error:msg', 'ช่องนี้ถูกใช้แล้ว');

    room.board[i] = me.symbol;
    room.moves.push({ i, s: me.symbol, t: Date.now() });

    const st = E.status(room.board, room.size, room.winLen, i);
    if (st.over) return finishGame(room, st.winner, st.line, st.draw ? 'draw' : 'line');

    room.turn = E.other(room.turn);
    startTurnTimer(room);
    pushState(room);
  });

  socket.on('game:resign', () => {
    const room = rooms.get(socket.data.room);
    if (!room || room.over) return;
    const me = room.players.find(p => p.id === socket.data.playerId);
    if (!me) return;
    const opp = room.players.find(p => p.id !== me.id);
    finishGame(room, opp ? opp.symbol : 0, [], 'resign', me.id);
  });

  socket.on('game:rematch', () => {
    const room = rooms.get(socket.data.room);
    if (!room || !room.over) return;
    const me = room.players.find(p => p.id === socket.data.playerId);
    if (!me) return;
    room.rematch.add(me.id);
    pushState(room);
    if (room.rematch.size >= 2 && room.players.length === 2) {
      room.board = E.create(room.size);
      room.moves = []; room.over = false; room.winner = 0; room.line = [];
      room.round++;
      room.players.forEach(p => { p.symbol = E.other(p.symbol); });   // สลับฝั่ง
      room.turn = E.X;
      room.rematch.clear();
      broadcast(room, 'game:restart', { round: room.round });
      startTurnTimer(room);
      pushState(room);
    }
  });

  socket.on('chat:send', ({ text } = {}) => {
    const room = rooms.get(socket.data.room);
    if (!room) return;
    const now = Date.now();
    if (now - (socket.data.chatAt || 0) < CHAT_COOLDOWN) return socket.emit('error:msg', 'พิมพ์ถี่เกินไป');
    socket.data.chatAt = now;
    let msg = String(text || '').replace(/\s+/g, ' ').trim().slice(0, CHAT_MAX);
    if (!msg) return;
    BANNED_WORDS.forEach(w => { msg = msg.replace(new RegExp(w, 'gi'), '*'.repeat(w.length)); });
    const p = getProfile(socket.data.playerId);
    broadcast(room, 'chat:msg', { id: p.id, name: p.name, avatar: p.avatar, text: msg, at: now });
  });

  socket.on('emote', ({ id } = {}) => {
    const room = rooms.get(socket.data.room);
    if (!room) return;
    broadcast(room, 'emote', { from: socket.data.playerId, id: String(id || '👍').slice(0, 4) });
  });

  socket.on('room:leave', () => handleLeave(socket, true));

  socket.on('disconnect', () => {
    leaveQueue(socket);
    io.emit('online:count', io.engine.clientsCount);
    const room = rooms.get(socket.data.room);
    if (!room) return;
    const me = room.players.find(p => p.id === socket.data.playerId);
    if (!me) {
      room.spectators = room.spectators.filter(s => s !== socket.data.playerId);
      return;
    }
    me.connected = false;
    broadcast(room, 'opponent:disconnected', { id: me.id, ms: RECONNECT_MS });
    pushState(room);
    me.dcTimer = setTimeout(() => {
      if (!rooms.has(room.code)) return;
      if (!room.over) {
        const opp = room.players.find(p => p.id !== me.id);
        finishGame(room, opp ? opp.symbol : 0, [], 'abandon', me.id);
      }
      broadcast(room, 'opponent:left', { id: me.id });
      if (room.players.every(p => !p.connected)) destroyRoom(room);
    }, RECONNECT_MS);
  });
});

function handleLeave(socket, notify) {
  const room = rooms.get(socket.data.room);
  socket.data.room = null;
  if (!room) return;
  socket.leave('room:' + room.code);
  const me = room.players.find(p => p.id === socket.data.playerId);
  if (!me) {
    room.spectators = room.spectators.filter(s => s !== socket.data.playerId);
    return;
  }
  if (!room.over && room.players.length === 2) {
    const opp = room.players.find(p => p.id !== me.id);
    finishGame(room, opp ? opp.symbol : 0, [], 'leave', me.id);
  }
  room.players = room.players.filter(p => p.id !== me.id);
  if (notify) broadcast(room, 'opponent:left', { id: me.id });
  if (room.players.length === 0) destroyRoom(room); else pushState(room);
}

/* เก็บกวาดห้องร้างทุก 1 นาที */
setInterval(() => {
  const now = Date.now();
  for (const room of rooms.values()) {
    const idle = now - (room.moves.at(-1)?.t || room.createdAt);
    if (room.players.length === 0 || idle > 30 * 60 * 1000) destroyRoom(room);
  }
}, 60000);

server.listen(PORT, HOST, () => console.log(`\n  ⭕❌  XO ARENA พร้อมแล้ว → http://${HOST === '0.0.0.0' ? '0.0.0.0' : HOST}:${PORT}\n`));