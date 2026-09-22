/*
 * store.js —— 状态与持久化层：localStorage 读写、旧版数据迁移、所有写操作入口。
 * 规则判断全部委托 LuoguRules；这里只负责"怎么存"。
 */
(function (global) {
  "use strict";

  const R = global.LuoguRules;
  const STORAGE_KEY = "wxyy-4-luogujing-rehearsal";
  const LEGACY_KEY = "wxyy-4-luogujing-grid";
  const STEPS = 16;

  function uid() {
    if (global.crypto && typeof global.crypto.randomUUID === "function") {
      return global.crypto.randomUUID();
    }
    return `id-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  }

  function defaultState(instruments) {
    return {
      version: 2,
      pieceName: "出场锣鼓-慢起",
      bpm: 96,
      loop: "",
      notes: [],
      pattern: instruments.map((instrument) =>
        Array.from({ length: STEPS }, (_, index) => (index % 4 === 0 ? instrument.token : ""))),
      saved: [],
      attempts: [], // 试排（含复盘）历史，时间正序
      issues: []   // 待处理 / 已处理问题
    };
  }

  /* 旧版 wxyy-4-luogujing-grid 数据迁移，保留已存方案与批注 */
  function migrateLegacy(instruments) {
    let legacy = null;
    try {
      legacy = JSON.parse(global.localStorage.getItem(LEGACY_KEY) || "null");
    } catch (_) {
      legacy = null;
    }
    const base = defaultState(instruments);
    if (!legacy) return base;
    if (typeof legacy.pieceName === "string") base.pieceName = legacy.pieceName;
    if (Number(legacy.bpm)) base.bpm = Number(legacy.bpm);
    if (legacy.loop !== undefined) base.loop = String(legacy.loop);
    if (Array.isArray(legacy.notes)) base.notes = legacy.notes;
    if (Array.isArray(legacy.pattern)) base.pattern = legacy.pattern.map((row) => [...row]);
    if (Array.isArray(legacy.saved)) base.saved = legacy.saved;
    return base;
  }

  function load(instruments) {
    let data = null;
    try {
      data = JSON.parse(global.localStorage.getItem(STORAGE_KEY) || "null");
    } catch (_) {
      data = null;
    }
    if (!data) {
      data = migrateLegacy(instruments);
      persist(data);
    }
    if (!Array.isArray(data.attempts)) data.attempts = [];
    if (!Array.isArray(data.issues)) data.issues = [];
    return data;
  }

  function persist(state) {
    global.localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  }

  function createStore(instruments) {
    const state = load(instruments);
    const listeners = new Set();

    function emit() {
      persist(state);
      listeners.forEach((fn) => fn(state));
    }
    function subscribe(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    }

    function get() {
      return state;
    }

    function snapshot() {
      return {
        pieceName: state.pieceName,
        bpm: state.bpm,
        loop: state.loop,
        pattern: R.clonePattern(state.pattern)
      };
    }

    /* 谱面/速度变更的统一闸口：
       试排中 → 拒绝（谱面速度固定，点格子只登记错拍）
       复盘中 → 复盘失效留档，原方案保留
       其余   → 直接生效 */
    function guardScoreChange(kind) {
      const draft = R.findDraftAttempt(state.attempts);
      if (draft) return { ok: false, blocked: true, message: "试排进行中，谱面与速度已固定，请先结束试排" };
      const review = R.findActiveReview(state.attempts);
      if (review) {
        R.voidReview(review, new Date().toISOString(), `${kind}被改动`);
        return { ok: true, voided: true, message: "复盘已因改动失效并留档，原方案随试排保留" };
      }
      return { ok: true };
    }

    function setPieceName(value) {
      state.pieceName = value;
      emit();
    }

    function setBpm(value) {
      const bpm = Number(value) || state.bpm;
      const guard = guardScoreChange("速度");
      if (guard.blocked) return guard;
      state.bpm = bpm;
      emit();
      return guard;
    }

    function setLoop(value) {
      state.loop = String(value);
      emit();
      return { ok: true };
    }

    function toggleCell(row, step) {
      const guard = guardScoreChange("谱面");
      if (guard.blocked) return guard;
      state.pattern[row][step] = state.pattern[row][step] ? "" : instruments[row].token;
      emit();
      return guard;
    }

    function addNote(text) {
      const value = String(text || "").trim();
      if (!value) return { ok: false, message: "批注不能为空" };
      state.notes.unshift(value);
      emit();
      return { ok: true };
    }

    function savePlan() {
      const item = {
        id: uid(),
        name: state.pieceName || "未命名片段",
        bpm: state.bpm,
        loop: state.loop,
        notes: [...state.notes],
        pattern: R.clonePattern(state.pattern),
        createdAt: new Date().toISOString()
      };
      state.saved.unshift(item);
      emit();
      return item;
    }

    function loadPlan(id) {
      const item = state.saved.find((entry) => entry.id === id);
      if (!item) return { ok: false, message: "方案不存在" };
      const patternChanged = JSON.stringify(item.pattern) !== JSON.stringify(state.pattern);
      const bpmChanged = item.bpm !== state.bpm;
      // 载入方案必然改动谱面/速度：试排中拒绝，复盘中失效留档
      const guard = guardScoreChange("谱面");
      if (guard.blocked) return guard;
      state.pieceName = item.name;
      state.bpm = item.bpm;
      state.loop = String(item.loop || "");
      state.notes = [...item.notes];
      state.pattern = R.clonePattern(item.pattern);
      void patternChanged;
      void bpmChanged;
      emit();
      return { ok: true, voided: guard.voided, message: guard.message };
    }

    function segmentLabel(loopValue) {
      if (loopValue === "" || loopValue === undefined || loopValue === null) return "全段";
      return `第${Number(loopValue) + 1}小节`;
    }

    /* 开始试排：固定当前谱面与速度；存在未结束复盘时先将其结束（只允许一个未结束复盘），
       存在进行中试排时直接返回当前试排。 */
    function startAttempt() {
      const draft = R.findDraftAttempt(state.attempts);
      if (draft) return { ok: false, blocked: true, attempt: draft, message: "已有进行中的试排" };
      const open = R.findActiveReview(state.attempts);
      if (open) {
        R.closeReview(open, new Date().toISOString());
      }
      const attempt = R.createAttempt({
        id: uid(),
        no: state.attempts.length + 1,
        pieceName: state.pieceName,
        segmentLabel: segmentLabel(state.loop),
        loop: state.loop,
        pattern: state.pattern,
        bpm: state.bpm,
        startedAt: new Date().toISOString()
      });
      state.attempts.push(attempt);
      emit();
      return { ok: true, attempt, closedPrevious: Boolean(open) };
    }

    /* 结束试排 → 进入复盘（未结束状态）；并立即判定连续两次同类问题 */
    function endAttempt() {
      const draft = R.findDraftAttempt(state.attempts);
      if (!draft) return { ok: false, message: "没有进行中的试排" };
      R.endAttempt(draft, new Date().toISOString());
      state.issues = R.promoteIssues(state.attempts, state.issues, new Date().toISOString());
      emit();
      return { ok: true, attempt: draft };
    }

    function closeReview() {
      const open = R.findActiveReview(state.attempts);
      if (!open) return { ok: false, message: "没有未结束的复盘" };
      R.closeReview(open, new Date().toISOString());
      emit();
      return { ok: true };
    }

    function registerMark(input) {
      const draft = R.findDraftAttempt(state.attempts);
      const open = R.findActiveReview(state.attempts);
      const target = draft || open;
      if (!target) return { ok: false, message: "请先开始试排再登记错拍" };
      const result = R.addMark(target, {
        id: uid(),
        measure: input.measure,
        beat: input.beat,
        instrument: input.instrument,
        reason: input.reason,
        createdAt: new Date().toISOString()
      });
      if (!result.added) return { ok: false, message: result.reason, duplicate: Boolean(result.existing) };
      // 若该试排已结束（复盘中补录），同样重新跑连续判定与统计
      if (target.status === R.ReviewStatus.OPEN) {
        state.issues = R.promoteIssues(state.attempts, state.issues, new Date().toISOString());
      }
      emit();
      return { ok: true, mark: result.existing, attempt: target };
    }

    function resolveMark(markId, note) {
      const result = R.resolveMark(state.attempts, state.issues, markId, note || "", new Date().toISOString());
      if (!result.mark) return { ok: false, message: "错拍记录不存在" };
      emit();
      return { ok: true };
    }

    function undoMark(markId) {
      const result = R.undoMark(state.attempts, state.issues, markId, new Date().toISOString());
      if (!result.removed) return { ok: false, message: "错拍记录不存在" };
      emit();
      return { ok: true };
    }

    function stats() {
      return R.recomputeStats(state.attempts, state.issues);
    }

    function currentAttempt() {
      return R.findDraftAttempt(state.attempts) || R.findActiveReview(state.attempts) || null;
    }

    return {
      subscribe,
      get,
      snapshot,
      setPieceName,
      setBpm,
      setLoop,
      toggleCell,
      addNote,
      savePlan,
      loadPlan,
      startAttempt,
      endAttempt,
      closeReview,
      registerMark,
      resolveMark,
      undoMark,
      stats,
      currentAttempt
    };
  }

  global.LuoguStore = { createStore };
})(window);
