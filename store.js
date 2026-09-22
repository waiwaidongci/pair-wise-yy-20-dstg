// store.js —— 存储层：localStorage 读写、旧数据迁移。业务判定全部委托给 rules.js。

import { createDraft } from "./rules.js";

const storageKey = "wxyy-4-luogujing-grid";
const schemaVersion = 2;

function freshState() {
  return {
    version: schemaVersion,
    draft: createDraft(),
    session: null, // 至多一个未结束的试排 / 复盘（刷新后仍在）
    pending: [], // 连续两次同类问题 -> 待处理
    archive: [], // 已结束或失效留档的复盘，含原方案快照
    saved: [], // 手动保存的方案
    lastIssueKeys: [] // 上一次试排的未决问题键，用于连续两次判定
  };
}

// 旧版（单文件版本）数据迁移为新结构，保留已存方案与批注
function migrate(raw) {
  if (raw && raw.version === schemaVersion) return raw;

  const state = freshState();
  if (!raw) return state;

  state.draft.pieceName = raw.pieceName || state.draft.pieceName;
  state.draft.bpm = typeof raw.bpm === "number" ? raw.bpm : state.draft.bpm;
  state.draft.loop = raw.loop || "";
  state.draft.notes = Array.isArray(raw.notes) ? [...raw.notes] : [];
  if (Array.isArray(raw.pattern)) state.draft.pattern = raw.pattern.map((row) => [...row]);

  if (Array.isArray(raw.saved)) {
    state.saved = raw.saved.map((item) => ({
      id: item.id,
      name: item.name,
      bpm: item.bpm,
      loop: item.loop || "",
      notes: Array.isArray(item.notes) ? [...item.notes] : [],
      pattern: Array.isArray(item.pattern) ? item.pattern.map((row) => [...row]) : [],
      createdAt: item.createdAt
    }));
  }
  return state;
}

export function load() {
  try {
    const raw = JSON.parse(localStorage.getItem(storageKey) || "null");
    return migrate(raw);
  } catch (error) {
    console.warn("锣鼓经排练台数据读取失败，已使用初始数据：", error);
    return freshState();
  }
}

export function save(state) {
  localStorage.setItem(storageKey, JSON.stringify(state));
}

// 谱面 / 速度 / 循环 / 批注直接落在当前草稿；试排期间的失效拦截由 ui.js 处理
export function persistDraft(state) {
  save(state);
}

export function savePlan(state) {
  state.saved.unshift({
    id: crypto.randomUUID(),
    name: state.draft.pieceName || "未命名片段",
    bpm: state.draft.bpm,
    loop: state.draft.loop,
    notes: [...state.draft.notes],
    pattern: state.draft.pattern.map((row) => [...row]),
    createdAt: new Date().toISOString()
  });
  save(state);
}

export function loadPlan(state, plan) {
  state.draft.pieceName = plan.name;
  state.draft.bpm = plan.bpm;
  state.draft.loop = plan.loop || "";
  state.draft.notes = [...(plan.notes || [])];
  state.draft.pattern = (plan.pattern || []).map((row) => [...row]);
  save(state);
}

export function loadArchive(state, entry) {
  state.draft.pieceName = entry.snapshot.name;
  state.draft.bpm = entry.snapshot.bpm;
  state.draft.pattern = entry.snapshot.pattern.map((row) => [...row]);
  save(state);
}
