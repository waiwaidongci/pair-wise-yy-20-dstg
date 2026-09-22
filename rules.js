// rules.js —— 业务规则层：只处理试排 / 复盘 / 错拍的规则与统计，不碰 DOM 与存储。

export const STEPS = 16;
export const STEPS_PER_MEASURE = 4;
export const MEASURES = STEPS / STEPS_PER_MEASURE;

export const instruments = [
  { name: "大锣", token: "仓", freq: 180 },
  { name: "鼓", token: "冬", freq: 120 },
  { name: "钹", token: "才", freq: 360 },
  { name: "小锣", token: "台", freq: 520 }
];

// 错因分类：“同类问题”按 key 判定；登记时必须选择一项（写明错因）。
export const reasonCauses = [
  { key: "early", label: "抢拍（早半拍）" },
  { key: "late", label: "拖拍（晚半拍）" },
  { key: "miss", label: "漏奏" },
  { key: "extra", label: "多击" },
  { key: "wrong", label: "错音" },
  { key: "force", label: "力度不当" }
];

const reasonMap = new Map(reasonCauses.map((item) => [item.key, item]));

export function reasonLabel(key) {
  return reasonMap.get(key)?.label ?? key;
}

export function instrumentByName(name) {
  return instruments.find((item) => item.name === name) || null;
}

export function now() {
  return new Date().toISOString();
}

export function uid() {
  if (globalThis.crypto?.randomUUID) return crypto.randomUUID();
  return `id-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

export function makePattern() {
  return instruments.map((instrument) =>
    Array.from({ length: STEPS }, (_, index) => (index % 4 === 0 ? instrument.token : ""))
  );
}

export function createDraft() {
  return {
    pieceName: "出场锣鼓-慢起",
    bpm: 96,
    loop: "",
    notes: [],
    pattern: makePattern()
  };
}

// —— 拍点换算 ——

export function measureOf(step) {
  return Math.floor(step / STEPS_PER_MEASURE) + 1;
}

export function beatOf(step) {
  return (step % STEPS_PER_MEASURE) + 1;
}

export function stepOf(measure, beat) {
  return (measure - 1) * STEPS_PER_MEASURE + (beat - 1);
}

// 同一拍的身份：小节 + 拍 + 乐器（去重只认这个，不认错因文案）
export function beatId(measure, beat, instrument) {
  return `${measure}.${beat}.${instrument}`;
}

// 同一拍 + 同类错因，才构成“同类问题”
export function issueId(mark) {
  return `${beatId(mark.measure, mark.beat, mark.instrument)}:${mark.reason}`;
}

function clonePattern(pattern) {
  return pattern.map((row) => [...row]);
}

// 每次试排开始时固定当前谱面与速度（连同片段名留作原方案快照）
function snapshotDraft(draft) {
  return {
    name: draft.pieceName,
    bpm: draft.bpm,
    pattern: clonePattern(draft.pattern)
  };
}

// —— 试排 / 复盘生命周期 ——

// 只允许一个未结束的试排或复盘：state.session 同时最多一个
export function startTrial(state) {
  if (state.session) return { ok: false, error: "已有未结束的试排或复盘，请先结束" };
  state.session = {
    id: uid(),
    status: "trial", // trial（试排中）-> review（复盘中）-> 关闭归档
    startedAt: now(),
    endedAt: null,
    snapshot: snapshotDraft(state.draft),
    marks: []
  };
  return { ok: true, session: state.session };
}

export function endTrial(state) {
  const session = state.session;
  if (!session || session.status !== "trial") return { ok: false, error: "当前没有进行中的试排" };
  session.status = "review";
  session.endedAt = now();
  return { ok: true };
}

// 试排中改动谱面或速度：复盘失效留档，原方案（快照）随档案保留；连续判定中断。
export function invalidateSession(state, changed) {
  const session = state.session;
  if (!session || session.status !== "trial") return null;
  const entry = toArchiveEntry(session, "invalidated");
  entry.changed = changed;
  state.archive.unshift(entry);
  state.session = null;
  state.lastIssueKeys = [];
  return entry;
}

// 结束复盘：与上一次试排做“连续两次”判定，命中的进入待处理
export function closeReview(state) {
  const session = state.session;
  if (!session || session.status !== "review") return { ok: false, error: "当前没有进行中的复盘" };

  const openMarks = session.marks.filter((mark) => mark.status === "open");
  const previous = new Set(state.lastIssueKeys || []);
  const promoted = [];
  for (const mark of openMarks) {
    const key = issueId(mark);
    if (previous.has(key)) {
      upsertPending(state, mark, session.id);
      promoted.push(key);
    }
  }

  const entry = toArchiveEntry(session, "closed");
  entry.promoted = promoted;
  state.archive.unshift(entry);
  // 只记上一次试排的未决问题，供下一次做“连续两次”判定
  state.lastIssueKeys = openMarks.map(issueId);
  state.session = null;
  return { ok: true, promoted };
}

function upsertPending(state, mark, trialId) {
  const key = issueId(mark);
  let item = state.pending.find((entry) => entry.key === key);
  if (!item) {
    item = {
      key,
      measure: mark.measure,
      beat: mark.beat,
      instrument: mark.instrument,
      reason: mark.reason,
      status: "open",
      trialIds: [],
      firstAt: now(),
      latestAt: now(),
      resolvedAt: null
    };
    state.pending.unshift(item);
  }
  // 已更正的问题再次连续出现，重新进入待处理
  if (item.status === "resolved") {
    item.status = "open";
    item.trialIds = [];
    item.resolvedAt = null;
  }
  if (!item.trialIds.includes(trialId)) item.trialIds.push(trialId);
  item.latestAt = now();
}

// 载入别的方案后，上一次试排的连续判定不再成立
export function resetStreak(state) {
  state.lastIssueKeys = [];
}

// —— 错拍登记：必须写明小节、乐器、错因；同一拍重复只留最早一次 ——

export function addMark(session, input) {
  if (!session || session.status !== "trial") {
    return { ok: false, error: "只有试排中可以登记错拍" };
  }
  const measure = Number(input.measure);
  const beat = Number(input.beat);
  const instrument = String(input.instrument || "");
  const reason = String(input.reason || "");
  const detail = String(input.detail || "").trim();

  if (!Number.isInteger(measure) || measure < 1 || measure > MEASURES) {
    return { ok: false, error: "请选择小节" };
  }
  if (!Number.isInteger(beat) || beat < 1 || beat > STEPS_PER_MEASURE) {
    return { ok: false, error: "请选择拍" };
  }
  if (!instrumentByName(instrument)) return { ok: false, error: "请选择乐器" };
  if (!reasonMap.has(reason)) return { ok: false, error: "请写明错因" };

  const key = beatId(measure, beat, instrument);
  if (session.marks.some((mark) => beatId(mark.measure, mark.beat, mark.instrument) === key)) {
    return { ok: false, duplicated: true, error: "同一拍重复记录，只保留最早一次" };
  }

  const mark = {
    id: uid(),
    measure,
    beat,
    instrument,
    reason,
    detail,
    createdAt: now(),
    status: "open" // open（待更正）/ resolved（已更正）；撤销则直接删除
  };
  session.marks.push(mark);
  return { ok: true, mark };
}

// 撤销错拍：直接移除，统计随之重算
export function revokeMark(session, markId) {
  if (!session) return false;
  const index = session.marks.findIndex((mark) => mark.id === markId);
  if (index < 0) return false;
  session.marks.splice(index, 1);
  return true;
}

// 更正错拍：标记为已更正，统计随之重算
export function resolveMark(session, markId) {
  const mark = session?.marks.find((item) => item.id === markId);
  if (!mark) return false;
  mark.status = "resolved";
  mark.resolvedAt = now();
  return true;
}

export function resolvePending(state, key) {
  const item = state.pending.find((entry) => entry.key === key);
  if (!item) return false;
  item.status = "resolved";
  item.resolvedAt = now();
  return true;
}

export function revokePending(state, key) {
  const index = state.pending.findIndex((entry) => entry.key === key);
  if (index < 0) return false;
  state.pending.splice(index, 1);
  return true;
}

// —— 谱面高亮查询：网格 / 列表 / 刷新后都从同一份状态推导 ——

export function markAt(session, row, step) {
  if (!session) return null;
  const measure = measureOf(step);
  const beat = beatOf(step);
  const instrument = instruments[row].name;
  return (
    session.marks.find(
      (mark) => mark.measure === measure && mark.beat === beat && mark.instrument === instrument
    ) || null
  );
}

export function pendingAt(state, row, step) {
  const measure = measureOf(step);
  const beat = beatOf(step);
  const instrument = instruments[row].name;
  return (
    state.pending.find(
      (item) =>
        item.status === "open" &&
        item.measure === measure &&
        item.beat === beat &&
        item.instrument === instrument
    ) || null
  );
}

// —— 统计：全部由当前状态现算，更正 / 撤销后调用即得新结果 ——

function bump(map, key) {
  map[key] = (map[key] || 0) + 1;
}

function tallyMarks(marks) {
  const tally = { total: 0, open: 0, resolved: 0, byMeasure: {}, byInstrument: {} };
  for (const mark of marks) {
    tally.total += 1;
    if (mark.status === "resolved") tally.resolved += 1;
    else tally.open += 1;
    bump(tally.byMeasure, mark.measure);
    bump(tally.byInstrument, mark.instrument);
  }
  return tally;
}

export function computeStats(state) {
  return {
    current: state.session ? tallyMarks(state.session.marks) : tallyMarks([]),
    pending: tallyMarks(
      state.pending.map((item) => ({
        measure: item.measure,
        instrument: item.instrument,
        status: item.status
      }))
    )
  };
}

function toArchiveEntry(session, outcome) {
  return {
    id: session.id,
    outcome, // closed（正常结束）/ invalidated（改动谱面或速度，失效留档）
    changed: null,
    name: session.snapshot.name,
    bpm: session.snapshot.bpm,
    startedAt: session.startedAt,
    endedAt: now(),
    promoted: [],
    // 原方案保留：快照随档案一起留档，可随时查看 / 载入
    snapshot: {
      name: session.snapshot.name,
      bpm: session.snapshot.bpm,
      pattern: clonePattern(session.snapshot.pattern)
    },
    marks: session.marks.map((mark) => ({ ...mark }))
  };
}
