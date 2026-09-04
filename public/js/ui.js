/* XO ARENA — DOM helper, modal, toast, i18n, การเรนเดอร์กระดาน */
(function (root) {
  'use strict';
  const $ = (sel, ctx = document) => ctx.querySelector(sel);
  const $$ = (sel, ctx = document) => Array.from(ctx.querySelectorAll(sel));

  /* ---------- i18n ---------- */
  const T = {
    th: {
      play_bot: '🤖 เล่นกับบอท', play_online: '🌐 แข่งออนไลน์', create_room: '🔒 สร้างห้องส่วนตัว',
      join_room: '🔑 เข้าห้องด้วยรหัส', play_local: '👥 เล่น 2 คน (เครื่องเดียว)',
      stats: '📊 สถิติ & ความสำเร็จ', leaderboard: '🏆 อันดับโลก', settings: '⚙️ ตั้งค่า',
      back: '← กลับ', start: 'เริ่มเกม', mode: 'รูปแบบกระดาน', difficulty: 'ระดับความยาก',
      first: 'ใครเริ่มก่อน', random: 'สุ่ม', hint: '💡 ใบ้', undo: '↩️ ย้อน', resign: '🏳️ ยอมแพ้',
      rematch: '🔁 เล่นอีกครั้ง', leave: '🚪 ออก', turn_you: 'ตาคุณ', turn_opp: 'ตาคู่แข่ง',
      you_win: 'คุณชนะ! 🎉', you_lose: 'คุณแพ้ 😢', draw: 'เสมอ 🤝', send: 'ส่ง',
      waiting: 'กำลังรอคู่แข่ง...', copy: 'คัดลอก', share: 'แชร์', cancel: 'ยกเลิก', reset: 'ล้างข้อมูล'
    },
    en: {
      play_bot: '🤖 Play vs Bot', play_online: '🌐 Online Match', create_room: '🔒 Create Room',
      join_room: '🔑 Join by Code', play_local: '👥 Local 2P',
      stats: '📊 Stats & Achievements', leaderboard: '🏆 Leaderboard', settings: '⚙️ Settings',
      back: '← Back', start: 'Start', mode: 'Board Mode', difficulty: 'Difficulty',
      first: 'Who goes first', random: 'Random', hint: '💡 Hint', undo: '↩️ Undo', resign: '🏳️ Resign',
      rematch: '🔁 Rematch', leave: '🚪 Leave', turn_you: 'Your turn', turn_opp: "Opponent's turn",
      you_win: 'You win! 🎉', you_lose: 'You lose 😢', draw: 'Draw 🤝', send: 'Send',
      waiting: 'Waiting for opponent...', copy: 'Copy', share: 'Share', cancel: 'Cancel', reset: 'Reset data'
    }
  };
  let lang = 'th';
  const t = (k) => (T[lang] && T[lang][k]) || T.th[k] || k;
  function setLang(l) {
    lang = T[l] ? l : 'th';
    $$('[data-i18n]').forEach(el => { el.textContent = t(el.dataset.i18n); });
    document.documentElement.lang = lang;
  }

  /* ---------- Screens ---------- */
  let current = 'home';
  function show(name) {
    $$('.screen').forEach(s => s.classList.toggle('active', s.id === 'screen-' + name));
    current = name;
    window.scrollTo({ top: 0, behavior: 'smooth' });
    return name;
  }

  /* ---------- Toast ---------- */
  function toast(msg, type = 'info', ms = 2600) {
    const wrap = $('#toasts');
    const el = document.createElement('div');
    el.className = 'toast toast-' + type;
    el.textContent = msg;
    wrap.appendChild(el);
    requestAnimationFrame(() => el.classList.add('in'));
    setTimeout(() => { el.classList.remove('in'); setTimeout(() => el.remove(), 300); }, ms);
  }

  /* ---------- Modal ---------- */
  function modal({ title, body, actions = [], input = null }) {
    return new Promise(resolve => {
      const m = $('#modal');
      $('#modalTitle').textContent = title || '';
      $('#modalBody').innerHTML = body || '';
      const inp = $('#modalInput');
      inp.classList.toggle('hidden', !input);
      if (input) { inp.value = input.value || ''; inp.placeholder = input.placeholder || ''; inp.maxLength = input.maxLength || 40; }
      const bar = $('#modalActions');
      bar.innerHTML = '';
      actions.forEach(a => {
        const b = document.createElement('button');
        b.className = 'btn ' + (a.variant || 'ghost');
        b.textContent = a.label;
        b.onclick = () => { m.classList.add('hidden'); resolve(a.value === undefined ? (input ? inp.value : true) : a.value); };
        bar.appendChild(b);
      });
      m.classList.remove('hidden');
      if (input) setTimeout(() => inp.focus(), 60);
      inp.onkeydown = (e) => { if (e.key === 'Enter' && actions[0]) { m.classList.add('hidden'); resolve(inp.value); } };
    });
  }

  /* ---------- Board ---------- */
  function buildBoard(el, size) {
    el.innerHTML = '';
    el.style.setProperty('--n', size);
    el.dataset.size = size;
    for (let i = 0; i < size * size; i++) {
      const c = document.createElement('button');
      c.className = 'cell';
      c.dataset.i = i;
      c.type = 'button';
      c.setAttribute('aria-label', `ช่องแถว ${Math.floor(i / size) + 1} คอลัมน์ ${i % size + 1}`);
      el.appendChild(c);
    }
  }

  function renderBoard(el, { board, size, line = [], last = -1, disabled = false, hint = -1 }) {
    if (Number(el.dataset.size) !== size) buildBoard(el, size);
    const cells = el.children;
    for (let i = 0; i < board.length; i++) {
      const c = cells[i];
      const v = board[i];
      const mark = v === 1 ? '✕' : v === 2 ? '◯' : '';
      if (c.textContent !== mark) {
        c.textContent = mark;
        if (mark) c.classList.add('pop');
        setTimeout(() => c.classList.remove('pop'), 320);
      }
      c.classList.toggle('x', v === 1);
      c.classList.toggle('o', v === 2);
      c.classList.toggle('win', line.includes(i));
      c.classList.toggle('last', i === last);
      c.classList.toggle('hint', i === hint);
      c.disabled = disabled || v !== 0;
    }
    el.classList.toggle('locked', disabled);
  }

  const fmtTime = (ms) => { const s = Math.max(0, Math.ceil(ms / 1000)); return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`; };
  const esc = (s) => String(s).replace(/[&<>"']/g, m => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[m]));

  root.UI = { $, $$, t, setLang, get lang() { return lang; }, show, get current() { return current; }, toast, modal, buildBoard, renderBoard, fmtTime, esc };
})(window);
