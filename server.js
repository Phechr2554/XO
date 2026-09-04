/* ============================================================
 * XO ARENA — Game Server
 * Express + Socket.IO : matchmaking, private room, Elo, chat,
 * turn timer, reconnect grace, leaderboard, persistence
 * ============================================================ */
'use strict';

const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
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
const USERS_FILE = path.join(DATA_DIR, 'users.jsonl');
const PLAYER_DATA_FILE = path.join(DATA_DIR, 'player_data.jsonl');
const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const PASSWORD_MIN = 6;
const USERNAME_RE = /^[A-Za-z0-9ก-๙_]{3,16}$/u;

const TURN_GRACE_MS = 1500;      // เผื่อ latency
const RECONNECT_MS = 30000;      // เวลาให้กลับเข้าเกม
const CHAT_COOLDOWN = 700;
const CHAT_MAX = 200;
const BANNED_WORDS = [];         // เพิ่มคำที่ต้องการกรองได้เอง

/* ---------------- File data ---------------- */
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
for (const file of [USERS_FILE, PLAYER_DATA_FILE]) if (!fs.existsSync(file)) fs.writeFileSync(file, '', 'utf8');

function readJsonLines(file) {
  const out = [];
  try {
    const text = fs.readFileSync(file, 'utf8');
    for (const line of text.split(/\r?\n/)) {
      if (!line.trim()) continue;
      try { out.push(JSON.parse(line)); } catch (e) { console.error('[data] ข้ามบรรทัดเสีย:', file, e.message); }
    }
  } catch (e) { console.error('[data] อ่านไฟล์ไม่ได้:', file, e.message); }
  return out;
}
function writeJsonLines(file, rows) {
  const tmp = file + '.tmp';
  const body = rows.map(x => JSON.stringify(x)).join('\n') + (rows.length ? '\n' : '');
  fs.writeFileSync(tmp, body, 'utf8');
  fs.renameSync(tmp, file);
}

const users = new Map(readJsonLines(USERS_FILE).map(u => [u.id, u]));
const usersByName = new Map(Array.from(users.values()).map(u => [u.name.toLowerCase(), u]));
const playerData = new Map(readJsonLines(PLAYER_DATA_FILE).map(d => [d.id, d]));
const sessions = new Map(); // token -> { userId, expiresAt }
let dataDirty = false;

function markDataDirty() { dataDirty = true; }
function now() { return Date.now(); }
function defaultPlayerData(id) {
  return {
    id, createdAt: now(), lastLogin: 0, avatar: '🐱', elo: 1000, wins: 0, losses: 0, draws: 0, games: 0, streak: 0, best: 0, lastSeen: now(),
    settings: { theme: 'dark', sound: true, volume: 0.5, animations: true, lang: 'th', boardStyle: 'neon', localTimer: 0, confirmMove: false },
    stats: {
      games: 0, wins: 0, losses: 0, draws: 0,
      vsBot: { games: 0, wins: 0, losses: 0, draws: 0, byLevel: {} },
      online: { games: 0, wins: 0, losses: 0, draws: 0 },
      streak: 0, bestStreak: 0, fastestWinMoves: 0, totalMoves: 0, playSeconds: 0,
      perfectGames: 0, comebacks: 0
    },
    achievements: {}, history: []
  };
}
function getPlayerData(id) {
  if (!playerData.has(id)) { playerData.set(id, defaultPlayerData(id)); markDataDirty(); }
  const d = playerData.get(id);
  d.lastSeen = now();
  return d;
}
function saveData() {
  if (!dataDirty) return;
  try {
    writeJsonLines(USERS_FILE, Array.from(users.values()));
    writeJsonLines(PLAYER_DATA_FILE, Array.from(playerData.values()));
    dataDirty = false;
  } catch (e) { console.error('[data] เขียนไม่สำเร็จ:', e.message); }
}
setInterval(saveData, 10000);
['SIGINT', 'SIGTERM'].forEach(sig => process.on(sig, () => { markDataDirty(); saveData(); process.exit(0); }));

function safeUsername(name) { return String(name || '').trim().slice(0, 16); }
function normalizeUsername(name) { return safeUsername(name).toLowerCase(); }
function hashPassword(password, salt = crypto.randomBytes(16).toString('hex')) {
  const N = 16384, r = 8, p = 1;
  const hash = crypto.scryptSync(String(password), salt, 64, { N, r, p }).toString('hex');
  return `scrypt$${N}$${r}$${p}$${salt}$${hash}`;
}
function verifyPassword(password, encoded) {
  try {
    const [algo, n, r, p, salt, expected] = String(encoded).split('$');
    if (algo !== 'scrypt') return false;
    const actual = crypto.scryptSync(String(password), salt, 64, { N: Number(n), r: Number(r), p: Number(p) }).toString('hex');
    return actual.length === expected.length && crypto.timingSafeEqual(Buffer.from(actual), Buffer.from(expected));
  } catch { return false; }
}
function newSession(userId) {
  const token = crypto.randomBytes(32).toString('base64url');
  sessions.set(token, { userId, expiresAt: now() + SESSION_TTL_MS });
  return token;
}
function sessionUser(token) {
  const s = sessions.get(String(token || ''));
  if (!s || s.expiresAt <= now()) { if (s) sessions.delete(token); return null; }
  s.expiresAt = now() + SESSION_TTL_MS;
  return users.get(s.userId) || null;
}
function profileFor(userId) {
  const u = users.get(userId);
  if (!u) return null;
  const d = getPlayerData(userId);
  return { id: u.id, name: u.name, avatar: d.avatar, elo: d.elo, wins: d.wins, losses: d.losses, draws: d.draws, games: d.games, streak: d.streak, best: d.best };
}
function publicPlayerData(userId) {
  const d = getPlayerData(userId);
  return JSON.parse(JSON.stringify(d));
}
function normalizeClientData(userId, patch = {}) {
  const d = getPlayerData(userId);
  if (patch.avatar) d.avatar = String(patch.avatar).slice(0, 4);
  if (patch.settings && typeof patch.settings === 'object') d.settings = { ...d.settings, ...patch.settings };
  if (patch.stats && typeof patch.stats === 'object') d.stats = patch.stats;
  if (patch.achievements && typeof patch.achievements === 'object') d.achievements = patch.achievements;
  if (Array.isArray(patch.history)) d.history = patch.history.slice(0, 50);
  d.lastSeen = now();
  markDataDirty();
  return d;
}
function getProfile(id) {
  return getPlayerData(id);
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
  markDataDirty();
  return { da, db };
}

/* ---------------- App ---------------- */
const app = express();
app.use(express.json({ limit: '256kb' }));
app.use(express.static(path.join(__dirname, 'public'), { etag: true, lastModified: true, maxAge: 0 }));

function authFromRequest(req, res, next) {
  const token = String(req.headers.authorization || '').replace(/^Bearer\s+/i, '').trim();
  const user = sessionUser(token);
  if (!user) return res.status(401).json({ error: 'กรุณาเข้าสู่ระบบก่อน' });
  req.user = user; req.token = token; next();
}

app.post('/api/auth/register', (req, res) => {
  const name = safeUsername(req.body?.name);
  const password = String(req.body?.password || '');
  const key = normalizeUsername(name);
  if (!USERNAME_RE.test(name)) return res.status(400).json({ error: 'ชื่อผู้ใช้ต้องยาว 3–16 ตัว และใช้ตัวอักษร/ตัวเลข/_ เท่านั้น' });
  if (password.length < PASSWORD_MIN) return res.status(400).json({ error: `รหัสผ่านต้องมีอย่างน้อย ${PASSWORD_MIN} ตัว` });
  if (usersByName.has(key)) return res.status(409).json({ error: 'ชื่อผู้ใช้นี้ถูกใช้แล้ว' });
  const id = 'u_' + crypto.randomBytes(10).toString('hex');
  const user = { id, name, passwordHash: hashPassword(password) };
  const d = defaultPlayerData(id); d.lastLogin = now();
  users.set(id, user); usersByName.set(key, user); playerData.set(id, d);
  markDataDirty(); saveData();
  const token = newSession(id);
  res.status(201).json({ token, profile: profileFor(id), data: publicPlayerData(id) });
});

app.post('/api/auth/login', (req, res) => {
  const name = safeUsername(req.body?.name);
  const password = String(req.body?.password || '');
  const user = usersByName.get(normalizeUsername(name));
  if (!user || !verifyPassword(password, user.passwordHash)) return res.status(401).json({ error: 'ชื่อผู้ใช้หรือรหัสผ่านไม่ถูกต้อง' });
  const d = getPlayerData(user.id); d.lastLogin = now(); d.lastSeen = now(); markDataDirty(); saveData();
  const token = newSession(user.id);
  res.json({ token, profile: profileFor(user.id), data: publicPlayerData(user.id) });
});

app.post('/api/auth/logout', authFromRequest, (req, res) => { sessions.delete(req.token); res.json({ ok: true }); });
app.get('/api/auth/me', authFromRequest, (req, res) => res.json({ profile: profileFor(req.user.id), data: publicPlayerData(req.user.id) }));
app.get('/api/health', (_req, res) => res.json({ ok: true, uptime: process.uptime(), rooms: rooms.size, online: io.engine.clientsCount, users: users.size }));

app.get('/api/leaderboard', (_req, res) => {
  const list = Array.from(playerData.values())
    .filter(p => p.games > 0 && users.has(p.id))
    .sort((a, b) => b.elo - a.elo || b.wins - a.wins)
    .slice(0, 50)
    .map((p, i) => ({ rank: i + 1, name: users.get(p.id).name, avatar: p.avatar, elo: p.elo, wins: p.wins, losses: p.losses, draws: p.draws, games: p.games, best: p.best || 0 }));
  res.json({ list, total: users.size });
});

app.get('/api/player/:id', (req, res) => {
  if (!users.has(req.params.id) || !playerData.has(req.params.id)) return res.status(404).json({ error: 'not found' });
  res.json(profileFor(req.params.id));
});

app.get('/api/player/data', authFromRequest, (req, res) => res.json({ data: publicPlayerData(req.user.id) }));
app.post('/api/player/data', authFromRequest, (req, res) => {
  const data = normalizeClientData(req.user.id, req.body || {});
  saveData();
  res.json({ data: publicPlayerData(req.user.id) });
});

const server = http.createServer(app);
const io = new Server(server, { pingTimeout: 20000, transports: ['websocket', 'polling'] });
io.use((socket, next) => {
  const token = socket.handshake.auth?.token;
  const user = sessionUser(token);
  if (!user) return next(new Error('AUTH_REQUIRED'));
  socket.data.user = user;
  socket.data.playerId = user.id;
  next();
});

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
  const p = profileFor(socket.data.playerId);
  return { id: p.id, name: p.name, avatar: p.avatar, symbol, socketId: socket.id, connected: true, dcTimer: null };
}

function leaveSocketRoom(socket, notify = true) {
  const code = socket.data.room;
  if (!code) return;
  handleLeave(socket, notify);
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

  socket.data.chatAt = 0;
  const id = socket.data.playerId;
  const previousSocketId = socketsByPlayer.get(id);
  socketsByPlayer.set(id, socket.id);
  if (previousSocketId && previousSocketId !== socket.id) {
    const previous = io.sockets.sockets.get(previousSocketId);
    if (previous) previous.disconnect(true);
  }
  const profile = profileFor(id);

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
  socket.emit('welcome', { profile, data: publicPlayerData(id), online: io.engine.clientsCount, resumed, presets: E.PRESETS });


  socket.on('queue:join', ({ preset } = {}) => joinQueue(socket, preset));
  socket.on('queue:leave', () => leaveQueue(socket));

  socket.on('room:create', ({ preset, friendly } = {}, ack) => {
    if (socket.data.room) leaveSocketRoom(socket, true);
    leaveQueue(socket);
    const cfg = E.PRESETS[preset] || E.PRESETS.classic;
    const room = createRoom(cfg, true);
    room.friendly = !!friendly;
    room.players = [makePlayer(socket, E.X)];
    socket.data.room = room.code;
    socket.join('room:' + room.code);
    const res = { code: room.code, you: E.X, friendly: room.friendly };
    socket.emit('room:created', res);
    if (typeof ack === 'function') ack(res);
    pushState(room);
  });

  socket.on('room:join', ({ code } = {}, ack) => {
    const normalized = String(code || '').toUpperCase().replace(/[^A-Z2-9]/g, '').slice(0, 5);
    const room = rooms.get(normalized);
    const fail = (msg) => { socket.emit('error:msg', msg); if (typeof ack === 'function') ack({ error: msg }); };
    if (!/^[A-Z2-9]{5}$/.test(normalized)) return fail('รหัสห้องต้องมี 5 ตัวอักษร');
    if (!room) return fail('ไม่พบห้องนี้ หรือห้องถูกปิดไปแล้ว');

    if (socket.data.room && socket.data.room !== room.code) leaveSocketRoom(socket, true);
    leaveQueue(socket);

    const already = room.players.find(p => p.id === socket.data.playerId);
    if (already) {
      clearTimeout(already.dcTimer);
      already.connected = true; already.socketId = socket.id;
    } else if (room.players.length >= 2) {
      if (!room.spectators.includes(socket.data.playerId)) room.spectators.push(socket.data.playerId);
      socket.data.room = room.code;
      socket.join('room:' + room.code);
      socket.emit('room:spectate', { code: room.code });
      pushState(room);
      if (typeof ack === 'function') ack({ spectator: true, code: room.code });
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
    const p = profileFor(socket.data.playerId);
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
    if (socketsByPlayer.get(socket.data.playerId) === socket.id) socketsByPlayer.delete(socket.data.playerId);
    else return; // เป็น socket เก่าที่ถูกแทนที่ด้วยการเชื่อมต่อใหม่
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
  clearTimeout(me.dcTimer);
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