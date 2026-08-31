/* XO ARENA — Shared Engine (ใช้ได้ทั้ง Browser และ Node) */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.XOEngine = factory();
})(typeof self !== 'undefined' ? self : globalThis, function () {
  'use strict';

  const EMPTY = 0, X = 1, O = 2;
  const DIRS = [[0, 1], [1, 0], [1, 1], [1, -1]];

  const PRESETS = {
    classic: { id: 'classic', size: 3, winLen: 3, turnMs: 20000, label: 'คลาสสิก 3×3', desc: 'ต่อ 3 ช่อง • ตำนานดั้งเดิม' },
    medium:  { id: 'medium',  size: 4, winLen: 4, turnMs: 25000, label: 'กลาง 4×4',    desc: 'ต่อ 4 ช่อง • คิดเยอะขึ้น' },
    large:   { id: 'large',   size: 5, winLen: 4, turnMs: 30000, label: 'ใหญ่ 5×5',     desc: 'ต่อ 4 ช่อง • เปิดกว้าง' },
    gomoku:  { id: 'gomoku',  size: 9, winLen: 5, turnMs: 40000, label: 'โกโมกุ 9×9',   desc: 'ต่อ 5 ช่อง • โหดจริง' }
  };

  const create = (size) => new Array(size * size).fill(EMPTY);
  const other = (p) => (p === X ? O : X);
  const inB = (r, c, n) => r >= 0 && c >= 0 && r < n && c < n;

  /** ตรวจผู้ชนะโดยดูจากหมากตัวล่าสุด (เร็ว) */
  function winnerAt(board, size, winLen, last) {
    if (last == null || last < 0) return null;
    const p = board[last];
    if (!p) return null;
    const r0 = Math.floor(last / size), c0 = last % size;
    for (const [dr, dc] of DIRS) {
      const cells = [last];
      for (let s = 1; s < winLen; s++) {
        const r = r0 - dr * s, c = c0 - dc * s;
        if (!inB(r, c, size) || board[r * size + c] !== p) break;
        cells.unshift(r * size + c);
      }
      for (let s = 1; s < winLen; s++) {
        const r = r0 + dr * s, c = c0 + dc * s;
        if (!inB(r, c, size) || board[r * size + c] !== p) break;
        cells.push(r * size + c);
      }
      if (cells.length >= winLen) return { winner: p, line: cells };
    }
    return null;
  }

  /** สแกนทั้งกระดาน (ใช้ตอนโหลด state ใหม่) */
  function findWinner(board, size, winLen) {
    for (let r = 0; r < size; r++) {
      for (let c = 0; c < size; c++) {
        const p = board[r * size + c];
        if (!p) continue;
        for (const [dr, dc] of DIRS) {
          const er = r + dr * (winLen - 1), ec = c + dc * (winLen - 1);
          if (!inB(er, ec, size)) continue;
          const line = [];
          let ok = true;
          for (let k = 0; k < winLen; k++) {
            const i = (r + dr * k) * size + (c + dc * k);
            if (board[i] !== p) { ok = false; break; }
            line.push(i);
          }
          if (ok) return { winner: p, line };
        }
      }
    }
    return null;
  }

  const isFull = (board) => board.every(v => v !== EMPTY);
  const emptyCells = (board) => board.reduce((a, v, i) => (v === EMPTY && a.push(i), a), []);

  function status(board, size, winLen, last) {
    const w = (last != null && last >= 0) ? winnerAt(board, size, winLen, last) : findWinner(board, size, winLen);
    if (w) return { over: true, winner: w.winner, line: w.line, draw: false };
    if (isFull(board)) return { over: true, winner: EMPTY, line: [], draw: true };
    return { over: false, winner: EMPTY, line: [], draw: false };
  }

  return { EMPTY, X, O, DIRS, PRESETS, create, other, inB, winnerAt, findWinner, isFull, emptyCells, status };
});