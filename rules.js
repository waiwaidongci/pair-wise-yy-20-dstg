/*
 * rules.js —— 纯业务规则，不碰 DOM、不碰 localStorage
 *
 * 概念：
 *  - attempt（试排）：开始时固定当前谱面 pattern 与速度 bpm；结束后进入复盘 review。
 *  - mark（错拍登记）：必须写明 小节 / 拍 / 乐器 / 错因；同一拍同一错因重复登记只留最早一次。
 *  - issue（待处理问题）：连续两次试排在同一拍（小节+拍+乐器+错因）出现同类问题才生成。
 *  - review（复盘）：同一时刻只允许一个未结束复盘；试排复盘期间改动谱面或速度，
 *    复盘失效留档（void），错拍记录仍保留；原方案快照随试排保留，可随时回看。
 */
(function (global) {
  "use strict";

  const STEPS_PER_MEASURE = 4;

  const ReviewStatus = Object.freeze({
    DRAFT: "draft",   // 试排进行中
    OPEN: "open",     // 已结束试排，复盘未结束
    CLOSED: "closed", // 复盘正常结束
    VOID: "void"      // 复盘期间谱面/速度被改动，失效留档
  });

  function clonePattern(pattern) {
    return pattern.map((row) => [...row]);
  }

  function stepToBeat(step) {
    return {
      measure: Math.floor(step / STEPS_PER_MEASURE) + 1,
      beat: (step % STEPS_PER_MEASURE) + 1
    };
  }

  function normalizeReason(reason) {
    return String(reason || "").trim();
  }

  /* 同一拍同类问题的唯一标识：小节 + 拍 + 乐器 + 规范化错因 */
  function markSignature({ measure, beat, instrument, reason }) {
    return [measure, beat, instrument, normalizeReason(reason)].join("|");
  }

  function makeSnapshot(plan) {
    return {
      pattern: clonePattern(plan.pattern),
      bpm: plan.bpm
    };
  }

  function createAttempt(input) {
    const snapshot = makeSnapshot(input);
    return {
      id: input.id,
      no: input.no,
      pieceName: input.pieceName || "",
      segmentLabel: input.segmentLabel || "全段",
      loop: input.loop === undefined || input.loop === null ? "" : String(input.loop),
      pattern: snapshot.pattern, // 试排期间固定的谱面
      bpm: snapshot.bpm,        // 试排期间固定的速度
      marks: [],
      status: ReviewStatus.DRAFT,
      startedAt: input.startedAt,
      endedAt: null,
      closedAt: null,
      voidedAt: null,
      voidReason: null
    };
  }

  /* 登记错拍：同一拍（小节+拍+乐器）同一错因只留最早一次。
     同一拍不同错因允许并存。返回 { attempt, added, existing } */
  function addMark(attempt, raw) {
    if (!attempt || (attempt.status !== ReviewStatus.DRAFT && attempt.status !== ReviewStatus.OPEN)) {
      return { attempt, added: false, existing: null, reason: "当前试排不允许登记错拍" };
    }
    const reason = normalizeReason(raw.reason);
    const measure = Number(raw.measure);
    const beat = Number(raw.beat);
    const instrument = String(raw.instrument || "").trim();
    if (!measure || !beat || !instrument || !reason) {
      return { attempt, added: false, existing: null, reason: "小节、乐器和错因必须填写完整" };
    }
    const sig = markSignature({ measure, beat, instrument, reason });
    const existing = attempt.marks.find((mark) => mark.signature === sig);
    if (existing) {
      return { attempt, added: false, existing, reason: "同一拍同类错因已登记，保留最早一次" };
    }
    const mark = {
      id: raw.id,
      measure,
      beat,
      instrument,
      reason,
      signature: sig,
      status: "open", // open / resolved
      createdAt: raw.createdAt,
      resolvedAt: null,
      resolveNote: ""
    };
    attempt.marks.push(mark);
    attempt.marks.sort((a, b) =>
      a.measure - b.measure || a.beat - b.beat || a.createdAt.localeCompare(b.createdAt));
    return { attempt, added: true, existing: mark, reason: "" };
  }

  function endAttempt(attempt, endedAt) {
    if (!attempt || attempt.status !== ReviewStatus.DRAFT) return attempt;
    attempt.status = ReviewStatus.OPEN;
    attempt.endedAt = endedAt;
    return attempt;
  }

  function closeReview(attempt, closedAt) {
    if (!attempt || attempt.status !== ReviewStatus.OPEN) return attempt;
    attempt.status = ReviewStatus.CLOSED;
    attempt.closedAt = closedAt;
    return attempt;
  }

  /* 复盘期间改动谱面或速度：复盘失效留档，原方案（快照）保留 */
  function voidReview(attempt, changedAt, reason) {
    if (!attempt || attempt.status !== ReviewStatus.OPEN) return attempt;
    attempt.status = ReviewStatus.VOID;
    attempt.voidedAt = changedAt;
    attempt.voidReason = reason || "谱面或速度被改动";
    return attempt;
  }

  function findActiveReview(attempts) {
    return attempts.find((a) => a.status === ReviewStatus.OPEN) || null;
  }

  function findDraftAttempt(attempts) {
    return attempts.find((a) => a.status === ReviewStatus.DRAFT) || null;
  }

  /* 连续两次试排（按时间先后相邻）在同一拍出现同类问题 → 待处理。
     issue id 直接取 signature，天然去重；再次出现则重新挂到最新相邻两次。 */
  function promoteIssues(attempts, existingIssues, now) {
    const issues = [...existingIssues];
    const finished = attempts
      .filter((a) => a.status !== ReviewStatus.DRAFT)
      .sort((a, b) => a.startedAt.localeCompare(b.startedAt));

    for (let i = 1; i < finished.length; i += 1) {
      const prev = finished[i - 1];
      const curr = finished[i];
      const prevSigs = new Set(prev.marks.filter((m) => m.status === "open").map((m) => m.signature));
      curr.marks.filter((m) => m.status === "open").forEach((mark) => {
        if (!prevSigs.has(mark.signature)) return;
        const known = issues.find((it) => it.id === mark.signature);
        if (known) {
          known.status = "open";
          known.attemptIds = [prev.id, curr.id];
          known.lastSeenAt = now;
        } else {
          issues.push({
            id: mark.signature,
            measure: mark.measure,
            beat: mark.beat,
            instrument: mark.instrument,
            reason: mark.reason,
            signature: mark.signature,
            status: "open",
            attemptIds: [prev.id, curr.id],
            firstSeenAt: now,
            lastSeenAt: now,
            resolvedAt: null
          });
        }
      });
    }
    return issues;
  }

  function _consecutivePairExists(attempts, signature) {
    const finished = attempts
      .filter((a) => a.status !== ReviewStatus.DRAFT)
      .sort((a, b) => a.startedAt.localeCompare(b.startedAt));
    for (let i = 1; i < finished.length; i += 1) {
      const inPrev = finished[i - 1].marks.some((m) => m.signature === signature && m.status === "open");
      const inCurr = finished[i].marks.some((m) => m.signature === signature && m.status === "open");
      if (inPrev && inCurr) return true;
    }
    return false;
  }

  function _issueFullyResolved(attempts, signature) {
    if (_consecutivePairExists(attempts, signature)) return false;
    return attempts
      .every((a) => a.marks
        .filter((m) => m.signature === signature)
        .every((m) => m.status === "resolved"));
  }

  function resolveMark(attempts, issues, markId, note, at) {
    for (const attempt of attempts) {
      const mark = attempt.marks.find((m) => m.id === markId);
      if (!mark) continue;
      mark.status = "resolved";
      mark.resolvedAt = at;
      mark.resolveNote = note || "";
      issues.forEach((issue) => {
        if (issue.status !== "open") return;
        if (issue.signature !== mark.signature) return;
        if (_issueFullyResolved(attempts, issue.signature)) {
          issue.status = "resolved";
          issue.resolvedAt = at;
        }
      });
      return { mark, attempt };
    }
    return { mark: null, attempt: null };
  }

  /* 撤销错拍：移除后重新评估——若相邻两次同类已不成立，待处理问题一并关闭 */
  function undoMark(attempts, issues, markId, at) {
    let removed = null;
    for (const attempt of attempts) {
      const index = attempt.marks.findIndex((m) => m.id === markId);
      if (index === -1) continue;
      [removed] = attempt.marks.splice(index, 1);
      break;
    }
    if (!removed) return { removed: null };
    issues.forEach((issue) => {
      if (issue.status !== "open") return;
      if (issue.signature !== removed.signature) return;
      if (!_consecutivePairExists(attempts, issue.signature)) {
        issue.status = "resolved";
        issue.resolvedAt = at;
      }
    });
    return { removed };
  }

  /* 统计只数未失效复盘；更正或撤销错拍后调用，整体重算 */
  function recomputeStats(attempts, issues) {
    const active = attempts.filter((a) => a.status !== ReviewStatus.VOID && a.status !== ReviewStatus.DRAFT);
    const marks = active.flatMap((a) => a.marks);
    const pendingMarks = marks.filter((m) => m.status === "open");
    return {
      attemptCount: attempts.filter((a) => a.status !== ReviewStatus.DRAFT).length,
      openReviewCount: attempts.filter((a) => a.status === ReviewStatus.OPEN).length,
      voidCount: attempts.filter((a) => a.status === ReviewStatus.VOID).length,
      markCount: marks.length,
      pendingMarkCount: pendingMarks.length,
      resolvedMarkCount: marks.filter((m) => m.status === "resolved").length,
      openIssueCount: issues.filter((i) => i.status === "open").length,
      resolvedIssueCount: issues.filter((i) => i.status === "resolved").length
    };
  }

  global.LuoguRules = Object.freeze({
    STEPS_PER_MEASURE,
    ReviewStatus,
    clonePattern,
    stepToBeat,
    normalizeReason,
    markSignature,
    createAttempt,
    addMark,
    endAttempt,
    closeReview,
    voidReview,
    findActiveReview,
    findDraftAttempt,
    promoteIssues,
    resolveMark,
    undoMark,
    recomputeStats
  });
})(window);
