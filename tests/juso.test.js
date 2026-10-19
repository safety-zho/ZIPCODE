// 실행: node --test tests/
const test = require("node:test");
const assert = require("node:assert/strict");
const Juso = require("../js/juso.js");

function fakeFetch(table, calls = []) {
  return async (url) => {
    const kw = new URL(url).searchParams.get("keyword");
    calls.push(kw);
    const entry = table[kw];
    if (entry instanceof Error) throw entry;
    const body = entry && entry.errorCode
      ? { results: { common: { errorCode: entry.errorCode, errorMessage: entry.errorMessage, totalCount: "0" }, juso: null } }
      : { results: { common: { errorCode: "0", errorMessage: "정상", totalCount: String((entry || []).length) }, juso: entry || [] } };
    return { ok: true, status: 200, json: async () => body };
  };
}
const J = (zipNo, roadAddr, jibunAddr = "") => ({ zipNo, roadAddr, jibunAddr });

test("검색어 만들기", () => {
  assert.deepEqual(Juso.queryVariants("남부순환로 2620"), ["남부순환로 2620"]);
  const v = Juso.queryVariants("(06133) 서울특별시 강남구 테헤란로 123, 5층 501호 (역삼동)");
  assert.equal(v[0], "서울특별시 강남구 테헤란로 123, 5층 501호 (역삼동)");
  assert.ok(v.includes("서울특별시 강남구 테헤란로 123"));
  assert.ok(v.includes("테헤란로 123"));
  assert.ok(Juso.queryVariants("서울 종로구 세종대로23길 47 미도파빌딩").includes("세종대로23길 47"));
  assert.ok(Juso.queryVariants("강남구 역삼동 648-23 101동 202호").includes("강남구 역삼동 648-23"));
  assert.equal(Juso.sanitize("테헤란로 123 [본관] <2층> 50%"), "테헤란로 123 본관 2층 50");
  assert.equal(Juso.sanitize("select 테헤란로 123"), "테헤란로 123");
});

test("결과 주소가 검색어와 맞는지", () => {
  const C = (road, jibun = "") => ({ zip: "1", road, jibun });
  assert.ok(Juso.candidateMatches("남부순환로 2620", C("서울특별시 서초구 남부순환로 2620 (양재동)")));
  assert.ok(!Juso.candidateMatches("남부순환로 2620", C("서울특별시 서초구 남부순환로 2620-1")));
  assert.ok(!Juso.candidateMatches("남부순환로 2620", C("서울특별시 강남구 테헤란로 123")));
  assert.ok(Juso.candidateMatches("역삼동 648-23", C("서울특별시 강남구 테헤란로 123", "서울특별시 강남구 역삼동 648-23")));
  assert.ok(Juso.candidateMatches("세종대로 지하 2", C("서울특별시 중구 세종대로 지하 2 (태평로1가)")));
});

test("결과 1건 → 그대로, 여러 우편번호 → 후보 전부", async () => {
  const c = new Juso.Client("KEY", { fetchImpl: fakeFetch({
    "남부순환로 2620": [J("06737", "서울특별시 서초구 남부순환로 2620 (양재동)")],
    "중앙로 1": [J("11111", "가상시 A구 중앙로 1"), J("22222", "가상시 B구 중앙로 1")],
  }) });
  const r1 = await c.lookup("남부순환로 2620");
  assert.deepEqual(r1.candidates.map((x) => x.zip), ["06737"]);
  const r2 = await c.lookup("중앙로 1");
  assert.deepEqual(r2.candidates.map((x) => x.zip), ["11111", "22222"]);
});

test("상세주소 때문에 못 찾으면 줄인 검색어로, 시·군·구로 거르기", async () => {
  const calls = [];
  const c = new Juso.Client("KEY", { fetchImpl: fakeFetch({
    "중앙로 1": [J("11111", "가상시 가상구 중앙로 1"), J("22222", "다른시 다른구 중앙로 1")],
  }, calls) });
  const r = await c.lookup("가상시 가상구 중앙로 1, 3층");
  assert.equal(r.query, "중앙로 1");
  assert.deepEqual(r.candidates.map((x) => x.zip), ["11111"]);
  assert.deepEqual(calls, ["가상시 가상구 중앙로 1, 3층", "가상시 가상구 중앙로 1", "중앙로 1"]);
});

test("검색어와 맞지 않는 결과는 쓰지 않는다", async () => {
  const c = new Juso.Client("KEY", { fetchImpl: fakeFetch({
    "남부순환로 2620": [J("06133", "서울특별시 강남구 테헤란로 123")],
  }) });
  await assert.rejects(c.lookup("남부순환로 2620"), /맞지 않아/);
});

test("승인키 오류는 바로 멈춤(fatal), 결과 없음 코드는 빈 결과", async () => {
  const bad = new Juso.Client("BAD", { fetchImpl: fakeFetch({ "테헤란로 123": { errorCode: "E0001", errorMessage: "승인되지 않은 KEY 입니다." } }) });
  await assert.rejects(bad.lookup("테헤란로 123"), (e) => e.fatal && /승인키/.test(e.message));
  const c = new Juso.Client("KEY", { fetchImpl: fakeFetch({ "없는길 9999": { errorCode: "E0006", errorMessage: "주소를 상세히 입력해 주시기 바랍니다." } }) });
  const r = await c.lookup("없는길 9999");
  assert.equal(r.candidates.length, 0);
  assert.match(r.note, /상세히/);
});

test("연결 오류는 재시도 후 오류로 올린다", async () => {
  const calls = [];
  const c = new Juso.Client("KEY", { retries: 2, fetchImpl: fakeFetch({ "테헤란로 123": new TypeError("Failed to fetch") }, calls) });
  await assert.rejects(c.lookup("테헤란로 123"), /연결하지 못했습니다/);
  assert.equal(calls.length, 2);
});

test("5자리가 아닌 우편번호는 버린다", () => {
  const out = Juso.parseResponse({ results: { common: { errorCode: "0", totalCount: "2" }, juso: [J("135-080", "옛 형식 테헤란로 1"), J("06133", "서울 테헤란로 123")] } });
  assert.deepEqual(out.cands.map((x) => x.zip), ["06133"]);
});
