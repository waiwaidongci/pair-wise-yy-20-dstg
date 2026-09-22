// 规则层冒烟测试（node --test 风格的临时校验脚本）
import assert from "node:assert/strict";
import {
  createDraft,
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
  computeStats,
  instruments
} from "./rules.js";

function freshState() {
  return {
    version: 2,
    draft: createDraft(),
    session: null,
    pending: [],
    archive: [],
    saved: [],
    lastIssueKeys: []
  };
}

// 1. 同一时间只允许一个未结束的试排/复盘
let s = freshState();
assert.equal(startTrial(s).ok, true);
assert.equal(startTrial(s).ok, false);

// 2. 登记错拍必须写明小节、乐器、错因
assert.equal(addMark(s.session, { measure: 1, beat: 1, instrument: "大锣" }).ok, false);
assert.equal(addMark(s.session, { measure: 1, beat: 1, instrument: "鼓", reason: "late" }).ok, true);
assert.equal(addMark(s.session, { measure: 1, beat: 1, instrument: "鼓", reason: "early" }).duplicated, true); // 同一拍只留最早
assert.equal(addMark(s.session, { measure: 1, beat: 1, instrument: "小锣", reason: "late", detail: "慢了" }).ok, true); // 换乐器不算重复

// 3. 高亮查询与网格一致
assert.equal(markAt(s.session, 1, 0).instrument, "鼓");
assert.equal(markAt(s.session, 1, 0).reason, "late");
assert.equal(markAt(s.session, 0, 0), null);

// 4. 试排中改谱面/速度 -> 失效留档，原方案保留，连续判定中断
s.draft.pattern[0][1] = "仓";
const entry = invalidateSession(s, "谱面");
assert.equal(entry.outcome, "invalidated");
assert.equal(entry.marks.length, 2);
assert.equal(entry.snapshot.pattern[0][1], ""); // 快照保留原方案
assert.equal(s.session, null);
assert.deepEqual(s.lastIssueKeys, []);
assert.equal(s.archive.length, 1);

// 5. 连续两次试排同一拍同类问题 -> 结束复盘时进入待处理；只连续一次不进入
assert.equal(startTrial(s).ok, true);
addMark(s.session, { measure: 2, beat: 2, instrument: "钹", reason: "early" });
endTrial(s);
let result = closeReview(s);
assert.equal(result.promoted.length, 0);
assert.equal(s.pending.length, 0);

assert.equal(startTrial(s).ok, true);
addMark(s.session, { measure: 2, beat: 2, instrument: "钹", reason: "early" }); // 同拍同类 -> 待处理
addMark(s.session, { measure: 3, beat: 1, instrument: "大锣", reason: "late" }); // 首次出现
endTrial(s);
result = closeReview(s);
assert.deepEqual(result.promoted, ["2.2.钹:early"]);
assert.equal(s.pending.length, 1);
assert.equal(s.pending[0].status, "open");

// 不同错因不算同类
assert.equal(startTrial(s).ok, true);
addMark(s.session, { measure: 3, beat: 1, instrument: "大锣", reason: "early" });
endTrial(s);
result = closeReview(s);
assert.equal(result.promoted.length, 0);

// 中间一次失效会打断连续
assert.equal(startTrial(s).ok, true);
addMark(s.session, { measure: 4, beat: 3, instrument: "小锣", reason: "miss" });
invalidateSession(s, "速度");
assert.equal(startTrial(s).ok, true);
addMark(s.session, { measure: 4, beat: 3, instrument: "小锣", reason: "miss" });
endTrial(s);
result = closeReview(s);
assert.equal(result.promoted.length, 0);

// 6. 更正/撤销后统计重算
s = freshState();
startTrial(s);
addMark(s.session, { measure: 1, beat: 1, instrument: "大锣", reason: "early" });
addMark(s.session, { measure: 1, beat: 2, instrument: "大锣", reason: "late" });
let stats = computeStats(s);
assert.equal(stats.current.total, 2);
assert.equal(stats.current.open, 2);
assert.equal(stats.current.byMeasure[1], 2);
assert.equal(stats.current.byInstrument["大锣"], 2);

endTrial(s);
const firstId = s.session.marks[0].id;
resolveMark(s.session, firstId);
stats = computeStats(s);
assert.equal(stats.current.open, 1);
assert.equal(stats.current.resolved, 1);
assert.equal(markAt(s.session, 0, 0).status, "resolved"); // 高亮与列表同源

revokeMark(s.session, s.session.marks[0].id);
stats = computeStats(s);
assert.equal(stats.current.total, 1);
assert.equal(markAt(s.session, 0, 0), null);

// 待处理的更正/撤销
s.pending.push({
  key: "1.2.大锣:late", measure: 1, beat: 2, instrument: "大锣", reason: "late",
  status: "open", trialIds: ["t1", "t2"], firstAt: new Date().toISOString(), latestAt: new Date().toISOString(), resolvedAt: null
});
assert.equal(pendingAt(s, 0, 1).key, "1.2.大锣:late"); // 第2拍 = step 1
resolvePending(s, "1.2.大锣:late");
assert.equal(computeStats(s).pending.open, 0);
assert.equal(computeStats(s).pending.resolved, 1);
assert.equal(pendingAt(s, 0, 1), null); // 已更正不再高亮为待处理
revokePending(s, "1.2.大锣:late");
assert.equal(s.pending.length, 0);

// 7. 复盘期间不允许登记错拍；只有试排中可以
assert.equal(addMark(s.session, { measure: 1, beat: 1, instrument: "鼓", reason: "late" }).ok, false);

// 8. 已更正的待处理问题再次连续出现 -> 重新进入待处理
s = freshState();
startTrial(s);
addMark(s.session, { measure: 2, beat: 1, instrument: "鼓", reason: "extra" });
endTrial(s); closeReview(s);
startTrial(s);
addMark(s.session, { measure: 2, beat: 1, instrument: "鼓", reason: "extra" });
endTrial(s); closeReview(s);
assert.equal(s.pending[0].status, "open");
resolvePending(s, s.pending[0].key);
assert.equal(s.pending[0].status, "resolved");
startTrial(s);
addMark(s.session, { measure: 2, beat: 1, instrument: "鼓", reason: "extra" });
endTrial(s);
const beforeClose = s.pending[0].status;
closeReview(s);
assert.equal(beforeClose, "resolved");
assert.equal(s.pending[0].status, "open");

// 9. 换方案重置连续判定
resetStreak(s);
assert.deepEqual(s.lastIssueKeys, []);

// 10. 乐器常量未被改动（迁移兼容）
assert.equal(instruments.length, 4);

console.log("全部规则层冒烟测试通过 ✔");
