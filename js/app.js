/* 화면 동작 */
(() => {
  "use strict";
  const $ = (id) => document.getElementById(id);
  const CFG = Object.assign({ jusoKey: "", maxRows: 5000, concurrency: 3, manualSearchUrl: "" }, window.ZIPCODE_CONFIG || {});

  const S = {
    file: null, buf: null, book: null, sheet: null, sheetIndex: 0, layout: null,
    rows: [], filter: "all", running: false, stop: false, client: null,
  };

  const STATUS = {
    wait:   { label: "대기",         cls: "wait" },
    busy:   { label: "조회 중",      cls: "busy" },
    ok:     { label: "입력됨",       cls: "ok" },
    picked: { label: "입력됨(선택)", cls: "ok" },
    pick:   { label: "선택 필요",    cls: "pick" },
    none:   { label: "결과 없음",    cls: "none" },
    error:  { label: "조회 오류",    cls: "error" },
  };
  const FILTERS = [
    { key: "all",   label: "전체",      color: null,          test: () => true },
    { key: "done",  label: "입력됨",    color: "var(--ok)",   test: (r) => r.status === "ok" || r.status === "picked" },
    { key: "pick",  label: "선택 필요", color: "var(--warn)", test: (r) => r.status === "pick" },
    { key: "none",  label: "결과 없음", color: "var(--bad)",  test: (r) => r.status === "none" },
    { key: "error", label: "조회 오류", color: "var(--bad)",  test: (r) => r.status === "error", hideEmpty: true },
  ];

  // ── 공통 ─────────────────────────────────────────
  function el(tag, attrs = {}, ...kids) {
    const n = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs)) {
      if (v == null || v === false) continue;
      if (k === "class") n.className = v;
      else if (k === "text") n.textContent = v;
      else if (k.startsWith("on")) n.addEventListener(k.slice(2), v);
      else n.setAttribute(k, v === true ? "" : v);
    }
    for (const k of kids.flat()) if (k != null) n.append(k);
    return n;
  }
  const show = (id, on) => { $(id).hidden = !on; };
  const msg = (id, text) => { const n = $(id); n.textContent = text || ""; n.hidden = !text; };
  function setStep(n) {
    document.querySelectorAll("#steps li").forEach((li) => {
      const s = +li.dataset.step;
      li.classList.toggle("on", s === n);
      li.classList.toggle("done", s < n);
    });
  }
  function zipBoxes(zip) {
    const z = (zip || "").padEnd(5).slice(0, 5);
    const box = el("span", { class: "zip" + (zip ? "" : " empty"), "aria-label": zip ? `우편번호 ${zip}` : "우편번호 없음" });
    for (const ch of z) box.append(el("span", { "aria-hidden": "true", text: ch.trim() }));
    return box;
  }
  function manualLink(q) {
    const base = CFG.manualSearchUrl || "https://www.epost.kr/search.RetrieveIntegrationNewZipCdList.comm";
    return base + (base.includes("?") ? "&" : "?") + "keyword=" + encodeURIComponent(q);
  }

  // ── 조회처 표시 ───────────────────────────────────
  $("source").replaceChildren(el("span", { class: "dot", style: CFG.jusoKey ? null : "background:var(--bad)" }),
    el("span", {}, "조회처 ", el("b", { text: "행정안전부 도로명주소" })));

  // ── 1. 파일 올리기 ────────────────────────────────
  const drop = $("drop");
  ["dragenter", "dragover"].forEach((t) => drop.addEventListener(t, (e) => { e.preventDefault(); drop.classList.add("over"); }));
  ["dragleave", "drop"].forEach((t) => drop.addEventListener(t, (e) => { e.preventDefault(); drop.classList.remove("over"); }));
  drop.addEventListener("drop", (e) => { const f = e.dataTransfer.files[0]; if (f) openFile(f); });
  $("file").addEventListener("change", (e) => { const f = e.target.files[0]; if (f) openFile(f); e.target.value = ""; });
  $("changeFile").addEventListener("click", () => {
    if (S.running) return;
    Object.assign(S, { file: null, buf: null, book: null, sheet: null, layout: null, rows: [] });
    show("setupSec", false); show("resultSec", false); show("dropSec", true); setStep(1);
  });

  async function openFile(f) {
    msg("dropErr", "");
    if (!/\.xlsx$/i.test(f.name)) {
      msg("dropErr", /\.xls$/i.test(f.name)
        ? ".xls 파일은 엑셀에서 ‘다른 이름으로 저장 → Excel 통합 문서(.xlsx)’로 바꾼 뒤 올려 주세요."
        : ".xlsx 엑셀 파일만 올릴 수 있습니다.");
      return;
    }
    try {
      S.file = f;
      S.buf = await f.arrayBuffer();
      S.book = await XlsxLite.open(S.buf);
      await chooseSheet();
    } catch (e) {
      S.file = null;
      msg("dropErr", e.message);
      return;
    }
    show("dropSec", false); show("setupSec", true);
  }

  // '주소' 제목이 있는 첫 시트를 고른다
  async function chooseSheet() {
    const order = S.book.sheets.map((s, i) => i).sort((a, b) => S.book.sheets[a].hidden - S.book.sheets[b].hidden);
    for (const i of order) {
      const sh = await XlsxLite.loadSheet(S.book, i);
      let lay;
      try { lay = SheetLayout.inspect(sh, { maxRows: CFG.maxRows }); } catch { continue; }
      if (lay.addressCol) { setLayout(i, sh, lay); return; }
    }
    await inspect({ sheetIndex: order[0] });
  }

  async function inspect({ sheetIndex, addressCol, zipCol, newZipCol }) {
    const sh = sheetIndex === S.sheetIndex && S.sheet ? S.sheet : await XlsxLite.loadSheet(S.book, sheetIndex);
    const lay = SheetLayout.inspect(sh, { addressCol, zipCol, newZipCol, maxRows: CFG.maxRows });
    setLayout(sheetIndex, sh, lay);
  }

  function setLayout(i, sh, lay) {
    S.sheetIndex = i; S.sheet = sh; S.layout = lay;
    S.rows = lay.rows.map((r) => ({ ...r, status: "wait", cands: [], sel: null, query: "", tried: [], error: "", note: "", editing: false }));
    S.filter = "all";
    renderSetup();
    renderTable();
    setStep(2);
  }

  // ── 2. 열 확인 ───────────────────────────────────
  function renderSetup() {
    const L = S.layout;
    $("fileName").textContent = S.file.name;
    const n = L.rows.length;
    $("fileMeta").textContent = L.addressCol
      ? (n ? `주소 ${n.toLocaleString()}건 (${L.rows[0].row}~${L.rows[n - 1].row}행)` : "주소가 들어 있는 행이 없습니다")
      : "주소 열을 골라 주세요";

    const sheet = $("selSheet");
    sheet.replaceChildren(...S.book.sheets.map((s, i) => el("option", { value: i, text: s.name + (s.hidden ? " (숨김)" : ""), selected: i === S.sheetIndex })));
    sheet.disabled = S.book.sheets.length < 2;

    const addr = $("selAddr");
    addr.replaceChildren(
      el("option", { value: "", text: "열을 고르세요", selected: !L.addressCol }),
      ...L.headers.map((h) => el("option", { value: h.col, text: `${h.letter}열 · ${h.title}`, selected: h.col === L.addressCol })));

    const zip = $("selZip");
    zip.replaceChildren(
      ...L.headers.filter((h) => h.col !== L.addressCol)
        .map((h) => el("option", { value: h.col, text: `${h.letter}열 · ${h.title}`, selected: h.col === L.zipCol })),
      el("option", { value: "new", text: `새 열 만들기 (${L.newZipLetter}열 · 우편번호)`, selected: !L.zipCol }));

    const warn = [];
    if (L.truncated) warn.push(`한 번에 ${CFG.maxRows.toLocaleString()}건까지만 처리합니다. 나머지 행은 파일을 나눠 올려 주세요.`);
    const existing = L.rows.filter((r) => r.existing).length;
    if (existing) warn.push(`우편번호 열에 이미 값이 있는 행이 ${existing.toLocaleString()}건 있습니다. 조회 결과로 다시 채웁니다.`);
    msg("setupWarn", warn.join(" "));
    msg("setupErr", L.zipFormulaRows.length
      ? `우편번호 열에 수식이 들어 있는 칸이 있습니다(${L.zipFormulaRows.slice(0, 5).join(", ")}행). 수식이 없는 열을 고르거나 ‘새 열 만들기’를 골라 주세요.`
      : "");
    msg("keyErr", CFG.jusoKey ? "" : "도로명주소 승인키가 설정되지 않아 조회할 수 없습니다. 관리자가 config.js에 승인키를 넣어야 합니다.");
    $("startBtn").disabled = !L.addressCol || !n || !CFG.jusoKey || L.zipFormulaRows.length > 0;
    $("startBtn").textContent = "우편번호 조회 시작";
    show("progressBox", false);
    show("resultSec", n > 0);
    updateDock();
  }

  function currentSel() {
    const z = $("selZip").value;
    return {
      sheetIndex: +$("selSheet").value,
      addressCol: $("selAddr").value ? +$("selAddr").value : null,
      zipCol: z && z !== "new" ? +z : null,
      newZipCol: z === "new",
    };
  }
  ["selSheet", "selAddr", "selZip"].forEach((id) => $(id).addEventListener("change", async () => {
    const p = currentSel();
    if (id === "selSheet") { p.addressCol = null; p.zipCol = null; p.newZipCol = false; }
    if (id === "selAddr") { p.zipCol = null; p.newZipCol = false; }
    try { await inspect(p); } catch (err) { msg("setupErr", err.message); }
  }));

  // ── 3. 조회 ──────────────────────────────────────
  $("startBtn").addEventListener("click", run);
  $("stopBtn").addEventListener("click", () => { S.stop = true; $("stopBtn").disabled = true; });

  function lockSetup(on) {
    ["selAddr", "selZip", "changeFile"].forEach((id) => { $(id).disabled = on; });
    $("selSheet").disabled = on || S.book.sheets.length < 2;
  }

  async function run() {
    if (S.running) return;
    const todo = S.rows.filter((r) => r.status === "wait" || r.status === "error");
    if (!todo.length) return;
    S.client = S.client || new Juso.Client(CFG.jusoKey);
    S.running = true; S.stop = false;
    lockSetup(true);
    $("startBtn").hidden = true; $("stopBtn").hidden = false; $("stopBtn").disabled = false;
    show("progressBox", true); setStep(3); msg("setupErr", "");
    let i = 0, errStreak = 0;
    const worker = async () => {
      while (!S.stop && i < todo.length) {
        const r = todo[i++];
        await lookup(r);
        errStreak = r.status === "error" ? errStreak + 1 : 0;
        if (r.fatal || (errStreak >= 5 && !S.stop)) {
          S.stop = true;
          msg("setupErr", r.fatal ? r.error : `연속으로 조회에 실패해 멈췄습니다: ${r.error} 인터넷 연결을 확인한 뒤 ‘이어서 조회’를 누르세요.`);
        }
      }
    };
    await Promise.all(Array.from({ length: Math.max(1, CFG.concurrency) }, worker));
    S.running = false;
    lockSetup(false);
    $("startBtn").hidden = false; $("stopBtn").hidden = true;
    const left = S.rows.filter((r) => r.status === "wait" || r.status === "error").length;
    $("startBtn").textContent = left ? `남은 ${left.toLocaleString()}건 이어서 조회` : "우편번호 조회 시작";
    $("startBtn").disabled = !left;
    updateTally(); updateDock();
  }

  async function lookup(r, query) {
    r.status = "busy"; r.error = ""; r.fatal = false; renderRow(r);
    try {
      S.client = S.client || new Juso.Client(CFG.jusoKey);
      applyResult(r, await S.client.lookup(r.address, query || null));
    } catch (e) {
      r.status = "error"; r.error = e.message || String(e); r.fatal = !!e.fatal; r.editing = true;
      if (!r.tried.length && query) r.tried = [query];
    }
    renderRow(r, true);
    updateTally(); updateDock();
  }

  function applyResult(r, res) {
    r.cands = res.candidates || [];
    r.tried = res.tried || [];
    r.query = res.query || r.tried[r.tried.length - 1] || r.address;
    r.note = res.note || "";
    const zips = new Set(r.cands.map((c) => c.zip));
    if (!r.cands.length) { r.status = "none"; r.sel = null; r.editing = true; }
    else if (zips.size === 1) { r.status = "ok"; r.sel = 0; r.editing = false; }
    else { r.status = "pick"; r.sel = null; r.editing = false; }
  }

  // ── 표 그리기 ────────────────────────────────────
  function renderTable() {
    $("tbody").replaceChildren(...S.rows.map((r) => { r.tr = el("tr"); fillRow(r); return r.tr; }));
    updateTally();
  }
  function renderRow(r, flash) {
    fillRow(r);
    if (flash && r.status === "ok") { r.tr.classList.remove("flash"); void r.tr.offsetWidth; r.tr.classList.add("flash"); }
    applyFilterTo(r);
  }

  function fillRow(r) {
    const st = STATUS[r.status];
    const chosen = r.sel != null ? r.cands[r.sel] : null;
    const multiZip = r.cands.length && new Set(r.cands.map((c) => c.zip)).size > 1;

    const addr = el("td", { class: "addr" }, r.address,
      r.existing ? el("span", { class: "ex", text: `기존 값 ${r.existing}` }) : null);

    const res = el("td", { class: "res" });
    if (r.status === "wait") res.append(el("span", { class: "sub", text: "조회 전" }));
    else if (r.status === "busy") res.append(el("span", { class: "sub", text: "도로명주소에서 찾는 중" }));
    else if (multiZip) {
      res.append(el("select", {
        class: r.sel != null ? "chosen" : null, "aria-label": `${r.row}행 우편번호 고르기`,
        onchange: (e) => {
          const v = e.target.value; r.sel = v === "" ? null : +v; r.status = r.sel == null ? "pick" : "picked";
          renderRow(r); updateTally(); updateDock();
        },
      },
      el("option", { value: "", text: `검색 결과 ${r.cands.length}건 중 하나를 고르세요`, selected: r.sel == null }),
      ...r.cands.map((c, i) => el("option", { value: i, text: `${c.zip}  ${c.road}`, selected: r.sel === i }))));
      if (chosen && chosen.jibun) res.append(el("span", { class: "sub", text: chosen.jibun }));
      if (r.note) res.append(el("span", { class: "sub", text: r.note }));
    } else if (chosen) {
      res.append(chosen.road);
      const extra = r.cands.length > 1 ? ` · 후보 ${r.cands.length}건 모두 같은 우편번호` : "";
      if (chosen.jibun || extra) res.append(el("span", { class: "sub", text: (chosen.jibun || "") + extra }));
    } else if (r.status === "none") {
      res.append(el("span", { class: "sub", text: `검색 결과가 없습니다. 시·군·구를 붙이거나 상세주소를 빼고 다시 검색해 보세요.${r.note ? " (" + r.note + ")" : ""}` }));
    } else if (r.status === "error") {
      res.append(el("span", { class: "sub", style: "color:var(--bad)", text: r.error }));
    }
    if (r.editing && r.status !== "busy" && r.status !== "wait") {
      const input = el("input", { type: "text", "aria-label": `${r.row}행 검색어` });
      input.value = r.status === "ok" || r.status === "picked" || r.status === "pick" ? (r.query || r.address) : (r.tried[0] || r.address);
      res.append(el("form", { onsubmit: (e) => { e.preventDefault(); const q = input.value.trim(); if (q) lookup(r, q); } },
        input, el("button", { class: "btn line small", type: "submit", text: "다시 검색" })));
    }

    const actions = el("td", { class: "act" });
    if (r.status !== "wait" && r.status !== "busy") {
      actions.append(el("a", { href: manualLink(r.query || r.address), target: "_blank", rel: "noopener", text: "우체국에서 보기" }));
      if (!r.editing) actions.append(el("button", {
        class: "linkish", type: "button", text: "다시 검색",
        onclick: () => { r.editing = true; renderRow(r); const i = r.tr.querySelector("input"); if (i) i.focus(); },
      }));
    }

    r.tr.replaceChildren(
      el("td", { class: "rn", text: r.row }),
      addr,
      el("td", { class: "z" }, zipBoxes(chosen ? chosen.zip : "")),
      res,
      el("td", { class: "st" }, el("span", { class: "tag " + st.cls, text: st.label })),
      actions);
  }

  function counts() {
    const c = {};
    for (const f of FILTERS) c[f.key] = S.rows.filter(f.test).length;
    return c;
  }
  function updateTally() {
    const c = counts();
    const box = $("tally");
    box.replaceChildren(...FILTERS.filter((f) => !(f.hideEmpty && !c[f.key])).map((f) =>
      el("button", {
        class: "chip", type: "button", "aria-pressed": String(S.filter === f.key),
        onclick: () => { S.filter = f.key; updateTally(); S.rows.forEach(applyFilterTo); },
      }, f.color ? el("span", { class: "sw", style: `background:${f.color}` }) : null, f.label, el("b", { text: c[f.key].toLocaleString() }))));
    const done = S.rows.filter((r) => r.status !== "wait" && r.status !== "busy").length;
    $("bar").style.width = `${Math.round((done / (S.rows.length || 1)) * 100)}%`;
    box.append(el("span", { class: "status-text", text: S.running ? `${done.toLocaleString()} / ${S.rows.length.toLocaleString()}건 조회` : "" }));
  }
  function applyFilterTo(r) {
    const f = FILTERS.find((x) => x.key === S.filter) || FILTERS[0];
    r.tr.hidden = !f.test(r);
  }

  // ── 4. 내려받기 ──────────────────────────────────
  function updateDock() {
    const c = counts();
    const filled = c.done, todo = c.pick + c.none + c.error;
    const waiting = S.rows.filter((r) => r.status === "wait" || r.status === "busy").length;
    $("downloadBtn").disabled = S.running || filled === 0;
    const s = $("summary");
    s.replaceChildren();
    if (!S.rows.length) return;
    s.append(el("b", { text: `${filled.toLocaleString()}건` }), ` 입력 / 전체 ${S.rows.length.toLocaleString()}건`);
    const rest = todo + waiting;
    if (rest) s.append(el("br"), `나머지 ${rest.toLocaleString()}건은 우편번호 칸이 빈 채로 저장됩니다`);
    if (filled && !S.running && !waiting) setStep(4);
  }

  $("downloadBtn").addEventListener("click", async () => {
    msg("dlErr", "");
    const btn = $("downloadBtn");
    btn.disabled = true; btn.textContent = "파일 만드는 중";
    try {
      const assignments = new Map();
      for (const r of S.rows) {
        if (r.sel == null || !(r.status === "ok" || r.status === "picked")) continue;
        const c = r.cands[r.sel];
        if (!/^\d{5}$/.test(c.zip)) continue;
        assignments.set(r.row, { zip: c.zip, road: c.road });
      }
      // 원본을 다시 열어서 고친다 (여러 번 내려받아도 매번 원본 기준)
      const sel = currentSel();
      const book = await XlsxLite.open(S.buf);
      const sheet = await XlsxLite.loadSheet(book, S.sheetIndex);
      const layout = SheetLayout.inspect(sheet, { addressCol: sel.addressCol, zipCol: sel.zipCol, newZipCol: sel.newZipCol, maxRows: CFG.maxRows });
      SheetLayout.fill(sheet, layout, assignments, { clearUnresolved: $("optClear").checked, addCheckColumn: $("optCheck").checked });
      const blob = await sheet.toBlob();
      const name = S.file.name.replace(/\.xlsx$/i, "") + "_우편번호.xlsx";
      const a = el("a", { href: URL.createObjectURL(blob), download: name });
      document.body.append(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(a.href), 4000);
      setStep(5);
    } catch (e) {
      msg("dlErr", "파일을 만들지 못했습니다: " + e.message);
    } finally {
      btn.textContent = "엑셀 내려받기"; updateDock();
    }
  });
})();
