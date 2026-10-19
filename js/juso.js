/*
 * 행정안전부 도로명주소 검색 API로 우편번호(국가기초구역번호)를 찾는다.
 * - 엑셀 주소를 그대로 검색하고, 결과가 없으면 상세주소를 덜어낸 검색어로 다시 찾는다.
 * - 검색한 '도로명+건물번호'(또는 '동+지번')가 결과 주소에 실제로 들어 있는 후보만 쓴다.
 */
(function (global) {
  "use strict";

  const API_URL = "https://business.juso.go.kr/addrlink/addrLinkApi.do";
  const ZIP_RE = /^\d{5}$/;

  const squash = (s) => String(s ?? "").replace(/ /g, " ").replace(/\s+/g, " ").trim();

  class JusoError extends Error {
    constructor(message, { fatal = false, noRetry = false } = {}) {
      super(message);
      this.fatal = fatal; // 승인키 문제처럼 다른 주소도 모두 실패할 오류
      this.noRetry = fatal || noRetry;
    }
  }

  // ── 검색어 만들기 ─────────────────────────────────────
  // 행정안전부로는 '시·군·구 + 도로명 + 건물번호'(또는 '동·리 + 지번')까지만 보낸다.
  // 동·호수, 층, 괄호 안 내용, 이름 같은 나머지 글자는 보내지 않는다.
  const ROAD_CORE_RE = /^(.*?)([0-9가-힣A-Za-z·.]+(?:로|길))\s+((?:지하\s*)?\d+(?:-\d+)?)(?!\d)/;
  // 띄어 쓰지 않은 경우: '테헤란로123', '중앙로123번길45'
  const ROAD_NOSPACE_RE = /^(.*?)([가-힣A-Za-z·.][0-9가-힣A-Za-z·.]*?(?:로|길))((?:지하)?\d+(?:-\d+)?)(?![\d가-힣-])/;
  const JIBUN_CORE_RE = /^(.*?)([가-힣][0-9가-힣]*(?:동|리|가))\s+((?:산\s*)?\d+(?:-\d+)?)(?!\d)/;
  const SIDO_SHORT = ["서울", "부산", "대구", "인천", "광주", "대전", "울산", "세종", "경기", "강원", "충북", "충남", "전북", "전남", "경북", "경남", "제주"];

  function normalizeAddress(addr) {
    let s = squash(addr);
    s = s.replace(/^\(?\d{5}\)?\s+/, "").replace(/^\(?\d{3}-\d{3}\)?\s+/, ""); // 앞에 붙은 우편번호
    return s;
  }

  // 도로명주소 API가 받지 않는 글자(특수문자, SQL 예약어)를 뺀다
  function sanitize(q) {
    let s = squash(q).replace(/[%=><\[\]]/g, " ");
    s = s.replace(/(^|\s)(OR|SELECT|INSERT|DELETE|UPDATE|CREATE|DROP|EXEC|UNION|FETCH|DECLARE|TRUNCATE)(?=\s|$)/gi, " ");
    return squash(s);
  }

  // 앞부분에서 시·도, 시·군·구, 읍·면 이름만 남긴다 (이름 등 다른 글자는 버림)
  function regionPart(head) {
    return squash(head).split(" ")
      .filter((t) => t && (/(?:특별시|광역시|특별자치시|특별자치도|도|시|군|구|읍|면)$/.test(t) || SIDO_SHORT.includes(t)))
      .join(" ");
  }

  // 주소에서 지역 + 핵심부(도로명 건물번호 또는 동 지번)를 뽑는다
  function addressCore(addr) {
    let s = sanitize(normalizeAddress(addr)).replace(/\([^)]*\)/g, " ");
    s = squash(s.split(",")[0]);
    let m = ROAD_CORE_RE.exec(s) || ROAD_NOSPACE_RE.exec(s);
    if (m) return { kind: "road", region: regionPart(m[1]), core: squash(`${m[2]} ${m[3]}`) };
    m = JIBUN_CORE_RE.exec(s);
    if (m) return { kind: "jibun", region: regionPart(m[1]), core: squash(`${m[2]} ${m[3]}`) };
    return null;
  }

  // 핵심부를 못 찾은 주소(건물 이름만 있는 경우 등)에서 층·호·동(아파트) 표기를 지운다
  function stripDetail(s) {
    return squash(String(s)
      .replace(/(?:지하\s*|[Bb])?\d+\s*(?:층|호실|호|동)(?=\s|$)/g, " ")
      .replace(/\d+-\d+\s*호(?=\s|$)/g, " "));
  }

  function queryVariants(addr) {
    const out = [];
    const add = (q) => {
      q = squash(q).replace(/^[\s,]+|[\s,]+$/g, "");
      if (q.length >= 2 && !out.includes(q)) out.push(q);
    };
    const c = addressCore(addr);
    if (c) {
      if (c.region) add(`${c.region} ${c.core}`);
      add(c.core);
    } else {
      const s = squash(sanitize(normalizeAddress(addr)).replace(/\([^)]*\)/g, " ").split(",")[0]);
      add(stripDetail(s));
    }
    return out;
  }

  function districtTokens(addr) {
    const toks = [];
    for (const t of normalizeAddress(addr).split(" ")) {
      if (/^[가-힣]+(?:구|군)$/.test(t) && t.length >= 2) toks.push(t);
      if (/(?:로|길)$/.test(t)) break;
    }
    return toks;
  }

  function coreKey(q) {
    const c = addressCore(q);
    return c ? c.core.replace(/\s+/g, "") : null;
  }

  function candidateMatches(q, c) {
    const k = coreKey(q);
    if (!k) return true; // 건물 이름 등으로 찾은 경우는 확인 생략
    const hay = `${c.road}|${c.jibun}`.replace(/\s+/g, "");
    const esc = k.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    return new RegExp(esc + "(?![\\d-])").test(hay);
  }

  function dedupe(cands) {
    const seen = new Set();
    return cands.filter((c) => {
      const k = c.zip + "|" + c.road;
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    });
  }

  // ── API 호출 ──────────────────────────────────────────
  const NO_RESULT_CODES = new Set(["E0005", "E0006", "E0008", "E0009", "E0010", "E0011", "E0012", "E0013", "E0015"]);
  const KEY_CODES = new Set(["E0001", "E0014"]);

  function parseResponse(j) {
    const common = (j && j.results && j.results.common) || {};
    const code = String(common.errorCode ?? "");
    if (code !== "0") {
      const msg = common.errorMessage || "알 수 없는 오류";
      if (KEY_CODES.has(code)) throw new JusoError(`도로명주소 승인키 문제: ${msg} (${code})`, { fatal: true });
      if (NO_RESULT_CODES.has(code)) return { cands: [], total: 0, note: msg };
      throw new JusoError(`도로명주소 검색 오류: ${msg} (${code})`);
    }
    const list = (j.results.juso || []).map((x) => ({
      zip: squash(x.zipNo),
      road: squash(x.roadAddr),
      jibun: squash(x.jibunAddr),
    }));
    return { cands: dedupe(list.filter((c) => ZIP_RE.test(c.zip) && c.road)), total: +common.totalCount || 0, note: "" };
  }

  function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

  class Client {
    constructor(key, { fetchImpl, apiUrl, perPage = 30, retries = 3 } = {}) {
      this.key = squash(key);
      this.fetch = fetchImpl || ((...a) => global.fetch(...a));
      this.apiUrl = apiUrl || API_URL;
      this.perPage = perPage;
      this.retries = retries;
      this.cache = new Map();
    }

    async search(q) {
      if (this.cache.has(q)) return this.cache.get(q);
      const params = new URLSearchParams({
        confmKey: this.key, currentPage: "1", countPerPage: String(this.perPage), keyword: q, resultType: "json",
      });
      let last;
      for (let i = 0; i < this.retries; i++) {
        try {
          let res;
          try {
            res = await this.fetch(`${this.apiUrl}?${params}`, { method: "GET", cache: "no-store" });
          } catch (e) {
            throw new JusoError("행정안전부 도로명주소 검색에 연결하지 못했습니다. 인터넷 연결을 확인해 주세요.");
          }
          if (!res.ok) throw new JusoError(`도로명주소 검색 서버 오류 (HTTP ${res.status})`);
          let j;
          try { j = await res.json(); } catch (e) { throw new JusoError("도로명주소 검색 응답을 읽지 못했습니다."); }
          const out = parseResponse(j);
          // 검색어와 맞는 후보만 남긴다. 하나도 맞지 않으면 잘못된 응답으로 보고 버린다.
          const matched = out.cands.filter((c) => candidateMatches(q, c));
          if (out.cands.length && !matched.length) {
            throw new JusoError("검색 결과가 검색어와 맞지 않아 사용하지 않았습니다.", { noRetry: true });
          }
          out.cands = matched;
          this.cache.set(q, out);
          return out;
        } catch (e) {
          last = e;
          if (e.noRetry) throw e;
          if (i + 1 < this.retries) await sleep(600 * (i + 1));
        }
      }
      throw last;
    }

    /** 엑셀 주소 한 건 조회. query가 있으면(사용자가 고친 검색어) 그것으로 찾는다.
        어느 경우든 행정안전부로는 queryVariants()가 만든 검색어(동·호수 제외)만 보낸다. */
    async lookup(address, query) {
      const result = { address: squash(address), query: "", tried: [], candidates: [], total: 0, note: "" };
      const source = query || address;
      const variants = queryVariants(source);
      if (!variants.length) { result.note = "검색할 주소가 비어 있습니다."; return result; }
      const districts = districtTokens(source);
      let lastError = null, answered = 0;
      for (const q of variants) {
        result.tried.push(q);
        let out;
        try {
          out = await this.search(q);
        } catch (e) {
          if (e.fatal) throw e;
          lastError = e;
          continue;
        }
        answered++;
        if (out.note) result.note = out.note;
        if (!out.cands.length) continue;
        let cands = out.cands;
        // 시·군·구를 뺀 짧은 검색어로 찾았으면 원래 주소의 시·군·구로 거른다
        if (districts.length && !districts.some((d) => q.includes(d))) {
          const narrowed = cands.filter((c) => districts.every((d) => c.road.includes(d) || c.jibun.includes(d)));
          if (narrowed.length) cands = narrowed;
        }
        result.query = q;
        result.candidates = cands;
        result.total = out.total;
        result.note = out.total > cands.length && out.total > this.perPage ? `검색 결과가 ${out.total}건이라 일부만 보입니다. 주소를 더 자세히 적어 주세요.` : "";
        return result;
      }
      if (lastError && !answered) throw lastError;
      return result;
    }
  }

  const api = { Client, JusoError, queryVariants, addressCore, stripDetail, districtTokens, candidateMatches, coreKey, sanitize, parseResponse, API_URL };
  global.Juso = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})(typeof window !== "undefined" ? window : globalThis);
