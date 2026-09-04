/* XO ARENA — ชั้นเชื่อมต่อ Socket.IO พร้อม token authentication */
(function (root) {
  'use strict';
  let socket = null;
  let authToken = '';
  const handlers = new Map();

  function on(ev, fn) {
    if (!handlers.has(ev)) handlers.set(ev, []);
    handlers.get(ev).push(fn);
    if (socket) socket.on(ev, fn);
    return () => off(ev, fn);
  }
  function off(ev, fn) {
    const arr = handlers.get(ev) || [];
    const i = arr.indexOf(fn);
    if (i >= 0) arr.splice(i, 1);
    if (socket) socket.off(ev, fn);
  }
  function emit(ev, data, ack) { if (socket && socket.connected) socket.emit(ev, data, ack); }

  function connect(token) {
    authToken = String(token || '');
    if (!authToken || typeof io === 'undefined') return null;
    if (socket) {
      socket.auth = { token: authToken };
      if (!socket.connected) socket.connect();
      return socket;
    }
    socket = io({ auth: { token: authToken }, transports: ['websocket', 'polling'], reconnectionAttempts: Infinity, reconnectionDelay: 800 });
    handlers.forEach((fns, ev) => fns.forEach(fn => socket.on(ev, fn)));
    socket.on('connect', () => fire('net:up'));
    socket.on('disconnect', reason => fire('net:down', reason));
    socket.on('connect_error', err => fire('net:error', err));
    return socket;
  }
  function disconnect() { if (socket) socket.disconnect(); }
  function fire(ev, data) { (handlers.get(ev) || []).forEach(fn => fn(data)); }
  const isConnected = () => !!(socket && socket.connected);
  root.XONet = { connect, disconnect, on, off, emit, fire, isConnected, get socket() { return socket; } };
})(window);
