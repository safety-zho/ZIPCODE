/* 시트에서 '주소' 열과 '우편번호' 열을 찾고, 주소가 든 행을 모은다. */
(function (global) {
  "use strict";

  const HEADER_SCAN_ROWS = 30;
  const ADDRESS_EXCLUDE = ["상세", "이메일", "메일", "email", "e-mail", "ip", "url", "홈페이지", "영문"];

  const squash = (v) => String(v ?? "").replace(/ /g, " ").replace(/\s+/g, " ").trim();
  const key = (v) => squash(v).replace(/\s+/g, "").toLowerCase();

  function addressScore(title) {
    const k = key(title);
    if (!k.includes("주소")) return 0;
    if (ADDRESS_EXCLUDE.some((x) => k.includes(x))) return 0;
    if (["주소", "도로명주소", "주소(도로명)", "도로명", "소재지", "주소지"].includes(k)) return 3;
    if (k.startsWith("도로명") || k.endsWith("주소")) return 2;
    return 1;
  }
  function isZipTitle(title) {
    const k = key(title);
    return k.includes("우편번호") || ["우편", "zip", "zipcode", "postcode"].includes(k);
  }

  function findHeaderRow(sheet) {
    let best = null;
    const maxR = Math.min(sheet.maxRow, HEADER_SCAN_ROWS);
    for (let r = 1; r <= maxR; r++) {
      for (let c = 1; c <= sheet.maxCol; c++) {
        const s = addressScore(sheet.text(r, c));
        if (s && (!best || s > best.score)) best = { score: s, row: r };
      }
      if (best && best.score === 3) break;
    }
    return best ? best.row : null;
  }
  function firstNonEmptyRow(sheet) {
    const maxR = Math.min(sheet.maxRow, HEADER_SCAN_ROWS);
    for (let r = 1; r <= maxR; r++) for (let c = 1; c <= sheet.maxCol; c++) if (squash(sheet.text(r, c))) return r;
    return 1;
  }

  /**
   * opts: { addressCol, zipCol, newZipCol(boolean), maxRows }
   */
  function inspect(sheet, opts = {}) {
    const maxRows = opts.maxRows || 5000;
    const headerRow = findHeaderRow(sheet) || firstNonEmptyRow(sheet);
    const headers = [];
    let lastCol = 0;
    for (let c = 1; c <= sheet.maxCol; c++) {
      const t = squash(sheet.text(headerRow, c));
      if (t) {
        headers.push({ col: c, letter: XlsxLite.numToCol(c), title: t });
        lastCol = c;
      }
    }
    if (!headers.length) throw new Error("시트에서 열 제목을 찾지 못했습니다. 위쪽에 ‘주소’, ‘우편번호’ 같은 제목이 있는지 확인해 주세요.");

    let addressCol = opts.addressCol || null;
    if (!addressCol) {
      let best = null;
      for (const h of headers) {
        const s = addressScore(h.title);
        if (s && (!best || s > best.s)) best = { col: h.col, s };
      }
      addressCol = best ? best.col : null;
    }

    let zipCol = null;
    if (!opts.newZipCol) {
      zipCol = opts.zipCol || null;
      if (!zipCol) {
        const z = headers.find((h) => isZipTitle(h.title) && h.col !== addressCol);
        zipCol = z ? z.col : null;
      }
    }
    if (addressCol && zipCol === addressCol) throw new Error("주소 열과 우편번호 열이 같습니다. 서로 다른 열을 골라 주세요.");

    const newZipColNum = Math.max(lastCol, sheet.maxCol) + 1;
    const layout = {
      headerRow, headers, addressCol, zipCol,
      newZipCol: newZipColNum, newZipLetter: XlsxLite.numToCol(newZipColNum),
      rows: [], truncated: false, zipFormulaRows: [],
    };
    if (!addressCol) return layout;

    for (let r = headerRow + 1; r <= sheet.maxRow; r++) {
      const address = squash(sheet.text(r, addressCol));
      if (!address) continue;
      if (layout.rows.length >= maxRows) { layout.truncated = true; break; }
      const existing = zipCol ? squash(sheet.text(r, zipCol)) : "";
      if (zipCol && sheet.hasFormula(r, zipCol)) layout.zipFormulaRows.push(r);
      layout.rows.push({ row: r, address, existing });
    }
    return layout;
  }

  /**
   * assignments: Map(행번호 → { zip, road })
   * opts: { zipCol(null이면 새 열), addressCol, headerRow, rows, clearUnresolved, addCheckColumn }
   */
  function fill(sheet, layout, assignments, opts) {
    const hr = layout.headerRow;
    let zipCol = layout.zipCol;
    const headerStyle = sheet.style(hr, layout.addressCol);
    if (!zipCol) {
      zipCol = layout.newZipCol;
      sheet.setText(hr, zipCol, "우편번호", headerStyle);
    }
    let checkCol = null;
    if (opts.addCheckColumn) {
      checkCol = Math.max(sheet.maxCol, zipCol) + 1;
      sheet.setText(hr, checkCol, "도로명주소 검색 결과", headerStyle);
    }
    let filled = 0, cleared = 0;
    for (const { row } of layout.rows) {
      const a = assignments.get(row);
      if (a) {
        sheet.setText(row, zipCol, a.zip, sheet.style(row, zipCol));
        if (checkCol) sheet.setText(row, checkCol, a.road || "", sheet.style(row, layout.addressCol));
        filled++;
      } else if (opts.clearUnresolved) {
        if (sheet.clear(row, zipCol)) cleared++;
      }
    }
    return { filled, cleared, unresolved: layout.rows.length - filled, zipLetter: XlsxLite.numToCol(zipCol) };
  }

  global.SheetLayout = { inspect, fill, addressScore, isZipTitle };
})(window);
