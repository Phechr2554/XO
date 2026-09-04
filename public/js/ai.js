/* XO ARENA — Bot AI : Negamax + Alpha-Beta + Iterative Deepening + Heuristic */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(require('./engine.js'));
  else root.XOBot = factory(root.XOEngine);
})(typeof self !== 'undefined' ? self : globalThis, function (E) {
  'use strict';

  const WIN = 1e9;
  const W = [0, 1, 14, 180, 2400, 32000, 420000, 5e6, 6e7, 7e8];   // น้ำหนักตามจำนวนหมากในหน้าต่าง

  const LEVELS = {
    easy:   { label: 'ง่าย 😴',      depth: 1, noise: 0.55, time: 120, blunder: 0.55 },
    normal: { label: 'ปานกลาง 🙂',   depth: 2, noise: 0.22, time: 250, blunder: 0.18 },
    hard:   { label: 'ยาก 😤',       depth: 4, noise: 0.05, time: 700, blunder: 0.03 },
    insane: { label: 'โหดสัส 🔥',    depth: 8, noise: 0,    time: 1400, blunder: 0 }
  };

  const rnd = (arr) => arr[Math.floor(Math.random() * arr.length)];

  /* ---------- ประเมินกระดาน (มุมมองของ me) ---------- */
  function evaluate(board, size, winLen, me) {
    const opp = E.other(me);
    let score = 0;
    for (let r = 0; r < size; r++) {
      for (let c = 0; c < size; c++) {
        for (const [dr, dc] of E.DIRS) {
          const er = r + dr * (winLen - 1), ec = c + dc * (winLen - 1);
          if (!E.inB(er, ec, size)) continue;
          let mine = 0, theirs = 0;
          for (let k = 0; k < winLen; k++) {
            const v = board[(r + dr * k) * size + (c + dc * k)];
            if (v === me) mine++; else if (v === opp) theirs++;
          }
          if (mine && theirs) continue;                 // หน้าต่างตาย
          if (mine) score += W[Math.min(mine, 9)];
          else if (theirs) score -= W[Math.min(theirs, 9)] * 1.35;   // ให้ค่าป้องกันสูงกว่าเล็กน้อย
        }
      }
    }
    return score;
  }

  /* ---------- หาช่องที่ชนะทันที ---------- */
  function immediate(board, size, winLen, player) {
    for (let i = 0; i < board.length; i++) {
      if (board[i]) continue;
      board[i] = player;
      const w = E.winnerAt(board, size, winLen, i);
      board[i] = 0;
      if (w) return i;
    }
    return -1;
  }

  /* ---------- ช่องที่ควรพิจารณา (ตัดพื้นที่ว่างไกล ๆ ทิ้ง) ---------- */
  function candidates(board, size, radius = 2, limit = 0) {
    const empties = [];
    let hasStone = false;
    for (let i = 0; i < board.length; i++) { if (board[i]) { hasStone = true; break; } }
    if (!hasStone) return [Math.floor(size / 2) * size + Math.floor(size / 2)];
    if (size <= 4) return E.emptyCells(board);

    for (let r = 0; r < size; r++) {
      for (let c = 0; c < size; c++) {
        const i = r * size + c;
        if (board[i]) continue;
        let near = false;
        for (let dr = -radius; dr <= radius && !near; dr++) {
          for (let dc = -radius; dc <= radius; dc++) {
            const rr = r + dr, cc = c + dc;
            if (E.inB(rr, cc, size) && board[rr * size + cc]) { near = true; break; }
          }
        }
        if (near) empties.push(i);
      }
    }
    const list = empties.length ? empties : E.emptyCells(board);
    return limit ? list.slice(0, limit) : list;
  }

  function orderMoves(board, size, winLen, player, list, limit) {
    const scored = list.map(m => {
      board[m] = player;
      const s = evaluate(board, size, winLen, player);
      board[m] = 0;
      return { m, s };
    }).sort((a, b) => b.s - a.s);
    return (limit ? scored.slice(0, limit) : scored).map(x => x.m);
  }

  /* ---------- Negamax + Alpha-Beta ---------- */
  function negamax(b, size, winLen, player, depth, alpha, beta, last, deadline, ply) {
    if (E.winnerAt(b, size, winLen, last)) return -(WIN - ply);     // ฝ่ายที่ถึงตาเดินแพ้แล้ว
    const cands = candidates(b, size);
    if (!cands.length) return 0;                                    // เสมอ
    if (depth <= 0 || Date.now() > deadline) return evaluate(b, size, winLen, player);

    const ordered = size > 5 ? orderMoves(b, size, winLen, player, cands, 10) : cands;
    let best = -Infinity;
    for (const m of ordered) {
      b[m] = player;
      const v = -negamax(b, size, winLen, E.other(player), depth - 1, -beta, -alpha, m, deadline, ply + 1);
      b[m] = 0;
      if (v > best) best = v;
      if (best > alpha) alpha = best;
      if (alpha >= beta) break;
    }
    return best;
  }

  /* ---------- API หลัก ---------- */
  function think(opts) {
    const { board, size, winLen, me, level = 'hard' } = opts;
    const cfg = LEVELS[level] || LEVELS.hard;
    const b = board.slice();
    const opp = E.other(me);
    const empties = E.emptyCells(b);
    if (!empties.length) return -1;

    // เปิดเกม
    if (empties.length === b.length) {
      const center = Math.floor(size / 2) * size + Math.floor(size / 2);
      return level === 'easy' ? rnd(empties) : center;
    }

    const winNow = immediate(b, size, winLen, me);
    const blockNow = immediate(b, size, winLen, opp);

    if (level === 'easy') {
      if (winNow >= 0 && Math.random() < 0.5) return winNow;
      if (blockNow >= 0 && Math.random() < 0.35) return blockNow;
      return rnd(empties);
    }
    if (winNow >= 0) return winNow;
    if (blockNow >= 0 && Math.random() > cfg.blunder) return blockNow;

    // ค้นหาลึกแบบ iterative deepening ภายใต้ time budget
    const deadline = Date.now() + cfg.time;
    const maxDepth = size === 3 ? Math.min(9, cfg.depth + 5) : cfg.depth;
    const baseCands = candidates(b, size);
    let best = rnd(baseCands), bestVal = -Infinity;

    for (let d = 1; d <= maxDepth; d++) {
      const ordered = size > 4 ? orderMoves(b, size, winLen, me, baseCands, 12) : baseCands;
      let localBest = -Infinity, localMove = best;
      for (const m of ordered) {
        b[m] = me;
        const v = -negamax(b, size, winLen, opp, d - 1, -Infinity, Infinity, m, deadline, 1);
        b[m] = 0;
        const jitter = cfg.noise ? (Math.random() - 0.5) * cfg.noise * 400 : 0;
        if (v + jitter > localBest) { localBest = v + jitter; localMove = m; }
        if (Date.now() > deadline) break;
      }
      best = localMove; bestVal = localBest;
      if (bestVal > WIN / 2) break;                 // เจอทางชนะบังคับแล้ว
      if (Date.now() > deadline) break;
    }
    return best;
  }

  /** คำใบ้สำหรับผู้เล่น = ให้บอทระดับสูงสุดคิดแทน */
  const hint = (board, size, winLen, me) => think({ board, size, winLen, me, level: 'insane' });

  return { LEVELS, think, hint, evaluate, immediate, candidates };
});