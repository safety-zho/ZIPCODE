"""인터넷우체국 우편번호 조회.

우편번호는 반드시 우정사업본부(인터넷우체국)에서 돌려준 값만 사용한다.
조회 방식은 두 가지이며 EPOST_MODE 환경변수로 고른다.

- web : 인터넷우체국 우편번호 검색 화면(www.epost.kr / www.epost.go.kr)의
        검색 결과를 그대로 읽는다. 별도 인증키가 필요 없다.
- api : 우정사업본부가 공공데이터포털(data.go.kr)로 제공하는
        '도로명주소 우편번호 조회서비스'(openapi.epost.go.kr)를 쓴다.
        인증키(EPOST_SERVICE_KEY)가 필요하며, 정식 운영에는 이 방식을 권장한다.

이 모듈은 조회 결과마다 서버 비밀키로 서명(sig)을 붙인다. 엑셀에 쓰기 직전
서명을 다시 검증하므로, 화면에서 우편번호를 임의로 만들어 보내도 파일에
들어가지 않는다.
"""

from __future__ import annotations

import hashlib
import hmac
import html
import logging
import os
import re
import secrets
import ssl
import threading
import time
import xml.etree.ElementTree as ET
from collections import OrderedDict
from dataclasses import asdict, dataclass, field
from pathlib import Path
from urllib.parse import quote, unquote, urlencode

import requests
from requests.adapters import HTTPAdapter

log = logging.getLogger("epost")

WEB_SEARCH_URL = os.environ.get(
    "EPOST_WEB_URL", "https://www.epost.kr/search.RetrieveIntegrationNewZipCdList.comm"
)
API_URL = os.environ.get(
    "EPOST_API_URL",
    "http://openapi.epost.go.kr/postal/retrieveNewAdressAreaCdService/"
    "retrieveNewAdressAreaCdService/getNewAddressListAreaCd",
)
# 사람이 직접 확인할 때 여는 인터넷우체국 검색 화면
MANUAL_SEARCH_URL = os.environ.get("EPOST_MANUAL_URL", WEB_SEARCH_URL)

ZIP_RE = re.compile(r"^\d{5}$")

# 인터넷우체국 검색 결과 각 행에는 viewDetail('우편번호','도로명주소','영문주소','지번주소','순번')
# 호출이 들어 있다. 이 인자를 그대로 읽는다.
VIEW_DETAIL_RE = re.compile(
    r"viewDetail\(\s*'(?P<zip>(?:\\'|[^'])*)'\s*,\s*'(?P<road>(?:\\'|[^'])*)'\s*,"
    r"\s*'(?P<english>(?:\\'|[^'])*)'\s*,\s*'(?P<jibun>(?:\\'|[^'])*)'",
    re.S,
)
NO_RESULT_HINTS = ("검색결과가 없", "검색된 결과가 없", "결과가 없습니다", "조회된 결과가 없", "검색 결과가 없")


class LookupError_(Exception):
    """우체국 조회 자체가 실패한 경우 (결과 없음과 구분)."""


class MismatchError(LookupError_):
    """우체국이 돌려준 결과가 검색어와 맞지 않는 경우. 잘못된 우편번호가 들어가지 않게 버린다."""


@dataclass
class Candidate:
    zip: str
    road: str
    jibun: str = ""
    sig: str = ""


@dataclass
class LookupResult:
    address: str
    query: str = ""  # 실제로 결과를 얻은 검색어
    tried: list[str] = field(default_factory=list)
    candidates: list[Candidate] = field(default_factory=list)
    source: str = ""
    note: str = ""

    def to_dict(self) -> dict:
        d = asdict(self)
        d["zips"] = sorted({c.zip for c in self.candidates})
        return d


# ---------------------------------------------------------------------------
# 서명: 우편번호가 우체국 조회 결과에서 나왔다는 증명
# ---------------------------------------------------------------------------

_SECRET = (os.environ.get("APP_SECRET") or secrets.token_hex(32)).encode()


def sign(zip_code: str, road: str, query: str) -> str:
    msg = "\x1f".join([zip_code, road, query]).encode()
    return hmac.new(_SECRET, msg, hashlib.sha256).hexdigest()[:40]


def verify(zip_code: str, road: str, query: str, sig: str) -> bool:
    if not ZIP_RE.match(zip_code or ""):
        return False
    return hmac.compare_digest(sign(zip_code, road, query), sig or "")


# ---------------------------------------------------------------------------
# 검색어 만들기
# ---------------------------------------------------------------------------

_ROAD_CORE_RE = re.compile(r"^(?P<head>.*?)(?P<road>[0-9가-힣A-Za-z·.]+(?:로|길))\s+(?P<num>(?:지하\s*)?\d+(?:-\d+)?)(?!\d)")
_JIBUN_CORE_RE = re.compile(r"^(?P<head>.*?)(?P<dong>[0-9가-힣]+(?:동|리|가))\s+(?P<num>(?:산\s*)?\d+(?:-\d+)?)(?!\d)")
_DISTRICT_RE = re.compile(r"[가-힣]+(?:구|군)$")


def _squash(s: str) -> str:
    return " ".join(str(s).replace(" ", " ").split()).strip()


def normalize_address(addr: str) -> str:
    s = _squash(addr)
    # 앞에 붙은 우편번호 표기 제거: "(06232) 서울 ..." / "06232 서울 ..."
    s = re.sub(r"^\(?\d{5}\)?\s+", "", s)
    s = re.sub(r"^\(?\d{3}-\d{3}\)?\s+", "", s)
    return s


def query_variants(addr: str) -> list[str]:
    """원문 → 괄호·상세주소 제거 → '도로명 건물번호'/'동 지번' 핵심부 순으로 검색어를 만든다."""
    full = normalize_address(addr)
    out: list[str] = []

    def add(q: str) -> None:
        q = _squash(q).strip(" ,")
        if len(q) >= 2 and q not in out:
            out.append(q)

    add(full)
    cleaned = _squash(re.sub(r"\([^)]*\)|\[[^\]]*\]", " ", full))
    cleaned = cleaned.split(",")[0]
    add(cleaned)

    m = _ROAD_CORE_RE.search(cleaned)
    if m:
        add(f"{m['head']}{m['road']} {m['num']}")
        add(f"{m['road']} {m['num']}")
    else:
        m = _JIBUN_CORE_RE.search(cleaned)
        if m:
            add(f"{m['head']}{m['dong']} {m['num']}")
    return out[:4]


def district_tokens(addr: str) -> list[str]:
    """주소 앞부분의 시·군·구 이름(예: 강남구). 짧은 검색어로 찾은 후보를 거를 때 쓴다."""
    toks = []
    for t in normalize_address(addr).split():
        if _DISTRICT_RE.match(t) and len(t) >= 2:
            toks.append(t)
        if re.search(r"(?:로|길)$", t):
            break
    return toks


def _core_key(q: str) -> str | None:
    """검색어의 핵심부를 공백 없이: '남부순환로 2620' → '남부순환로2620', '역삼동 648-23' → '역삼동648-23'."""
    m = _ROAD_CORE_RE.search(q)
    if m:
        return re.sub(r"\s+", "", m["road"] + m["num"])
    m = _JIBUN_CORE_RE.search(q)
    if m:
        return re.sub(r"\s+", "", m["dong"] + m["num"])
    return None


def candidate_matches(q: str, c: "Candidate") -> bool:
    """후보의 도로명주소나 지번주소에 검색어 핵심부가 그대로 들어 있는지.
    핵심부를 뽑을 수 없는 검색어(건물 이름 등)는 확인하지 않고 통과시킨다."""
    key = _core_key(q)
    if not key:
        return True
    hay = re.sub(r"\s+", "", f"{c.road}|{c.jibun}")
    return re.search(re.escape(key) + r"(?![\d-])", hay) is not None


def is_road_query(q: str) -> bool:
    return bool(_ROAD_CORE_RE.search(q)) or bool(re.search(r"(?:로|길)(\s|$)", q))


# ---------------------------------------------------------------------------
# HTTP
# ---------------------------------------------------------------------------


class _TLS12Adapter(HTTPAdapter):
    """인터넷우체국 서버는 최신 TLS 협상에서 간헐적으로 연결이 끊기는 사례가 있어 TLS 1.2로 맞춘다."""

    def init_poolmanager(self, *args, **kwargs):
        ctx = ssl.create_default_context()
        ctx.maximum_version = ssl.TLSVersion.TLSv1_2
        kwargs["ssl_context"] = ctx
        return super().init_poolmanager(*args, **kwargs)


class _Throttle:
    def __init__(self, min_interval: float):
        self.min_interval = min_interval
        self._lock = threading.Lock()
        self._last = 0.0

    def wait(self) -> None:
        with self._lock:
            delay = self._last + self.min_interval - time.monotonic()
            if delay > 0:
                time.sleep(delay)
            self._last = time.monotonic()


class EpostClient:
    def __init__(
        self,
        mode: str | None = None,
        service_key: str | None = None,
        min_interval: float | None = None,
        timeout: float = 20.0,
        retries: int = 3,
        debug_dir: str | None = None,
    ):
        self.mode = (mode or os.environ.get("EPOST_MODE") or "web").strip().lower()
        if self.mode not in ("web", "api"):
            raise ValueError("EPOST_MODE는 web 또는 api 여야 합니다.")
        key = service_key if service_key is not None else os.environ.get("EPOST_SERVICE_KEY", "")
        key = key.strip()
        # 포털의 '인코딩' 키를 넣어도 동작하도록 한 번 풀어 둔다 (requests가 다시 인코딩함)
        self.service_key = unquote(key) if "%" in key else key
        if self.mode == "api" and not self.service_key:
            raise ValueError("EPOST_MODE=api 에는 EPOST_SERVICE_KEY(공공데이터포털 인증키)가 필요합니다.")
        self.timeout = timeout
        self.retries = retries
        self.throttle = _Throttle(
            min_interval if min_interval is not None else float(os.environ.get("EPOST_MIN_INTERVAL", "0.3"))
        )
        self.debug_dir = debug_dir or os.environ.get("EPOST_DEBUG_DIR") or None
        self._cache: OrderedDict[str, list[Candidate]] = OrderedDict()
        self._cache_lock = threading.Lock()
        self._cache_max = 5000

    # -- 공개 함수 ---------------------------------------------------------

    def lookup(self, address: str, query: str | None = None) -> LookupResult:
        """엑셀 주소 한 건을 조회한다. query가 주어지면(사용자가 고친 검색어) 그것만 쓴다."""
        address = _squash(address)
        result = LookupResult(address=address, source=self.mode)
        variants = [_squash(query)] if query else query_variants(address)
        variants = [v for v in variants if v]
        if not variants:
            result.note = "검색할 주소가 비어 있습니다."
            return result

        districts = district_tokens(address)
        last_error: LookupError_ | None = None
        answered = 0  # 오류 없이 응답을 받은 검색 횟수
        for q in variants:
            result.tried.append(q)
            try:
                cands = self._search_cached(q)
            except MismatchError as e:
                last_error = e
                continue  # 다른 검색어로 다시 시도
            except LookupError_ as e:
                last_error = e
                break  # 연결·서버 오류면 다른 검색어도 실패하므로 바로 멈춘다
            answered += 1
            if not cands:
                continue
            # 시·군·구를 뺀 짧은 검색어로 찾았으면 원래 주소의 시·군·구로 후보를 거른다
            if districts and not any(d in q for d in districts):
                narrowed = [c for c in cands if all(d in c.road or d in c.jibun for d in districts)]
                if narrowed:
                    cands = narrowed
            result.query = q
            result.candidates = [Candidate(c.zip, c.road, c.jibun, sign(c.zip, c.road, q)) for c in cands]
            return result

        if last_error is not None:
            if answered == 0:
                raise last_error  # 전부 오류 → 화면에서 '다시 시도'
            result.note = f"일부 검색어는 조회 오류: {last_error}"
        return result

    # -- 내부 -------------------------------------------------------------

    def _search_cached(self, q: str) -> list[Candidate]:
        key = f"{self.mode}:{q}"
        with self._cache_lock:
            if key in self._cache:
                self._cache.move_to_end(key)
                return self._cache[key]
        cands = self._search_web(q) if self.mode == "web" else self._search_api(q)
        # 검색한 도로명+건물번호(또는 동+지번)가 결과 주소에 실제로 들어 있는 후보만 쓴다.
        # 하나도 맞지 않으면 잘못된 응답으로 보고 버린다(캐시에도 넣지 않음).
        matched = [c for c in cands if candidate_matches(q, c)]
        if cands and not matched:
            log.warning("검색어와 맞지 않는 결과 %s건을 버렸습니다.", len(cands))
            raise MismatchError("인터넷우체국 결과가 검색어와 맞지 않아 사용하지 않았습니다. 다시 검색해 주세요.")
        cands = matched
        with self._cache_lock:
            self._cache[key] = cands
            if len(self._cache) > self._cache_max:
                self._cache.popitem(last=False)
        return cands

    @staticmethod
    def _new_session() -> requests.Session:
        # 검색마다 새 연결을 쓴다. 쿠키(세션)를 이어 쓰면 인터넷우체국이 앞선 검색 결과를
        # 다시 돌려주는 현상이 확인되어, 매번 처음 방문한 것처럼 요청한다.
        s = requests.Session()
        s.mount("https://", _TLS12Adapter())
        s.headers.update(
            {
                "User-Agent": "Mozilla/5.0 (compatible; ZipcodeFiller/1.0; +internal-government-tool)",
                "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
                "Accept-Language": "ko-KR,ko;q=0.9",
            }
        )
        return s

    def _get(self, url: str, params: dict) -> requests.Response:
        # 공백을 %20으로 인코딩 (인터넷우체국 검색창과 같은 방식)
        qs = urlencode(params, quote_via=quote)
        last: Exception | None = None
        for attempt in range(self.retries):
            self.throttle.wait()
            try:
                with self._new_session() as s:
                    resp = s.get(url, params=qs, timeout=self.timeout, allow_redirects=True)
                    resp.content  # 연결을 닫기 전에 본문을 다 읽어 둔다
                if resp.status_code >= 500:
                    raise LookupError_(f"우체국 서버 응답 오류 (HTTP {resp.status_code})")
                if resp.status_code != 200:
                    raise LookupError_(f"우체국 서버가 요청을 거절했습니다 (HTTP {resp.status_code})")
                return resp
            except (requests.RequestException, LookupError_) as e:
                last = e
                # 예외 메시지에는 주소·인증키가 담긴 URL이 들어갈 수 있어 종류만 기록한다
                detail = str(e) if isinstance(e, LookupError_) else type(e).__name__
                log.warning("epost 요청 실패 (%s/%s): %s", attempt + 1, self.retries, detail)
                if attempt + 1 < self.retries:
                    time.sleep(1.0 * (attempt + 1))
        if isinstance(last, LookupError_):
            raise last
        if isinstance(last, requests.exceptions.SSLError):
            raise LookupError_("인터넷우체국과 보안 연결(SSL)에 실패했습니다. README의 '인증서 오류' 항목을 확인해 주세요.")
        if isinstance(last, requests.exceptions.ProxyError):
            raise LookupError_("프록시 서버를 통해 인터넷우체국에 연결하지 못했습니다.")
        if isinstance(last, requests.exceptions.Timeout):
            raise LookupError_("인터넷우체국 응답 시간이 초과되었습니다. 잠시 후 다시 시도해 주세요.")
        raise LookupError_("인터넷우체국에 연결하지 못했습니다. 이 PC(서버)가 인터넷에 연결되어 있는지 확인해 주세요.")

    def _search_web(self, q: str) -> list[Candidate]:
        resp = self._get(WEB_SEARCH_URL, {"keyword": q})
        page = resp.text if resp.encoding else resp.content.decode("utf-8", "replace")
        cands = parse_web_results(page)
        if not cands and not any(h in page for h in NO_RESULT_HINTS):
            self._dump("web", q, page)
            if "viewDetail" not in page and len(page) < 500:
                raise LookupError_("인터넷우체국 응답이 비어 있습니다.")
        return cands

    def _search_api(self, q: str) -> list[Candidate]:
        params = {
            "ServiceKey": self.service_key,
            "searchSe": "road" if is_road_query(q) else "dong",
            "srchwrd": q,
            "countPerPage": "50",
            "currentPage": "1",
        }
        resp = self._get(API_URL, params)
        try:
            return parse_api_results(resp.content)
        except LookupError_:
            self._dump("api", q, resp.text)
            raise

    def _dump(self, kind: str, q: str, body: str) -> None:
        if not self.debug_dir:
            return
        try:
            d = Path(self.debug_dir)
            d.mkdir(parents=True, exist_ok=True)
            name = f"{kind}-{int(time.time()*1000)}-{hashlib.md5(q.encode()).hexdigest()[:8]}.txt"
            (d / name).write_text(f"query: {q}\n\n{body}", encoding="utf-8")
        except OSError:
            pass


# ---------------------------------------------------------------------------
# 응답 해석
# ---------------------------------------------------------------------------


def _clean(v: str | None) -> str:
    if not v:
        return ""
    return _squash(html.unescape(v).replace("\\'", "'"))


def _dedupe(cands: list[Candidate]) -> list[Candidate]:
    seen, out = set(), []
    for c in cands:
        k = (c.zip, c.road)
        if k not in seen:
            seen.add(k)
            out.append(c)
    return out


def parse_web_results(page: str) -> list[Candidate]:
    out = []
    for m in VIEW_DETAIL_RE.finditer(page):
        z = _clean(m["zip"])
        road = _clean(m["road"])
        if ZIP_RE.match(z) and road:
            out.append(Candidate(z, road, _clean(m["jibun"])))
    return _dedupe(out)


def _text(root: ET.Element, tag: str) -> str:
    el = root.find(f".//{tag}")
    return (el.text or "").strip() if el is not None and el.text else ""


def parse_api_results(body: bytes | str) -> list[Candidate]:
    try:
        root = ET.fromstring(body if isinstance(body, bytes) else body.encode("utf-8"))
    except ET.ParseError as e:
        raise LookupError_("우체국 API 응답을 읽지 못했습니다 (XML 형식 아님).") from e

    out = []
    for el in root.iter():
        z = el.find("zipNo")
        if z is None:
            continue
        zc = (z.text or "").strip()
        road = _clean(el.findtext("rnAdres"))
        if ZIP_RE.match(zc) and road:
            out.append(Candidate(zc, road, _clean(el.findtext("lnmAdres"))))
    if out:
        return _dedupe(out)

    # 결과가 없을 때: 정상 '자료 없음'인지, 인증키·호출량 오류인지 구분
    auth = _text(root, "returnAuthMsg")
    reason = _text(root, "returnReasonCode")
    err = _text(root, "errMsg")
    code = _text(root, "returnCode")
    success = _text(root, "successYN")
    if auth or (reason and reason != "00"):
        raise LookupError_(f"우체국 API 오류: {auth or err or '알 수 없음'} (코드 {reason or '-'})")
    if success.upper() == "N" and err and not any(k in err for k in ("없", "NODATA", "NO DATA")):
        raise LookupError_(f"우체국 API 오류: {err} (코드 {code or '-'})")
    return []
