const path = require('path');
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

const PORT = process.env.PORT || 3000;
const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const CELEBRATION_MS = 2200;

/** @type {Record<string, Room>} */
const rooms = {};

/** @type {Record<string, { code: string, drinkerIndex: number, role: 'host' | 'player' }>} */
const socketMeta = {};

/**
 * @typedef {Object} Room
 * @property {string} code
 * @property {string} hostId
 * @property {string[]} drinkers
 * @property {'tracker' | 'ended'} status
 * @property {number} round
 * @property {number} currentIndex
 * @property {number[]} drunkThisRound
 * @property {boolean} celebrating
 * @property {NodeJS.Timeout | null} celebrationTimer
 * @property {Record<string, { drinkerIndex: number }>} players
 */

function generateRoomCode() {
  let code;
  let attempts = 0;
  do {
    code = '';
    for (let i = 0; i < 4; i++) {
      code += CODE_CHARS[Math.floor(Math.random() * CODE_CHARS.length)];
    }
    attempts++;
  } while (rooms[code] && attempts < 50);
  return code;
}

function normalizeName(name) {
  return String(name).trim().replace(/\s+/g, ' ');
}

function roomSnapshot(room) {
  return {
    code: room.code,
    drinkers: [...room.drinkers],
    status: room.status,
    round: room.round,
    currentIndex: room.currentIndex,
    drunkThisRound: [...room.drunkThisRound],
    celebrating: room.celebrating,
    playerSlots: Object.fromEntries(
      Object.entries(room.players).map(([sid, p]) => [sid, p.drinkerIndex])
    ),
  };
}

function clearCelebrationTimer(room) {
  if (room.celebrationTimer) {
    clearTimeout(room.celebrationTimer);
    room.celebrationTimer = null;
  }
}

function broadcastRoom(code) {
  const room = rooms[code];
  if (!room) return;
  io.to(code).emit('room:state', roomSnapshot(room));
}

function destroyRoom(code) {
  const room = rooms[code];
  if (!room) return;
  clearCelebrationTimer(room);
  delete rooms[code];
}

function advanceAfterCelebration(code) {
  const room = rooms[code];
  if (!room || room.status !== 'tracker') return;
  room.round += 1;
  room.drunkThisRound = [];
  room.currentIndex = 0;
  room.celebrating = false;
  room.celebrationTimer = null;
  broadcastRoom(code);
}

function startCelebration(code) {
  const room = rooms[code];
  if (!room) return;
  room.celebrating = true;
  clearCelebrationTimer(room);
  broadcastRoom(code);
  room.celebrationTimer = setTimeout(() => {
    advanceAfterCelebration(code);
  }, CELEBRATION_MS);
}

function getSocketRole(socketId, room) {
  if (room.hostId === socketId) return 'host';
  return room.players[socketId] ? 'player' : null;
}

function canMarkShot(socketId, room) {
  if (room.status !== 'tracker' || room.celebrating) return false;
  const player = room.players[socketId];
  if (!player) return false;
  return player.drinkerIndex === room.currentIndex;
}

function attachSocketToRoom(socket, code, meta) {
  const room = rooms[code];
  if (!room) return false;

  const prev = socketMeta[socket.id];
  if (prev?.code && prev.code !== code) {
    socket.leave(prev.code);
  }

  socket.join(code);
  socketMeta[socket.id] = { code, drinkerIndex: meta.drinkerIndex, role: meta.role };

  if (meta.role === 'host') {
    room.hostId = socket.id;
  } else if (meta.drinkerIndex >= 0) {
    for (const [sid, p] of Object.entries(room.players)) {
      if (sid !== socket.id && p.drinkerIndex === meta.drinkerIndex) {
        delete room.players[sid];
      }
    }
    room.players[socket.id] = { drinkerIndex: meta.drinkerIndex };
  }

  return true;
}

function leaveRoom(socket) {
  const meta = socketMeta[socket.id];
  if (!meta) return;

  const room = rooms[meta.code];
  if (room) {
    if (meta.role === 'player') {
      delete room.players[socket.id];
    }
    socket.leave(meta.code);
  }
  delete socketMeta[socket.id];
}

app.use(express.static(path.join(__dirname, 'public')));

app.get('/', (_req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

io.on('connection', (socket) => {
  socket.on('room:create', (payload, ack) => {
    const drinkers = (payload?.drinkers || [])
      .map(normalizeName)
      .filter(Boolean);

    const seen = new Set();
    const unique = [];
    for (const name of drinkers) {
      const key = name.toLowerCase();
      if (!seen.has(key)) {
        seen.add(key);
        unique.push(name);
      }
    }

    if (unique.length < 2) {
      ack?.({ ok: false, error: 'Kailangan ng hindi bababa sa 2 pangalan.' });
      return;
    }

    leaveRoom(socket);

    const code = generateRoomCode();
    const room = {
      code,
      hostId: socket.id,
      drinkers: unique,
      status: 'tracker',
      round: 1,
      currentIndex: 0,
      drunkThisRound: [],
      celebrating: false,
      celebrationTimer: null,
      players: {},
    };

    rooms[code] = room;
    attachSocketToRoom(socket, code, {
      drinkerIndex: -1,
      role: 'host',
    });

    socket.to(code).emit('room:state', roomSnapshot(room));
    ack?.({ ok: true, code, state: roomSnapshot(room) });
    broadcastRoom(code);
  });

  socket.on('room:peek', (payload, ack) => {
    const code = String(payload?.code || '')
      .trim()
      .toUpperCase();
    const room = rooms[code];
    if (!room) {
      ack?.({ ok: false, error: 'Hindi mahanap ang room code.' });
      return;
    }
    if (room.status === 'ended') {
      ack?.({ ok: false, error: 'Tapos na ang inuman sa room na ito.', ended: true });
      return;
    }
    const takenIndices = Object.values(room.players).map((p) => p.drinkerIndex);
    ack?.({
      ok: true,
      drinkers: [...room.drinkers],
      status: room.status,
      takenIndices,
    });
  });

  socket.on('room:join', (payload, ack) => {
    const code = String(payload?.code || '')
      .trim()
      .toUpperCase();
    const drinkerIndex = Number(payload?.drinkerIndex);

    const room = rooms[code];
    if (!room) {
      ack?.({ ok: false, error: 'Hindi mahanap ang room code.' });
      return;
    }
    if (room.status === 'ended') {
      ack?.({ ok: false, error: 'Tapos na ang inuman sa room na ito.' });
      return;
    }
    if (
      !Number.isInteger(drinkerIndex) ||
      drinkerIndex < 0 ||
      drinkerIndex >= room.drinkers.length
    ) {
      ack?.({ ok: false, error: 'Pumili ng pangalan sa listahan.' });
      return;
    }

    leaveRoom(socket);
    attachSocketToRoom(socket, code, {
      drinkerIndex,
      role: 'player',
    });

    ack?.({
      ok: true,
      code,
      state: roomSnapshot(room),
      role: 'player',
      drinkerIndex,
    });
    broadcastRoom(code);
  });

  socket.on('room:rejoin', (payload, ack) => {
    const code = String(payload?.code || '')
      .trim()
      .toUpperCase();
    const drinkerIndex = Number(payload?.drinkerIndex);
    const role = payload?.role === 'host' ? 'host' : 'player';

    const room = rooms[code];
    if (!room) {
      ack?.({ ok: false, error: 'Hindi mahanap ang room code.' });
      return;
    }
    if (room.status === 'ended') {
      ack?.({ ok: false, error: 'Tapos na ang inuman.', ended: true });
      return;
    }

    if (role === 'host') {
      leaveRoom(socket);
      attachSocketToRoom(socket, code, { drinkerIndex: -1, role: 'host' });
      ack?.({
        ok: true,
        code,
        state: roomSnapshot(room),
        role: 'host',
        drinkerIndex: -1,
      });
      broadcastRoom(code);
      return;
    }

    if (
      !Number.isInteger(drinkerIndex) ||
      drinkerIndex < 0 ||
      drinkerIndex >= room.drinkers.length
    ) {
      ack?.({ ok: false, error: 'Invalid session.' });
      return;
    }

    leaveRoom(socket);
    attachSocketToRoom(socket, code, { drinkerIndex, role: 'player' });
    ack?.({
      ok: true,
      code,
      state: roomSnapshot(room),
      role: 'player',
      drinkerIndex,
    });
    broadcastRoom(code);
  });

  socket.on('drinkers:add', (payload, ack) => {
    const meta = socketMeta[socket.id];
    if (!meta) {
      ack?.({ ok: false, error: 'Walang room.' });
      return;
    }
    const room = rooms[meta.code];
    if (!room || room.hostId !== socket.id) {
      ack?.({ ok: false, error: 'Host lang ang pwedeng mag-edit.' });
      return;
    }
    if (room.status !== 'tracker' || room.celebrating) {
      ack?.({ ok: false, error: 'Hindi pwede ngayon.' });
      return;
    }

    const name = normalizeName(payload?.name);
    if (!name) {
      ack?.({ ok: false, error: 'Maglagay ng pangalan.' });
      return;
    }
    if (room.drinkers.some((d) => d.toLowerCase() === name.toLowerCase())) {
      ack?.({ ok: false, error: 'May ganyan na sa listahan.' });
      return;
    }

    room.drinkers.push(name);
    ack?.({ ok: true });
    broadcastRoom(meta.code);
  });

  socket.on('drinkers:remove', (payload, ack) => {
    const meta = socketMeta[socket.id];
    if (!meta) {
      ack?.({ ok: false, error: 'Walang room.' });
      return;
    }
    const room = rooms[meta.code];
    if (!room || room.hostId !== socket.id) {
      ack?.({ ok: false, error: 'Host lang ang pwedeng mag-edit.' });
      return;
    }
    if (room.status !== 'tracker' || room.celebrating) {
      ack?.({ ok: false, error: 'Hindi pwede ngayon.' });
      return;
    }

    const index = Number(payload?.index);
    if (
      !Number.isInteger(index) ||
      index < 0 ||
      index >= room.drinkers.length
    ) {
      ack?.({ ok: false, error: 'Invalid index.' });
      return;
    }
    if (room.drinkers.length <= 2) {
      ack?.({ ok: false, error: 'Hindi bababa sa 2 ang kailangan.' });
      return;
    }

    room.drinkers.splice(index, 1);

    const remap = (idx) => {
      if (idx === index) return -1;
      if (idx > index) return idx - 1;
      return idx;
    };

    room.currentIndex = Math.min(
      remap(room.currentIndex) < 0 ? 0 : remap(room.currentIndex),
      room.drinkers.length - 1
    );
    if (room.currentIndex < 0) room.currentIndex = 0;

    room.drunkThisRound = room.drunkThisRound
      .map(remap)
      .filter((i) => i >= 0);

    for (const [sid, p] of Object.entries(room.players)) {
      const next = remap(p.drinkerIndex);
      if (next < 0) {
        delete room.players[sid];
        const sock = io.sockets.sockets.get(sid);
        if (sock) {
          delete socketMeta[sid];
          sock.emit('room:kicked', { reason: 'Inalis ang pangalan mo sa grupo.' });
        }
      } else {
        p.drinkerIndex = next;
      }
    }

    const hostMeta = socketMeta[room.hostId];
    if (hostMeta && hostMeta.drinkerIndex >= 0) {
      hostMeta.drinkerIndex = remap(hostMeta.drinkerIndex);
    }

    ack?.({ ok: true });
    broadcastRoom(meta.code);
  });

  socket.on('shot:mark', (_payload, ack) => {
    const meta = socketMeta[socket.id];
    if (!meta) {
      ack?.({ ok: false, error: 'Walang room.' });
      return;
    }
    const room = rooms[meta.code];
    if (!room) {
      ack?.({ ok: false, error: 'Walang room.' });
      return;
    }
    if (!canMarkShot(socket.id, room)) {
      ack?.({ ok: false, error: 'Hindi pa ikaw ang turno.' });
      return;
    }

    const idx = room.currentIndex;
    if (!room.drunkThisRound.includes(idx)) {
      room.drunkThisRound.push(idx);
    }

    const total = room.drinkers.length;
    if (room.drunkThisRound.length >= total) {
      startCelebration(meta.code);
      ack?.({ ok: true });
      return;
    }

    room.currentIndex = (idx + 1) % total;
    ack?.({ ok: true });
    broadcastRoom(meta.code);
  });

  socket.on('session:end', (_payload, ack) => {
    const meta = socketMeta[socket.id];
    if (!meta) {
      ack?.({ ok: false, error: 'Walang room.' });
      return;
    }
    const room = rooms[meta.code];
    if (!room || room.hostId !== socket.id) {
      ack?.({ ok: false, error: 'Host lang ang pwedeng mag-end.' });
      return;
    }

    clearCelebrationTimer(room);
    room.status = 'ended';
    room.celebrating = false;
    io.to(meta.code).emit('session:ended');
    ack?.({ ok: true });

    setTimeout(() => {
      destroyRoom(meta.code);
    }, 60000);
  });

  socket.on('disconnect', () => {
    const meta = socketMeta[socket.id];
    if (!meta) return;

    const room = rooms[meta.code];
    if (!room) {
      delete socketMeta[socket.id];
      return;
    }

    if (meta.role === 'player') {
      delete room.players[socket.id];
    }

    delete socketMeta[socket.id];
    broadcastRoom(meta.code);
  });
});

server.listen(PORT, () => {
  console.log(`Sino Na? server running on port ${PORT}`);
});
