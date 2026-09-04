/* XO ARENA — client cache + server synchronization */
(function (root) {
  'use strict';
  const KEY = 'xo-arena-v2';
  const DEFAULTS = {
    profile: { id: '', name: '', avatar: '🐱', elo: 1000 },
    settings: { theme: 'dark', sound: true, volume: 0.5, animations: true, lang: 'th', boardStyle: 'neon', localTimer: 0, confirmMove: false },
    stats: { games: 0, wins: 0, losses: 0, draws: 0, vsBot: { games: 0, wins: 0, losses: 0, draws: 0, byLevel: {} }, online: { games: 0, wins: 0, losses: 0, draws: 0 }, streak: 0, bestStreak: 0, fastestWinMoves: 0, totalMoves: 0, playSeconds: 0, perfectGames: 0, comebacks: 0 },
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
    { id: 'beat_insane', icon: '👑', name: 'เหนือ AI', desc: 'ชนะบอทระดับโหด', check: s => (s.vsBot.byLevel.insane?.wins || 0) >= 1 },
    { id: 'speedster', icon: '⚡', name: 'จบไว', desc: 'ชนะภายใน 5 ตา', check: s => s.fastestWinMoves > 0 && s.fastestWinMoves <= 5 },
    { id: 'perfect', icon: '💎', name: 'ไร้ที่ติ', desc: 'ชนะแบบไม่เสียเปรียบเลย 5 ครั้ง', check: s => s.perfectGames >= 5 },
    { id: 'online10', icon: '🌐', name: 'นักสู้ออนไลน์', desc: 'เล่นออนไลน์ครบ 10 เกม', check: s => s.online.games >= 10 },
    { id: 'marathon', icon: '⏱️', name: 'มาราธอน', desc: 'เล่นรวมครบ 1 ชั่วโมง', check: s => s.playSeconds >= 3600 },
    { id: 'century', icon: '🎯', name: 'ร้อยตา', desc: 'เดินครบ 1,000 ตา', check: s => s.totalMoves >= 1000 },
    { id: 'comeback', icon: '🔄', name: 'พลิกเกม', desc: 'ชนะหลังจากเกือบแพ้ 3 ครั้ง', check: s => s.comebacks >= 3 }
  ];
  function deepMerge(base, over) {
    const out = Array.isArray(base) ? base.slice() : { ...base };
    for (const k in (over || {})) out[k] = (over[k] && typeof over[k] === 'object' && !Array.isArray(over[k])) ? deepMerge(base[k] || {}, over[k]) : over[k];
    return out;
  }
  let state;
  function load() {
    try { state = deepMerge(DEFAULTS, JSON.parse(localStorage.getItem(KEY) || '{}')); }
    catch { state = deepMerge(DEFAULTS, {}); }
    return state;
  }
  const save = () => localStorage.setItem(KEY, JSON.stringify(state || DEFAULTS));
  const get = () => state || load();
  function hydrateRemote(profile) {
    if (!profile) return get();
    const fresh = deepMerge(DEFAULTS, {
      profile: { id: profile.id, name: profile.name, avatar: profile.avatar, elo: profile.elo },
      settings: profile.settings || {}, stats: profile.stats || {}, achievements: profile.achievements || {}, history: profile.history || []
    });
    state = fresh; save(); return state;
  }
  async function syncRemote() {
    const s = get();
    if (!s.profile.id) return null;
    try {
      const r = await fetch('/api/me', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: s.profile.name, avatar: s.profile.avatar, settings: s.settings, stats: s.stats, achievements: s.achievements, history: s.history }) });
      if (!r.ok) return null;
      const d = await r.json(); if (d.profile) hydrateRemote(d.profile); return d.profile || null;
    } catch { return null; }
  }
  function setProfile(patch) { Object.assign(get().profile, patch); save(); syncRemote(); }
  function setSetting(k, v) { get().settings[k] = v; save(); syncRemote(); }
  function recordGame({ mode, result, level, moves, seconds, perfect, comeback }) {
    const s = get().stats; s.games++; s.totalMoves += moves || 0; s.playSeconds += Math.round(seconds || 0);
    const bucket = mode === 'online' ? s.online : (mode === 'bot' ? s.vsBot : null); if (bucket) bucket.games++;
    if (result === 'win') { s.wins++; s.streak++; s.bestStreak = Math.max(s.bestStreak, s.streak); if (bucket) bucket.wins++; if (moves && (!s.fastestWinMoves || moves < s.fastestWinMoves)) s.fastestWinMoves = moves; if (perfect) s.perfectGames++; if (comeback) s.comebacks++; }
    else if (result === 'loss') { s.losses++; s.streak = 0; if (bucket) bucket.losses++; } else { s.draws++; if (bucket) bucket.draws++; }
    if (mode === 'bot' && level) { const bl = s.vsBot.byLevel[level] || (s.vsBot.byLevel[level] = { games: 0, wins: 0, losses: 0, draws: 0 }); bl.games++; if (result === 'win') bl.wins++; else if (result === 'loss') bl.losses++; else bl.draws++; }
    get().history.unshift({ mode, result, level, moves, at: Date.now() }); get().history = get().history.slice(0, 50);
    const unlocked = []; ACHIEVEMENTS.forEach(a => { if (!get().achievements[a.id] && a.check(s)) { get().achievements[a.id] = Date.now(); unlocked.push(a); } });
    save(); syncRemote(); return unlocked;
  }
  function resetAll() { localStorage.removeItem(KEY); state = load(); return state; }
  root.XOStore = { load, save, get, hydrateRemote, syncRemote, setProfile, setSetting, recordGame, resetAll, ACHIEVEMENTS };
})(window);
