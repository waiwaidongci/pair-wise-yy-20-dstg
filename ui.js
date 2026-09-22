/*
 * ui.js —— 交互层：DOM 渲染、播放、事件绑定。
 * 不直接读写 localStorage，所有变更走 store；谱面高亮、列表、刷新后状态均来自同一份 store。
 */
(function (global) {
  "use strict";

  const R = global.LuoguRules;

  function escapeHtml(value) {
    return String(value ?? "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  function escapeAttr(value) {
    return escapeHtml(value);
  }

  function formatTime(iso) {
    if (!iso) return "";
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return "";
    const pad = (n) => String(n).padStart(2, "0");
    return `${d.getMonth() + 1}/${d.getDate()} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
  }

  function initUI(opts) {
    const { store, instruments, steps } = opts;
    const state = store.get();

    const els = {
      grid: document.querySelector("#grid"),
      savedList: document.querySelector("#savedList"),
      structure: document.querySelector("#structure"),
      notesList: document.querySelector("#notesList"),
      reviewPanel: document.querySelector("#reviewPanel"),
      issuesList: document.querySelector("#issuesList"),
      pieceName: document.querySelector("#pieceName"),
      bpmInput: document.querySelector("#bpmInput"),
      loopSelect: document.querySelector("#loopSelect"),
      noteInput: document.querySelector("#noteInput"),
      playBtn: document.querySelector("#playBtn"),
      stopBtn: document.querySelector("#stopBtn"),
      saveBtn: document.querySelector("#saveBtn"),
      startBtn: document.querySelector("#startBtn"),
      endBtn: document.querySelector("#endBtn"),
      closeReviewBtn: document.querySelector("#closeReviewBtn"),
      rehearsalStatus: document.querySelector("#rehearsalStatus"),
      rehearsalHint: document.querySelector("#rehearsalHint"),
      rehearsalBar: document.querySelector(".rehearsal-bar")
    };

    let timer = null;
    let playhead = 0;
    let audioContext = null;

    function currentRange() {
      const loop = store.get().loop;
      if (loop === "") return [0, steps - 1];
      const start = Number(loop) * R.STEPS_PER_MEASURE;
      return [start, start + R.STEPS_PER_MEASURE - 1];
    }

    /* 高亮范围以"当前试排固定的分段"为准；无试排时用控件选择 */
    function effectiveRange() {
      const attempt = store.currentAttempt();
      if (attempt && attempt.loop !== "") {
        const start = Number(attempt.loop) * R.STEPS_PER_MEASURE;
        return [start, start + R.STEPS_PER_MEASURE - 1];
      }
      return currentRange();
    }

    function beatLabel(index) {
      const { measure, beat } = R.stepToBeat(index);
      return `${measure}-${beat}`;
    }

    /* 收集用于格子高亮的标记：当前试排的错拍 + 已成立待处理问题 */
    function markIndex() {
      const attempt = store.currentAttempt();
      const marks = attempt ? attempt.marks : [];
      const map = new Map();
      marks.forEach((mark) => {
        const key = `${mark.instrument}|${mark.measure}|${mark.beat}`;
        map.set(key, { mark, kind: "mark" });
      });
      store.get().issues.forEach((issue) => {
        if (issue.status !== "open") return;
        const key = `${issue.instrument}|${issue.measure}|${issue.beat}`;
        if (!map.has(key)) map.set(key, { mark: null, kind: "issue" });
      });
      return map;
    }

    function resolvedMarkKeys() {
      const keys = new Set();
      store.get().attempts.forEach((attempt) => {
        attempt.marks.forEach((mark) => {
          if (mark.status === "resolved") {
            keys.add(`${mark.instrument}|${mark.measure}|${mark.beat}`);
          }
        });
      });
      return keys;
    }

    function renderFields() {
      const s = store.get();
      const attempt = store.currentAttempt();
      els.pieceName.value = s.pieceName;
      els.bpmInput.value = s.bpm;
      els.loopSelect.value = s.loop;

      // 试排中谱面/速度/分段全部锁定
      const locked = attempt && attempt.status === R.ReviewStatus.DRAFT;
      els.bpmInput.disabled = locked;
      els.loopSelect.disabled = locked;
      // 谱面锁定与否由格子点击行为体现；名称可随时改（不属于固定项）

      els.startBtn.disabled = Boolean(attempt);
      els.endBtn.disabled = !(attempt && attempt.status === R.ReviewStatus.DRAFT);
      els.closeReviewBtn.disabled = !(attempt && attempt.status === R.ReviewStatus.OPEN);
    }

    function renderRehearsalBar() {
      const attempt = store.currentAttempt();
      const stats = store.stats();
      els.rehearsalBar.classList.remove("live", "open", "void");

      if (!attempt) {
        els.rehearsalStatus.textContent =
          stats.openReviewCount === 0 && stats.attemptCount > 0
            ? `暂无进行中试排（累计 ${stats.attemptCount} 次试排，待处理问题 ${stats.openIssueCount} 个）`
            : "尚未开排";
        els.rehearsalHint.textContent = "点击「开始试排」即固定当前谱面与速度；每次试排只能有一个未结束复盘。";
        return;
      }

      if (attempt.status === R.ReviewStatus.DRAFT) {
        els.rehearsalBar.classList.add("live");
        els.rehearsalStatus.textContent =
          `第 ${attempt.no} 次试排进行中 · ${attempt.segmentLabel} · ${attempt.bpm}BPM`;
        els.rehearsalHint.textContent =
          "谱面与速度已锁定。点击格子 → 填写错因即可登记错拍；同一拍同类错因只保留最早一次。";
      } else if (attempt.status === R.ReviewStatus.OPEN) {
        els.rehearsalBar.classList.add("open");
        els.rehearsalStatus.textContent =
          `第 ${attempt.no} 次试排复盘中（${formatTime(attempt.endedAt)} 结束）· ${attempt.segmentLabel} · ${attempt.bpm}BPM`;
        els.rehearsalHint.textContent =
          "复盘中可补录、更正或撤销错拍；改动谱面或速度会使本复盘失效留档（原方案仍保留）。";
      }
    }

    function renderGrid() {
      const s = store.get();
      const attempt = store.currentAttempt();
      const marksByCell = markIndex();
      const resolvedKeys = resolvedMarkKeys();
      const voided = attempt && attempt.status === R.ReviewStatus.VOID;
      const markable = Boolean(attempt) && !voided;
      // 谱面以试排固定快照为准，保证"试排中改不动"与刷新一致
      const pattern = attempt ? attempt.pattern : s.pattern;

      const header = ['<div class="label-cell">乐器</div>'];
      for (let i = 0; i < steps; i += 1) {
        header.push(`<div class="beat-cell">${beatLabel(i)}</div>`);
      }

      const rows = instruments.flatMap((instrument, rowIndex) => {
        const row = [`<div class="label-cell">${escapeHtml(instrument.name)}</div>`];
        for (let step = 0; step < steps; step += 1) {
          const { measure, beat } = R.stepToBeat(step);
          const value = pattern[rowIndex][step];
          const key = `${instrument.name}|${measure}|${beat}`;
          const entry = marksByCell.get(key);
          const classes = ["cell"];
          if (value) classes.push("filled");
          if (markable) classes.push("markable");
          if (entry?.kind === "mark") classes.push("has-mark");
          if (entry?.kind === "issue") classes.push("has-issue");
          if (resolvedKeys.has(key)) classes.push("resolved");
          if (voided) classes.push("voided");

          let badge = "";
          if (entry?.kind === "issue") badge = '<span class="badge">待</span>';
          else if (resolvedKeys.has(key)) badge = '<span class="badge">正</span>';
          else if (entry?.kind === "mark") badge = '<span class="badge">错</span>';

          row.push(
            `<button class="${classes.join(" ")}" type="button" ` +
              `data-row="${rowIndex}" data-step="${step}" ` +
              `data-measure="${measure}" data-beat="${beat}" ` +
              `data-instrument="${escapeAttr(instrument.name)}">${escapeHtml(value)}${badge}</button>`
          );
        }
        return row;
      });

      els.grid.innerHTML = [...header, ...rows].join("");
    }

    function renderStructure() {
      const s = store.get();
      const attempt = store.currentAttempt();
      const pattern = attempt ? attempt.pattern : s.pattern;
      const measureCount = Math.ceil(steps / R.STEPS_PER_MEASURE);
      const items = Array.from({ length: measureCount }, (_, measure) => {
        const start = measure * R.STEPS_PER_MEASURE;
        const count = pattern
          .flatMap((row) => row.slice(start, start + R.STEPS_PER_MEASURE))
          .filter(Boolean).length;
        return { measure: measure + 1, count };
      });
      els.structure.innerHTML = items.map((item) => `
        <div class="structure-row"><span>第${item.measure}小节</span><strong>${item.count}个口令</strong></div>
      `).join("");
    }

    function renderNotes() {
      const s = store.get();
      els.notesList.innerHTML = s.notes.length
        ? s.notes.map((note) => `<article class="note"><p>${escapeHtml(note)}</p></article>`).join("")
        : '<p class="empty">暂无批注。</p>';
    }

    function renderSaved() {
      const s = store.get();
      els.savedList.innerHTML = s.saved.length
        ? s.saved.map((item) => `
          <button class="saved-item" type="button" data-load="${item.id}">
            <strong>${escapeHtml(item.name)}</strong><br>
            <span>${item.bpm}BPM · ${item.notes.length}条批注 · ${formatTime(item.createdAt)}</span>
          </button>`).join("")
        : '<p class="empty">还没有保存方案。</p>';
    }

    function statusTag(attempt) {
      if (attempt.status === R.ReviewStatus.DRAFT) return '<span class="tag open">试排中</span>';
      if (attempt.status === R.ReviewStatus.OPEN) return '<span class="tag open">复盘未结束</span>';
      if (attempt.status === R.ReviewStatus.VOID) return '<span class="tag void">失效留档</span>';
      return '<span class="tag closed">复盘已结束</span>';
    }

    function markClasses(mark) {
      if (mark.status === "resolved") return "is-resolved";
      const issue = store.get().issues.find((it) => it.signature === mark.signature && it.status === "open");
      return issue ? "is-issue" : "";
    }

    function renderMarks(attempt) {
      if (!attempt.marks.length) return '<p class="empty">本次试排暂无错拍登记。</p>';
      return attempt.marks.map((mark) => {
        const issue = store.get().issues.find((it) => it.signature === mark.signature && it.status === "open");
        const statusLine = mark.status === "resolved"
          ? `<span>已更正${mark.resolveNote ? `：${escapeHtml(mark.resolveNote)}` : ""} · ${formatTime(mark.resolvedAt)}</span>`
          : issue
            ? "<span>已进入待处理（连续两次同类）</span>"
            : "<span>观察中：下一次试排同类再现才进入待处理</span>";
        const canEdit = attempt.status === R.ReviewStatus.OPEN && mark.status !== "resolved";
        return `
          <div class="mark-row ${markClasses(mark)}" data-mark-id="${mark.id}">
            <div class="mr-top">
              <span class="mr-loc">第${mark.measure}小节 第${mark.beat}拍 · ${escapeHtml(mark.instrument)}</span>
              <span>${formatTime(mark.createdAt)}</span>
            </div>
            <p class="mr-reason">错因：${escapeHtml(mark.reason)}</p>
            <div class="mr-top">
              ${statusLine}
              ${canEdit ? `
                <span class="mr-actions">
                  <button class="tiny primary" type="button" data-action="resolve" data-id="${mark.id}">更正</button>
                  <button class="tiny ghost" type="button" data-action="undo" data-id="${mark.id}">撤销</button>
                </span>` : ""}
            </div>
          </div>`;
      }).join("");
    }

    function renderReview() {
      const attempts = store.get().attempts;
      if (!attempts.length) {
        els.reviewPanel.innerHTML = '<p class="empty">尚未开始过试排。</p>';
        return;
      }
      // 最近 4 次，最新在前
      const recent = [...attempts].reverse().slice(0, 4);
      els.reviewPanel.innerHTML = recent.map((attempt) => {
        const voidBanner = attempt.status === R.ReviewStatus.VOID
          ? `<div class="void-banner">复盘已失效留档：${escapeHtml(attempt.voidReason || "")}（${formatTime(attempt.voidedAt)}）。原方案快照保留，统计不计入。</div>`
          : "";
        return `
          <article class="review-card ${attempt.status === R.ReviewStatus.VOID ? "void" : ""}">
            <div class="review-head">
              <strong>第 ${attempt.no} 次试排 · ${escapeHtml(attempt.segmentLabel)}</strong>
              ${statusTag(attempt)}
            </div>
            <p class="review-meta">
              ${escapeHtml(attempt.pieceName || "未命名片段")} · 固定 ${attempt.bpm}BPM<br>
              ${formatTime(attempt.startedAt)} 开始${attempt.endedAt ? ` · ${formatTime(attempt.endedAt)} 结束试排` : ""}
            </p>
            ${voidBanner}
            ${renderMarks(attempt)}
          </article>`;
      }).join("");
    }

    function renderIssues() {
      const issues = store.get().issues;
      if (!issues.length) {
        els.issuesList.innerHTML = '<p class="empty">暂无待处理问题。连续两次试排同一拍同类出错才会进入。</p>';
        return;
      }
      els.issuesList.innerHTML = [...issues]
        .sort((a, b) => (a.status === b.status ? b.lastSeenAt.localeCompare(a.lastSeenAt) : a.status === "open" ? -1 : 1))
        .map((issue) => {
          const attempts = store.get().attempts;
          const pairNos = issue.attemptIds
            .map((id) => attempts.find((a) => a.id === id)?.no)
            .filter((no) => no)
            .map((no) => `第${no}次`);
          return `
          <div class="issue-row ${issue.status === "resolved" ? "resolved" : ""}">
            <p><strong>第${issue.measure}小节 第${issue.beat}拍 · ${escapeHtml(issue.instrument)}</strong>
              ${issue.status === "open" ? '<span class="tag open">待处理</span>' : '<span class="tag closed">已处理</span>'}</p>
            <p>错因：${escapeHtml(issue.reason)}</p>
            <p class="ir-sub">连续出现于${pairNos.join("、") || "相邻两次"}试排 ·
              最近 ${formatTime(issue.lastSeenAt)}${issue.status === "resolved" ? ` · ${formatTime(issue.resolvedAt)} 处理` : ""}</p>
          </div>`;
        }).join("");
    }

    function render() {
      renderFields();
      renderRehearsalBar();
      renderGrid();
      renderStructure();
      renderNotes();
      renderSaved();
      renderReview();
      renderIssues();
    }

    /* ---------- 播放（只读当前试排快照/当前谱面） ---------- */
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

    function playingPattern() {
      const attempt = store.currentAttempt();
      return attempt ? attempt.pattern : store.get().pattern;
    }

    function tick() {
      const [start, end] = effectiveRange();
      if (playhead < start || playhead > end) playhead = start;
      highlight(playhead);
      const pattern = playingPattern();
      instruments.forEach((instrument, rowIndex) => {
        if (pattern[rowIndex][playhead]) playSound(instrument);
      });
      playhead = playhead >= end ? start : playhead + 1;
    }

    function stopPlayback() {
      if (timer) clearInterval(timer);
      timer = null;
      document.querySelectorAll(".cell.playing").forEach((cell) => cell.classList.remove("playing"));
    }

    function restartTimer() {
      if (!timer) return;
      clearInterval(timer);
      timer = setInterval(tick, 60000 / store.get().bpm);
    }

    /* ---------- 错拍登记对话框 ---------- */
    function promptMark(button) {
      const measure = button.dataset.measure;
      const beat = button.dataset.beat;
      const instrument = button.dataset.instrument;
      const reason = global.prompt(`登记错拍 —— 第${measure}小节 第${beat}拍 · ${instrument}\n请写明错因（如：晚半拍、抢拍、漏击）：`, "");
      if (reason === null) return;
      const result = store.registerMark({ measure: Number(measure), beat: Number(beat), instrument, reason });
      if (!result.ok) {
        global.alert(result.duplicate ? "同一拍同类错因已登记，只保留最早一次。" : result.message);
      }
    }

    /* ---------- 事件 ---------- */
    els.grid.addEventListener("click", (event) => {
      const cell = event.target.closest(".cell");
      if (!cell) return;
      const row = Number(cell.dataset.row);
      const step = Number(cell.dataset.step);
      const attempt = store.currentAttempt();
      if (attempt && attempt.status !== R.ReviewStatus.VOID) {
        promptMark(cell);
        return;
      }
      const result = store.toggleCell(row, step);
      if (result.ok && result.voided) {
        global.alert(result.message);
      }
    });

    els.pieceName.addEventListener("input", () => store.setPieceName(els.pieceName.value));

    els.bpmInput.addEventListener("input", () => {
      const result = store.setBpm(els.bpmInput.value);
      if (result.blocked) {
        global.alert(result.message);
        els.bpmInput.value = store.get().bpm;
        return;
      }
      if (result.voided) global.alert(result.message);
      restartTimer();
    });

    els.loopSelect.addEventListener("change", () => {
      store.setLoop(els.loopSelect.value);
      playhead = effectiveRange()[0];
    });

    els.noteInput.addEventListener("keydown", (event) => {
      if (event.key !== "Enter" || !els.noteInput.value.trim()) return;
      store.addNote(els.noteInput.value);
      els.noteInput.value = "";
    });

    els.playBtn.addEventListener("click", () => {
      if (timer) clearInterval(timer);
      [playhead] = effectiveRange();
      tick();
      timer = setInterval(tick, 60000 / store.get().bpm);
    });

    els.stopBtn.addEventListener("click", stopPlayback);

    els.saveBtn.addEventListener("click", () => {
      store.savePlan();
      global.alert("方案已保存。");
    });

    els.savedList.addEventListener("click", (event) => {
      const btn = event.target.closest("[data-load]");
      if (!btn) return;
      const result = store.loadPlan(btn.dataset.load);
      if (result.blocked) global.alert(result.message);
      else if (result.voided) global.alert(result.message);
    });

    els.startBtn.addEventListener("click", () => {
      const result = store.startAttempt();
      if (result.blocked) global.alert(result.message);
      else if (result.closedPrevious) {
        global.alert("上一个复盘已结束（同时只允许一个未结束复盘），已按当前谱面与速度开新试排。");
      }
      playhead = effectiveRange()[0];
    });

    els.endBtn.addEventListener("click", () => {
      store.endAttempt();
    });

    els.closeReviewBtn.addEventListener("click", () => {
      store.closeReview();
    });

    // 更正 / 撤销（事件委托）
    els.reviewPanel.addEventListener("click", (event) => {
      const actionBtn = event.target.closest("[data-action]");
      if (!actionBtn) return;
      const id = actionBtn.dataset.id;
      const action = actionBtn.dataset.action;
      if (action === "resolve") {
        const note = global.prompt("更正说明（可留空）：", "");
        if (note === null) return;
        store.resolveMark(id, note);
      } else if (action === "undo") {
        if (!global.confirm("撤销这条错拍？统计将立即重算，若不再连续则待处理问题自动关闭。")) return;
        store.undoMark(id);
      }
    });

    // store 变更后统一重渲染：谱面高亮、列表、刷新后状态来自同一份数据
    store.subscribe(() => {
      stopPlayback();
      render();
    });

    render();

    return { render, stopPlayback };
  }

  global.LuoguUI = { initUI };
})(window);
