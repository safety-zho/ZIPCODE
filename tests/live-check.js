// 실제 도로명주소 API로 몇 건 조회해 본다 (GitHub Actions에서 실행). 결과는 실행 요약에 표시.
global.window = undefined;
const fs = require("fs");
const Juso = require("../js/juso.js");
const cfgText = fs.readFileSync(__dirname + "/../config.js", "utf8");
const key = (cfgText.match(/jusoKey:\s*"([^"]*)"/) || [])[1] || "";
const addrs = process.argv.slice(2).length ? process.argv.slice(2)
  : ["남부순환로 2620", "송파대로 145", "서울 강남구 테헤란로 123, 5층 501호", "역삼동 648-23", "없는길 9999"];

(async () => {
  const lines = [];
  for (const [label, headers] of [["github.io에서 호출", { Referer: "https://safety-zho.github.io/ZIPCODE/", Origin: "https://safety-zho.github.io" }]]) {
    const client = new Juso.Client(key, { fetchImpl: (url, opt) => fetch(url, { ...opt, headers }) });
    lines.push(`[${label}]`);
    for (const a of addrs) {
      try {
        const r = await client.lookup(a);
        lines.push(r.candidates.length
          ? `${a} → ${r.candidates.length}건: ` + r.candidates.slice(0, 3).map((c) => `${c.zip} ${c.road}`).join(" | ")
          : `${a} → 결과 없음 ${r.note ? "(" + r.note + ")" : ""}`);
      } catch (e) {
        lines.push(`${a} → 오류: ${e.message}`);
      }
    }
  }
  const msg = lines.join("\n");
  console.log(msg);
  console.log("::notice title=도로명주소 실제 조회 시험::" + msg.replace(/%/g, "%25").replace(/\r/g, "%0D").replace(/\n/g, "%0A"));
})();
