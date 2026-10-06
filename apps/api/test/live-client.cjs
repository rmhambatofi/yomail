#!/usr/bin/env node
// Manual check for the Socket.IO gateway (docs/PLAN.md, Phase 4).
//
// Usage: node apps/api/test/live-client.cjs <endpointId> [BASE_URL] [--polling] [--duration=ms] [--prefix=api]
//   BASE_URL   default http://localhost:3000
//   --polling  force the HTTP long-polling transport (what Apache/Passenger ends up using)
//   --duration exit automatically after this many ms (default: run until Ctrl+C)
// Prints one line per event with a timestamp, and flags any `request:new` seen twice.
const { io } = require('socket.io-client');

const args = process.argv.slice(2);
const endpointId = args.find((a) => !a.startsWith('--') && /^[0-9a-f-]{36}$/i.test(a));
const base =
  args.find((a) => !a.startsWith('--') && /^https?:\/\//.test(a)) ?? 'http://localhost:3000';
const polling = args.includes('--polling');
const duration = Number(args.find((a) => a.startsWith('--duration='))?.slice(11) ?? 0);
const prefix = args.find((a) => a.startsWith('--prefix='))?.slice(9) ?? 'api';
if (!endpointId) {
  console.error('usage: live-client.cjs <endpointId> [BASE_URL] [--polling] [--duration=ms]');
  process.exit(2);
}

const seen = new Set();
const stamp = () => new Date().toISOString().slice(11, 23);
const log = (...parts) => console.log(stamp(), ...parts);

const socket = io(base, {
  path: `/${prefix}/socket.io`,
  transports: polling ? ['polling'] : ['polling', 'websocket'],
  reconnectionDelay: 500,
});

socket.on('connect', () => {
  log('connected', socket.id, 'transport=' + socket.io.engine.transport.name);
  socket.io.engine.on('upgrade', (t) => log('upgraded to', t.name));
  socket.emit('subscribe', { endpointId }, (ack) => log('subscribe ack', JSON.stringify(ack)));
});
socket.on('disconnect', (reason) => log('disconnected', reason));
socket.on('connect_error', (err) => log('connect_error', err.message));

socket.on('request:new', (r) => {
  const dup = seen.has(r.id);
  seen.add(r.id);
  log(
    dup ? 'DUPLICATE request:new' : 'request:new',
    r.method,
    r.path,
    r.id.slice(0, 8),
    r.content_kind,
    r.size_bytes + 'B',
  );
});
socket.on('request:deleted', (p) => log('request:deleted', p.id.slice(0, 8)));
socket.on('endpoint:cleared', (p) => log('endpoint:cleared', p.endpointId.slice(0, 8)));
socket.on('endpoint:deleted', (p) => log('endpoint:deleted', p.endpointId.slice(0, 8)));

if (duration > 0) {
  setTimeout(() => {
    log('done,', seen.size, 'distinct request(s)');
    socket.close();
    process.exit(0);
  }, duration);
}
