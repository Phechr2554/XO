/* XO ARENA — Socket.IO connection layer */
(function (root) {
  'use strict';
  let socket = null; const handlers = new Map();
  function on(ev, fn) { if (!handlers.has(ev)) handlers.set(ev, []); handlers.get(ev).push(fn); if (socket) socket.on(ev, fn); return () => off(ev, fn); }
  function off(ev, fn) { const arr = handlers.get(ev) || []; const i = arr.indexOf(fn); if (i >= 0) arr.splice(i, 1); if (socket) socket.off(ev, fn); }
  function emit(ev, data, ack) { if (socket) socket.emit(ev, data, ack); }
  function connect() {
    if (socket) { if (!socket.connected) socket.connect(); return socket; }
    if (typeof io === 'undefined') return null;
    socket = io({ transports: ['websocket', 'polling'], reconnectionAttempts: Infinity, reconnectionDelay: 800, withCredentials: true });
    handlers.forEach((fns, ev) => fns.forEach(fn => socket.on(ev, fn)));
    socket.on('connect', () => { socket.emit('hello'); fire('net:up'); });
    socket.on('disconnect', () => fire('net:down'));
    socket.on('connect_error', () => fire('net:error'));
    return socket;
  }
  function fire(ev, data) { (handlers.get(ev) || []).forEach(fn => fn(data)); }
  root.XONet = { connect, on, off, emit, fire, isConnected: () => !!(socket && socket.connected), get socket() { return socket; } };
})(window);
