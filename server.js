const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const QRCode = require('qrcode');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static(path.join(__dirname, 'public')));
app.get('/host', (req, res) => res.sendFile(path.join(__dirname, 'public', 'host.html')));

// QR 코드는 서버에서 생성 (외부 CDN 없이 동작)
app.get('/qr', async (req, res) => {
  try {
    const text = String(req.query.text || '').slice(0, 500);
    const png = await QRCode.toBuffer(text, { width: 480, margin: 1 });
    res.type('png').send(png);
  } catch (e) {
    res.status(400).end();
  }
});

// ---------- 게임 상태 (전부 메모리) ----------
//
// 게임의 의미:
// - 각자에게 주어진 포인트는 "인생의 시간(년)"이다.
// - 한 물품에 입찰하는 순간 그 물품에 인생을 투자한 것 — 다른 물품에는 입찰할 수 없다.
// - 카테고리 '허영'은 얻어도 사라지는 것, '가치'는 얻지 못해도 남는 것.
//   분류는 경매가 모두 끝난 뒤 결과 화면에서만 공개된다.

const DEFAULT_ITEMS = [
  '명문대,10,허영',
  '의대,15,허영',
  '외모지상,10,허영',
  '인플루언서,10,허영',
  '억대연봉,15,허영',
  '평안,10,가치',
  '가족,15,가치',
  '친구,10,가치',
  '믿음,15,가치',
  '하나님,20,가치',
].join('\n');

// public/items/<물품명>.png 등이 있으면 그 이미지를 물품과 함께 보여준다
const ITEMS_DIR = path.join(__dirname, 'public', 'items');
function findImg(name) {
  for (const ext of ['png', 'jpg', 'jpeg', 'webp']) {
    if (fs.existsSync(path.join(ITEMS_DIR, `${name}.${ext}`))) return `/items/${name}.${ext}`;
  }
  return null;
}

let state;
let itemTimer = null;

function newGame() {
  return {
    phase: 'lobby', // lobby | running | ended
    startPoints: 80, // 인생의 시간(년)
    itemSeconds: 30,
    items: [],
    activeIndex: -1,
    endsAt: null,
    participants: {}, // token -> { id, nickname, points, connected, committedItemId }
    lastResult: null,
    verseShown: false, // 호스트가 '말씀' 버튼으로 토글 — 모든 화면에 말씀 표시
  };
}
state = newGame();

function parseItems(text) {
  return String(text)
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line, i) => {
      const parts = line.split(',').map((s) => s.trim());
      const name = parts[0] || `물품 ${i + 1}`;
      const price = parseInt(parts[1], 10);
      const cat = /허/.test(parts[2] || '') ? 'vanity' : 'value';
      return {
        id: i,
        name,
        startPrice: Number.isFinite(price) && price > 0 ? price : 1,
        cat, // vanity(허영) | value(가치) — 종료 후에만 클라이언트에 공개
        round: cat === 'vanity' ? 1 : 2, // 1부(억대연봉까지) / 2부
        img: findImg(name),
        status: 'pending', // pending | active | sold | passed
        currentBid: null, // { token, nickname, amount }
      };
    });
}

function snapshot() {
  const ended = state.phase === 'ended';
  const activeItem = state.activeIndex >= 0 ? state.items[state.activeIndex] : null;
  // 다음 물품 미리보기: 진행 중에는 같은 부(round) 안에서만 보여준다 (2부 스포일러 방지)
  let nextItem = state.items.find((it) => it.status === 'pending') || null;
  if (nextItem && activeItem && nextItem.round !== activeItem.round) nextItem = null;
  return {
    phase: state.phase,
    startPoints: state.startPoints,
    itemSeconds: state.itemSeconds,
    serverNow: Date.now(),
    endsAt: state.endsAt,
    lastResult: state.lastResult,
    verseShown: state.verseShown,
    activeIndex: state.activeIndex,
    items: state.items.map((it) => ({
      id: it.id,
      name: it.name,
      startPrice: it.startPrice,
      status: it.status,
      round: it.round,
      img: it.img,
      cat: ended ? it.cat : null, // 게임 중에는 분류를 숨긴다 (스포일러 방지)
      currentBid: it.currentBid ? { nickname: it.currentBid.nickname, amount: it.currentBid.amount } : null,
    })),
    participants: Object.values(state.participants).map((p) => ({
      id: p.id,
      nickname: p.nickname,
      points: p.points,
      connected: p.connected,
      committedItemId: p.committedItemId,
    })),
    activeItem: activeItem
      ? {
          id: activeItem.id,
          name: activeItem.name,
          startPrice: activeItem.startPrice,
          round: activeItem.round,
          img: activeItem.img,
          currentBid: activeItem.currentBid
            ? { nickname: activeItem.currentBid.nickname, amount: activeItem.currentBid.amount }
            : null,
        }
      : null,
    nextItem: nextItem
      ? { id: nextItem.id, name: nextItem.name, startPrice: nextItem.startPrice, round: nextItem.round, img: nextItem.img }
      : null,
  };
}

function broadcast() {
  io.emit('state', snapshot());
}

function clearItemTimer() {
  if (itemTimer) {
    clearTimeout(itemTimer);
    itemTimer = null;
  }
}

function armItemTimer() {
  clearItemTimer();
  if (!state.endsAt) return;
  const delay = Math.max(0, state.endsAt - Date.now());
  itemTimer = setTimeout(finishActiveItem, delay + 30);
}

function finishActiveItem() {
  clearItemTimer();
  const item = state.items[state.activeIndex];
  if (!item || item.status !== 'active') return;

  if (item.currentBid) {
    item.status = 'sold';
    const winner = state.participants[item.currentBid.token];
    if (winner) winner.points -= item.currentBid.amount;
    state.lastResult = {
      itemName: item.name,
      type: 'sold',
      nickname: item.currentBid.nickname,
      amount: item.currentBid.amount,
      at: Date.now(),
    };
  } else {
    item.status = 'passed';
    state.lastResult = { itemName: item.name, type: 'passed', at: Date.now() };
  }

  state.activeIndex = -1;
  state.endsAt = null;

  if (state.items.every((it) => it.status === 'sold' || it.status === 'passed')) {
    state.phase = 'ended';
  }
  broadcast();
}

// ---------- 소켓 ----------

io.on('connection', (socket) => {
  socket.emit('state', snapshot());

  // 학생 입장 (token이 있으면 재접속, 같은 닉네임이면 이어하기)
  socket.on('join', (data, cb) => {
    const nickname = String((data && data.nickname) || '').trim().slice(0, 12);
    let token = data && data.token;

    if (token && state.participants[token]) {
      const p = state.participants[token];
      p.connected = true;
      socket.data.token = token;
      if (cb) cb({ ok: true, token, nickname: p.nickname });
      broadcast();
      return;
    }

    if (!nickname) {
      if (cb) cb({ ok: false, error: '이름을 입력하세요.' });
      return;
    }

    // 같은 이름이 이미 있으면 그 자리로 이어하기 (폰을 껐다 켠 경우 대비)
    const existing = Object.entries(state.participants).find(([, p]) => p.nickname === nickname);
    if (existing) {
      token = existing[0];
      existing[1].connected = true;
      socket.data.token = token;
      if (cb) cb({ ok: true, token, nickname });
      broadcast();
      return;
    }

    token = crypto.randomBytes(12).toString('hex');
    state.participants[token] = {
      id: Object.keys(state.participants).length + 1,
      nickname,
      points: state.startPoints,
      connected: true,
      committedItemId: null,
    };
    socket.data.token = token;
    if (cb) cb({ ok: true, token, nickname });
    broadcast();
  });

  // 입찰 = 인생의 시간을 투자
  socket.on('bid', (data, cb) => {
    const token = socket.data.token;
    const p = token && state.participants[token];
    const item = state.items[state.activeIndex];
    const amount = Math.floor(Number(data && data.amount));

    if (!p) return cb && cb({ ok: false, error: '먼저 입장하세요.' });
    if (!item || item.status !== 'active') return cb && cb({ ok: false, error: '지금은 입찰 시간이 아닙니다.' });
    if (!Number.isFinite(amount)) return cb && cb({ ok: false, error: '금액이 올바르지 않습니다.' });

    // 핵심 규칙: 한 번 투자한 인생은 되돌릴 수 없다
    if (p.committedItemId !== null && p.committedItemId !== item.id) {
      const committed = state.items.find((it) => it.id === p.committedItemId);
      return cb && cb({
        ok: false,
        error: `이미 '${committed ? committed.name : '다른 물품'}'에 인생을 투자했습니다. 한 번 투자한 인생은 되돌릴 수 없습니다.`,
      });
    }

    const minBid = item.currentBid ? item.currentBid.amount + 1 : item.startPrice;
    if (amount < minBid) return cb && cb({ ok: false, error: `최소 ${minBid}년 이상 불러야 합니다.` });
    if (amount > p.points) return cb && cb({ ok: false, error: '남은 인생의 시간이 부족합니다.' });
    if (item.currentBid && item.currentBid.token === token)
      return cb && cb({ ok: false, error: '이미 최고 입찰자입니다.' });

    p.committedItemId = item.id;
    item.currentBid = { token, nickname: p.nickname, amount };

    // 마감 5초 전 입찰이면 5초로 연장 (막판 눈치싸움 방지)
    const remain = state.endsAt - Date.now();
    if (remain < 5000) {
      state.endsAt = Date.now() + 5000;
      armItemTimer();
    }

    if (cb) cb({ ok: true });
    broadcast();
  });

  // ---------- 호스트 ----------

  socket.on('host:setup', (data, cb) => {
    if (state.phase === 'running') return cb && cb({ ok: false, error: '진행 중에는 변경할 수 없습니다.' });
    const items = parseItems((data && data.itemsText) || DEFAULT_ITEMS);
    if (!items.length) return cb && cb({ ok: false, error: '물품을 1개 이상 입력하세요.' });
    const startPoints = Math.max(1, Math.floor(Number(data && data.startPoints)) || 80);
    const itemSeconds = Math.min(300, Math.max(5, Math.floor(Number(data && data.itemSeconds)) || 30));

    state.items = items;
    state.startPoints = startPoints;
    state.itemSeconds = itemSeconds;
    state.phase = 'lobby';
    state.activeIndex = -1;
    state.endsAt = null;
    state.lastResult = null;
    for (const p of Object.values(state.participants)) {
      p.points = startPoints;
      p.committedItemId = null;
    }
    if (cb) cb({ ok: true });
    broadcast();
  });

  socket.on('host:start-item', (data, cb) => {
    if (!state.items.length) return cb && cb({ ok: false, error: '먼저 물품을 설정하세요.' });
    if (state.activeIndex >= 0) return cb && cb({ ok: false, error: '이미 진행 중인 물품이 있습니다.' });
    const next = state.items.findIndex((it) => it.status === 'pending');
    if (next < 0) return cb && cb({ ok: false, error: '남은 물품이 없습니다.' });

    state.phase = 'running';
    state.activeIndex = next;
    state.items[next].status = 'active';
    state.lastResult = null;
    state.endsAt = Date.now() + state.itemSeconds * 1000;
    armItemTimer();
    if (cb) cb({ ok: true });
    broadcast();
  });

  socket.on('host:end-item', (data, cb) => {
    if (state.activeIndex < 0) return cb && cb({ ok: false, error: '진행 중인 물품이 없습니다.' });
    finishActiveItem();
    if (cb) cb({ ok: true });
  });

  socket.on('host:verse', (data, cb) => {
    state.verseShown = !state.verseShown;
    if (cb) cb({ ok: true, shown: state.verseShown });
    broadcast();
  });

  socket.on('host:reset', (data, cb) => {
    clearItemTimer();
    const keepParticipants = state.participants;
    state = newGame();
    state.participants = keepParticipants;
    for (const p of Object.values(state.participants)) {
      p.points = state.startPoints;
      p.committedItemId = null;
    }
    if (cb) cb({ ok: true });
    broadcast();
  });

  socket.on('disconnect', () => {
    const token = socket.data.token;
    if (token && state.participants[token]) {
      state.participants[token].connected = false;
      broadcast();
    }
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`모의 경매 서버 실행 중: http://localhost:${PORT}  (호스트 화면: /host)`);
});
