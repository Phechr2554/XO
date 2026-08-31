/* XO ARENA — เสียงสังเคราะห์ด้วย WebAudio (ไม่ต้องมีไฟล์เสียงเลย) */
(function (root) {
  'use strict';
  let ctx = null, master = null, enabled = true, volume = 0.5;

  function init() {
    if (ctx) return ctx;
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return null;
    ctx = new AC();
    master = ctx.createGain();
    master.gain.value = volume;
    master.connect(ctx.destination);
    return ctx;
  }

  function tone(freq, dur = 0.12, type = 'sine', delay = 0, gain = 0.3) {
    if (!enabled) return;
    const c = init(); if (!c) return;
    if (c.state === 'suspended') c.resume();
    const t0 = c.currentTime + delay;
    const osc = c.createOscillator();
    const g = c.createGain();
    osc.type = type;
    osc.frequency.setValueAtTime(freq, t0);
    g.gain.setValueAtTime(0.0001, t0);
    g.gain.exponentialRampToValueAtTime(gain, t0 + 0.012);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
    osc.connect(g); g.connect(master);
    osc.start(t0); osc.stop(t0 + dur + 0.02);
  }

  function noise(dur = 0.2, gain = 0.15) {
    if (!enabled) return;
    const c = init(); if (!c) return;
    const buf = c.createBuffer(1, c.sampleRate * dur, c.sampleRate);
    const d = buf.getChannelData(0);
    for (let i = 0; i < d.length; i++) d[i] = (Math.random() * 2 - 1) * (1 - i / d.length);
    const src = c.createBufferSource(); src.buffer = buf;
    const g = c.createGain(); g.gain.value = gain;
    src.connect(g); g.connect(master); src.start();
  }

  const SFX = {
    click:  () => tone(520, 0.06, 'triangle', 0, 0.18),
    placeX: () => { tone(440, 0.10, 'square', 0, 0.22); tone(660, 0.08, 'sine', 0.03, 0.14); },
    placeO: () => { tone(330, 0.10, 'sawtooth', 0, 0.18); tone(495, 0.08, 'sine', 0.03, 0.12); },
    win:    () => [523, 659, 784, 1047].forEach((f, i) => tone(f, 0.25, 'triangle', i * 0.09, 0.28)),
    lose:   () => [392, 349, 294, 220].forEach((f, i) => tone(f, 0.28, 'sine', i * 0.11, 0.24)),
    draw:   () => [440, 440].forEach((f, i) => tone(f, 0.2, 'sine', i * 0.16, 0.2)),
    tick:   () => tone(880, 0.04, 'sine', 0, 0.10),
    warn:   () => tone(1200, 0.07, 'square', 0, 0.16),
    msg:    () => { tone(880, 0.06, 'sine', 0, 0.14); tone(1180, 0.06, 'sine', 0.06, 0.12); },
    match:  () => [523, 784, 1047].forEach((f, i) => tone(f, 0.18, 'triangle', i * 0.08, 0.26)),
    error:  () => { tone(180, 0.16, 'square', 0, 0.2); noise(0.1, 0.06); },
    unlock: () => [659, 880, 1319].forEach((f, i) => tone(f, 0.22, 'triangle', i * 0.1, 0.3))
  };

  root.XOAudio = {
    play: (n) => SFX[n] && SFX[n](),
    setEnabled: (v) => { enabled = !!v; if (enabled) init(); },
    setVolume: (v) => { volume = Math.max(0, Math.min(1, v)); if (master) master.gain.value = volume; },
    unlock: () => { const c = init(); if (c && c.state === 'suspended') c.resume(); }
  };
})(window);