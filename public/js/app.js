/* ============================================================
 * XO ARENA — Application Controller
 * โหมด: bot / local / online (quickmatch + private room)
 * ============================================================ */
(function () {
  'use strict';
  const { $, $$, t, show, toast, modal, renderBoard, fmtTime, esc } = UI;
  const E = window.XOEngine, Bot = window.XOBot, Store = window.XOStore, A = window.XOAudio, Net = window.XONet;

  const AVATARS = ['🐱', '🐶', '🦊', '🐼', '🐯', '🦁', '🐸', '🐵', '🦄', '🐧', '🦉', '🐲', '👾', '🤖', '👻', '🎃', '⚡', '🔥', '🌟', '💎'];
  const EMOTES = ['👍', '😂', '😮', '😭', '🔥', '🤝', '🎉', '🧠', '😴', '🫡'];

  const S = Store.load();

  /* ---------------- Game state ---------------- */
  const G = {
    mode: 'bot', level: 'hard', presetId: 'classic',
    size: 3, winLen: 3, board: [], turn: E.X, mySymbol: E.X,
    over: false, winner: 0, line: [], last: -1, history: [],
    startedAt: 0, thinking: false, hintCell: -1,
    room: null, players: [], scores: {}, deadline: 0, drift: 0,
    firstChoice: 'x', localTimerLeft: 0, oppLeft: false
  };
  let tickTimer = null;

  /* ---------------- Boot ---------------- */
  function boot() {
    applySettings();
    UI.setLang(S.settings.lang);
    renderProfile();
    bindUI();
    setupNet();
    renderAvatarPicker();
    renderPresetChips();
    renderDifficultyChips();
    show('home');
    if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js').catch(() => {});
  }

  function applySettings() {
    document.documentElement.dataset.theme = S.settings.theme;
    document.documentElement.dataset.anim = S.settings.animations ? 'on' : 'off';
    document.documentElement.dataset.style = S.settings.boardStyle;
    A.setEnabled(S.settings.sound);
    A.setVolume(S.settings.volume);
    $('#btnSound').textContent = S.settings.sound ? '🔊' : '🔇';
    $('#btnTheme').textContent = S.settings.theme === 'dark' ? '🌙' : '☀️';
    $('#btnLang').textContent = S.settings.lang.toUpperCase();
  }

  function renderProfile() {
    $('#myAvatar').textContent = S.profile.avatar;
    $('#myName').value = S.profile.name;
    $('#myElo').textContent = S.profile.elo ? `${S.profile.elo} Elo` : '— Elo';
    $('#miniAvatar').textContent = S.profile.avatar;
  }

  function renderAvatarPicker() {
    const wrap = $('#avatarPicker');
    wrap.innerHTML = '';
    AVATARS.forEach(a => {
      const b = document.createElement('button');
      b.className = 'avatar-opt' + (a === S.profile.avatar ? ' sel' : '');
      b.textContent = a;
      b.onclick = () => {
        Store.setProfile({ avatar: a });
        $$('.avatar-opt').forEach(x => x.classList.remove('sel'));
        b.classList.add('sel');
        renderProfile(); A.play('click');
        Net.emit('hello', { playerId: S.profile.id, name: S.profile.name, avatar: a });
      };
      wrap.appendChild(b);
    });
  }

  function renderPresetChips() {
    const wrap = $('#presetRow');
    wrap.innerHTML = '';
    Object.values(E.PRESETS).forEach(p => {
      const b = document.createElement('button');
      b.className = 'chip' + (p.id === G.presetId ? ' sel' : '');
      b.innerHTML = `<strong>${p.label}</strong><span>${p.desc}</span>`;
      b.onclick = () => { G.presetId = p.id; renderPresetChips(); A.play('click'); };
      wrap.appendChild(b);
    });
  }

  function renderDifficultyChips() {
    const wrap = $('#difficultyRow');
    wrap.innerHTML = '';
    Object.entries(Bot.LEVELS).forEach(([k, v]) => {
      const b = document.createElement('button');
      b.className = 'chip' + (k === G.level ? ' sel' : '');
      b.innerHTML = `<strong>${v.label}</strong>`;
      b.onclick = () => { G.level = k; renderDifficultyChips(); A.play('click'); };
      wrap.appendChild(b);
    });
  }

  /* ---------------- UI bindings ---------------- */
  function bindUI() {
    document.body.addEventListener('pointerdown', () => A.unlock(), { once: true });

    $('#myName').addEventListener('change', (e) => {
      const n = e.target.value.trim().slice(0, 16) || 'ผู้เล่น';
      Store.setProfile({ name: n }); e.target.value = n;
      Net.emit('hello', { playerId: S.profile.id, name: n, avatar: S.profile.avatar });
      toast('บันทึกชื่อแล้ว', 'ok');
    });

    $('#btnTheme').onclick = () => { Store.setSetting('theme', S.settings.theme === 'dark' ? 'light' : 'dark'); applySettings(); A.play('click'); };
    $('#btnSound').onclick = () => { Store.setSetting('sound', !S.settings.sound); applySettings(); A.play('click'); };
    $('#btnLang').onclick = () => { Store.setSetting('lang', S.settings.lang === 'th' ? 'en' : 'th'); applySettings(); UI.setLang(S.settings.lang); };

    $('#btnBot').onclick = () => openSetup('bot');
    $('#btnLocal').onclick = () => openSetup('local');
    $('#btnOnline').onclick = () => openSetup('online');
    $('#btnCreateRoom').onclick = () => openSetup('room');
    $('#btnJoinRoom').onclick = joinByCode;
    $('#btnStats').onclick = () => { renderStats(); show('stats'); };
    $('#btnLeaderboard').onclick = () => { loadLeaderboard(); show('leaderboard'); };
    $('#btnSettings').onclick = () => { renderSettings(); show('settings'); };

    $$('[data-back]').forEach(b => b.onclick = () => { A.play('click'); show('home'); });
    $('#btnStartSetup').onclick = startFromSetup;
    $('#btnLobbyCancel').onclick = cancelLobby;
    $('#btnCopyCode').onclick = copyCode;
    $('#btnShareCode').onclick = shareCode;

    $('#board').addEventListener('click', (e) => {
      const cell = e.target.closest('.cell');
      if (cell) onCellClick(Number(cell.dataset.i));
    });

    $('#btnHint').onclick = doHint;
    $('#btnUndo').onclick = doUndo;
    $('#btnResign').onclick = doResign;
    $('#btnRematch').onclick = doRematch;
    $('#btnLeaveGame').onclick = leaveGame;

    $('#btnChatSend').onclick = sendChat;
    $('#chatInput').addEventListener('keydown', e => { if (e.key === 'Enter') sendChat(); });
    const er = $('#emoteRow');
    EMOTES.forEach(em => {
      const b = document.createElement('button');
      b.className = 'emote'; b.textContent = em;
      b.onclick = () => { Net.emit('emote', { id: em }); A.play('click'); };
      er.appendChild(b);
    });

    $('#btnResetData').onclick = async () => {
      const ok = await modal({ title: 'ล้างข้อมูลทั้งหมด?', body: '<p>สถิติ ความสำเร็จ และการตั้งค่าจะถูกลบถาวร</p>', actions: [{ label: 'ยกเลิก', value: false }, { label: 'ลบเลย', variant: 'danger', value: true }] });
      if (ok) { Store.resetAll(); location.reload(); }
    };
    $('#btnRefreshLb').onclick = loadLeaderboard;

    document.addEventListener('keydown', (e) => {
      if (UI.current !== 'game' || G.over) return;
      if (e.key === 'h') doHint();
      if (e.key === 'u' && G.mode !== 'online') doUndo();
      if (e.key === 'Escape') leaveGame();
      const n = Number(e.key);
      if (G.size === 3 && n >= 1 && n <= 9) onCellClick(n - 1);
    });
  }

  /* ---------------- Setup ---------------- */
  let pendingMode = 'bot';
  function openSetup(mode) {
    pendingMode = mode;
    A.play('click');
    $('#setupTitle').textContent = { bot: '🤖 เล่นกับบอท', local: '👥 เล่น 2 คนเครื่องเดียว', online: '🌐 จับคู่ออนไลน์', room: '🔒 สร้างห้องส่วนตัว' }[mode];
    $('#difficultyBlock').classList.toggle('hidden', mode !== 'bot');
    $('#firstBlock').classList.toggle('hidden', mode === 'online' || mode === 'room');
    $('#friendlyBlock').classList.toggle('hidden', mode !== 'room');
    show('setup');
  }

  function startFromSetup() {
    const preset = E.PRESETS[G.presetId];
    G.presetId = preset.id; G.size = preset.size; G.winLen = preset.winLen;
    G.firstChoice = $('input[name="first"]:checked')?.value || 'x';
    A.play('click');
    if (pendingMode === 'bot' || pendingMode === 'local') return startLocalGame(pendingMode);
    if (pendingMode === 'online') return startQueue();
    if (pendingMode === 'room') return createRoom();
  }

  /* ---------------- โหมดออฟไลน์ (บอท / 2 คน) ---------------- */
  function startLocalGame(mode) {
    Object.assign(G, {
      mode, board: E.create(G.size), turn: E.X, over: false, winner: 0,
      line: [], last: -1, history: [], startedAt: Date.now(), thinking: false,
      hintCell: -1, room: null, oppLeft: false, scores: G.scores || {}
    });
    let first = G.firstChoice === 'random' ? (Math.random() < 0.5 ? 'x' : 'o') : G.firstChoice;
    G.mySymbol = mode === 'local' ? E.X : (first === 'x' ? E.X : E.O);
    G.localFirst = first;

    $('#chatPanel').classList.add('hidden');
    $('#btnHint').classList.remove('hidden');
    $('#btnUndo').classList.toggle('hidden', mode === 'local');
    const leftPlayer = mode === 'local'
      ? { name: 'ผู้เล่น 1', avatar: S.profile.avatar, sub: 'X' }
      : (G.mySymbol === E.X
        ? { name: S.profile.name, avatar: S.profile.avatar, sub: 'X' }
        : { name: `บอท ${Bot.LEVELS[G.level].label}`, avatar: '🤖', sub: 'X' });
    const rightPlayer = mode === 'local'
      ? { name: 'ผู้เล่น 2', avatar: '🧑', sub: 'O' }
      : (G.mySymbol === E.O
        ? { name: S.profile.name, avatar: S.profile.avatar, sub: 'O' }
        : { name: `บอท ${Bot.LEVELS[G.level].label}`, avatar: '🤖', sub: 'O' });
    setPlayersUI(leftPlayer, rightPlayer);
    show('game');
    draw();
    if (mode === 'bot' && G.turn !== G.mySymbol) scheduleBot();
    startLocalTimer();
  }

  function onCellClick(i) {
    if (G.over || G.thinking) return;
    if (G.board[i] !== E.EMPTY) { A.play('error'); return; }
    if (G.mode === 'online') {
      if (G.turn !== G.mySymbol) return toast('ยังไม่ถึงตาคุณ', 'warn'), A.play('error');
      Net.emit('game:move', { index: i });
      return;
    }
    if (G.mode === 'bot' && G.turn !== G.mySymbol) return;
    placeLocal(i, G.turn);
  }

  function placeLocal(i, sym) {
    G.board[i] = sym; G.last = i; G.hintCell = -1;
    G.history.push(i);
    A.play(sym === E.X ? 'placeX' : 'placeO');
    const st = E.status(G.board, G.size, G.winLen, i);
    draw();
    if (st.over) return endLocal(st);
    G.turn = E.other(G.turn);
    draw();
    resetLocalTimer();
    if (G.mode === 'bot' && G.turn !== G.mySymbol) scheduleBot();
  }

  function scheduleBot() {
    G.thinking = true;
    $('#turnLabel').textContent = 'บอทกำลังคิด...';
    $('#board').classList.add('locked');
    const delay = 220 + Math.random() * 380;
    setTimeout(() => {
      const move = Bot.think({ board: G.board, size: G.size, winLen: G.winLen, me: G.turn, level: G.level });
      G.thinking = false;
      $('#board').classList.remove('locked');
      if (move >= 0 && !G.over) placeLocal(move, G.turn);
    }, delay);
  }

  function endLocal(st) {
    G.over = true; G.winner = st.winner; G.line = st.line;
    stopLocalTimer();
    draw();
    let result = 'draw';
    if (st.winner) result = (G.mode === 'local') ? 'win' : (st.winner === G.mySymbol ? 'win' : 'loss');
    const seconds = (Date.now() - G.startedAt) / 1000;
    const myMoves = Math.ceil(G.history.length / 2);
    const unlocked = Store.recordGame({
      mode: G.mode, result, level: G.mode === 'bot' ? G.level : null,
      moves: myMoves, seconds,
      perfect: result === 'win' && G.mode === 'bot' && (G.level === 'hard' || G.level === 'insane'),
      comeback: false
    });
    showResult(result, st, unlocked);
  }

  /* ---------------- โหมดออนไลน์ ---------------- */
  function setupNet() {
    Net.connect({ playerId: S.profile.id, name: S.profile.name, avatar: S.profile.avatar });

    Net.on('welcome', (d) => {
      if (d.profile) { S.profile.elo = d.profile.elo; Store.save(); renderProfile(); }
      $('#onlineCount').textContent = `● ${d.online} ออนไลน์`;
      if (d.resumed) { toast('กลับเข้าเกมเดิมแล้ว', 'ok'); enterOnlineGame(d.resumed.code, d.resumed.you); }
    });
    Net.on('online:count', (n) => $('#onlineCount').textContent = `● ${n} ออนไลน์`);
    Net.on('net:up', () => $('#netDot').className = 'net-dot up');
    Net.on('net:down', () => { $('#netDot').className = 'net-dot down'; toast('การเชื่อมต่อหลุด กำลังลองใหม่...', 'warn'); });

    Net.on('queue:status', (d) => {
      if (d.inQueue) $('#lobbyStatus').textContent = `กำลังหาคู่แข่ง (${E.PRESETS[d.preset].label})...`;
    });

    Net.on('room:created', (d) => {
      $('#lobbyStatus').textContent = 'ส่งรหัสนี้ให้เพื่อนเพื่อเข้าห้อง';
      $('#lobbyCodeBox').classList.remove('hidden');
      $('#lobbyCode').textContent = d.code;
      G.room = d.code;
    });

    Net.on('match:found', (d) => { A.play('match'); enterOnlineGame(d.code, d.you); });
    Net.on('room:spectate', (d) => { toast('เข้าชมเกมในฐานะผู้ชม', 'info'); enterOnlineGame(d.code, 0); });

    Net.on('game:state', (st) => {
      if (!st || (G.room && st.code !== G.room)) return;
      applyServerState(st);
    });

    Net.on('game:over', (r) => {
      G.over = true; G.winner = r.winner; G.line = r.line || [];
      draw(); stopLocalTimer();
      let result = 'draw';
      if (r.winner) result = r.winner === G.mySymbol ? 'win' : 'loss';
      if (G.mySymbol === 0) result = 'spectate';
      const delta = r.delta?.[S.profile.id];
      if (r.elo?.[S.profile.id]) { S.profile.elo = r.elo[S.profile.id]; Store.save(); renderProfile(); }
      const unlocked = result === 'spectate' ? [] : Store.recordGame({
        mode: 'online', result, moves: Math.ceil((G.history.length || 0) / 2),
        seconds: (Date.now() - G.startedAt) / 1000, perfect: false
      });
      showResult(result, { winner: r.winner, line: r.line }, unlocked, { reason: r.reason, delta });
    });

    Net.on('game:restart', (d) => { toast(`เริ่มรอบที่ ${d.round}`, 'ok'); A.play('match'); $('#resultOverlay').classList.add('hidden'); });
    Net.on('chat:msg', (m) => addChat(m));
    Net.on('emote', (e) => flyEmote(e.id, e.from === S.profile.id));
    Net.on('opponent:disconnected', () => toast('คู่แข่งหลุดการเชื่อมต่อ กำลังรอ 30 วินาที...', 'warn'));
    Net.on('opponent:reconnected', () => toast('คู่แข่งกลับมาแล้ว', 'ok'));
    Net.on('opponent:left', () => { G.oppLeft = true; toast('คู่แข่งออกจากห้อง', 'warn'); });
    Net.on('error:msg', (m) => { toast(m, 'error'); A.play('error'); });
  }

  function startQueue() {
    if (!Net.isConnected()) return toast('ยังเชื่อมต่อเซิร์ฟเวอร์ไม่ได้', 'error');
    $('#lobbyCodeBox').classList.add('hidden');
    $('#lobbyStatus').textContent = 'กำลังหาคู่แข่ง...';
    startLobbyTimer();
    show('lobby');
    Net.emit('queue:join', { preset: G.presetId });
  }

  function createRoom() {
    if (!Net.isConnected()) return toast('ยังเชื่อมต่อเซิร์ฟเวอร์ไม่ได้', 'error');
    const friendly = $('#friendlyToggle').checked;
    $('#lobbyStatus').textContent = 'กำลังสร้างห้อง...';
    startLobbyTimer();
    show('lobby');
    Net.emit('room:create', { preset: G.presetId, friendly });
  }

  async function joinByCode() {
    const code = await modal({
      title: '🔑 เข้าห้องด้วยรหัส',
      body: '<p class="muted">ใส่รหัส 5 ตัวอักษรที่เพื่อนส่งมา</p>',
      input: { placeholder: 'เช่น K7M2Q', maxLength: 5 },
      actions: [{ label: 'เข้าห้อง', variant: 'primary' }, { label: 'ยกเลิก', value: null }]
    });
    if (!code) return;
    Net.emit('room:join', { code: String(code).toUpperCase() }, (res) => {
      if (res?.error) toast(res.error, 'error');
    });
  }

  function enterOnlineGame(code, symbol) {
    G.mode = 'online'; G.room = code; G.mySymbol = symbol;
    G.history = []; G.startedAt = Date.now(); G.oppLeft = false;
    $('#chatPanel').classList.remove('hidden');
    $('#btnHint').classList.add('hidden');
    $('#btnUndo').classList.add('hidden');
    $('#chatLog').innerHTML = '';
    stopLobbyTimer();
    show('game');
  }

  function applyServerState(st) {
    G.size = st.size; G.winLen = st.winLen; G.board = st.board;
    G.turn = st.turn; G.over = st.over; G.winner = st.winner; G.line = st.line || [];
    G.last = st.moves?.length ? st.moves[st.moves.length - 1].i : -1;
    G.history = (st.moves || []).map(m => m.i);
    G.players = st.players; G.scores = st.scores || {};
    G.drift = Date.now() - st.serverNow;
    G.deadline = st.turnDeadline ? st.turnDeadline + G.drift : 0;

    const me = st.players.find(p => p.id === S.profile.id);
    if (me) G.mySymbol = me.symbol;
    const opp = st.players.find(p => p.id !== S.profile.id);
    setPlayersUI(
      me ? { name: me.name, avatar: me.avatar, sub: `${me.symbol === 1 ? 'X' : 'O'} • ${me.elo}` } : { name: 'ผู้ชม', avatar: '👀', sub: '-' },
      opp ? { name: opp.name + (opp.connected ? '' : ' (หลุด)'), avatar: opp.avatar, sub: `${opp.symbol === 1 ? 'X' : 'O'} • ${opp.elo}` } : { name: 'รอคู่แข่ง...', avatar: '⏳', sub: '-' }
    );
    $('#roundLabel').textContent = `รอบ ${st.round} • ${E.PRESETS[st.presetId]?.label || ''}`;
    $('#scoreLine').textContent = `X ${st.scores?.[1] || 0} : ${st.scores?.[2] || 0} O • เสมอ ${st.scores?.draw || 0}`;
    $('#btnRematch').classList.toggle('hidden', !st.over);
    draw();
    startNetTimer();
  }

  /* ---------------- Timer ---------------- */
  function startNetTimer() {
    clearInterval(tickTimer);
    if (G.over || !G.deadline) return setTimer(0, 1);
    tickTimer = setInterval(() => {
      const left = G.deadline - Date.now();
      setTimer(left, left / (E.PRESETS[G.presetId]?.turnMs || 20000));
      if (left <= 5000 && left > 0 && Math.floor(left / 1000) !== window.__lastTick) {
        window.__lastTick = Math.floor(left / 1000);
        A.play(left <= 3000 ? 'warn' : 'tick');
      }
      if (left <= 0) clearInterval(tickTimer);
    }, 100);
  }

  function startLocalTimer() {
    clearInterval(tickTimer);
    const sec = Number(S.settings.localTimer) || 0;
    if (!sec) return setTimer(0, 1, true);
    G.localTimerLeft = sec * 1000;
    tickTimer = setInterval(() => {
      if (G.over) return clearInterval(tickTimer);
      G.localTimerLeft -= 100;
      setTimer(G.localTimerLeft, G.localTimerLeft / (sec * 1000));
      if (G.localTimerLeft <= 0) {
        clearInterval(tickTimer);
        endLocal({ over: true, winner: E.other(G.turn), line: [], draw: false });
      }
    }, 100);
  }
  function resetLocalTimer() { if (G.mode !== 'online') startLocalTimer(); }
  function stopLocalTimer() { clearInterval(tickTimer); }

  function setTimer(ms, ratio, hide) {
    $('#timerWrap').classList.toggle('hidden', !!hide);
    $('#timerText').textContent = ms > 0 ? fmtTime(ms) : '—';
    const bar = $('#timerBar');
    bar.style.width = Math.max(0, Math.min(100, ratio * 100)) + '%';
    bar.classList.toggle('danger', ratio < 0.25);
  }

  let lobbyStart = 0, lobbyTimer = null;
  function startLobbyTimer() {
    lobbyStart = Date.now();
    clearInterval(lobbyTimer);
    lobbyTimer = setInterval(() => {
      $('#lobbyTimer').textContent = fmtTime(Date.now() - lobbyStart);
    }, 500);
  }
  function stopLobbyTimer() { clearInterval(lobbyTimer); }

  function cancelLobby() {
    Net.emit('queue:leave');
    Net.emit('room:leave');
    stopLobbyTimer();
    G.room = null;
    show('home');
  }

  /* ---------------- Draw ---------------- */
  function draw() {
    const myTurn = G.mode === 'local' ? true : G.turn === G.mySymbol;
    const waiting = G.mode === 'online' && G.players.length < 2;
    renderBoard($('#board'), {
      board: G.board, size: G.size, line: G.line, last: G.last,
      disabled: G.over || G.thinking || !myTurn || waiting || G.mySymbol === 0,
      hint: G.hintCell
    });
    $('#pX').classList.toggle('active', !G.over && G.turn === E.X);
    $('#pO').classList.toggle('active', !G.over && G.turn === E.O);

    let label;
    if (waiting) label = 'รอคู่แข่งเข้าห้อง...';
    else if (G.over) label = G.winner ? `${G.winner === E.X ? '✕' : '◯'} ชนะ!` : 'เสมอ';
    else if (G.mode === 'local') label = `ตาของ ${G.turn === E.X ? '✕ ผู้เล่น 1' : '◯ ผู้เล่น 2'}`;
    else label = myTurn ? t('turn_you') : t('turn_opp');
    $('#turnLabel').textContent = label;

    $('#moveLog').textContent = `ตาที่ ${G.history.length} • ต่อ ${G.winLen} ช่องเพื่อชนะ`;
    $('#btnUndo').disabled = G.history.length < 2 || G.over;
    $('#btnRematch').classList.toggle('hidden', !G.over);
  }

  function setPlayersUI(a, b) {
    $('#pXAvatar').textContent = a.avatar; $('#pXName').textContent = a.name; $('#pXSub').textContent = a.sub;
    $('#pOAvatar').textContent = b.avatar; $('#pOName').textContent = b.name; $('#pOSub').textContent = b.sub;
  }

  /* ---------------- Actions ---------------- */
  function doHint() {
    if (G.over || G.mode === 'online') return;
    const m = Bot.hint(G.board, G.size, G.winLen, G.turn);
    if (m >= 0) { G.hintCell = m; draw(); A.play('msg'); setTimeout(() => { G.hintCell = -1; draw(); }, 1800); }
  }

  function doUndo() {
    if (G.mode === 'online' || G.over || !G.history.length) return;
    const back = G.mode === 'bot' ? 2 : 1;
    for (let k = 0; k < back && G.history.length; k++) {
      const i = G.history.pop();
      G.board[i] = E.EMPTY;
      G.turn = E.other(G.turn);
    }
    if (G.mode === 'bot') G.turn = G.mySymbol;
    G.last = G.history.at(-1) ?? -1;
    G.over = false; G.line = [];
    A.play('click'); draw(); resetLocalTimer();
  }

  async function doResign() {
    const ok = await modal({ title: 'ยอมแพ้?', body: '<p>เกมนี้จะนับเป็นการแพ้</p>', actions: [{ label: 'ไม่', value: false }, { label: 'ยอมแพ้', variant: 'danger', value: true }] });
    if (!ok) return;
    if (G.mode === 'online') Net.emit('game:resign');
    else endLocal({ over: true, winner: E.other(G.mySymbol), line: [], draw: false });
  }

  function doRematch() {
    $('#resultOverlay').classList.add('hidden');
    if (G.mode === 'online') { Net.emit('game:rematch'); toast('ส่งคำขอเล่นอีกครั้งแล้ว', 'info'); return; }
    startLocalGame(G.mode);
  }

  function leaveGame() {
    if (G.mode === 'online') Net.emit('room:leave');
    stopLocalTimer();
    G.room = null;
    $('#resultOverlay').classList.add('hidden');
    show('home');
    renderProfile();
  }

  /* ---------------- Result ---------------- */
  function showResult(result, st, unlocked = [], extra = {}) {
    const ov = $('#resultOverlay');
    const map = {
      win: { icon: '🏆', title: t('you_win'), cls: 'win', sfx: 'win' },
      loss: { icon: '💀', title: t('you_lose'), cls: 'lose', sfx: 'lose' },
      draw: { icon: '🤝', title: t('draw'), cls: 'draw', sfx: 'draw' },
      spectate: { icon: '👀', title: 'เกมจบแล้ว', cls: 'draw', sfx: 'draw' }
    };
    const m = map[result] || map.draw;
    $('#resultIcon').textContent = m.icon;
    $('#resultTitle').textContent = m.title;
    ov.className = 'result-overlay ' + m.cls;

    const reasonTxt = { timeout: 'หมดเวลา', resign: 'ยอมแพ้', abandon: 'คู่แข่งหลุด', leave: 'คู่แข่งออกจากห้อง', draw: 'กระดานเต็ม', line: 'ต่อครบแถว' }[extra.reason] || '';
    const eloTxt = extra.delta !== undefined ? `<span class="${extra.delta >= 0 ? 'up' : 'down'}">${extra.delta >= 0 ? '+' : ''}${extra.delta} Elo</span>` : '';
    $('#resultDesc').innerHTML = `${reasonTxt ? `<div class="muted">${esc(reasonTxt)}</div>` : ''}
      <div>ใช้ไป <b>${G.history.length}</b> ตา • ${Math.round((Date.now() - G.startedAt) / 1000)} วินาที</div>${eloTxt}`;

    $('#resultAchievements').innerHTML = unlocked.length
      ? `<div class="ach-pop">${unlocked.map(a => `<div class="ach-item"><span>${a.icon}</span><div><b>${esc(a.name)}</b><small>${esc(a.desc)}</small></div></div>`).join('')}</div>`
      : '';
    if (unlocked.length) setTimeout(() => A.play('unlock'), 600);

    A.play(m.sfx);
    if (result === 'win' && S.settings.animations) confetti();
    ov.classList.remove('hidden');
  }

  function confetti() {
    const c = $('#confetti');
    c.innerHTML = '';
    for (let i = 0; i < 60; i++) {
      const p = document.createElement('i');
      p.style.left = Math.random() * 100 + '%';
      p.style.animationDelay = (Math.random() * 0.6) + 's';
      p.style.background = ['#7c5cff', '#38bdf8', '#fb7185', '#34d399', '#fbbf24'][i % 5];
      c.appendChild(p);
    }
    setTimeout(() => c.innerHTML = '', 3200);
  }

  /* ---------------- Chat & Emote ---------------- */
  function sendChat() {
    const inp = $('#chatInput');
    const text = inp.value.trim();
    if (!text) return;
    Net.emit('chat:send', { text });
    inp.value = '';
  }

  function addChat(m) {
    const log = $('#chatLog');
    const mine = m.id === S.profile.id;
    const el = document.createElement('div');
    el.className = 'chat-msg' + (mine ? ' mine' : '');
    el.innerHTML = `<span class="ava">${esc(m.avatar)}</span><div><b>${esc(m.name)}</b><p>${esc(m.text)}</p></div>`;
    log.appendChild(el);
    log.scrollTop = log.scrollHeight;
    if (!mine) A.play('msg');
  }

  function flyEmote(id, mine) {
    const el = document.createElement('div');
    el.className = 'fly-emote' + (mine ? ' mine' : '');
    el.textContent = id;
    $('#screen-game').appendChild(el);
    setTimeout(() => el.remove(), 2200);
  }

  /* ---------------- Stats / Leaderboard / Settings ---------------- */
  function renderStats() {
    const s = S.stats;
    const rate = s.games ? Math.round(s.wins / s.games * 100) : 0;
    const cards = [
      ['เกมทั้งหมด', s.games], ['ชนะ', s.wins], ['แพ้', s.losses], ['เสมอ', s.draws],
      ['อัตราชนะ', rate + '%'], ['ชนะติดต่อกันสูงสุด', s.bestStreak],
      ['ชนะเร็วสุด', s.fastestWinMoves ? s.fastestWinMoves + ' ตา' : '—'],
      ['เวลาเล่นรวม', Math.floor(s.playSeconds / 60) + ' นาที'],
      ['ออนไลน์ ช/พ/ส', `${s.online.wins}/${s.online.losses}/${s.online.draws}`],
      ['กับบอท ช/พ/ส', `${s.vsBot.wins}/${s.vsBot.losses}/${s.vsBot.draws}`]
    ];
    $('#statsGrid').innerHTML = cards.map(([k, v]) => `<div class="stat-card"><small>${k}</small><b>${v}</b></div>`).join('');

    $('#achievementList').innerHTML = Store.ACHIEVEMENTS.map(a => {
      const got = !!S.achievements[a.id];
      return `<div class="ach-item ${got ? 'got' : 'locked'}"><span>${got ? a.icon : '🔒'}</span>
        <div><b>${esc(a.name)}</b><small>${esc(a.desc)}</small></div></div>`;
    }).join('');

    $('#historyList').innerHTML = (S.history || []).slice(0, 12).map(h => {
      const tag = { win: '<span class="tag ok">ชนะ</span>', loss: '<span class="tag bad">แพ้</span>', draw: '<span class="tag">เสมอ</span>' }[h.result] || '';
      const mode = { bot: '🤖 บอท', online: '🌐 ออนไลน์', local: '👥 ในเครื่อง' }[h.mode] || h.mode;
      return `<div class="hist-row">${tag}<span>${mode}${h.level ? ' • ' + h.level : ''}</span><small>${new Date(h.at).toLocaleString('th-TH')}</small></div>`;
    }).join('') || '<p class="muted">ยังไม่มีประวัติ</p>';
  }

  async function loadLeaderboard() {
    const box = $('#leaderboardList');
    box.innerHTML = '<p class="muted">กำลังโหลด...</p>';
    try {
      const r = await fetch('/api/leaderboard');
      const d = await r.json();
      if (!d.list.length) return box.innerHTML = '<p class="muted">ยังไม่มีข้อมูลอันดับ</p>';
      box.innerHTML = d.list.map(p => {
        const medal = p.rank === 1 ? '🥇' : p.rank === 2 ? '🥈' : p.rank === 3 ? '🥉' : `#${p.rank}`;
        return `<div class="lb-row ${p.name === S.profile.name ? 'me' : ''}">
          <span class="rank">${medal}</span><span class="ava">${esc(p.avatar)}</span>
          <span class="nm">${esc(p.name)}</span>
          <span class="elo">${p.elo}</span>
          <small>${p.wins}ช/${p.losses}พ/${p.draws}ส</small></div>`;
      }).join('');
    } catch { box.innerHTML = '<p class="muted">โหลดอันดับไม่สำเร็จ</p>'; }
  }

  function renderSettings() {
    $('#setTheme').value = S.settings.theme;
    $('#setStyle').value = S.settings.boardStyle;
    $('#setLang').value = S.settings.lang;
    $('#setTimer').value = S.settings.localTimer;
    $('#setSound').checked = S.settings.sound;
    $('#setAnim').checked = S.settings.animations;
    $('#setVolume').value = S.settings.volume;

    $('#setTheme').onchange = e => { Store.setSetting('theme', e.target.value); applySettings(); };
    $('#setStyle').onchange = e => { Store.setSetting('boardStyle', e.target.value); applySettings(); };
    $('#setLang').onchange = e => { Store.setSetting('lang', e.target.value); applySettings(); UI.setLang(e.target.value); };
    $('#setTimer').onchange = e => Store.setSetting('localTimer', Number(e.target.value));
    $('#setSound').onchange = e => { Store.setSetting('sound', e.target.checked); applySettings(); };
    $('#setAnim').onchange = e => { Store.setSetting('animations', e.target.checked); applySettings(); };
    $('#setVolume').oninput = e => { Store.setSetting('volume', Number(e.target.value)); A.setVolume(Number(e.target.value)); };
  }

  function copyCode() {
    const code = $('#lobbyCode').textContent;
    navigator.clipboard?.writeText(code).then(() => toast('คัดลอกรหัสแล้ว: ' + code, 'ok'));
  }
  function shareCode() {
    const code = $('#lobbyCode').textContent;
    const url = `${location.origin}/?room=${code}`;
    if (navigator.share) navigator.share({ title: 'XO Arena', text: `มาเล่น XO กัน! รหัสห้อง ${code}`, url });
    else navigator.clipboard?.writeText(url).then(() => toast('คัดลอกลิงก์ชวนเล่นแล้ว', 'ok'));
  }

  /* ---------------- Deep link ?room=CODE ---------------- */
  window.addEventListener('load', () => {
    const code = new URLSearchParams(location.search).get('room');
    if (code) setTimeout(() => { Net.emit('room:join', { code: code.toUpperCase() }); history.replaceState({}, '', location.pathname); }, 900);
  });

  boot();
})();