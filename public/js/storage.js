/* XO ARENA — ข้อมูลฝั่งผู้ใช้ / auth session / สถิติ / settings */
(function (root) {
  'use strict';
  const KEY = 'xo-arena-v2';
  const DEFAULTS = {
    auth: { token: '', userId: '' },
    profile: { id: '', name: '', avatar: '🐱', elo: 1000 },
    settings: {
      theme: 'dark', sound: true, volume: 0.5, animations: true,
      lang: 'th', boardStyle: 'neon', localTimer: 0, confirmMove: false
    },
    stats: {
      games: 0, wins: 0, losses: 0, draws: 0,
      vsBot: { games: 0, wins: 0, losses: 0, draws: 0, byLevel: {} },
      online: { games: 0, wins: 0, losses: 0, draws: 0 },
      streak: 0, bestStreak: 0, fastestWinMoves: 0, totalMoves: 0, playSeconds: 0,
      perfectGames: 0, comebacks: 0
    },
    achievements: {}, history: []
  };

  const ACHIEVEMENTS = [
    { id: 'first_blood', icon: '🩸', name: 'ชัยชนะแรก', desc: 'ชนะเกมแรกของคุณ', check: s => s.wins >= 1 },
    { id: 'win10', icon: '🥉', name: 'มือใหม่ไฟแรง', desc: 'ชนะครบ 10 เกม', check: s => s.wins >= 10 },
    { id: 'win50', icon: '🥈', name: 'ขาประจำ', desc: 'ชนะครบ 50 เกม', check: s => s.wins >= 50 },
    { id: 'win100', icon: '🥇', name: 'เซียน XO', desc: 'ชนะครบ 100 เกม', check: s => s.wins >= 100 },
    { id: 'streak3', icon: '🔥', name: 'ติดลม', desc: 'ชนะติดต่อกัน 3 เกม', check: s => s.bestStreak >= 3 },
    { id: 'streak7', icon: '🌋', name: 'ไฟลุก', desc: 'ชนะติดต่อกัน 7 เกม', check: s => s.bestStreak >= 7 },
    { id: 'beat_hard', icon: '🤖', name: 'ล้มหุ่นยนต์', desc: 'ชนะบอทระดับยาก', check: s => (s.vsBot.byLevel.hard?.wins || 0) >= 1 },
    { id: 'beat_insane', icon: '👑', name: 'เหนือ AI', desc: 'ชนะบอทระดับโหดสัส', check: s => (s.vsBot.byLevel.insane?.wins || 0) >= 1 },
    { id: 'speedster', icon: '⚡', name: 'จบไว', desc: 'ชนะภายใน 5 ตา', check: s => s.fastestWinMoves > 0 && s.fastestWinMoves <= 5 },
    { id: 'perfect', icon: '💎', name: 'ไร้ที่ติ', desc: 'ชนะแบบไม่เสียเปรียบเลย 5 ครั้ง', check: s => s.perfectGames >= 5 },
    { id: 'online10', icon: '🌐', name: 'นักสู้ออนไลน์', desc: 'เล่นออนไลน์ครบ 10 เกม', check: s => s.online.games >= 10 },
    { id: 'marathon', icon: '⏱️', name: 'มาราธอน', desc: 'เล่นรวมครบ 1 ชั่วโมง', check: s => s.playSeconds >= 3600 },
    { id: 'century', icon: '🎯', name: 'ร้อยตา', desc: 'เดินครบ 1,000 ตา', check: s => s.totalMoves >= 1000 },
    { id: 'comeback', icon: '🔄', name: 'พลิกเกม', desc: 'ชนะหลังจากเกือบแพ้ 3 ครั้ง', check: s => s.comebacks >= 3 }
  ];

  function deepMerge(base, over) {
    const out = Array.isArray(base) ? base.slice() : { ...base };
    if (!over || typeof over !== 'object') return out;
    for (const k in over) {
      if (over[k] && typeof over[k] === 'object' && !Array.isArray(over[k])) out[k] = deepMerge(base[k] || {}, over[k]);
      else out[k] = over[k];
    }
    return out;
  }

  let state;
  function load() {
    try { state = deepMerge(DEFAULTS, JSON.parse(localStorage.getItem(KEY) || '{}')); }
    catch { state = deepMerge(DEFAULTS, {}); }
    return state;
  }
  const save = () => { if (!state) return; localStorage.setItem(KEY, JSON.stringify(state)); };
  const get = () => state || load();

  function setAuth(auth = {}) { Object.assign(get().auth, auth); save(); }
  function clearAuth() { get().auth = { token: '', userId: '' }; save(); }
  function setProfile(patch) { Object.assign(get().profile, patch); save(); }
  function setSetting(k, v) { get().settings[k] = v; save(); }
  function applyServerData(data) {
    if (!data) return;
    const s = get();
    if (data.avatar) s.profile.avatar = data.avatar;
    if (data.elo != null) s.profile.elo = data.elo;
    if (data.settings) s.settings = deepMerge(s.settings, data.settings);
    if (data.stats) s.stats = deepMerge(s.stats, data.stats);
    if (data.achievements) s.achievements = data.achievements;
    if (Array.isArray(data.history)) s.history = data.history;
    save();
  }
  function exportPlayerData() {
    const s = get();
    return { id: s.profile.id, avatar: s.profile.avatar, settings: s.settings, stats: s.stats, achievements: s.achievements, history: s.history };
  }

  function recordGame({ mode, result, level, moves, seconds, perfect, comeback }) {
    const s = get().stats;
    s.games++; s.totalMoves += moves || 0; s.playSeconds += Math.round(seconds || 0);
    const bucket = mode === 'online' ? s.online : (mode === 'bot' ? s.vsBot : null);
    if (bucket) bucket.games++;
    if (result === 'win') {
      s.wins++; s.streak++; s.bestStreak = Math.max(s.bestStreak, s.streak);
      if (bucket) bucket.wins++;
      if (moves && (!s.fastestWinMoves || moves < s.fastestWinMoves)) s.fastestWinMoves = moves;
      if (perfect) s.perfectGames++;
      if (comeback) s.comebacks++;
    } else if (result === 'loss') {
      s.losses++; s.streak = 0; if (bucket) bucket.losses++;
    } else {
      s.draws++; if (bucket) bucket.draws++;
    }
    if (mode === 'bot' && level) {
      const bl = s.vsBot.byLevel[level] || (s.vsBot.byLevel[level] = { games: 0, wins: 0, losses: 0, draws: 0 });
      bl.games++; if (result === 'win') bl.wins++; else if (result === 'loss') bl.losses++; else bl.draws++;
    }
    get().history.unshift({ mode, result, level, moves, at: Date.now() });
    get().history = get().history.slice(0, 50);
    const unlocked = [];
    ACHIEVEMENTS.forEach(a => {
      if (!get().achievements[a.id] && a.check(s)) { get().achievements[a.id] = Date.now(); unlocked.push(a); }
    });
    save();
    return unlocked;
  }

  function resetAll() {
    const auth = { ...get().auth };
    localStorage.removeItem(KEY);
    state = null;
    load();
    get().auth = auth;
    save();
    return state;
  }

  root.XOStore = { load, save, get, setAuth, clearAuth, setProfile, setSetting, applyServerData, exportPlayerData, recordGame, resetAll, ACHIEVEMENTS };
})(window);
