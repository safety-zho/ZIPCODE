/*
 * 엑셀(.xlsx)을 브라우저 안에서 읽고, 필요한 칸만 고쳐서 다시 저장한다.
 * 파일 전체를 다시 만드는 대신 해당 시트 XML의 칸만 바꾸므로
 * 원본의 서식·수식·그림·다른 시트는 그대로 남는다. (JSZip 필요)
 */
(function (global) {
  "use strict";

  const XML_NS = "http://www.w3.org/XML/1998/namespace";
  const XLSX_MIME = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";

  function colToNum(s) {
    let n = 0;
    for (const ch of s.toUpperCase()) n = n * 26 + (ch.charCodeAt(0) - 64);
    return n;
  }
  function numToCol(n) {
    let s = "";
    while (n > 0) {
      const m = (n - 1) % 26;
      s = String.fromCharCode(65 + m) + s;
      n = Math.floor((n - 1) / 26);
    }
    return s;
  }
  function parseRef(ref) {
    const m = /^\$?([A-Za-z]{1,3})\$?(\d+)$/.exec(ref || "");
    return m ? { col: colToNum(m[1]), row: +m[2] } : null;
  }

  function parseXml(text) {
    const doc = new DOMParser().parseFromString(text, "application/xml");
    if (doc.getElementsByTagName("parsererror").length) throw new Error("엑셀 파일 내부를 읽지 못했습니다. 파일이 손상되었을 수 있습니다.");
    return doc;
  }
  const kids = (el, name) => Array.from(el.childNodes).filter((n) => n.nodeType === 1 && n.localName === name);
  const first = (el, name) => kids(el, name)[0] || null;
  const all = (el, name) => Array.from(el.getElementsByTagNameNS("*", name));

  // <si>, <is> 안의 글자. 후리가나(<rPh>) 부분은 뺀다.
  function textOf(el) {
    return all(el, "t").filter((t) => !(t.parentNode && t.parentNode.localName === "rPh")).map((t) => t.textContent).join("");
  }

  function resolvePath(base, target) {
    if (target.startsWith("/")) return target.slice(1);
    const parts = base.split("/").slice(0, -1);
    for (const seg of target.split("/")) {
      if (seg === "..") parts.pop();
      else if (seg && seg !== ".") parts.push(seg);
    }
    return parts.join("/");
  }
  function relsPathFor(path) {
    const i = path.lastIndexOf("/");
    return path.slice(0, i + 1) + "_rels/" + path.slice(i + 1) + ".rels";
  }
  async function readRels(zip, path) {
    const f = zip.file(relsPathFor(path));
    if (!f) return [];
    const doc = parseXml(await f.async("string"));
    return all(doc, "Relationship").map((r) => ({
      id: r.getAttribute("Id"),
      type: r.getAttribute("Type") || "",
      target: r.getAttribute("Target") || "",
    }));
  }

  // ------------------------------------------------------------------
  async function open(data) {
    let zip;
    try {
      zip = await JSZip.loadAsync(data);
    } catch (e) {
      throw new Error("엑셀 파일을 열 수 없습니다. .xlsx 형식인지 확인해 주세요. (.xls 파일은 엑셀에서 ‘Excel 통합 문서(.xlsx)’로 저장한 뒤 올려 주세요.)");
    }
    const rootRels = await readRels(zip, "");
    const office = rootRels.find((r) => /\/officeDocument$/.test(r.type));
    const wbPath = office ? resolvePath("", office.target) : "xl/workbook.xml";
    const wbFile = zip.file(wbPath);
    if (!wbFile) throw new Error("엑셀 통합 문서를 찾지 못했습니다. .xlsx 파일인지 확인해 주세요.");
    const wb = parseXml(await wbFile.async("string"));
    const wbRels = await readRels(zip, wbPath);

    const sheets = [];
    for (const s of all(wb, "sheet")) {
      const idAttr = Array.from(s.attributes).find((a) => a.localName === "id" && a.namespaceURI);
      const rel = wbRels.find((r) => r.id === (idAttr && idAttr.value));
      if (!rel || !/\/worksheet$/.test(rel.type)) continue; // 차트 시트 등 제외
      const path = resolvePath(wbPath, rel.target);
      if (!zip.file(path)) continue;
      sheets.push({ name: s.getAttribute("name"), hidden: (s.getAttribute("state") || "visible") !== "visible", path });
    }
    if (!sheets.length) throw new Error("엑셀 파일에 시트가 없습니다.");

    let shared = [];
    const ssRel = wbRels.find((r) => /\/sharedStrings$/.test(r.type));
    if (ssRel) {
      const f = zip.file(resolvePath(wbPath, ssRel.target));
      if (f) shared = all(parseXml(await f.async("string")), "si").map(textOf);
    }
    return { zip, sheets, shared };
  }

  async function loadSheet(book, index) {
    const info = book.sheets[index];
    const doc = parseXml(await book.zip.file(info.path).async("string"));
    const sheetData = all(doc, "sheetData")[0];
    if (!sheetData) throw new Error("시트 내용을 찾지 못했습니다.");
    return new Sheet(book, info, doc, sheetData);
  }

  class Sheet {
    constructor(book, info, doc, sheetData) {
      this.book = book;
      this.info = info;
      this.doc = doc;
      this.sheetData = sheetData;
      this.ns = doc.documentElement.namespaceURI;
      this.rows = new Map(); // 행번호 → { el, cells: Map(열번호 → el) }
      let r = 0;
      for (const rowEl of kids(sheetData, "row")) {
        r = rowEl.hasAttribute("r") ? +rowEl.getAttribute("r") : r + 1;
        rowEl.setAttribute("r", r);
        const cells = new Map();
        let c = 0;
        for (const cEl of kids(rowEl, "c")) {
          const ref = parseRef(cEl.getAttribute("r"));
          c = ref ? ref.col : c + 1;
          if (!ref) cEl.setAttribute("r", numToCol(c) + r);
          cells.set(c, cEl);
        }
        this.rows.set(r, { el: rowEl, cells });
      }
    }

    get maxRow() {
      let m = 0;
      for (const [r, R] of this.rows) if (R.cells.size && r > m) m = r;
      return m;
    }
    get maxCol() {
      let m = 0;
      for (const R of this.rows.values()) for (const c of R.cells.keys()) if (c > m) m = c;
      return m;
    }

    cell(row, col) {
      const R = this.rows.get(row);
      return R ? R.cells.get(col) || null : null;
    }

    text(row, col) {
      const c = this.cell(row, col);
      if (!c) return "";
      const t = c.getAttribute("t");
      if (t === "inlineStr") {
        const is = first(c, "is");
        return is ? textOf(is) : "";
      }
      const v = first(c, "v");
      const raw = v ? v.textContent : "";
      if (t === "s") return this.book.shared[+raw] ?? "";
      if (t === "b") return raw === "1" ? "TRUE" : raw === "0" ? "FALSE" : raw;
      return raw;
    }

    hasFormula(row, col) {
      const c = this.cell(row, col);
      return !!(c && first(c, "f"));
    }

    style(row, col) {
      const c = this.cell(row, col);
      return c ? c.getAttribute("s") : null;
    }

    _ensureCell(row, col) {
      let R = this.rows.get(row);
      if (!R) {
        const el = this.doc.createElementNS(this.ns, "row");
        el.setAttribute("r", row);
        const next = [...this.rows.keys()].filter((k) => k > row).sort((a, b) => a - b)[0];
        this.sheetData.insertBefore(el, next ? this.rows.get(next).el : null);
        R = { el, cells: new Map() };
        this.rows.set(row, R);
      }
      let c = R.cells.get(col);
      if (!c) {
        c = this.doc.createElementNS(this.ns, "c");
        c.setAttribute("r", numToCol(col) + row);
        const next = [...R.cells.keys()].filter((k) => k > col).sort((a, b) => a - b)[0];
        R.el.insertBefore(c, next ? R.cells.get(next) : null);
        R.cells.set(col, c);
        R.el.removeAttribute("spans"); // 열 범위 힌트는 지워 두면 엑셀이 다시 계산한다
      }
      return c;
    }

    setText(row, col, text, style) {
      if (this.hasFormula(row, col)) throw new Error(`${numToCol(col)}${row} 칸에 수식이 있어 값을 쓸 수 없습니다.`);
      const c = this._ensureCell(row, col);
      while (c.firstChild) c.removeChild(c.firstChild);
      if (style != null) c.setAttribute("s", style);
      c.setAttribute("t", "inlineStr"); // 글자로 저장 → 06232의 앞자리 0 유지
      const is = this.doc.createElementNS(this.ns, "is");
      const t = this.doc.createElementNS(this.ns, "t");
      t.setAttributeNS(XML_NS, "xml:space", "preserve");
      t.textContent = text;
      is.appendChild(t);
      c.appendChild(is);
    }

    clear(row, col) {
      const c = this.cell(row, col);
      if (!c) return false;
      if (first(c, "f")) throw new Error(`${numToCol(col)}${row} 칸에 수식이 있어 지울 수 없습니다.`);
      const had = !!(first(c, "v") || first(c, "is"));
      while (c.firstChild) c.removeChild(c.firstChild);
      c.removeAttribute("t"); // 서식(s)은 그대로 둔다
      return had;
    }

    _updateDimension() {
      const dim = all(this.doc, "dimension")[0];
      if (!dim) return;
      let r0 = Infinity, c0 = Infinity, r1 = 0, c1 = 0;
      for (const [r, R] of this.rows) {
        for (const c of R.cells.keys()) {
          r0 = Math.min(r0, r); r1 = Math.max(r1, r);
          c0 = Math.min(c0, c); c1 = Math.max(c1, c);
        }
      }
      if (r1) dim.setAttribute("ref", r0 === r1 && c0 === c1 ? `${numToCol(c0)}${r0}` : `${numToCol(c0)}${r0}:${numToCol(c1)}${r1}`);
    }

    async toBlob() {
      this._updateDimension();
      const body = new XMLSerializer().serializeToString(this.doc).replace(/^<\?xml[^>]*\?>\s*/, "");
      this.book.zip.file(this.info.path, '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n' + body);
      return this.book.zip.generateAsync({ type: "blob", mimeType: XLSX_MIME, compression: "DEFLATE", compressionOptions: { level: 6 } });
    }
  }

  global.XlsxLite = { open, loadSheet, colToNum, numToCol, parseRef };
})(window);
