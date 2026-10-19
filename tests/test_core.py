"""핵심 동작 테스트. 실행: python -m unittest discover -s tests -v

인터넷우체국에 실제로 접속하지 않도록 조회 함수는 가짜로 바꿔 끼운다.
아래 가짜 결과의 우편번호는 테스트용이며 실제 우편번호가 아니다(06133 테헤란로 123 예시 제외).
"""

import io
import json
import os
import sys
import unittest
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent))
os.environ["OPEN_BROWSER"] = "0"
os.environ["EPOST_MIN_INTERVAL"] = "0"

import openpyxl  # noqa: E402

import epost  # noqa: E402
import excel_io  # noqa: E402

SAMPLE = (HERE / "sample_upload.xlsx").read_bytes()

WEB_HTML = """
<table><tbody>
<tr class="title2"><th scope="row">06133</th>
<td class="t_a_l l_h_18">서울특별시 강남구 테헤란로 123 (역삼동, 여삼빌딩)<br />서울특별시 강남구 역삼동 648-23 (여삼빌딩)</td>
<td><a class="btn_s gray" href="#" onclick="javascript:viewDetail('06133','서울특별시 강남구 테헤란로 123 (역삼동, 여삼빌딩)','123, Teheran-ro, Gangnam-gu, Seoul, 06133, Rep. of KOREA','서울특별시 강남구 역삼동 648-23 (여삼빌딩)', '0');" title="보기">더보기</a></td></tr>
<tr><td><a onclick="javascript:viewDetail('12345','경기도 가상시 테헤란로 123 (A&amp;B타워)','123, Teheran-ro, Gasang-si, Gyeonggi-do','경기도 가상시 가상동 1', '1');">더보기</a></td></tr>
<tr><td><a onclick="javascript:viewDetail('135-080','옛 우편번호 형식','x','y', '2');">더보기</a></td></tr>
</tbody></table>
"""

API_XML = """<?xml version="1.0" encoding="UTF-8"?>
<NewAddressListResponse><cmmMsgHeader><successYN>Y</successYN><returnCode>00</returnCode><errMsg></errMsg>
<totalCount>1</totalCount><countPerPage>50</countPerPage><totalPage>1</totalPage><currentPage>1</currentPage></cmmMsgHeader>
<newAddressListAreaCd><zipNo>61725</zipNo><lnmAdres>광주광역시 남구 주월동 408-1 빅스포</lnmAdres><rnAdres>광주광역시 남구 서문대로 745 (주월동, 빅스포)</rnAdres></newAddressListAreaCd>
</NewAddressListResponse>"""

API_AUTH_ERR = """<OpenAPI_ServiceResponse><cmmMsgHeader><errMsg>SERVICE ERROR</errMsg>
<returnAuthMsg>SERVICE_KEY_IS_NOT_REGISTERED_ERROR</returnAuthMsg><returnReasonCode>30</returnReasonCode></cmmMsgHeader></OpenAPI_ServiceResponse>"""

API_EMPTY = """<NewAddressListResponse><cmmMsgHeader><successYN>N</successYN><returnCode>00</returnCode>
<errMsg>검색된 자료가 없습니다.</errMsg><totalCount>0</totalCount></cmmMsgHeader></NewAddressListResponse>"""


def fake_client(table: dict[str, list[epost.Candidate]] | None = None, fail: set[str] | None = None):
    c = epost.EpostClient(mode="web", min_interval=0)
    calls = []

    def fake(q):
        calls.append(q)
        if fail and q in fail:
            raise epost.LookupError_("연결 실패(테스트)")
        return list((table or {}).get(q, []))

    c._search_web = fake
    c.calls = calls
    return c


class ParseTests(unittest.TestCase):
    def test_web_parse_reads_viewdetail_and_skips_non_5digit(self):
        cands = epost.parse_web_results(WEB_HTML)
        self.assertEqual([c.zip for c in cands], ["06133", "12345"])
        self.assertEqual(cands[0].road, "서울특별시 강남구 테헤란로 123 (역삼동, 여삼빌딩)")
        self.assertEqual(cands[0].jibun, "서울특별시 강남구 역삼동 648-23 (여삼빌딩)")
        self.assertIn("A&B타워", cands[1].road)  # HTML 엔티티 해제

    def test_api_parse(self):
        cands = epost.parse_api_results(API_XML.encode())
        self.assertEqual(len(cands), 1)
        self.assertEqual(cands[0].zip, "61725")
        self.assertTrue(cands[0].road.startswith("광주광역시 남구 서문대로 745"))

    def test_api_auth_error_raises(self):
        with self.assertRaises(epost.LookupError_) as cm:
            epost.parse_api_results(API_AUTH_ERR)
        self.assertIn("SERVICE_KEY_IS_NOT_REGISTERED_ERROR", str(cm.exception))

    def test_api_no_data_is_empty_not_error(self):
        self.assertEqual(epost.parse_api_results(API_EMPTY), [])


class QueryTests(unittest.TestCase):
    def test_variants_strip_detail(self):
        v = epost.query_variants("(06133) 서울특별시 강남구 테헤란로 123, 5층 501호 (역삼동)")
        self.assertEqual(v[0], "서울특별시 강남구 테헤란로 123, 5층 501호 (역삼동)")
        self.assertIn("서울특별시 강남구 테헤란로 123", v)
        self.assertIn("테헤란로 123", v)

    def test_variants_numbered_gil(self):
        v = epost.query_variants("서울 종로구 세종대로23길 47 미도파빌딩")
        self.assertIn("서울 종로구 세종대로23길 47", v)
        self.assertIn("세종대로23길 47", v)

    def test_variants_jibun(self):
        v = epost.query_variants("강남구 역삼동 648-23 101동 202호")
        self.assertIn("강남구 역삼동 648-23", v)

    def test_simple_sample_addresses(self):
        self.assertEqual(epost.query_variants("남부순환로 2620"), ["남부순환로 2620"])
        self.assertEqual(epost.district_tokens("서울 강남구 테헤란로 123"), ["강남구"])


class LookupTests(unittest.TestCase):
    def test_falls_back_to_shorter_query_and_narrows_by_district(self):
        a = epost.Candidate("11111", "서울특별시 가상구 시험로 5", "")
        b = epost.Candidate("22222", "부산광역시 다른구 시험로 5", "")
        c = fake_client({"시험로 5": [a, b]})
        r = c.lookup("서울 가상구 시험로 5, 3층")
        self.assertEqual(r.query, "시험로 5")
        self.assertEqual([x.zip for x in r.candidates], ["11111"])
        self.assertTrue(epost.verify("11111", a.road, "시험로 5", r.candidates[0].sig))

    def test_no_result(self):
        r = fake_client({}).lookup("없는로 999")
        self.assertEqual(r.candidates, [])
        self.assertEqual(r.tried, ["없는로 999"])

    def test_all_errors_raise(self):
        with self.assertRaises(epost.LookupError_):
            fake_client({}, fail={"남부순환로 2620"}).lookup("남부순환로 2620")

    def test_cache(self):
        c = fake_client({"테헤란로 123": [epost.Candidate("06133", "서울특별시 강남구 테헤란로 123", "")]})
        c.lookup("테헤란로 123")
        c.lookup("테헤란로 123")
        self.assertEqual(c.calls, ["테헤란로 123"])

    def test_tampered_signature_rejected(self):
        sig = epost.sign("06133", "서울특별시 강남구 테헤란로 123", "테헤란로 123")
        self.assertTrue(epost.verify("06133", "서울특별시 강남구 테헤란로 123", "테헤란로 123", sig))
        self.assertFalse(epost.verify("06134", "서울특별시 강남구 테헤란로 123", "테헤란로 123", sig))
        self.assertFalse(epost.verify("0613", "x", "y", epost.sign("0613", "x", "y")))


class MatchTests(unittest.TestCase):
    """인터넷우체국이 엉뚱한(앞선 검색의) 결과를 돌려줘도 우편번호로 쓰지 않는지."""

    def test_candidate_matches(self):
        C = epost.Candidate
        self.assertTrue(epost.candidate_matches("남부순환로 2620", C("1", "서울특별시 강남구 남부순환로 2620 (도곡동)")))
        self.assertFalse(epost.candidate_matches("남부순환로 2620", C("1", "서울특별시 강남구 남부순환로 2620-1")))
        self.assertFalse(epost.candidate_matches("남부순환로 2620", C("1", "서울특별시 강남구 남부순환로 26201")))
        self.assertFalse(epost.candidate_matches("남부순환로 2620", C("06133", "서울특별시 강남구 테헤란로 123 (역삼동)")))
        self.assertTrue(epost.candidate_matches("서울 강남구 테헤란로 123, 5층", C("1", "서울특별시 강남구 테헤란로 123")))
        self.assertTrue(epost.candidate_matches("역삼동 648-23", C("1", "서울특별시 강남구 테헤란로 123", "서울특별시 강남구 역삼동 648-23")))
        self.assertTrue(epost.candidate_matches("세종대로 지하 2", C("1", "서울특별시 중구 세종대로 지하 2 (태평로1가)")))
        self.assertTrue(epost.candidate_matches("여삼빌딩", C("1", "아무 주소")))  # 핵심부 없으면 확인 생략

    def test_stale_result_is_rejected_not_used(self):
        stale = [epost.Candidate("06133", "서울특별시 강남구 테헤란로 123 (역삼동, 여삼빌딩)", "")]
        c = fake_client({"남부순환로 2620": stale})
        with self.assertRaises(epost.MismatchError):
            c.lookup("남부순환로 2620")
        # 잘못된 응답은 캐시하지 않으므로 다시 검색하면 새로 조회한다
        with self.assertRaises(epost.MismatchError):
            c.lookup("남부순환로 2620")
        self.assertEqual(c.calls, ["남부순환로 2620", "남부순환로 2620"])

    def test_mixed_results_keep_only_matching(self):
        good = epost.Candidate("11111", "가상시 가상구 송파대로 145", "")
        bad = epost.Candidate("06133", "서울특별시 강남구 테헤란로 123", "")
        r = fake_client({"송파대로 145": [bad, good]}).lookup("송파대로 145")
        self.assertEqual([x.zip for x in r.candidates], ["11111"])

    def test_mismatch_then_shorter_query_succeeds(self):
        stale = [epost.Candidate("06133", "서울특별시 강남구 테헤란로 123", "")]
        good = [epost.Candidate("11111", "가상시 가상구 송파대로 145", "")]
        r = fake_client({"가상시 송파대로 145, 3층": stale, "가상시 송파대로 145": good}).lookup("가상시 송파대로 145, 3층")
        self.assertEqual(r.query, "가상시 송파대로 145")
        self.assertEqual([x.zip for x in r.candidates], ["11111"])

    def test_new_http_session_per_request(self):
        c = epost.EpostClient(mode="web", min_interval=0, retries=1)
        made = []
        real = c._new_session

        def track():
            s = real()
            made.append(s)
            s.get = lambda *a, **k: (_ for _ in ()).throw(epost.requests.ConnectionError())
            return s

        c._new_session = track
        for _ in range(2):
            with self.assertRaises(epost.LookupError_):
                c._get("https://example.invalid/x", {"keyword": "a"})
        self.assertEqual(len(made), 2)
        self.assertIsNot(made[0], made[1])


class ExcelTests(unittest.TestCase):
    def test_inspect_sample(self):
        lay = excel_io.inspect(SAMPLE)
        self.assertEqual((lay.header_row, lay.address_col, lay.zip_col), (1, 2, 3))
        self.assertEqual([r["address"] for r in lay.rows], ["남부순환로 2620", "송파대로 145"])

    def test_fill_keeps_leading_zero_as_text(self):
        out, stats = excel_io.fill(SAMPLE, "Sheet1", 2, 3, {2: {"zip": "06133", "road": "도로"}},
                                   clear_unresolved=True, add_check_column=True)
        ws = openpyxl.load_workbook(io.BytesIO(out)).active
        self.assertEqual(ws["C2"].value, "06133")
        self.assertEqual(ws["C2"].number_format, "@")
        self.assertIsNone(ws["C3"].value)
        self.assertEqual(ws["D1"].value, "인터넷우체국 검색 주소")
        self.assertEqual(ws["D2"].value, "도로")
        self.assertEqual(stats["filled"], 1)
        self.assertEqual(stats["unresolved"], 1)

    def test_new_zip_column_when_missing(self):
        wb = openpyxl.Workbook()
        ws = wb.active
        ws.append(["번호", "성명", "도로명주소"])
        ws.append([1, "홍길동", "테헤란로 123"])
        buf = io.BytesIO()
        wb.save(buf)
        lay = excel_io.inspect(buf.getvalue())
        self.assertEqual((lay.address_col, lay.zip_col, lay.new_zip_col), (3, None, 4))
        out, _ = excel_io.fill(buf.getvalue(), ws.title, 3, None, {2: {"zip": "06133", "road": ""}}, True, False)
        ws2 = openpyxl.load_workbook(io.BytesIO(out)).active
        self.assertEqual((ws2["D1"].value, ws2["D2"].value), ("우편번호", "06133"))

    def test_header_not_on_first_row_and_detail_column_ignored(self):
        wb = openpyxl.Workbook()
        ws = wb.active
        ws.append(["2026년 안내문 발송 대상자"])
        ws.append([])
        ws.append(["연번", "성명", "주소", "상세주소", "우편번호"])
        ws.append([1, "가", "송파대로 145", "101호", 12345])
        buf = io.BytesIO()
        wb.save(buf)
        lay = excel_io.inspect(buf.getvalue())
        self.assertEqual((lay.header_row, lay.address_col, lay.zip_col), (3, 3, 5))
        self.assertEqual(lay.rows[0]["existing"], "12345")

    def test_rejects_non_excel(self):
        with self.assertRaises(excel_io.ExcelError):
            excel_io.inspect(b"not a zip")


class AppTests(unittest.TestCase):
    def setUp(self):
        import app as appmod

        self.appmod = appmod
        self.road = "가상시 가상구 남부순환로 2620 (가상동)"
        appmod._client = fake_client({
            "남부순환로 2620": [epost.Candidate("06133", self.road, "")],
            "송파대로 145": [epost.Candidate("11111", "가상시 A구 송파대로 145", ""),
                          epost.Candidate("22222", "가상시 B구 송파대로 145 (B동)", "")],
        })
        self.c = appmod.app.test_client()

    def test_flow(self):
        r = self.c.post("/api/inspect", data={"file": (io.BytesIO(SAMPLE), "주소목록.xlsx")},
                        content_type="multipart/form-data")
        self.assertEqual(r.status_code, 200, r.json)
        self.assertEqual(len(r.json["rows"]), 2)

        s1 = self.c.post("/api/search", json={"address": "남부순환로 2620"}).json
        s2 = self.c.post("/api/search", json={"address": "송파대로 145"}).json
        self.assertEqual(s1["zips"], ["06133"])
        self.assertEqual(s2["zips"], ["11111", "22222"])

        c1, c2 = s1["candidates"][0], s2["candidates"][1]
        meta = {"sheet": "Sheet1", "address_col": 2, "zip_col": 3, "clear_unresolved": True,
                "assignments": [
                    {"row": 2, "zip": c1["zip"], "road": c1["road"], "query": s1["query"], "sig": c1["sig"]},
                    {"row": 3, "zip": c2["zip"], "road": c2["road"], "query": s2["query"], "sig": c2["sig"]},
                ]}
        r = self.c.post("/api/fill", data={"file": (io.BytesIO(SAMPLE), "주소목록.xlsx"), "meta": json.dumps(meta)},
                        content_type="multipart/form-data")
        self.assertEqual(r.status_code, 200, r.data[:300])
        self.assertIn("filename*=UTF-8''", r.headers["Content-Disposition"])
        ws = openpyxl.load_workbook(io.BytesIO(r.data)).active
        self.assertEqual((ws["C2"].value, ws["C3"].value), ("06133", "22222"))

        # 화면에서 우편번호를 바꿔 보내면 거절
        meta["assignments"][0]["zip"] = "06134"
        r = self.c.post("/api/fill", data={"file": (io.BytesIO(SAMPLE), "주소목록.xlsx"), "meta": json.dumps(meta)},
                        content_type="multipart/form-data")
        self.assertEqual(r.status_code, 409)

    def test_rejects_xls(self):
        r = self.c.post("/api/inspect", data={"file": (io.BytesIO(b"x"), "old.xls")}, content_type="multipart/form-data")
        self.assertEqual(r.status_code, 400)
        self.assertIn(".xlsx", r.json["error"])

    def test_upstream_error_is_502(self):
        self.appmod._client = fake_client({}, fail={"남부순환로 2620"})
        r = self.c.post("/api/search", json={"address": "남부순환로 2620"})
        self.assertEqual(r.status_code, 502)


if __name__ == "__main__":
    unittest.main()
