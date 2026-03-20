// ============================================================
// ASTERION ONE — WebSocket Client (UI Subscriber)
// Connects to ws_gateway /ui path for live updates
// Ref: ws_gateway.js — UI broadcast channel
// ============================================================

const WS_URL = `ws://${window.location.hostname}:8081/ui`;

let socket = null;
let listeners = new Map();
let reconnectTimer = null;

export function connect() {
  if (socket && socket.readyState === WebSocket.OPEN) return;

  socket = new WebSocket(WS_URL);

  socket.onopen = () => {
    console.log('[ws] Connected to Ground gateway');
    emit('connection', { connected: true });
  };

  socket.onmessage = (event) => {
    try {
      const msg = JSON.parse(event.data);
      emit(msg.type, msg);
    } catch (err) {
      console.error('[ws] Parse error:', err);
    }
  };

  socket.onclose = () => {
    console.log('[ws] Disconnected — reconnecting in 3s');
    emit('connection', { connected: false });
    reconnectTimer = setTimeout(connect, 3000);
  };

  socket.onerror = () => {
    socket?.close();
  };
}

export function disconnect() {
  clearTimeout(reconnectTimer);
  if (socket) {
    socket.onclose = null; // prevent auto-reconnect
    socket.close();
    socket = null;
  }
}

export function on(type, callback) {
  if (!listeners.has(type)) listeners.set(type, new Set());
  listeners.get(type).add(callback);
  return () => listeners.get(type)?.delete(callback);
}

function emit(type, data) {
  listeners.get(type)?.forEach((cb) => {
    try { cb(data); } catch (err) { console.error('[ws] Listener error:', err); }
  });
}

export default { connect, disconnect, on };