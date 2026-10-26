
const express = require('express');
const http = require('http');
const {
  randomUUID,
  randomBytes,
  scryptSync,
  timingSafeEqual,
  createHash
} = require('crypto');
const { Server } = require('socket.io');

const app = express();

app.use(express.json({ limit: '100kb' }));

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

app.get('/', (_req, res) => {
  res.send('BLUE DOOM online server is running');
});

app.get('/health', (_req, res) => {
  res.json({ ok: true, game: 'BLUE DOOM' });
});

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

      const old = found && found[0] ? found[0] : { kills: 0, deaths: 0 };
      const payload = {
        player_id: player.playerId,
        nickname: cleanNickname(player.nickname),
        kills: Math.max(0, Number(old.kills) || 0) + (won ? 1 : 0),
        deaths: Math.max(0, Number(old.deaths) || 0) + (won ? 0 : 1),
        updated_at: new Date().toISOString()
      };

      await db('player_stats?on_conflict=player_id', {
        method: 'POST',
        headers: { Prefer: 'resolution=merge-duplicates,return=minimal' },
        body: JSON.stringify(payload)
      });
    }
    console.log('BLUE DOOM: round stats saved');
  } catch (error) {
    console.error('Leaderboard save failed:', error.message);
  }
}

// Облачные аккаунты BLUE DOOM
function accountName(v) {
  return String(v || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_.-]/g, '')
    .slice(0, 20);
}

function hashPassword(password, salt) {
  return scryptSync(String(password), salt, 64).toString('hex');
}

function tokenHash(token) {
  return createHash('sha256').update(token).digest('hex');
}

async function findAccount(username) {
  const u = encodeURIComponent(username);
  const rows = await db(
    `blue_doom_profiles?username=eq.${u}&select=username,password_salt,password_hash,token_hash,profile,updated_at`
  );
  return rows && rows[0] || null;
}

async function saveAccount(row) {
  await db('blue_doom_profiles?on_conflict=username', {
    method: 'POST',
    headers: { Prefer: 'resolution=merge-duplicates,return=minimal' },
    body: JSON.stringify(row)
  });
}

function bearer(req) {
  const h = String(req.headers.authorization || '');
  return h.startsWith('Bearer ') ? h.slice(7) : '';
}

async function authAccount(req) {
  const token = bearer(req);
  if (!token) return null;

  const hash = tokenHash(token);
  const rows = await db(
    `blue_doom_profiles?token_hash=eq.${encodeURIComponent(hash)}&select=username,profile&limit=1`
  );
  return rows && rows[0] || null;
}

function safeProfile(p) {
  const src = p && typeof p === 'object' ? p : {};
  const s = src.stats && typeof src.stats === 'object' ? src.stats : {};
  const clean = {};

  const numeric = ['kills', 'deaths', 'coins', 'rankPaid', 'johnBossKills'];
  const booleans = [
    'saw', 'hammer', 'pepper', 'uzi', 'sniper', 'flamethrower',
    'grenLauncher', 'bossRewardClaimed', 'rafaelRewardClaimed',
    'batyaRewardClaimed'
  ];
  const allowed = [
    ...numeric, ...booleans, 'sidearm', 'melee'
  ];

  for (const k of allowed) {
    if (k in s) clean[k] = s[k];
  }

  for (const k of numeric) {
    clean[k] = Math.max(
      0,
      Math.min(100000000, Number(clean[k]) || 0) | 0
    );
  }

  for (const k of booleans) clean[k] = !!clean[k];

  clean.sidearm = clean.sidearm === 'uzi' && clean.uzi ? 'uzi' : 'pm';
  clean.melee = ['saw', 'pep', 'hammer'].includes(clean.melee)
    ? clean.melee
    : 'kn';

  return {
    stats: clean,
    playSeconds: Math.max(
      0,
      Math.min(100000000, Number(src.playSeconds) || 0) | 0
    )
  };
}

app.post('/profile/register', async (req, res) => {
  try {
    if (!hasDatabase()) {
      return res.status(503).json({ error: 'Supabase не настроен' });
    }

    const username = accountName(req.body && req.body.username);
    const password = String(req.body && req.body.password || '');

    if (username.length < 3) {
      return res.status(400).json({
        error: 'Никнейм: минимум 3 символа (латиница/цифры/._-)'
      });
    }

    if (password.length < 6 || password.length > 200) {
      return res.status(400).json({
        error: 'Пароль должен быть длиной от 6 символов'
      });
    }

    if (await findAccount(username)) {
      return res.status(409).json({ error: 'Этот аккаунт уже существует' });
    }

    const salt = randomBytes(16).toString('hex');
    const token = randomBytes(32).toString('hex');
    const profile = safeProfile(req.body && req.body.profile);

    await saveAccount({
      username,
      password_salt: salt,
      password_hash: hashPassword(password, salt),
      token_hash: tokenHash(token),
      profile,
      updated_at: new Date().toISOString()
    });

    res.json({ token, username, profile });
  } catch (e) {
    console.error('profile register:', e.message);
    res.status(500).json({
      error: 'Не удалось создать профиль. Проверьте таблицу Supabase.'
    });
  }
});

app.post('/profile/login', async (req, res) => {
  try {
    if (!hasDatabase()) {
      return res.status(503).json({ error: 'Supabase не настроен' });
    }

    const username = accountName(req.body && req.body.username);
    const password = String(req.body && req.body.password || '');
    const row = await findAccount(username);

    if (!row) {
      return res.status(401).json({ error: 'Неверный никнейм или пароль' });
    }

    const got = Buffer.from(hashPassword(password, row.password_salt), 'hex');
    const want = Buffer.from(row.password_hash, 'hex');

    if (got.length !== want.length || !timingSafeEqual(got, want)) {
      return res.status(401).json({ error: 'Неверный никнейм или пароль' });
    }

    const token = randomBytes(32).toString('hex');

    await saveAccount({
      username,
      password_salt: row.password_salt,
      password_hash: row.password_hash,
      token_hash: tokenHash(token),
      profile: row.profile || { stats: {}, playSeconds: 0 },
      updated_at: new Date().toISOString()
    });

    res.json({
      token,
      username,
      profile: row.profile || { stats: {}, playSeconds: 0 }
    });
  } catch (e) {
    console.error('profile login:', e.message);
    res.status(500).json({ error: 'Не удалось войти в аккаунт' });
  }
});

app.get('/profile/me', async (req, res) => {
  try {
    if (!hasDatabase()) {
      return res.status(503).json({ error: 'Supabase не настроен' });
    }

    const account = await authAccount(req);
    if (!account) return res.status(401).json({ error: 'Сессия истекла' });

    res.set('Cache-Control', 'no-store');
    res.json({
      username: account.username,
      profile: account.profile || { stats: {}, playSeconds: 0 }
    });
  } catch (e) {
    res.status(500).json({ error: 'Не удалось загрузить профиль' });
  }
});

app.post('/profile/save', async (req, res) => {
  try {
    if (!hasDatabase()) {
      return res.status(503).json({ error: 'Supabase не настроен' });
    }

    const account = await authAccount(req);
    if (!account) return res.status(401).json({ error: 'Сессия истекла' });

    const token = bearer(req);
    const existing = await findAccount(account.username);
    if (!existing) {
      return res.status(401).json({ error: 'Аккаунт не найден' });
    }

    await saveAccount({
      username: account.username,
      password_salt: existing.password_salt,
      password_hash: existing.password_hash,
      token_hash: tokenHash(token),
      profile: safeProfile(req.body),
      updated_at: new Date().toISOString()
    });

    res.json({ ok: true });
  } catch (e) {
    console.error('profile save:', e.message);
    res.status(500).json({ error: 'Не удалось сохранить профиль' });
  }
});

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
  return p && p.state ? p.state : {
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

function opponents(room, socket) {
  const self = findPlayer(room, socket);
  return room && self ? room.players.filter(
    p => p && p.id !== socket.id &&
      (room.mode !== '2v2' || p.team !== self.team)
  ) : [];
}

function livingTeam(room, team) {
  return room.players.filter(p => p && p.team === team && p.hp > 0).length;
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

function endRound(room, winnerTeam) {
  if (!room || room.roundOver) return;
  room.roundOver = true;
  room.scores[winnerTeam - 1]++;

  const winners = room.players.filter(p => p && p.team === winnerTeam);
  const losers = room.players.filter(p => p && p.team !== winnerTeam);

  if (room.mode === '1v1' && winners[0] && losers[0]) {
    void saveRound(winners[0], losers[0]);
  }

  io.to(room.code).emit('round-end', {
    round: room.round,
    winnerSlot: winners[0] ? winners[0].slot : winnerTeam,
    winnerTeam,
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
        winnerTeam: matchWinner,
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
  socket.data.profile = { playerId: randomUUID(), nickname: 'Игрок' };

  socket.on('profile', data => {
    socket.data.profile = {
      playerId: cleanPlayerId(data && data.playerId),
      nickname: cleanNickname(data && data.nickname)
    };
  });

  socket.on('create', data => {
    let c;
    do {
      c = roomCode();
    } while (rooms.has(c));

    const profile = socket.data.profile;
    const room = {
      code: c,
      mode: data && data.mode === '2v2' ? '2v2' : '1v1',
      players: [null, null, null, null],
      round: 1,
      scores: [0, 0],
      roundOver: false
    };

    room.players[0] = {
      id: socket.id,
      playerId: profile.playerId,
      nickname: profile.nickname,
      slot: 1,
      team: 1,
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

    const requestedMode = data && data.mode === '2v2' ? '2v2' : '1v1';

    if (requestedMode !== room.mode) {
      socket.emit('room-error', {
        message: room.mode === '2v2'
          ? 'Это комната 2 на 2. Выбери режим 2 на 2.'
          : 'Это комната 1 на 1. Выбери режим 1 на 1.'
      });
      return;
    }

    const slotIndex = room.players.findIndex(p => !p);
    if (slotIndex < 0 || (room.mode === '1v1' && slotIndex > 1)) {
      socket.emit('room-error', { message: 'Комната уже заполнена.' });
      return;
    }

    const profile = socket.data.profile;
    room.players[slotIndex] = {
      id: socket.id,
      playerId: profile.playerId,
      nickname: profile.nickname,
      slot: slotIndex + 1,
      team: room.mode === '2v2' ? (slotIndex < 2 ? 1 : 2) : slotIndex + 1,
      hp: 100,
      state: null
    };

    socket.data.room = c;
    socket.join(c);

    const needed = room.mode === '2v2' ? 4 : 2;
    const count = room.players.filter(Boolean).length;

    if (count === needed) {
      for (const recipient of room.players.filter(Boolean)) {
        const others = room.players.filter(p => p && p.id !== recipient.id)
          .map(p => ({
            ...publicState(p),
            slot: p.slot,
            team: p.team,
            nickname: p.nickname
          }));

        io.to(recipient.id).emit('ready', {
          code: c,
          slot: recipient.slot,
          team: recipient.team,
          mode: room.mode,
          round: room.round,
          scores: room.scores.slice(),
          players: others,
          opponent: others[0] || null
        });
      }
    } else {
      socket.emit('waiting', { code: c, count, needed, mode: room.mode });
      for (const p of room.players.filter(Boolean)) {
        io.to(p.id).emit('waiting', { code: c, count, needed, mode: room.mode });
      }
    }
  });

  socket.on('state', data => {
    const room = roomOf(socket);
    const p = findPlayer(room, socket);
    if (!p || room.roundOver || !data) return;

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
      weapon: typeof data.weapon === 'string' ? data.weapon.slice(0, 12) : 'ak',
      slot: p.slot,
      team: p.team,
      nickname: p.nickname
    };

    for (const other of room.players) {
      if (other && other.id !== p.id) {
        io.to(other.id).emit('state', p.state);
      }
    }
  });

  socket.on('hit', data => {
    const room = roomOf(socket);
    const attacker = findPlayer(room, socket);
    if (!room || !attacker || room.roundOver || !data) return;

    const candidates = opponents(room, socket);
    const target = data.targetSlot
      ? candidates.find(p => p.slot === Number(data.targetSlot))
      : candidates.find(p => p.hp > 0);

    if (!target || target.hp <= 0) return;

    const damage = Math.max(1, Math.min(100, Math.round(Number(data.damage) || 0)));
    target.hp = Math.max(0, target.hp - damage);

    io.to(target.id).emit('hit', {
      hp: target.hp,
      damage,
      by: attacker.slot,
      source: data.source === 'grenade' ? 'grenade' : 'weapon',
      slot: target.slot
    });

    if (target.hp <= 0 && livingTeam(room, target.team) === 0) {
      endRound(room, attacker.team);
    }
  });

  socket.on('shoot', data => {
    const room = roomOf(socket);
    const p = findPlayer(room, socket);
    if (!room || !p || room.roundOver || !data) return;

    const a = Number(data.a);
    if (!Number.isFinite(a)) return;

    const payload = {
      a,
      x: Number(data.x) || 0,
      y: Number(data.y) || 0,
      weapon: typeof data.weapon === 'string' ? data.weapon : 'ak',
      floor: Number(data.floor) || 0,
      slot: p.slot,
      team: p.team
    };

    for (const other of room.players) {
      if (other && other.id !== p.id) {
        io.to(other.id).emit('opponent-shoot', payload);
      }
    }
  });

  socket.on('grenade', data => {
    const room = roomOf(socket);
    const p = findPlayer(room, socket);
    if (!room || !p || room.roundOver || !data) return;

    const x = Number(data.x);
    const y = Number(data.y);
    if (!Number.isFinite(x) || !Number.isFinite(y)) return;

    const payload = {
      x,
      y,
      floor: Number(data.floor) || 0,
      z: Number(data.z) || 0.45,
      vx: Number(data.vx) || 0,
      vy: Number(data.vy) || 0,
      vz: Number(data.vz) || 0,
      fuse: Math.max(0.1, Math.min(3, Number(data.fuse) || 1.75)),
      slot: p.slot,
      team: p.team
    };

    for (const other of room.players) {
      if (other && other.id !== p.id) {
        io.to(other.id).emit('opponent-grenade', payload);
      }
    }
  });

  socket.on('respawn', () => {});

  socket.on('disconnect', () => {
    const room = roomOf(socket);
    if (!room) return;

    const idx = room.players.findIndex(p => p && p.id === socket.id);
    if (idx >= 0) room.players[idx] = null;

    io.to(room.code).emit('opponent-left', { slot: idx + 1 });
    if (room.players.every(p => !p)) rooms.delete(room.code);
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`BLUE DOOM server listening on ${PORT}`);
});
