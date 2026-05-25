const path = require('path');
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

const PORT = process.env.PORT || 3000;
const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const CELEBRATION_MS = 2800;
const ROOM_IDLE_TTL_MS = 6 * 60 * 60 * 1000;

/** @type {Record<string, Room>} */
const rooms = {};

/** @type {Record<string, { code: string, drinkerIndex: number, role: 'host' | 'player' }>} */
const socketMeta = {};

function getPlayerIndex(socketId, room) {
  return room.players[socketId]?.drinkerIndex ?? -1;
}

function isTanggeroSocket(socketId, room) {
  const idx = getPlayerIndex(socketId, room);
  return idx >= 0 && idx === room.tanggeroIndex;
}

function canManageRoom(socketId, room) {
  if (room.creatorId && room.players[room.creatorId]) {
    if (room.creatorId === socketId) return true;
  }
  return isTanggeroSocket(socketId, room);
}

function isCreatorOnline(room) {
  return Boolean(room.creatorId && room.players[room.creatorId]);
}

function connectedSocketIds(room, exceptId = null) {
  return Object.keys(room.players).filter((sid) => sid !== exceptId);
}

function reassignCreator(room, leavingSocketId, code) {
  if (room.creatorId !== leavingSocketId) return;

  for (const sid of connectedSocketIds(room, leavingSocketId)) {
    room.creatorId = sid;
    const name = room.drinkers[room.players[sid].drinkerIndex];
    announce(code, `Si ${name} ang bahala sa room habang wala ang nag-setup`);
    return;
  }

  room.creatorId = null;
}

function transferTanggeroIfNeeded(room, leavingDrinkerIndex, code) {
  if (leavingDrinkerIndex !== room.tanggeroIndex) return;

  room.tanggeroIndex = pickFallbackTanggero(room, leavingDrinkerIndex);
  const nextName = room.drinkers[room.tanggeroIndex];
  announce(code, `Si ${nextName} ang tanggero na 🍺`);
}

function announce(code, message) {
  io.to(code).emit('room:announce', { message });
}

function pickFallbackTanggero(room, excludeIndex = -1) {
  const indices = Object.values(room.players)
    .map((p) => p.drinkerIndex)
    .filter((i) => i !== excludeIndex)
    .sort((a, b) => a - b);

  if (indices.length > 0) return indices[0];

  for (let i = 0; i < room.drinkers.length; i++) {
    if (i !== excludeIndex) return i;
  }
  return 0;
}

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

function initStats(length) {
  return Array.from({ length }, () => 0);
}

function completedSet(room) {
  return new Set([...room.drunkThisRound, ...room.skippedThisRound]);
}

function roomSnapshot(room) {
  return {
    code: room.code,
    drinkers: [...room.drinkers],
    status: room.status,
    round: room.round,
    currentIndex: room.currentIndex,
    drunkThisRound: [...room.drunkThisRound],
    skippedThisRound: [...room.skippedThisRound],
    celebrating: room.celebrating,
    drinkCounts: [...room.drinkCounts],
    skipCounts: [...room.skipCounts],
    tanggeroIndex: room.tanggeroIndex,
    creatorOnline: isCreatorOnline(room),
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

function touchRoom(room) {
  room.lastActiveAt = Date.now();
}

function broadcastRoom(code) {
  const room = rooms[code];
  if (!room) return;
  touchRoom(room);
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
  room.skippedThisRound = [];
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

function isRoundComplete(room) {
  return completedSet(room).size >= room.drinkers.length;
}

function advanceTurn(room, code) {
  const total = room.drinkers.length;
  const done = completedSet(room);

  if (done.size >= total) {
    startCelebration(code);
    return;
  }

  for (let i = 1; i <= total; i++) {
    const next = (room.currentIndex + i) % total;
    if (!done.has(next)) {
      room.currentIndex = next;
      return;
    }
  }
}

function canMarkShot(socketId, room) {
  if (room.status !== 'tracker' || room.celebrating) return false;
  const player = room.players[socketId];
  if (!player) return false;
  if (isTanggeroSocket(socketId, room)) return true;
  return player.drinkerIndex === room.currentIndex;
}

function canSkip(socketId, room) {
  if (room.status !== 'tracker' || room.celebrating) return false;
  if (isTanggeroSocket(socketId, room)) return true;
  const player = room.players[socketId];
  return player && player.drinkerIndex === room.currentIndex;
}

function attachSocketToRoom(socket, code, meta) {
  const room = rooms[code];
  if (!room) return false;

  const prev = socketMeta[socket.id];
  if (prev?.code && prev.code !== code) {
    socket.leave(prev.code);
  }

  socket.join(code);
  socketMeta[socket.id] = {
    code,
    drinkerIndex: meta.drinkerIndex,
    role: meta.role,
  };

  if (meta.role === 'host') {
    room.creatorId = socket.id;
    if (meta.drinkerIndex >= 0) {
      for (const [sid, p] of Object.entries(room.players)) {
        if (sid !== socket.id && p.drinkerIndex === meta.drinkerIndex) {
          delete room.players[sid];
        }
      }
      room.players[socket.id] = { drinkerIndex: meta.drinkerIndex };
    }
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
    if (meta.role === 'player' || meta.drinkerIndex >= 0) {
      delete room.players[socket.id];
    }
    socket.leave(meta.code);
  }
  delete socketMeta[socket.id];
}

function remapIndex(idx, removedIndex) {
  if (idx === removedIndex) return -1;
  if (idx > removedIndex) return idx - 1;
  return idx;
}

function findDrinkerByName(room, name) {
  const n = name.toLowerCase();
  return room.drinkers.findIndex((d) => d.toLowerCase() === n);
}

function buildDrinkerList(hostName, others) {
  const host = normalizeName(hostName);
  if (!host) return { error: 'Ilagay ang pangalan mo.' };

  const seen = new Set([host.toLowerCase()]);
  const list = [host];

  for (const raw of others || []) {
    const name = normalizeName(raw);
    if (!name) continue;
    const key = name.toLowerCase();
    if (!seen.has(key)) {
      seen.add(key);
      list.push(name);
    }
  }

  if (list.length < 2) {
    return { error: 'Magdagdag ng kahit isang kasama pa.' };
  }

  return { drinkers: list };
}

app.use(express.static(path.join(__dirname, 'public')));

app.get('/', (_req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

io.on('connection', (socket) => {
  socket.on('room:create', (payload, ack) => {
    const built = buildDrinkerList(payload?.hostName, payload?.drinkers);
    if (built.error) {
      ack?.({ ok: false, error: built.error });
      return;
    }

    const drinkers = built.drinkers;
    leaveRoom(socket);

    const code = generateRoomCode();
    const room = {
      code,
      creatorId: socket.id,
      creatorDrinkerIndex: 0,
      tanggeroIndex: 0,
      lastActiveAt: Date.now(),
      drinkers,
      status: 'tracker',
      round: 1,
      currentIndex: 0,
      drunkThisRound: [],
      skippedThisRound: [],
      celebrating: false,
      celebrationTimer: null,
      drinkCounts: initStats(drinkers.length),
      skipCounts: initStats(drinkers.length),
      players: {},
    };

    rooms[code] = room;
    attachSocketToRoom(socket, code, {
      drinkerIndex: 0,
      role: 'host',
    });

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
    const playerName = normalizeName(payload?.playerName || '');
    let drinkerIndex = Number(payload?.drinkerIndex);

    const room = rooms[code];
    if (!room) {
      ack?.({ ok: false, error: 'Hindi mahanap ang room code.' });
      return;
    }
    if (room.status === 'ended') {
      ack?.({ ok: false, error: 'Tapos na ang inuman sa room na ito.' });
      return;
    }

    if (playerName) {
      drinkerIndex = findDrinkerByName(room, playerName);
      if (drinkerIndex < 0) {
        ack?.({ ok: false, error: 'Wala ang pangalan mo sa listahan ng host.' });
        return;
      }
    }

    if (
      !Number.isInteger(drinkerIndex) ||
      drinkerIndex < 0 ||
      drinkerIndex >= room.drinkers.length
    ) {
      ack?.({ ok: false, error: 'Ilagay ang pangalan mo sa listahan.' });
      return;
    }

    const taken = Object.entries(room.players).some(
      ([sid, p]) => sid !== socket.id && p.drinkerIndex === drinkerIndex
    );
    if (taken) {
      ack?.({ ok: false, error: 'May naka-claim na sa pangalang ito.' });
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
      const idx =
        Number.isInteger(drinkerIndex) && drinkerIndex >= 0
          ? drinkerIndex
          : room.creatorDrinkerIndex ?? 0;
      leaveRoom(socket);
      attachSocketToRoom(socket, code, { drinkerIndex: idx, role: 'host' });
      if (!room.players[socket.id]) {
        room.players[socket.id] = { drinkerIndex: idx };
      }
      const name = room.drinkers[idx];
      announce(code, `Si ${name} ay bumalik — same room code`);
      ack?.({
        ok: true,
        code,
        state: roomSnapshot(room),
        role: 'host',
        drinkerIndex: idx,
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
    if (!room || !canManageRoom(socket.id, room)) {
      ack?.({ ok: false, error: 'Creator lang ang pwedeng mag-edit.' });
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
    room.drinkCounts.push(0);
    room.skipCounts.push(0);
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
    if (!room || !canManageRoom(socket.id, room)) {
      ack?.({ ok: false, error: 'Creator lang ang pwedeng mag-edit.' });
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
    if (index === 0) {
      ack?.({ ok: false, error: 'Hindi pwedeng alisin ang tagapag-setup.' });
      return;
    }
    if (index === room.tanggeroIndex) {
      ack?.({ ok: false, error: 'Hindi pwedeng alisin ang tanggero. Ilipat muna ang role.' });
      return;
    }
    if (room.drinkers.length <= 2) {
      ack?.({ ok: false, error: 'Hindi bababa sa 2 ang kailangan.' });
      return;
    }

    room.drinkers.splice(index, 1);
    room.drinkCounts.splice(index, 1);
    room.skipCounts.splice(index, 1);

    const remap = (idx) => remapIndex(idx, index);

    room.currentIndex = Math.min(
      Math.max(0, remap(room.currentIndex)),
      room.drinkers.length - 1
    );

    room.drunkThisRound = room.drunkThisRound
      .map(remap)
      .filter((i) => i >= 0);
    room.skippedThisRound = room.skippedThisRound
      .map(remap)
      .filter((i) => i >= 0);

    for (const [sid, p] of Object.entries(room.players)) {
      const next = remap(p.drinkerIndex);
      if (next < 0) {
        delete room.players[sid];
        const sock = io.sockets.sockets.get(sid);
        if (sock) {
          delete socketMeta[sid];
          sock.emit('room:kicked', {
            reason: 'Inalis ang pangalan mo sa grupo.',
          });
        }
      } else {
        p.drinkerIndex = next;
      }
    }

    const creatorMeta = socketMeta[room.creatorId];
    if (creatorMeta) {
      creatorMeta.drinkerIndex = remap(creatorMeta.drinkerIndex);
      if (creatorMeta.drinkerIndex < 0) creatorMeta.drinkerIndex = 0;
    }

    if (room.tanggeroIndex === index) {
      room.tanggeroIndex = pickFallbackTanggero(room);
    } else {
      room.tanggeroIndex = remap(room.tanggeroIndex);
      if (room.tanggeroIndex < 0) room.tanggeroIndex = 0;
    }

    ack?.({ ok: true });
    broadcastRoom(meta.code);
  });

  socket.on('tanggero:transfer', (payload, ack) => {
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
    if (!isTanggeroSocket(socket.id, room) && !canManageRoom(socket.id, room)) {
      ack?.({ ok: false, error: 'Tanggero o room manager lang ang pwedeng maglipat.' });
      return;
    }

    const targetIndex = Number(payload?.targetIndex);
    if (
      !Number.isInteger(targetIndex) ||
      targetIndex < 0 ||
      targetIndex >= room.drinkers.length
    ) {
      ack?.({ ok: false, error: 'Pumili ng kasama sa bilog.' });
      return;
    }

    room.tanggeroIndex = targetIndex;
    const name = room.drinkers[targetIndex];
    announce(meta.code, `Si ${name} ang tanggero na 🍺`);
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
      ack?.({ ok: false, error: 'Hindi mo pwedeng i-mark ngayon.' });
      return;
    }

    const idx = room.currentIndex;
    if (!room.drunkThisRound.includes(idx)) {
      room.drunkThisRound.push(idx);
    }
    room.drinkCounts[idx] = (room.drinkCounts[idx] || 0) + 1;

    if (isRoundComplete(room)) {
      startCelebration(meta.code);
      ack?.({ ok: true });
      return;
    }

    advanceTurn(room, meta.code);
    ack?.({ ok: true });
    broadcastRoom(meta.code);
  });

  socket.on('shot:skip', (_payload, ack) => {
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
    if (!canSkip(socket.id, room)) {
      ack?.({ ok: false, error: 'Hindi pwedeng mag-skip ngayon.' });
      return;
    }

    const idx = room.currentIndex;
    if (!room.skippedThisRound.includes(idx)) {
      room.skippedThisRound.push(idx);
    }
    room.skipCounts[idx] = (room.skipCounts[idx] || 0) + 1;

    if (isRoundComplete(room)) {
      startCelebration(meta.code);
      ack?.({ ok: true });
      return;
    }

    advanceTurn(room, meta.code);
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
    if (!room || !canManageRoom(socket.id, room)) {
      ack?.({ ok: false, error: 'Tanggero o room manager lang ang pwedeng mag-end.' });
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

  function handlePlayerExit(socket, room, meta) {
    const code = meta.code;
    const player = room.players[socket.id];
    const leavingDrinkerIndex = player?.drinkerIndex ?? -1;
    const wasCreator = socket.id === room.creatorId;

    if (player) {
      const name = room.drinkers[leavingDrinkerIndex] || 'May umalis';
      announce(code, `Si ${name} umalis sa room (pwede pa ring bumalik — same code)`);
    } else if (wasCreator) {
      announce(code, 'Ang nag-setup ay offline — tuloy pa rin ang room');
    }

    delete room.players[socket.id];

    reassignCreator(room, socket.id, code);

    if (leavingDrinkerIndex >= 0) {
      transferTanggeroIfNeeded(room, leavingDrinkerIndex, code);
    }

    const remaining = connectedSocketIds(room);
    if (remaining.length === 0) {
      touchRoom(room);
      announce(
        code,
        'Walang nakakonekta — room code valid pa rin. Mag-rejoin kapag bumalik.'
      );
    }

    socket.leave(code);
    delete socketMeta[socket.id];
    broadcastRoom(code);
  }

  socket.on('room:leave', (_payload, ack) => {
    const meta = socketMeta[socket.id];
    if (!meta) {
      ack?.({ ok: true });
      return;
    }
    const room = rooms[meta.code];
    if (room) handlePlayerExit(socket, room, meta);
    ack?.({ ok: true });
  });

  socket.on('disconnect', () => {
    const meta = socketMeta[socket.id];
    if (!meta) return;

    const room = rooms[meta.code];
    if (!room) {
      delete socketMeta[socket.id];
      return;
    }

    handlePlayerExit(socket, room, meta);
  });
});

setInterval(() => {
  const now = Date.now();
  for (const [code, room] of Object.entries(rooms)) {
    if (room.status === 'ended') continue;
    const empty = Object.keys(room.players).length === 0;
    if (empty && now - (room.lastActiveAt || 0) > ROOM_IDLE_TTL_MS) {
      destroyRoom(code);
    }
  }
}, 10 * 60 * 1000);

server.listen(PORT, () => {
  console.log(`Sino Na? server running on port ${PORT}`);
});
