/* ============================================================
 * XO ARENA — Game Server
 * Express + Socket.IO + account auth + split JSONL persistence
 * ============================================================ */
'use strict';

const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const http = require('http');
const express = require('express');
const { Server } = require('socket.io');
const E = require('./public/js/engine.js');

const PORT = Number(process.env.PORT || process.env.SERVER_PORT || process.env.APP_PORT || 25118);
const HOST = process.env.HOST || '0.0.0.0';
const DATA_DIR = path.join(__dirname, 'data');
const ACCOUNTS_FILE = path.join(DATA_DIR, 'accounts.jsonl');
const DATA_FILE = path.join(DATA_DIR, 'data.jsonl');
const COOKIE_NAME = 'xo_session';
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const TURN_GRACE_MS = 1500;
const RECONNECT_MS = 30000;
const CHAT_COOLDOWN = 700;
const CHAT_MAX = 200;
const BANNED_WORDS = [];

if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

const DEFAULT_DATA = () => ({
  id: '', name: '', avatar: '🐱', elo: 1000, wins: 0, losses: 0, draws: 0, games: 0,
  streak: 0, best: 0, settings: {}, stats: {}, achievements: {}, history: [], lastSeen: 0
});

function readJsonl(file) {
  const map = new Map();
  if (!fs.existsSync(file)) return map;
  try {
    for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
      if (!line.trim()) continue;
      const item = JSON.parse(line);
      const id = String(item.id || '');
      if (id) map.set(id, item);
    }
  } catch (e) {
    console.error(`[db] อ่าน ${path.basename(file)} ไม่สำเร็จ:`, e.message);
  }
  return map;
}

let ACCOUNTS = readJsonl(ACCOUNTS_FILE);
let DATA = readJsonl(DATA_FILE);
let dirtyAccounts = false;
let dirtyData = false;

function atomicWriteJsonl(file, map) {
  const tmp = file + '.tmp';
  const body = [...map.values()].map(v => JSON.stringify(v)).join('\n') + (map.size ? '\n' : '');
  fs.writeFileSync(tmp, body, 'utf8');
  fs.renameSync(tmp, file);
}
function saveData() {
  try {
    if (dirtyAccounts) { atomicWriteJsonl(ACCOUNTS_FILE, ACCOUNTS); dirtyAccounts = false; }
    if (dirtyData) { atomicWriteJsonl(DATA_FILE, DATA); dirtyData = false; }
  } catch (e) { console.error('[db] เขียนข้อมูลไม่สำเร็จ:', e.message); }
}
setInterval(saveData, 5000);
['SIGINT', 'SIGTERM'].forEach(sig => process.on(sig, () => { dirtyAccounts = true; dirtyData = true; saveData(); process.exit(0); }));

function migrateLegacy() {
  const legacy = path.join(DATA_DIR, 'db.json');
  if (!fs.existsSync(legacy) || DATA.size) return;
  try {
    const db = JSON.parse(fs.readFileSync(legacy, 'utf8'));
    for (const p of Object.values(db.players || {})) {
      const id = String(p.id || crypto.randomUUID());
      DATA.set(id, { ...DEFAULT_DATA(), ...p, id, name: String(p.name || 'ผู้เล่น').slice(0, 16) });
    }
    dirtyData = DATA.size > 0;
    console.log(`[db] migrated ${DATA.size} legacy player profiles to data.jsonl`);
  } catch (e) { console.error('[db] migrate legacy ไม่สำเร็จ:', e.message); }
}
migrateLegacy();

function cloneProfile(p) {
  return {
    id: p.id, name: p.name, avatar: p.avatar, elo: Number(p.elo || 1000),
    wins: Number(p.wins || 0), losses: Number(p.losses || 0), draws: Number(p.draws || 0),
    games: Number(p.games || 0), streak: Number(p.streak || 0), best: Number(p.best || 0),
    settings: p.settings || {}, stats: p.stats || {}, achievements: p.achievements || {},
    history: Array.isArray(p.history) ? p.history.slice(0, 50) : [], lastSeen: p.lastSeen || 0
  };
}
function getProfile(id) {
  if (!DATA.has(id)) {
    const p = DEFAULT_DATA(); p.id = id; p.name = 'ผู้เล่น'; p.lastSeen = Date.now();
    DATA.set(id, p); dirtyData = true;
  }
  const p = DATA.get(id);
  p.lastSeen = Date.now();
  dirtyData = true;
  return p;
}
function publicProfile(p) { return cloneProfile(p); }

// Passwords are never stored as plain text. One account = one vertical JSONL row.
function hashPassword(password, salt = crypto.randomBytes(16).toString('hex')) {
  const hash = crypto.scryptSync(password, salt, 64).toString('hex');
  return `scrypt$${salt}$${hash}`;
}
function verifyPassword(password, encoded) {
  const [, salt, stored] = String(encoded || '').split('$');
  if (!salt || !stored) return false;
  const actual = crypto.scryptSync(password, salt, 64).toString('hex');
  try { return crypto.timingSafeEqual(Buffer.from(actual, 'hex'), Buffer.from(stored, 'hex')); }
  catch { return false; }
}
function normalizeName(name) { return String(name || '').trim().replace(/\s+/g, ' ').slice(0, 16); }
function validateCredentials(name, password) {
  if (!/^[\p{L}\p{N}_-]{3,16}$/u.test(name)) return 'ชื่อผู้ใช้ต้องมี 3–16 ตัว และใช้ตัวอักษร ตัวเลข _ หรือ -';
  if (String(password || '').length < 6 || String(password || '').length > 128) return 'รหัสผ่านต้องมี 6–128 ตัวอักษร';
  return null;
}
function parseCookies(header) {
  const out = {};
  for (const part of String(header || '').split(';')) {
    const i = part.indexOf('=');
    if (i > -1) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1));
  }
  return out;
}
function setSession(res, id) {
  const token = crypto.randomBytes(32).toString('base64url');
  sessions.set(token, { id, expires: Date.now() + SESSION_TTL_MS });
  res.setHeader('Set-Cookie', `${COOKIE_NAME}=${encodeURIComponent(token)}; HttpOnly; Path=/; SameSite=Lax; Max-Age=${Math.floor(SESSION_TTL_MS / 1000)}`);
}
const sessions = new Map();
function sessionFromRequest(req) {
  const token = parseCookies(req.headers.cookie)[COOKIE_NAME];
  const s = token && sessions.get(token);
  if (!s || s.expires < Date.now()) { if (token) sessions.delete(token); return null; }
  return s;
}
function authRequired(req, res, next) {
  const session = sessionFromRequest(req);
  if (!session) return res.status(401).json({ error: 'กรุณาเข้าสู่ระบบ' });
  req.userId = session.id; next();
}

/* ---------------- Elo ---------------- */
function kFactor(games, elo) { if (games < 15) return 40; if (elo >= 1800) return 16; return 24; }
function applyElo(a, b, resultA) {
  const ea = 1 / (1 + Math.pow(10, (b.elo - a.elo) / 400));
  const eb = 1 - ea;
  const da = Math.round(kFactor(a.games, a.elo) * (resultA - ea));
  const db = Math.round(kFactor(b.games, b.elo) * ((1 - resultA) - eb));
  a.elo = Math.max(100, a.elo + da); b.elo = Math.max(100, b.elo + db);
  a.games++; b.games++;
  if (resultA === 1) { a.wins++; b.losses++; a.streak++; b.streak = 0; }
  else if (resultA === 0) { b.wins++; a.losses++; b.streak++; a.streak = 0; }
  else { a.draws++; b.draws++; }
  a.best = Math.max(a.best || 0, a.streak); b.best = Math.max(b.best || 0, b.streak);
  dirtyData = true;
  return { da, db };
}

/* ---------------- App ---------------- */
const app = express();
app.use(express.json({ limit: '256kb' }));
app.use(express.static(path.join(__dirname, 'public'), { etag: true, lastModified: true, maxAge: 0 }));

app.get('/api/health', (_req, res) => res.json({ ok: true, uptime: process.uptime(), rooms: rooms.size, online: io.engine.clientsCount, users: DATA.size }));

app.post('/api/register', (req, res) => {
  const name = normalizeName(req.body?.name);
  const password = String(req.body?.password || '');
  const problem = validateCredentials(name, password);
  if (problem) return res.status(400).json({ error: problem });
  const key = name.toLocaleLowerCase('th');
  if ([...ACCOUNTS.values()].some(a => String(a.name).toLocaleLowerCase('th') === key)) return res.status(409).json({ error: 'ชื่อนี้ถูกใช้แล้ว' });
  const id = crypto.randomUUID();
  ACCOUNTS.set(id, { id, name, passwordHash: hashPassword(password), createdAt: Date.now() });
  DATA.set(id, { ...DEFAULT_DATA(), id, name, lastSeen: Date.now() });
  dirtyAccounts = dirtyData = true;
  setSession(res, id);
  res.status(201).json({ ok: true, profile: publicProfile(getProfile(id)) });
});

app.post('/api/login', (req, res) => {
  const name = normalizeName(req.body?.name);
  const password = String(req.body?.password || '');
  const account = [...ACCOUNTS.values()].find(a => String(a.name).toLocaleLowerCase('th') === name.toLocaleLowerCase('th'));
  if (!account || !verifyPassword(password, account.passwordHash)) return res.status(401).json({ error: 'ชื่อผู้ใช้หรือรหัสผ่านไม่ถูกต้อง' });
  setSession(res, account.id);
  res.json({ ok: true, profile: publicProfile(getProfile(account.id)) });
});

app.post('/api/logout', (req, res) => {
  const token = parseCookies(req.headers.cookie)[COOKIE_NAME];
  if (token) sessions.delete(token);
  res.setHeader('Set-Cookie', `${COOKIE_NAME}=; HttpOnly; Path=/; SameSite=Lax; Max-Age=0`);
  res.json({ ok: true });
});

app.get('/api/me', authRequired, (req, res) => res.json({ authenticated: true, profile: publicProfile(getProfile(req.userId)) }));
app.put('/api/me', authRequired, (req, res) => {
  const p = getProfile(req.userId);
  if (req.body && Object.prototype.hasOwnProperty.call(req.body, 'name')) {
    const next = normalizeName(req.body.name);
    const problem = validateCredentials(next, '123456');
    if (problem && !/รหัสผ่าน/.test(problem)) return res.status(400).json({ error: problem });
    const owner = [...ACCOUNTS.values()].find(a => a.id === p.id);
    const duplicate = [...ACCOUNTS.values()].some(a => a.id !== p.id && a.name.toLocaleLowerCase('th') === next.toLocaleLowerCase('th'));
    if (duplicate) return res.status(409).json({ error: 'ชื่อนี้ถูกใช้แล้ว' });
    if (owner) owner.name = next;
    p.name = next; dirtyAccounts = dirtyData = true;
  }
  if (req.body && typeof req.body.avatar === 'string') p.avatar = req.body.avatar.slice(0, 4);
  if (req.body && req.body.settings && typeof req.body.settings === 'object') p.settings = req.body.settings;
  if (req.body && req.body.stats && typeof req.body.stats === 'object') p.stats = req.body.stats;
  if (req.body && req.body.achievements && typeof req.body.achievements === 'object') p.achievements = req.body.achievements;
  if (req.body && Array.isArray(req.body.history)) p.history = req.body.history.slice(0, 50);
  dirtyData = true;
  res.json({ ok: true, profile: publicProfile(p) });
});

app.get('/api/leaderboard', (_req, res) => {
  const list = [...DATA.values()].filter(p => p.games > 0).sort((a, b) => b.elo - a.elo || b.wins - a.wins).slice(0, 50)
    .map((p, i) => ({ rank: i + 1, id: p.id, name: p.name, avatar: p.avatar, elo: p.elo, wins: p.wins, losses: p.losses, draws: p.draws, games: p.games, best: p.best || 0 }));
  res.json({ list, total: DATA.size });
});
app.get('/api/player/:id', (req, res) => {
  const p = DATA.get(req.params.id);
  if (!p) return res.status(404).json({ error: 'not found' });
  res.json(publicProfile(p));
});

const server = http.createServer(app);
const io = new Server(server, { pingTimeout: 20000, transports: ['websocket', 'polling'] });

/* ---------------- State ---------------- */
const rooms = new Map();
const queues = new Map();
const socketsByPlayer = new Map();
const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
function newCode() {
  let code;
  do code = Array.from({ length: 5 }, () => CODE_ALPHABET[Math.floor(Math.random() * CODE_ALPHABET.length)]).join(''); while (rooms.has(code));
  return code;
}
function createRoom(preset, isPrivate) {
  const code = newCode();
  const room = { code, preset, private: !!isPrivate, friendly: false, size: preset.size, winLen: preset.winLen, turnMs: preset.turnMs,
    board: E.create(preset.size), turn: E.X, players: [], spectators: [], moves: [], over: false, winner: 0, line: [], scores: {}, rematch: new Set(), round: 1, turnDeadline: 0, timer: null, createdAt: Date.now() };
  rooms.set(code, room); return room;
}
function destroyRoom(room) { if (!room) return; clearTimeout(room.timer); room.players.forEach(p => clearTimeout(p.dcTimer)); rooms.delete(room.code); }
function publicState(room) {
  return { code: room.code, presetId: room.preset.id, size: room.size, winLen: room.winLen, board: room.board, turn: room.turn, over: room.over, winner: room.winner, line: room.line, round: room.round, moves: room.moves, turnMs: room.turnMs, turnDeadline: room.turnDeadline, serverNow: Date.now(), scores: room.scores,
    players: room.players.map(p => ({ id: p.id, name: p.name, avatar: p.avatar, symbol: p.symbol, elo: getProfile(p.id).elo, connected: p.connected, rematch: room.rematch.has(p.id) })) };
}
function broadcast(room, event, payload) { io.to('room:' + room.code).emit(event, payload); }
function pushState(room) { broadcast(room, 'game:state', publicState(room)); }
function playerInRoom(room, id) { return room.players.find(p => p.id === id); }

function startTurnTimer(room) {
  clearTimeout(room.timer);
  if (room.over || room.players.length !== 2) { room.turnDeadline = 0; return; }
  room.turnDeadline = Date.now() + room.turnMs;
  room.timer = setTimeout(() => {
    if (room.over || room.players.length !== 2) return;
    const loser = room.players.find(p => p.symbol === room.turn);
    const winner = room.players.find(p => p.symbol !== room.turn);
    finishGame(room, winner ? winner.symbol : 0, [], 'timeout', loser?.id);
  }, room.turnMs + TURN_GRACE_MS);
}
function finishGame(room, winnerSymbol, line, reason, loserId) {
  if (room.over) return;
  clearTimeout(room.timer); room.turnDeadline = 0; room.over = true; room.winner = winnerSymbol; room.line = line || [];
  const result = { reason, winner: winnerSymbol, line: room.line, delta: {} };
  if (room.players.length === 2 && !room.friendly) {
    const [a, b] = room.players.map(p => getProfile(p.id));
    const ra = winnerSymbol ? (room.players[0].symbol === winnerSymbol ? 1 : 0) : 0.5;
    const { da, db } = applyElo(a, b, ra); result.delta[a.id] = da; result.delta[b.id] = db; result.elo = { [a.id]: a.elo, [b.id]: b.elo };
  }
  if (winnerSymbol) room.scores[winnerSymbol] = (room.scores[winnerSymbol] || 0) + 1; else room.scores.draw = (room.scores.draw || 0) + 1;
  room.rematch.clear(); pushState(room); broadcast(room, 'game:over', result);
}

function leaveQueue(socket) {
  const presetId = socket.data.queue;
  if (!presetId) return;
  const q = (queues.get(presetId) || []).filter(e => e.socketId !== socket.id);
  queues.set(presetId, q); socket.data.queue = null;
  socket.emit('queue:status', { inQueue: false });
}
function joinQueue(socket, presetId) {
  const preset = E.PRESETS[presetId] || E.PRESETS.classic; leaveQueue(socket);
  const q = queues.get(preset.id) || []; const meId = socket.data.playerId;
  if (!meId) return socket.emit('error:msg', 'ยังไม่ได้ยืนยันตัวตน');
  const me = { socketId: socket.id, playerId: meId, elo: getProfile(meId).elo, at: Date.now() };
  let bestIdx = -1, bestDiff = Infinity;
  q.forEach((e, i) => {
    if (e.playerId === me.playerId || !io.sockets.sockets.get(e.socketId)) return;
    const diff = Math.abs(e.elo - me.elo); const range = 120 + ((Date.now() - e.at) / 1000) * 40;
    if (diff <= range && diff < bestDiff) { bestDiff = diff; bestIdx = i; }
  });
  if (bestIdx >= 0) {
    const other = q.splice(bestIdx, 1)[0]; queues.set(preset.id, q);
    const otherSock = io.sockets.sockets.get(other.socketId);
    if (otherSock) return startMatch(otherSock, socket, preset);
  }
  q.push(me); queues.set(preset.id, q); socket.data.queue = preset.id; socket.emit('queue:status', { inQueue: true, preset: preset.id, size: q.length });
}
function makePlayer(socket, symbol) {
  const p = getProfile(socket.data.playerId);
  return { id: p.id, name: p.name, avatar: p.avatar, symbol, socketId: socket.id, connected: true, dcTimer: null };
}
function removeDuplicateQueueEntries(playerId) {
  for (const [presetId, q] of queues) { const next = q.filter(e => e.playerId !== playerId); queues.set(presetId, next); }
}
function startMatch(sockA, sockB, preset) {
  removeDuplicateQueueEntries(sockA.data.playerId); removeDuplicateQueueEntries(sockB.data.playerId);
  if (sockA.data.room || sockB.data.room) return;
  const room = createRoom(preset, false); const a = makePlayer(sockA, E.X), b = makePlayer(sockB, E.O);
  room.players = Math.random() < 0.5 ? [a, b] : [b, a];
  for (const s of [sockA, sockB]) { s.data.queue = null; s.data.room = room.code; s.join('room:' + room.code); s.emit('match:found', { code: room.code, you: playerInRoom(room, s.data.playerId).symbol }); }
  startTurnTimer(room); pushState(room);
}

/* ---------------- Socket auth ---------------- */
io.on('connection', socket => {
  io.emit('online:count', io.engine.clientsCount);
  socket.on('hello', (_payload = {}, ack) => {
    const token = parseCookies(socket.handshake.headers.cookie)[COOKIE_NAME];
    const session = token && sessions.get(token);
    if (!session || session.expires < Date.now()) { socket.emit('auth:required'); return typeof ack === 'function' && ack({ error: 'auth' }); }
    socket.data.superseded = false;
    const oldSocketId = socketsByPlayer.get(session.id);
    if (oldSocketId && oldSocketId !== socket.id) {
      const oldSocket = io.sockets.sockets.get(oldSocketId);
      if (oldSocket) { oldSocket.data.superseded = true; oldSocket.disconnect(true); }
    }
    socket.data.playerId = session.id; socket.data.chatAt = 0; socketsByPlayer.set(session.id, socket.id);
    const profile = getProfile(session.id);
    let resumed = null;
    for (const room of rooms.values()) {
      const p = playerInRoom(room, session.id);
      if (!p) continue;
      clearTimeout(p.dcTimer); p.connected = true; p.socketId = socket.id; socket.data.room = room.code; socket.join('room:' + room.code);
      broadcast(room, 'opponent:reconnected', { id: session.id }); pushState(room); resumed = { code: room.code, you: p.symbol }; break;
    }
    const out = { profile: publicProfile(profile), online: io.engine.clientsCount, resumed, presets: E.PRESETS };
    socket.emit('welcome', out); if (typeof ack === 'function') ack(out);
  });

  socket.on('queue:join', ({ preset } = {}) => joinQueue(socket, preset));
  socket.on('queue:leave', () => leaveQueue(socket));

  socket.on('room:create', ({ preset, friendly } = {}, ack) => {
    const fail = msg => { socket.emit('error:msg', msg); if (typeof ack === 'function') ack({ error: msg }); };
    if (!socket.data.playerId) return fail('กรุณาเข้าสู่ระบบก่อน');
    if (socket.data.room) return fail('คุณอยู่ในห้องอื่นอยู่แล้ว');
    const cfg = E.PRESETS[preset] || E.PRESETS.classic; const room = createRoom(cfg, true); room.friendly = !!friendly; room.players = [makePlayer(socket, E.X)];
    socket.data.room = room.code; socket.join('room:' + room.code); const res = { code: room.code, you: E.X, friendly: room.friendly };
    socket.emit('room:created', res); if (typeof ack === 'function') ack(res); pushState(room);
  });

  socket.on('room:join', ({ code } = {}, ack) => {
    const normalized = String(code || '').toUpperCase().trim();
    const room = rooms.get(normalized);
    const fail = msg => { socket.emit('error:msg', msg); if (typeof ack === 'function') ack({ error: msg }); };
    if (!socket.data.playerId) return fail('กรุณาเข้าสู่ระบบก่อน');
    if (!room) return fail('ไม่พบห้องนี้ หรือห้องถูกปิดไปแล้ว');
    if (socket.data.room && socket.data.room !== room.code) return fail('คุณอยู่ในห้องอื่นอยู่แล้ว');
    const already = playerInRoom(room, socket.data.playerId);
    if (already) {
      clearTimeout(already.dcTimer); already.connected = true; already.socketId = socket.id;
    } else if (room.players.length >= 2) {
      if (!room.private) return fail('ห้องนี้ไม่รับผู้ชม');
      if (!room.spectators.includes(socket.data.playerId)) room.spectators.push(socket.data.playerId);
      socket.data.room = room.code; socket.join('room:' + room.code); socket.emit('room:spectate', { code: room.code }); pushState(room);
      if (typeof ack === 'function') ack({ spectator: true }); return;
    } else {
      room.players.push(makePlayer(socket, E.O));
    }
    socket.data.room = room.code; socket.join('room:' + room.code);
    const me = playerInRoom(room, socket.data.playerId); socket.emit('match:found', { code: room.code, you: me.symbol });
    broadcast(room, 'room:player-joined', { code: room.code, id: me.id });
    if (room.players.length === 2 && !room.over) startTurnTimer(room); pushState(room);
    if (typeof ack === 'function') ack({ code: room.code, you: me.symbol });
  });

  socket.on('game:move', ({ index } = {}) => {
    const room = rooms.get(socket.data.room); if (!room || room.over) return;
    const me = playerInRoom(room, socket.data.playerId);
    if (!me) return socket.emit('error:msg', 'คุณเป็นผู้ชม ไม่สามารถเดินได้');
    if (room.players.length !== 2) return socket.emit('error:msg', 'รอคู่แข่งเข้าห้องก่อน');
    if (me.symbol !== room.turn) return socket.emit('error:msg', 'ยังไม่ถึงตาคุณ');
    const i = Number(index); if (!Number.isInteger(i) || i < 0 || i >= room.board.length) return;
    if (room.board[i] !== E.EMPTY) return socket.emit('error:msg', 'ช่องนี้ถูกใช้แล้ว');
    room.board[i] = me.symbol; room.moves.push({ i, s: me.symbol, t: Date.now() });
    const st = E.status(room.board, room.size, room.winLen, i); if (st.over) return finishGame(room, st.winner, st.line, st.draw ? 'draw' : 'line');
    room.turn = E.other(room.turn); startTurnTimer(room); pushState(room);
  });

  socket.on('game:resign', () => {
    const room = rooms.get(socket.data.room); if (!room || room.over) return; const me = playerInRoom(room, socket.data.playerId); if (!me) return;
    const opp = room.players.find(p => p.id !== me.id); finishGame(room, opp ? opp.symbol : 0, [], 'resign', me.id);
  });
  socket.on('game:rematch', () => {
    const room = rooms.get(socket.data.room); if (!room || !room.over) return; const me = playerInRoom(room, socket.data.playerId); if (!me) return;
    room.rematch.add(me.id); pushState(room);
    if (room.rematch.size >= 2 && room.players.length === 2) {
      room.board = E.create(room.size); room.moves = []; room.over = false; room.winner = 0; room.line = []; room.round++; room.players.forEach(p => { p.symbol = E.other(p.symbol); }); room.turn = E.X; room.rematch.clear(); broadcast(room, 'game:restart', { round: room.round }); startTurnTimer(room); pushState(room);
    }
  });
  socket.on('chat:send', ({ text } = {}) => {
    const room = rooms.get(socket.data.room); if (!room || !socket.data.playerId) return;
    const now = Date.now(); if (now - (socket.data.chatAt || 0) < CHAT_COOLDOWN) return socket.emit('error:msg', 'พิมพ์ถี่เกินไป'); socket.data.chatAt = now;
    let msg = String(text || '').replace(/\s+/g, ' ').trim().slice(0, CHAT_MAX); if (!msg) return; BANNED_WORDS.forEach(w => { msg = msg.replace(new RegExp(w, 'gi'), '*'.repeat(w.length)); });
    const p = getProfile(socket.data.playerId); broadcast(room, 'chat:msg', { id: p.id, name: p.name, avatar: p.avatar, text: msg, at: now });
  });
  socket.on('emote', ({ id } = {}) => { const room = rooms.get(socket.data.room); if (!room) return; broadcast(room, 'emote', { from: socket.data.playerId, id: String(id || '👍').slice(0, 4) }); });
  socket.on('room:leave', () => handleLeave(socket, true));

  socket.on('disconnect', () => {
    leaveQueue(socket); io.emit('online:count', io.engine.clientsCount);
    if (socketsByPlayer.get(socket.data.playerId) === socket.id) socketsByPlayer.delete(socket.data.playerId);
    if (socket.data.superseded) return;
    const room = rooms.get(socket.data.room); if (!room) return;
    const me = playerInRoom(room, socket.data.playerId); if (!me) { room.spectators = room.spectators.filter(id => id !== socket.data.playerId); return; }
    me.connected = false; broadcast(room, 'opponent:disconnected', { id: me.id, ms: RECONNECT_MS }); pushState(room);
    clearTimeout(me.dcTimer); me.dcTimer = setTimeout(() => {
      if (!rooms.has(room.code)) return;
      const current = playerInRoom(room, me.id); if (!current || current.connected) return;
      if (!room.over) { const opp = room.players.find(p => p.id !== me.id); finishGame(room, opp ? opp.symbol : 0, [], 'abandon', me.id); }
      broadcast(room, 'opponent:left', { id: me.id }); if (room.players.every(p => !p.connected)) destroyRoom(room);
    }, RECONNECT_MS);
  });
});

function handleLeave(socket, notify) {
  const code = socket.data.room; socket.data.room = null; const room = rooms.get(code); if (!room) return; socket.leave('room:' + room.code);
  const me = playerInRoom(room, socket.data.playerId); if (!me) { room.spectators = room.spectators.filter(id => id !== socket.data.playerId); return; }
  clearTimeout(me.dcTimer);
  if (!room.over && room.players.length === 2) { const opp = room.players.find(p => p.id !== me.id); finishGame(room, opp ? opp.symbol : 0, [], 'leave', me.id); }
  room.players = room.players.filter(p => p.id !== me.id); room.rematch.delete(me.id); room.spectators = room.spectators.filter(id => id !== me.id);
  if (notify) broadcast(room, 'opponent:left', { id: me.id });
  if (room.players.length === 0) destroyRoom(room); else pushState(room);
}

setInterval(() => {
  const now = Date.now();
  for (const room of rooms.values()) {
    const idle = now - (room.moves.at(-1)?.t || room.createdAt);
    if (room.players.length === 0 || idle > 30 * 60 * 1000) destroyRoom(room);
  }
  for (const [token, s] of sessions) if (s.expires < now) sessions.delete(token);
}, 60000);

server.listen(PORT, HOST, () => console.log(`\n  ⭕❌  XO ARENA พร้อมแล้ว → http://${HOST === '0.0.0.0' ? '0.0.0.0' : HOST}:${PORT}\n`));
