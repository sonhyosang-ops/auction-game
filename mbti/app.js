import { DIMENSIONS, QUESTIONS, TYPES } from "./data.js";

// ─────────────────────────────────────────────
// 설정
// ─────────────────────────────────────────────
const MODEL = "claude-opus-5-5";
const SDK_PATH = "./vendor/anthropic-sdk-1.3.0.js";
const KEY_STORAGE = "mbti-claude-key"; // 선생님 API 키만 sessionStorage에 임시 보관 (학생 데이터는 절대 저장하지 않음)
const AFTER_PRINT_SECONDS = 20;
const IDLE_WIPE_MS = 5 * 60 * 1000; // 5분 동안 아무 조작이 없으면 자동 삭제

// ─────────────────────────────────────────────
// 상태 (메모리에만 존재)
// ─────────────────────────────────────────────
let state = freshState();
function freshState() {
  return { name: "", grade: "", answers: new Array(QUESTIONS.length).fill(null), index: 0, result: null };
}

const $ = (id) => document.getElementById(id);
const screens = ["start", "quiz", "loading", "result"];

function show(name) {
  for (const s of screens) $(`screen-${s}`).classList.toggle("active", s === name);
  window.scrollTo(0, 0);
}

function toast(msg, ms = 3200) {
  const t = $("toast");
  t.textContent = msg;
  t.classList.add("show");
  clearTimeout(toast._t);
  toast._t = setTimeout(() => t.classList.remove("show"), ms);
}

// ─────────────────────────────────────────────
// API 키 (선생님 설정)
// ─────────────────────────────────────────────
function safeGet(k) { try { return sessionStorage.getItem(k) || ""; } catch { return ""; } }
function safeSet(k, v) { try { v ? sessionStorage.setItem(k, v) : sessionStorage.removeItem(k); } catch { /* 저장 불가 환경은 메모리만 사용 */ } }
let apiKey = safeGet(KEY_STORAGE);

function refreshBadge() {
  const b = $("ai-badge");
  b.textContent = apiKey ? "AI 해설 켜짐" : "AI 해설 꺼짐";
  b.classList.toggle("off", !apiKey);
  b.classList.toggle("on", !!apiKey);
}

$("btn-key-save").addEventListener("click", () => {
  const v = $("in-key").value.trim();
  if (!v) return toast("API 키를 입력해 주세요.");
  apiKey = v;
  safeSet(KEY_STORAGE, v);
  $("in-key").value = "";
  refreshBadge();
  toast("AI 맞춤 해설이 켜졌어요 ✨");
});
$("btn-key-clear").addEventListener("click", () => {
  apiKey = "";
  safeSet(KEY_STORAGE, "");
  $("in-key").value = "";
  refreshBadge();
  toast("API 키를 지웠어요.");
});
refreshBadge();

// ─────────────────────────────────────────────
// 시작
// ─────────────────────────────────────────────
$("start-form").addEventListener("submit", (e) => {
  e.preventDefault();
  const name = $("in-name").value.trim();
  const grade = document.querySelector('input[name="grade"]:checked')?.value || "";
  if (!name) { $("in-name").focus(); return toast("이름을 적어 주세요 ✏️"); }
  if (!grade) return toast("학년을 골라 주세요 🙂");
  state = freshState();
  state.name = name;
  state.grade = grade;
  renderQuestion();
  show("quiz");
});

// ─────────────────────────────────────────────
// 질문
// ─────────────────────────────────────────────
function renderQuestion() {
  const i = state.index;
  const q = QUESTIONS[i];
  const dim = DIMENSIONS.find((d) => d.key === q.dim);
  const card = $("quiz-card");
  card.style.setProperty("--accent", dim.color);
  card.classList.remove("pop");
  void card.offsetWidth; // 애니메이션 재시작
  card.classList.add("pop");

  $("q-num").textContent = `Q${i + 1}`;
  $("q-text").textContent = q.q;
  for (const side of ["a", "b"]) {
    const btn = $(`choice-${side}`);
    btn.querySelector(".choice-emoji").textContent = q[side].emoji;
    btn.querySelector(".choice-text").textContent = q[side].text;
    btn.classList.toggle("picked", state.answers[i] === side);
    btn.disabled = false;
  }
  const pct = (i / QUESTIONS.length) * 100;
  $("progress-fill").style.width = `${pct}%`;
  $("progress-runner").style.left = `${pct}%`;
  $("progress-num").textContent = `${i + 1} / ${QUESTIONS.length}`;
  $("btn-back").style.visibility = "visible";
}

function choose(side) {
  const i = state.index;
  state.answers[i] = side;
  $(`choice-${side}`).classList.add("picked");
  $("choice-a").disabled = $("choice-b").disabled = true;
  setTimeout(() => {
    if (i < QUESTIONS.length - 1) {
      state.index++;
      renderQuestion();
    } else {
      $("progress-fill").style.width = "100%";
      $("progress-runner").style.left = "100%";
      finish();
    }
  }, 260);
}

$("choice-a").addEventListener("click", () => choose("a"));
$("choice-b").addEventListener("click", () => choose("b"));
$("btn-back").addEventListener("click", () => {
  if (state.index === 0) { wipe(false); return; }
  state.index--;
  renderQuestion();
});
document.addEventListener("keydown", (e) => {
  if (!$("screen-quiz").classList.contains("active") || $("choice-a").disabled) return;
  if (e.key === "1" || e.key.toLowerCase() === "a") choose("a");
  if (e.key === "2" || e.key.toLowerCase() === "b") choose("b");
});

// ─────────────────────────────────────────────
// 채점
// ─────────────────────────────────────────────
function score() {
  const dims = DIMENSIONS.map((d) => {
    let left = 0, right = 0;
    QUESTIONS.forEach((q, i) => {
      if (q.dim !== d.key) return;
      state.answers[i] === "a" ? left++ : right++;
    });
    return { ...d, leftCount: left, rightCount: right, pick: left > right ? d.left : d.right };
  });
  return { type: dims.map((d) => d.pick).join(""), dims };
}

// ─────────────────────────────────────────────
// Claude API — 학생 이름은 보내지 않아요
// ─────────────────────────────────────────────
const RESULT_SCHEMA = {
  type: "object",
  properties: {
    nickname: { type: "string" },
    summary: { type: "string" },
    strengths: { type: "array", items: { type: "string" } },
    growth: { type: "array", items: { type: "string" } },
    study: { type: "string" },
    friend: { type: "string" },
    cheer: { type: "string" },
  },
  required: ["nickname", "summary", "strengths", "growth", "study", "friend", "cheer"],
  additionalProperties: false,
};

function systemPrompt(grade) {
  return `너는 초등학생을 위한 성격 유형(MBTI) 결과지를 쓰는 다정한 상담 선생님이야.
독자는 초등학교 ${grade}학년 학생이고, 결과지는 A4 한 장에 인쇄되어 집에 가져가.

글쓰기 원칙:
- 초등학생이 바로 이해할 쉬운 낱말로, 따뜻한 "~해요" 말투로 써. 학생을 부를 때는 "너"라고 해.
- 학생이 실제로 고른 답을 근거로 들어서, 이 학생만을 위한 해설처럼 느껴지게 써.
- 성격 유형은 정답이나 꼬리표가 아니라 나를 알아가는 도구라는 관점을 지켜. 단점은 '성장 포인트'로 긍정적으로 바꿔 말해.
- 다른 유형을 깎아내리거나, 진로·능력을 단정하는 말은 쓰지 마.
- 이모지는 쓰지 마(결과지 디자인에 이미 들어 있어).

분량(인쇄 칸에 맞춰야 하니 꼭 지켜):
- nickname: 동물이나 사물에 빗댄 귀여운 별명, 공백 포함 18자 이내
- summary: 3문장, 공백 포함 150자 이내
- strengths: 정확히 3개, 각 22자 이내
- growth: 정확히 2개, 각 38자 이내
- study: 1~2문장, 70자 이내 (이 학생에게 맞는 공부 방법)
- friend: 1~2문장, 70자 이내 (친구 관계 팁)
- cheer: 1~2문장, 55자 이내 (응원 한마디)`;
}

function userPrompt(type, dims) {
  const base = TYPES[type];
  const scoreLines = dims
    .map((d) => `- ${d.left}(${d.leftName}) ${d.leftCount} : ${d.rightCount} ${d.right}(${d.rightName})`)
    .join("\n");
  const answerLines = QUESTIONS.map((q, i) => `${i + 1}. ${q.q} → ${q[state.answers[i]].text}`).join("\n");
  return `결과 유형: ${type}
기본 별명(참고용, 더 어울리게 바꿔도 돼): ${base.nickname}

지표별 점수(각 3문항):
${scoreLines}

학생이 고른 답:
${answerLines}

위 내용을 바탕으로 결과지 문구를 JSON으로 작성해 줘.`;
}

async function askClaude(type, dims) {
  const { default: Anthropic } = await import(SDK_PATH);
  const client = new Anthropic({ apiKey, dangerouslyAllowBrowser: true, timeout: 90_000, maxRetries: 1 });
  const response = await client.beta.messages.create({
    model: MODEL,
    max_tokens: 8000,
    betas: ["server-side-fallback-2026-07-01"],
    fallbacks: "default",
    output_config: { effort: "low", format: { type: "json_schema", schema: RESULT_SCHEMA } },
    system: systemPrompt(state.grade),
    messages: [{ role: "user", content: userPrompt(type, dims) }],
  });
  if (response.stop_reason === "refusal") throw new Error("refusal");
  if (response.stop_reason === "max_tokens") throw new Error("max_tokens");
  const text = response.content.filter((b) => b.type === "text").map((b) => b.text).join("");
  return JSON.parse(text);
}

// AI 응답을 기본 해설과 합쳐서 빈칸·이상값이 없게 정리
function mergeResult(base, ai) {
  const str = (v, fb, max) => (typeof v === "string" && v.trim() ? v.trim().slice(0, max) : fb);
  const list = (v, fb, n, max) => {
    const arr = Array.isArray(v) ? v.filter((x) => typeof x === "string" && x.trim()).map((x) => x.trim().slice(0, max)) : [];
    return arr.length >= n ? arr.slice(0, n) : fb;
  };
  if (!ai) return { ...base, ai: false };
  return {
    emoji: base.emoji,
    nickname: str(ai.nickname, base.nickname, 24),
    summary: str(ai.summary, base.summary, 220),
    strengths: list(ai.strengths, base.strengths, 3, 34),
    growth: list(ai.growth, base.growth, 2, 56),
    study: str(ai.study, base.study, 110),
    friend: str(ai.friend, base.friend, 110),
    cheer: str(ai.cheer, base.cheer, 90),
    ai: true,
  };
}

const LOADING_MSGS = [
  "답변을 하나하나 살펴보고 있어요 👀",
  "나만의 강점을 찾고 있어요 ⭐",
  "딱 맞는 별명을 고르고 있어요 🏷️",
  "예쁜 결과지를 꾸미고 있어요 🎨",
];

async function finish() {
  const { type, dims } = score();
  show("loading");
  let m = 0;
  $("loading-msg").textContent = LOADING_MSGS[0];
  const ticker = setInterval(() => { m = (m + 1) % LOADING_MSGS.length; $("loading-msg").textContent = LOADING_MSGS[m]; }, 1800);

  const base = TYPES[type];
  let ai = null;
  if (apiKey) {
    try {
      ai = await askClaude(type, dims);
    } catch (err) {
      console.warn("Claude API 호출 실패, 기본 해설을 사용합니다:", err);
      toast("AI 연결이 잠시 안 돼서 기본 해설로 만들었어요.", 4500);
    }
  } else {
    await new Promise((r) => setTimeout(r, 1600)); // 두근두근 연출
  }
  clearInterval(ticker);

  state.result = { type, dims, content: mergeResult(base, ai) };
  renderResult();
  show("result");
  requestAnimationFrame(fitAndScale);
}

// ─────────────────────────────────────────────
// 결과지 (A4)
// ─────────────────────────────────────────────
function esc(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

function today() {
  const d = new Date();
  return `${d.getFullYear()}. ${d.getMonth() + 1}. ${d.getDate()}.`;
}

function dimRow(d) {
  const leftWin = d.pick === d.left;
  const segs = [];
  for (let k = 0; k < 3; k++) segs.push(`<i class="${k < d.leftCount ? "on" : ""}"></i>`);
  const desc = leftWin ? d.leftDesc : d.rightDesc;
  return `
    <div class="d-row" style="--c:${d.color}">
      <div class="d-side ${leftWin ? "win" : ""}"><b>${d.left}</b><small>${d.leftName}</small></div>
      <div class="d-mid">
        <div class="d-track">${segs.join("")}</div>
        <div class="d-desc">${esc(desc)}</div>
      </div>
      <div class="d-side right ${leftWin ? "" : "win"}"><b>${d.right}</b><small>${d.rightName}</small></div>
    </div>`;
}

function renderResult() {
  const { type, dims, content: c } = state.result;
  const letters = dims.map((d) => `<span style="color:${d.color}">${d.pick}</span>`).join("");
  $("result-hello").innerHTML = `<b>${esc(state.name)}</b>의 유형은 <b class="type-chip">${type}</b> ${c.emoji}`;

  $("sheet-scale").innerHTML = `
  <article class="sheet" id="sheet">
    <div class="sheet-inner" id="sheet-inner">
      <header class="s-head">
        <div class="s-brand"><span class="s-logo">🧭</span>나의 성격 탐험 보고서</div>
        <div class="s-meta">
          <span>이름 <b>${esc(state.name)}</b></span>
          <span>학년 <b>${esc(state.grade)}학년</b></span>
          <span>날짜 <b>${today()}</b></span>
        </div>
      </header>

      <section class="s-hero">
        <div class="s-emoji">${c.emoji}</div>
        <div class="s-hero-text">
          <div class="s-label">나의 성격 유형은</div>
          <div class="s-type">${letters}</div>
          <div class="s-nick">${esc(c.nickname)}</div>
        </div>
      </section>

      <section class="s-dims">${dims.map(dimRow).join("")}</section>

      <section class="s-box s-summary">
        <h3>🔎 나는 이런 사람이에요</h3>
        <p>${esc(c.summary)}</p>
      </section>

      <div class="s-grid">
        <section class="s-box s-yellow">
          <h3>⭐ 나의 강점</h3>
          <ul>${c.strengths.map((s) => `<li>${esc(s)}</li>`).join("")}</ul>
        </section>
        <section class="s-box s-green">
          <h3>🌱 이렇게 하면 더 멋져요</h3>
          <ul>${c.growth.map((s) => `<li>${esc(s)}</li>`).join("")}</ul>
        </section>
        <section class="s-box s-blue">
          <h3>📚 나에게 맞는 공부 꿀팁</h3>
          <p>${esc(c.study)}</p>
        </section>
        <section class="s-box s-pink">
          <h3>🤝 친구 관계 꿀팁</h3>
          <p>${esc(c.friend)}</p>
        </section>
      </div>

      <section class="s-cheer">
        <div class="s-cheer-icon">💌</div>
        <p>${esc(c.cheer)}</p>
      </section>

      <section class="s-promise">
        <h3>✏️ 나의 다짐 한마디</h3>
        <div class="s-lines"><i></i><i></i></div>
      </section>

      <footer class="s-foot">
        성격 유형은 정답이 아니라 <b>나를 알아가는 재미있는 지도</b>예요. 사람은 자라면서 얼마든지 달라질 수 있어요!
        <span class="s-foot-sub">12문항 간이 검사${c.ai ? " · AI 맞춤 해설" : ""} · 이 결과는 어디에도 저장되지 않았어요</span>
      </footer>
    </div>
  </article>`;
}

// 내용이 A4 한 장을 넘치면 글자 크기를 조금씩 줄여서 딱 맞춰요
function fitSheet() {
  const sheet = $("sheet");
  const inner = $("sheet-inner");
  if (!sheet || !inner) return;
  // 큰 글씨에서 시작해 넘치지 않을 때까지 조금씩 줄여요 (측정하는 동안엔 칸을 늘리지 않음)
  sheet.classList.add("measuring");
  let size = 16.5;
  sheet.style.setProperty("--fs", `${size}px`);
  while (inner.scrollHeight > inner.clientHeight + 1 && size > 10) {
    size -= 0.25;
    sheet.style.setProperty("--fs", `${size}px`);
  }
  sheet.classList.remove("measuring");
}

function scaleSheet() {
  const wrap = $("sheet-wrap");
  const scaler = $("sheet-scale");
  const sheet = $("sheet");
  if (!sheet) return;
  const w = sheet.offsetWidth;
  const h = sheet.offsetHeight;
  const scale = Math.min(1, (wrap.clientWidth - 8) / w);
  scaler.style.transform = `scale(${scale})`;
  scaler.style.width = `${w}px`;
  wrap.style.height = `${h * scale}px`;
}

async function fitAndScale() {
  try { await document.fonts.ready; } catch { /* 폰트 로딩 실패 시 기본 글꼴 사용 */ }
  fitSheet();
  scaleSheet();
}
window.addEventListener("resize", scaleSheet);

// ─────────────────────────────────────────────
// 인쇄 → 삭제
// ─────────────────────────────────────────────
let countdownTimer = null;
let printing = false;

$("btn-print").addEventListener("click", () => {
  fitSheet();
  printing = true;
  window.print();
  // 대부분 브라우저는 print()가 대화상자가 닫힐 때까지 기다려요. afterprint가 없는 환경도 대비.
  setTimeout(() => { if (printing) afterPrint(); }, 300);
});
window.addEventListener("afterprint", () => { if (printing) afterPrint(); });

function afterPrint() {
  printing = false;
  if (!state.result) return;
  const modal = $("modal-after");
  if (!modal.hidden) return;
  modal.hidden = false;
  let left = AFTER_PRINT_SECONDS;
  $("countdown").textContent = left;
  clearInterval(countdownTimer);
  countdownTimer = setInterval(() => {
    left--;
    $("countdown").textContent = left;
    if (left <= 0) wipe(true);
  }, 1000);
}

$("btn-done").addEventListener("click", () => wipe(true));
$("btn-reprint").addEventListener("click", () => {
  clearInterval(countdownTimer);
  $("modal-after").hidden = true;
  $("btn-print").click();
});
$("btn-reset").addEventListener("click", () => {
  if (confirm("결과를 삭제하고 처음 화면으로 돌아갈까요?")) wipe(true);
});

// 모든 학생 데이터 삭제
function wipe(withToast) {
  clearInterval(countdownTimer);
  $("modal-after").hidden = true;
  state = freshState();
  $("sheet-scale").innerHTML = "";
  $("sheet-scale").removeAttribute("style");
  $("sheet-wrap").removeAttribute("style");
  $("result-hello").textContent = "";
  $("start-form").reset();
  $("q-text").textContent = "";
  show("start");
  if (withToast) toast("결과가 깨끗하게 삭제되었어요 🧹 다음 친구 차례!");
}

// 한동안 조작이 없으면 자동 삭제 (자리를 비운 사이 정보가 남지 않도록)
let idleTimer = null;
function bumpIdle() {
  clearTimeout(idleTimer);
  idleTimer = setTimeout(() => {
    if (!$("screen-start").classList.contains("active")) wipe(true);
  }, IDLE_WIPE_MS);
}
["pointerdown", "keydown", "scroll", "touchstart"].forEach((ev) => window.addEventListener(ev, bumpIdle, { passive: true }));
bumpIdle();
