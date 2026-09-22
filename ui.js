// ui.js —— 交互层：DOM 渲染、事件绑定、播放。规则走 rules.js，持久化走 store.js。

import {
  STEPS,
  MEASURES,
  STEPS_PER_MEASURE,
  instruments,
  reasonCauses,
  reasonLabel,
  measureOf,
  beatOf,
  stepOf,
  beatId,
  startTrial,
  endTrial,
  closeReview,
  invalidateSession,
  resetStreak,
  addMark,
  revokeMark,
  resolveMark,
  resolvePending,
  revokePending,
  markAt,
  pendingAt,
  computeStats
} from "./rules.js";
import { load, save, savePlan, loadPlan, loadArchive } from "./store.js";

const state = load();

let timer = null;
let playhead = 0;
let audioContext = null;
let flashTimer = null;

const $ = (selector) => document.querySelector(selector);

const grid = $("#grid");
const sessionBar = $("#sessionBar");
const savedList = $("#savedList");
const archiveList = $("#archiveList");
const structure = $("#structure");
const notesList = $("#notesList");
const marksPanel = $("#marksPanel");
const pendingList = $("#pendingList");
const statsBox = $("#statsBox");
const pieceName = $("#pieceName");
const bpmInput = $("#bpmInput");
const loopSelect = $("#loopSelect");
const noteInput = $("#noteInput");
const flashBox = $("#flash");

function escapeHtml(text) {
  return String(text ?? "").replace(/[&<>"']/g, (char) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
  }[char]));
}

function formatTime(iso) {
  if (!iso) return "";
  const date = new Date(iso);
  const pad = (value) => String(value).padStart(2, "0");
  return `${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function flash(message, type = "info") {
  flashBox.textContent = message;
  flashBox.className = `flash show ${type}`;
  clearTimeout(flashTimer);
  flashTimer = setTimeout(() => flashBox.classList.remove("show"), 2600);
}

// 试排期间一切展示以固定快照为准；未开始试排时展示当前草稿
function context() {
  const session = state.session;
  if (session) {
    return {
      pieceName: session.snapshot.name,
      bpm: session.snapshot.bpm,
      pattern: session.snapshot.pattern,
      locked: true,
      phase: session.status
    };
  }
  return {
    pieceName: state.draft.pieceName,
    bpm: state.draft.bpm,
    pattern: state.draft.pattern,
    locked: false,
    phase: null
  };
}

// —— 渲染 ——

function renderSessionBar() {
  const session = state.session;
  let html = "";
  if (!session) {
    html = `
      <div class="session-idle">
        <span>当前未在试排，可自由编辑谱面。</span>
        <button id="startTrialBtn" type="button">开始分段试排</button>
      </div>`;
  } else if (session.status === "trial") {
    html = `
      <div class="session-line">
        <span class="badge trial">试排中</span>
        <span>谱面与速度已固定：<strong>${escapeHtml(session.snapshot.name)}</strong> · ${session.snapshot.bpm}BPM · ${formatTime(session.startedAt)} 开始</span>
      </div>
      <div class="session-line">
        <button id="editPatternBtn" type="button" class="ghost">修改谱面（本次试排将失效留档）</button>
        <button id="endTrialBtn" type="button">结束试排，进入复盘</button>
      </div>`;
  } else {
    const open = session.marks.filter((mark) => mark.status === "open").length;
    html = `
      <div class="session-line">
        <span class="badge review">复盘中</span>
        <span>复盘：${escapeHtml(session.snapshot.name)} · ${session.marks.length} 条错拍（待更正 ${open}），可更正或撤销后再结束。</span>
      </div>
      <div class="session-line">
        <button id="closeReviewBtn" type="button">结束复盘并归档</button>
      </div>`;
  }
  sessionBar.innerHTML = html;
}

function renderControls() {
  const ctx = context();
  const inSession = state.session !== null;
  pieceName.value = ctx.pieceName;
  pieceName.disabled = inSession;
  bpmInput.value = ctx.bpm;
  bpmInput.disabled = state.session?.status === "review";
  loopSelect.value = state.draft.loop;
}

function renderGrid() {
  const ctx = context();
  const header = ['<div class="label-cell">乐器</div>'];
  for (let step = 0; step < STEPS; step += 1) {
    header.push(`<div class="beat-cell">${measureOf(step)}-${beatOf(step)}</div>`);
  }

  const rows = instruments.flatMap((instrument, rowIndex) => {
    const row = [`<div class="label-cell">${instrument.name}</div>`];
    for (let step = 0; step < STEPS; step += 1) {
      const value = ctx.pattern[rowIndex][step];
      const mark = markAt(state.session, rowIndex, step);
      const pending = pendingAt(state, rowIndex, step);
      const classes = ["cell"];
      if (value) classes.push("filled");
      if (mark) classes.push(mark.status === "resolved" ? "mark-resolved" : "mark-open");
      if (pending) classes.push("pending-beat");
      const titles = [];
      if (mark) titles.push(`错拍：${reasonLabel(mark.reason)}${mark.status === "resolved" ? "（已更正）" : ""}`);
      if (pending) titles.push(`待处理：${reasonLabel(pending.reason)}`);
      row.push(
        `<button class="${classes.join(" ")}" type="button" data-row="${rowIndex}" data-step="${step}" title="${escapeHtml(titles.join("；"))}">${escapeHtml(value || "")}</button>`
      );
    }
    return row;
  });

  grid.innerHTML = [...header, ...rows].join("");
  if (timer) highlight(playhead);
}

function renderStructure() {
  const ctx = context();
  const rows = Array.from({ length: MEASURES }, (_, measure) => {
    const start = measure * STEPS_PER_MEASURE;
    const count = ctx.pattern
      .flatMap((row) => row.slice(start, start + STEPS_PER_MEASURE))
      .filter(Boolean).length;
    return { measure: measure + 1, count };
  });
  structure.innerHTML = rows
    .map((item) => `<div class="structure-row"><span>第${item.measure}小节</span><strong>${item.count}个口令</strong></div>`)
    .join("");
}

function renderNotes() {
  notesList.innerHTML = state.draft.notes.length
    ? state.draft.notes.map((note, index) => `
      <article class="note">
        <p>${escapeHtml(note)}</p>
        <button class="link-btn" type="button" data-note-del="${index}">删除</button>
      </article>`).join("")
    : "<p>暂无批注。</p>";
}

function renderMarks() {
  const session = state.session;
  const measureOptions = Array.from({ length: MEASURES }, (_, i) => i + 1)
    .map((value) => `<option value="${value}">第${value}小节</option>`).join("");
  const beatOptions = Array.from({ length: STEPS_PER_MEASURE }, (_, i) => i + 1)
    .map((value) => `<option value="${value}">第${value}拍</option>`).join("");
  const instrumentOptions = instruments
    .map((item) => `<option value="${item.name}">${item.name}</option>`).join("");
  const reasonOptions = ['<option value="">请选择错因…</option>']
    .concat(reasonCauses.map((item) => `<option value="${item.key}">${item.label}</option>`)).join("");

  let listHtml = "";
  if (!session) {
    listHtml = `<p class="hint">开始试排后，可在此登记错拍；同一拍重复只保留最早一次。</p>`;
  } else if (session.marks.length === 0) {
    listHtml = `<p class="hint">本次试排暂无错拍。点击谱面格子可快速定位。</p>`;
  } else {
    listHtml = session.marks
      .slice()
      .sort((a, b) => beatId(a.measure, a.beat, a.instrument).localeCompare(beatId(b.measure, b.beat, b.instrument)))
      .map((mark) => {
        const actions = [
          `<button class="link-btn danger" type="button" data-revoke="${mark.id}">撤销</button>`
        ];
        if (session.status === "review" && mark.status === "open") {
          actions.unshift(`<button class="link-btn" type="button" data-resolve="${mark.id}">更正</button>`);
        }
        return `
          <article class="mark ${mark.status === "resolved" ? "resolved" : ""}">
            <div class="mark-head">
              <strong>第${mark.measure}小节第${mark.beat}拍 · ${escapeHtml(mark.instrument)}</strong>
              <span class="tag ${mark.status === "resolved" ? "ok" : "warn"}">${mark.status === "resolved" ? "已更正" : "待更正"}</span>
            </div>
            <p>${escapeHtml(reasonLabel(mark.reason))}${mark.detail ? `：${escapeHtml(mark.detail)}` : ""}</p>
            <div class="mark-actions">${actions.join("")}</div>
          </article>`;
      })
      .join("");
  }

  const formDisabled = session?.status !== "trial";
  marksPanel.innerHTML = `
    <h2>错拍登记${session ? `（${session.status === "trial" ? "试排中" : "复盘中"}）` : ""}</h2>
    <form id="markForm" class="mark-form ${formDisabled ? "locked" : ""}">
      <select id="markMeasure" ${formDisabled ? "disabled" : ""}>${measureOptions}</select>
      <select id="markBeat" ${formDisabled ? "disabled" : ""}>${beatOptions}</select>
      <select id="markInstrument" ${formDisabled ? "disabled" : ""}>${instrumentOptions}</select>
      <select id="markReason" ${formDisabled ? "disabled" : ""}>${reasonOptions}</select>
      <input id="markDetail" type="text" maxlength="60" placeholder="补充说明（可选）" ${formDisabled ? "disabled" : ""} />
      <button type="submit" ${formDisabled ? "disabled" : ""}>登记错拍</button>
      <p class="form-note">${formDisabled
        ? (session?.status === "review" ? "复盘进行中：只能更正或撤销已登记的错拍。" : "开始试排后可登记错拍。")
        : "须写明小节、乐器和错因；同一拍重复登记只留最早一次。"}</p>
    </form>
    <div class="mark-list">${listHtml}</div>`;

  if (!formDisabled) {
    $("#markForm").addEventListener("submit", onSubmitMark);
  }
}

function renderPending() {
  if (!state.pending.length) {
    pendingList.innerHTML = `<p class="hint">暂无待处理问题。连续两次试排在同一拍出现同类错拍，会自动进入这里。</p>`;
    return;
  }
  pendingList.innerHTML = state.pending
    .map((item) => `
      <article class="mark ${item.status === "resolved" ? "resolved" : ""}">
        <div class="mark-head">
          <strong>第${item.measure}小节第${item.beat}拍 · ${escapeHtml(item.instrument)}</strong>
          <span class="tag ${item.status === "resolved" ? "ok" : "warn"}">${item.status === "resolved" ? "已更正" : "待处理"}</span>
        </div>
        <p>${escapeHtml(reasonLabel(item.reason))} · 出现 ${item.trialIds.length} 次</p>
        <div class="mark-actions">
          ${item.status === "open" ? `<button class="link-btn" type="button" data-pending-resolve="${item.key}">更正</button>` : ""}
          <button class="link-btn danger" type="button" data-pending-revoke="${item.key}">撤销</button>
        </div>
      </article>`)
    .join("");
}

function renderStats() {
  const stats = computeStats(state);
  const current = stats.current;
  const measureParts = [];
  for (let measure = 1; measure <= MEASURES; measure += 1) {
    measureParts.push(`第${measure}小节 ${current.byMeasure[measure] || 0}`);
  }
  const instrumentParts = instruments.map(
    (item) => `${item.name} ${current.byInstrument[item.name] || 0}`
  );
  statsBox.innerHTML = `
    <h2>错拍统计</h2>
    <div class="stat-main">
      <span>合计 <strong>${current.total}</strong></span>
      <span>待更正 <strong class="warn-text">${current.open}</strong></span>
      <span>已更正 <strong class="ok-text">${current.resolved}</strong></span>
      <span>待处理积压 <strong class="warn-text">${stats.pending.open}</strong></span>
    </div>
    <p class="stat-line">${measureParts.join(" · ")}</p>
    <p class="stat-line">${instrumentParts.join(" · ")}</p>`;
}

function renderArchive() {
  if (!state.archive.length) {
    archiveList.innerHTML = `<p class="hint">暂无复盘档案。</p>`;
    return;
  }
  archiveList.innerHTML = state.archive
    .map((entry) => `
      <article class="saved-item archive-item ${entry.outcome === "invalidated" ? "invalid" : ""}">
        <div class="mark-head">
          <strong>${escapeHtml(entry.name)}</strong>
          <span class="tag ${entry.outcome === "invalidated" ? "warn" : "ok"}">
            ${entry.outcome === "invalidated" ? `改动${escapeHtml(entry.changed || "")}失效` : "正常结束"}
          </span>
        </div>
        <p>${entry.bpm}BPM · 错拍 ${entry.marks.length} 条 · 转待处理 ${entry.promoted.length} 条</p>
        <p class="sub">${formatTime(entry.startedAt)} 起 · ${formatTime(entry.endedAt)} 归档</p>
        <button class="link-btn" type="button" data-archive-load="${entry.id}">查看 / 载入原方案</button>
      </article>`)
    .join("");
}

function renderSaved() {
  savedList.innerHTML = state.saved.length
    ? state.saved.map((item) => `
      <button class="saved-item" type="button" data-load="${item.id}">
        <strong>${escapeHtml(item.name)}</strong><br>
        <span>${item.bpm}BPM · ${item.notes.length}条批注</span>
      </button>`).join("")
    : "<p>还没有保存方案。</p>";
}

function render() {
  renderSessionBar();
  renderControls();
  renderGrid();
  renderStructure();
  renderMarks();
  renderPending();
  renderStats();
  renderArchive();
  renderSaved();
  renderNotes();
}

// —— 播放 ——

function playSound(instrument) {
  audioContext ||= new AudioContext();
  const osc = audioContext.createOscillator();
  const gain = audioContext.createGain();
  osc.frequency.value = instrument.freq;
  osc.type = instrument.name === "鼓" ? "sine" : "square";
  gain.gain.setValueAtTime(0.08, audioContext.currentTime);
  gain.gain.exponentialRampToValueAtTime(0.001, audioContext.currentTime + 0.08);
  osc.connect(gain).connect(audioContext.destination);
  osc.start();
  osc.stop(audioContext.currentTime + 0.09);
}

function highlight(step) {
  document.querySelectorAll(".cell.playing").forEach((cell) => cell.classList.remove("playing"));
  document.querySelectorAll(`[data-step="${step}"]`).forEach((cell) => cell.classList.add("playing"));
}

function currentRange() {
  if (state.draft.loop === "") return [0, STEPS - 1];
  const start = Number(state.draft.loop) * STEPS_PER_MEASURE;
  return [start, start + STEPS_PER_MEASURE - 1];
}

function tick() {
  const ctx = context();
  const [start, end] = currentRange();
  if (playhead < start || playhead > end) playhead = start;
  highlight(playhead);
  instruments.forEach((instrument, rowIndex) => {
    if (ctx.pattern[rowIndex][playhead]) playSound(instrument);
  });
  playhead = playhead >= end ? start : playhead + 1;
}

function stopPlayback() {
  clearInterval(timer);
  timer = null;
  document.querySelectorAll(".cell.playing").forEach((cell) => cell.classList.remove("playing"));
}

// —— 试排 / 复盘事件 ——

sessionBar.addEventListener("click", (event) => {
  if (event.target.closest("#startTrialBtn")) {
    const result = startTrial(state);
    if (!result.ok) {
      flash(result.error, "error");
      return;
    }
    stopPlayback();
    save(state);
    render();
    flash("试排开始：当前谱面与速度已固定。");
  }

  if (event.target.closest("#endTrialBtn")) {
    const result = endTrial(state);
    if (!result.ok) {
      flash(result.error, "error");
      return;
    }
    save(state);
    render();
    flash("进入复盘：可逐条更正或撤销错拍，统计已同步重算。");
  }

  if (event.target.closest("#closeReviewBtn")) {
    const result = closeReview(state);
    if (!result.ok) {
      flash(result.error, "error");
      return;
    }
    stopPlayback();
    save(state);
    render();
    flash(
      result.promoted.length
        ? `复盘已归档；${result.promoted.length} 个连续两次的同类问题进入待处理。`
        : "复盘已归档；无连续两次的同类问题。",
      result.promoted.length ? "warn" : "ok"
    );
  }

  // 试排中改谱面：先明确确认，再令本次试排失效留档，原方案随档案保留
  if (event.target.closest("#editPatternBtn")) {
    if (!window.confirm("试排中修改谱面会使当前复盘失效留档（原方案保留，可在档案中载入）。确定继续？")) return;
    invalidateSession(state, "谱面");
    save(state);
    render();
    flash("本次试排已失效留档，原方案保留；现在可以修改谱面。", "warn");
  }
});

// —— 错拍登记 / 更正 / 撤销 ——

function onSubmitMark(event) {
  event.preventDefault();
  // 表单随渲染重建，提交时现取元素，避免引用到已被替换的节点
  const result = addMark(state.session, {
    measure: $("#markMeasure").value,
    beat: $("#markBeat").value,
    instrument: $("#markInstrument").value,
    reason: $("#markReason").value,
    detail: $("#markDetail").value
  });
  if (!result.ok) {
    flash(result.error, "error");
    return;
  }
  markReason.value = "";
  markDetail.value = "";
  save(state);
  render();
  flash(`已登记：第${result.mark.measure}小节第${result.mark.beat}拍 · ${result.mark.instrument} · ${reasonLabel(result.mark.reason)}`, "ok");
}

marksPanel.addEventListener("click", (event) => {
  const resolveId = event.target.closest("[data-resolve]")?.dataset.resolve;
  const revokeId = event.target.closest("[data-revoke]")?.dataset.revoke;
  if (resolveId && resolveMark(state.session, resolveId)) {
    save(state);
    render();
    flash("已更正，统计已重算。", "ok");
  } else if (revokeId && revokeMark(state.session, revokeId)) {
    save(state);
    render();
    flash("已撤销该错拍，统计已重算。");
  }
});

pendingList.addEventListener("click", (event) => {
  const resolveKey = event.target.closest("[data-pending-resolve]")?.dataset.pendingResolve;
  const revokeKey = event.target.closest("[data-pending-revoke]")?.dataset.pendingRevoke;
  if (resolveKey && resolvePending(state, resolveKey)) {
    save(state);
    render();
    flash("待处理问题已更正，统计已重算。", "ok");
  } else if (revokeKey && revokePending(state, revokeKey)) {
    save(state);
    render();
    flash("已撤销待处理问题，统计已重算。");
  }
});

// —— 谱面格：试排中用于定位错拍，空闲时用于编辑；复盘中锁定 ——

grid.addEventListener("click", (event) => {
  const cell = event.target.closest(".cell");
  if (!cell) return;
  const row = Number(cell.dataset.row);
  const step = Number(cell.dataset.step);
  const session = state.session;

  if (!session) {
    state.draft.pattern[row][step] = state.draft.pattern[row][step] ? "" : instruments[row].token;
    save(state);
    render();
    return;
  }

  if (session.status === "review") {
    flash("复盘进行中，谱面已锁定；更正或撤销请在错拍列表操作。", "error");
    return;
  }

  // 试排中：点击格子快速定位到登记表，不改动谱面
  const form = $("#markForm");
  if (form) {
    $("#markMeasure").value = String(measureOf(step));
    $("#markBeat").value = String(beatOf(step));
    $("#markInstrument").value = instruments[row].name;
    $("#markReason").focus();
    flash(`已定位第${measureOf(step)}小节第${beatOf(step)}拍 · ${instruments[row].name}，请写明错因后登记。`);
  }
});

// —— 控制区 ——

pieceName.addEventListener("input", () => {
  state.draft.pieceName = pieceName.value;
  save(state);
});

// 试排中改速度：确认后本次试排失效留档；取消则恢复固定速度
bpmInput.addEventListener("change", () => {
  const next = Number(bpmInput.value || 96);
  if (state.session?.status === "trial") {
    if (!window.confirm("试排中修改速度会使当前复盘失效留档（原方案保留）。确定继续？")) {
      bpmInput.value = state.session.snapshot.bpm;
      return;
    }
    state.draft.bpm = next;
    invalidateSession(state, "速度");
    stopPlayback();
    save(state);
    render();
    flash("已改速度，本次试排失效留档，原方案保留。", "warn");
    return;
  }
  state.draft.bpm = next;
  save(state);
  if (timer) {
    clearInterval(timer);
    timer = setInterval(tick, 60000 / context().bpm);
  }
});

loopSelect.addEventListener("change", () => {
  state.draft.loop = loopSelect.value;
  playhead = currentRange()[0];
  save(state);
});

noteInput.addEventListener("keydown", (event) => {
  if (event.key !== "Enter" || !noteInput.value.trim()) return;
  state.draft.notes.unshift(noteInput.value.trim());
  noteInput.value = "";
  save(state);
  renderNotes();
});

notesList.addEventListener("click", (event) => {
  const index = event.target.closest("[data-note-del]")?.dataset.noteDel;
  if (index === undefined) return;
  state.draft.notes.splice(Number(index), 1);
  save(state);
  renderNotes();
});

$("#saveBtn").addEventListener("click", () => {
  savePlan(state);
  renderSaved();
  flash("方案已保存。", "ok");
});

savedList.addEventListener("click", (event) => {
  const id = event.target.closest("[data-load]")?.dataset.load;
  const item = state.saved.find((entry) => entry.id === id);
  if (!item) return;
  loadPlan(state, item);
  resetStreak(state); // 换方案后“连续两次”重新累计
  save(state);
  stopPlayback();
  render();
  flash(`已载入方案：${item.name}。`);
});

archiveList.addEventListener("click", (event) => {
  const id = event.target.closest("[data-archive-load]")?.dataset.archiveLoad;
  const entry = state.archive.find((item) => item.id === id);
  if (!entry) return;
  loadArchive(state, entry);
  resetStreak(state);
  save(state);
  stopPlayback();
  render();
  flash(`已载入留档原方案：${entry.name}（${entry.bpm}BPM）。`);
});

$("#playBtn").addEventListener("click", () => {
  if (timer) clearInterval(timer);
  playhead = currentRange()[0];
  tick();
  timer = setInterval(tick, 60000 / context().bpm);
});

$("#stopBtn").addEventListener("click", stopPlayback);

render();
