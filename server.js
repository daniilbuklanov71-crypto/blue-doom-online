const express = require('express');
const http = require('http');
const { randomUUID } = require('crypto');
const { Server } = require('socket.io');

const app = express();

// CORS: разрешаем GitHub Pages загружать рейтинг
app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: '*', methods: ['GET', 'POST'] }
});

app.get('/', (_req, res) =>
  res.send('BLUE DOOM online server is running')
);

app.get('/health', (_req, res) =>
  res.json({ ok: true, game: 'BLUE DOOM' })
);

const SUPABASE_URL = (process.env.SUPABASE_URL || '').replace(/\/$/, '');
const SUPABASE_KEY =
  process.env.SUPABASE_SECRET_KEY ||
  process.env.SUPABASE_SERVICE_ROLE_KEY ||
  '';

function hasDatabase() {
  return Boolean(SUPABASE_URL && SUPABASE_KEY);
}

async function db(path, options = {}) {
  if (!hasDatabase()) throw new Error('Supabase is not configured');

  const response = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    ...options,
    headers: {
      apikey: SUPABASE_KEY,
      Authorization: `Bearer ${SUPABASE_KEY}`,
      'Content-Type': 'application/json',
      ...(options.headers || {})
    }
  });

  if (!response.ok) {
    throw new Error(
      `Supabase HTTP ${response.status}: ${(await response.text()).slice(0, 200)}`
    );
  }

  const text = await response.text();
  return text ? JSON.parse(text) : null;
}

function cleanNickname(value) {
  return String(value || 'Игрок')
    .replace(/[<>\u0000-\u001f]/g, '')
    .trim()
    .slice(0, 20) || 'Игрок';
}

function cleanPlayerId(value) {
  const id = String(value || '').trim();
  return /^[A-Za-z0-9_-]{8,80}$/.test(id) ? id : randomUUID();
}

async function saveRound(winner, loser) {
  if (!hasDatabase() || !winner || !loser) return;

  try {
    for (const [player, won] of [[winner, true], [loser, false]]) {
      const id = encodeURIComponent(player.playerId);
      const found = await db(
        `player_stats?player_id=eq.${id}&select=kills,deaths`
      );

      const old = found && found[0]
        ? found[0]
        : { kills: 0, deaths: 0 };

      const payload = {
        player_id: player.playerId,
        nickname: cleanNickname(player.nickname),
        kills: Math.max(0, Number(old.kills) || 0) + (won ? 1 : 0),
        deaths: Math.max(0, Number(old.deaths) || 0) + (won ? 0 : 1),
        updated_at: new Date().toISOString()
      };

      await db('player_stats?on_conflict=player_id', {
        method: 'POST',
        headers: {
          Prefer: 'resolution=merge-duplicates,return=minimal'
        },
        body: JSON.stringify(payload)
      });
    }

    console.log('BLUE DOOM: round stats saved');
  } catch (error) {
    console.error('Leaderboard save failed:', error.message);
  }
}

app.get('/leaderboard', async (_req, res) => {
  if (!hasDatabase()) {
    return res.status(503).json({
      error: 'Leaderboard database is not configured'
    });
  }

  try {
    const rows = await db(
      'player_stats?select=player_id,nickname,kills,deaths&order=kills.desc,updated_at.asc&limit=50'
    );

    res.set('Cache-Control', 'no-store');
    res.json(rows || []);
  } catch (error) {
    console.error('Leaderboard load failed:', error.message);
    res.status(502).json({ error: 'Could not load leaderboard' });
  }
});

const rooms = new Map();

function roomCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let result = '';
  for (let i = 0; i < 6; i++) {
    result += chars[Math.floor(Math.random() * chars.length)];
  }
  return result;
}

function publicState(p) {
  return p && p.state
    ? p.state
    : {
        x: p.slot === 1 ? 2.5 : 13.5,
        y: p.slot === 1 ? 2.5 : 9.5,
        a: 0,
        hp: p.hp,
        floor: 0,
        weapon: 'ak'
      };
}

function roomOf(socket) {
  return socket.data.room ? rooms.get(socket.data.room) : null;
}

function findPlayer(room, socket) {
  return room && room.players.find(p => p && p.id === socket.id);
}

function opponent(room, socket) {
  return room && room.players.find(p => p && p.id !== socket.id);
}

function startRound(room) {
  room.roundOver = false;
  for (const p of room.players) {
    if (p) {
      p.hp = 100;
      p.state = null;
    }
  }
  io.to(room.code).emit('round-start', {
    round: room.round,
    scores: room.scores.slice()
  });
}

function endRound(room, winnerSlot) {
  if (!room || room.roundOver) return;

  room.roundOver = true;
  room.scores[winnerSlot - 1]++;

  const winner = room.players[winnerSlot - 1];
  const loser = room.players[winnerSlot === 1 ? 1 : 0];

  if (winner && loser) void saveRound(winner, loser);

  io.to(room.code).emit('round-end', {
    round: room.round,
    winnerSlot,
    scores: room.scores.slice()
  });

  if (room.round >= 10) {
    setTimeout(() => {
      if (!rooms.has(room.code)) return;

      const matchWinner = room.scores[0] === room.scores[1]
        ? 0
        : room.scores[0] > room.scores[1] ? 1 : 2;

      io.to(room.code).emit('match-end', {
        winnerSlot: matchWinner,
        scores: room.scores.slice(),
        rounds: 10
      });
    }, 1800);
  } else {
    setTimeout(() => {
      if (!rooms.has(room.code)) return;
      room.round++;
      startRound(room);
    }, 2600);
  }
}

io.on('connection', socket => {
  socket.data.profile = {
    playerId: randomUUID(),
    nickname: 'Игрок'
  };

  socket.on('profile', data => {
    socket.data.profile = {
      playerId: cleanPlayerId(data && data.playerId),
      nickname: cleanNickname(data && data.nickname)
    };
  });

  socket.on('create', () => {
    let c;
    do {
      c = roomCode();
    } while (rooms.has(c));

    const profile = socket.data.profile;
    const room = {
      code: c,
      players: [null, null],
      round: 1,
      scores: [0, 0],
      roundOver: false
    };

    room.players[0] = {
      id: socket.id,
      playerId: profile.playerId,
      nickname: profile.nickname,
      slot: 1,
      hp: 100,
      state: null
    };

    rooms.set(c, room);
    socket.data.room = c;
    socket.join(c);
    socket.emit('room', { code: c });
  });

  socket.on('join', data => {
    const c = String(data && data.code || '').toUpperCase();
    const room = rooms.get(c);

    if (!room) {
      socket.emit('room-error', {
        message: 'Комната не найдена. Проверь код.'
      });
      return;
    }

    if (room.players[1]) {
      socket.emit('room-error', {
        message: 'Комната уже заполнена.'
      });
      return;
    }

    const profile = socket.data.profile;
    room.players[1] = {
      id: socket.id,
      playerId: profile.playerId,
      nickname: profile.nickname,
      slot: 2,
      hp: 100,
      state: null
    };

    socket.data.room = c;
    socket.join(c);

    const a = room.players[0];
    const b = room.players[1];

    io.to(a.id).emit('ready', {
      code: c,
      slot: 1,
      round: room.round,
      scores: room.scores.slice(),
      opponent: publicState(b),
      opponentNickname: b.nickname
    });

    io.to(b.id).emit('ready', {
      code: c,
      slot: 2,
      round: room.round,
      scores: room.scores.slice(),
      opponent: publicState(a),
      opponentNickname: a.nickname
    });
  });

  socket.on('state', data => {
    const room = roomOf(socket);
    const p = findPlayer(room, socket);
    const o = opponent(room, socket);

    if (!p || !o || room.roundOver || !data) return;

    const x = Number(data.x);
    const y = Number(data.y);
    const a = Number(data.a);
    if (![x, y, a].every(Number.isFinite)) return;

    p.state = {
      x: Math.max(0, Math.min(40, x)),
      y: Math.max(0, Math.min(40, y)),
      a,
      hp: p.hp,
      floor: Number(data.floor) || 0,
      weapon: typeof data.weapon === 'string'
        ? data.weapon.slice(0, 12)
        : 'ak'
    };

    io.to(o.id).emit('state', p.state);
  });

  socket.on('hit', data => {
    const room = roomOf(socket);
    const attacker = findPlayer(room, socket);
    const target = opponent(room, socket);

    if (!room || !attacker || !target || room.roundOver || !data) return;

    const damage = Math.max(
      1,
      Math.min(100, Math.round(Number(data.damage) || 0))
    );

    target.hp = Math.max(0, target.hp - damage);

    io.to(target.id).emit('hit', {
      hp: target.hp,
      damage,
      by: attacker.slot,
      source: data.source === 'grenade' ? 'grenade' : 'weapon'
    });

    if (target.hp <= 0) endRound(room, attacker.slot);
  });

  socket.on('shoot', data => {
    const room = roomOf(socket);
    const p = findPlayer(room, socket);
    const o = opponent(room, socket);

    if (!room || !p || !o || room.roundOver || !data) return;

    const a = Number(data.a);
    if (!Number.isFinite(a)) return;

    io.to(o.id).emit('opponent-shoot', {
      a,
      x: Number(data.x) || 0,
      y: Number(data.y) || 0,
      weapon: typeof data.weapon === 'string' ? data.weapon : 'ak',
      floor: Number(data.floor) || 0
    });
  });

  socket.on('grenade', data => {
    const room = roomOf(socket);
    const p = findPlayer(room, socket);
    const o = opponent(room, socket);

    if (!room || !p || !o || room.roundOver || !data) return;

    const x = Number(data.x);
    const y = Number(data.y);
    if (!Number.isFinite(x) || !Number.isFinite(y)) return;

    io.to(o.id).emit('opponent-grenade', {
      x,
      y,
      floor: Number(data.floor) || 0,
      z: Number(data.z) || 0.45,
      vx: Number(data.vx) || 0,
      vy: Number(data.vy) || 0,
      vz: Number(data.vz) || 0,
      fuse: Math.max(0.1, Math.min(3, Number(data.fuse) || 1.75))
    });
  });

  socket.on('respawn', () => {});

  socket.on('disconnect', () => {
    const room = roomOf(socket);
    if (!room) return;

    const idx = room.players.findIndex(p => p && p.id === socket.id);
    if (idx >= 0) room.players[idx] = null;

    socket.to(room.code).emit('opponent-left');
    if (room.players.every(p => !p)) rooms.delete(room.code);
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`BLUE DOOM server listening on ${PORT}`);
});
