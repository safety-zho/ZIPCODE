"""우편번호 일괄 입력 웹앱.

실행:  python app.py   →  브라우저에서 http://127.0.0.1:8000
       (.exe로 만든 경우 실행 파일을 두 번 누르면 됨)
설정은 실행 파일과 같은 폴더의 .env 파일(또는 환경변수)로 한다. .env.example 참고.
"""

from __future__ import annotations

import json
import logging
import os
import sys
from pathlib import Path

FROZEN = getattr(sys, "frozen", False)  # PyInstaller로 만든 .exe에서 실행 중인지
# 화면 파일(static) 위치: .exe 안에 묶인 임시 폴더 또는 소스 폴더
BASE = Path(getattr(sys, "_MEIPASS", Path(__file__).resolve().parent))
# 설정 파일(.env) 위치: .exe가 있는 폴더 또는 소스 폴더
CONFIG_DIR = Path(sys.executable).resolve().parent if FROZEN else Path(__file__).resolve().parent


def _load_env_file(path: Path) -> None:
    if not path.exists():
        return
    for line in path.read_text(encoding="utf-8-sig").splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        k, v = line.split("=", 1)
        os.environ.setdefault(k.strip(), v.strip().strip('"').strip("'"))


_load_env_file(CONFIG_DIR / ".env")

from flask import Flask, jsonify, request, send_file, send_from_directory  # noqa: E402

import epost  # noqa: E402
import excel_io  # noqa: E402

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s")
log = logging.getLogger("app")

MAX_ROWS = int(os.environ.get("MAX_ROWS", "5000"))
MAX_UPLOAD_MB = int(os.environ.get("MAX_UPLOAD_MB", "20"))

app = Flask(__name__, static_folder=None)
app.config["MAX_CONTENT_LENGTH"] = MAX_UPLOAD_MB * 1024 * 1024
app.json.ensure_ascii = False

_client: epost.EpostClient | None = None


def client() -> epost.EpostClient:
    global _client
    if _client is None:
        _client = epost.EpostClient()
    return _client


def _err(msg: str, status: int = 400):
    return jsonify({"error": msg}), status


def _read_upload() -> tuple[bytes, str]:
    f = request.files.get("file")
    if not f or not f.filename:
        raise excel_io.ExcelError("엑셀 파일을 선택해 주세요.")
    name = f.filename
    if not name.lower().endswith(".xlsx"):
        raise excel_io.ExcelError(
            ".xlsx 파일만 올릴 수 있습니다. (.xls 파일은 엑셀에서 'Excel 통합 문서(.xlsx)'로 저장한 뒤 올려 주세요.)"
        )
    return f.read(), name


def _int_or_none(v) -> int | None:
    try:
        return int(v) if v not in (None, "", "null") else None
    except (TypeError, ValueError):
        return None


# ---------------------------------------------------------------------------


@app.get("/")
def index():
    return send_from_directory(BASE / "static", "index.html")


@app.get("/api/config")
def config():
    return jsonify(
        {
            "mode": client().mode,
            "manual_search_url": epost.MANUAL_SEARCH_URL,
            "max_rows": MAX_ROWS,
            "max_upload_mb": MAX_UPLOAD_MB,
        }
    )


@app.post("/api/inspect")
def api_inspect():
    try:
        data, name = _read_upload()
        zip_raw = request.form.get("zip_col")
        layout = excel_io.inspect(
            data,
            sheet=request.form.get("sheet") or None,
            address_col=_int_or_none(request.form.get("address_col")),
            zip_col=_int_or_none(zip_raw),
            use_new_zip_col=(zip_raw == "new"),
            max_rows=MAX_ROWS,
        )
    except excel_io.ExcelError as e:
        return _err(str(e))
    d = layout.to_dict()
    d["filename"] = name
    return jsonify(d)


@app.post("/api/search")
def api_search():
    body = request.get_json(silent=True) or {}
    address = str(body.get("address") or "").strip()
    query = str(body.get("query") or "").strip() or None
    if not address and not query:
        return _err("주소가 비어 있습니다.")
    try:
        result = client().lookup(address or query, query=query)
    except epost.LookupError_ as e:
        return _err(str(e), 502)
    return jsonify(result.to_dict())


@app.post("/api/fill")
def api_fill():
    try:
        data, name = _read_upload()
        meta = json.loads(request.form.get("meta") or "{}")
    except excel_io.ExcelError as e:
        return _err(str(e))
    except json.JSONDecodeError:
        return _err("요청 형식이 올바르지 않습니다.")

    address_col = _int_or_none(meta.get("address_col"))
    if address_col is None:
        return _err("주소 열을 골라 주세요.")
    zip_col = None if meta.get("zip_col") in (None, "", "new") else _int_or_none(meta.get("zip_col"))

    # 인터넷우체국 조회 결과에서 나온 값인지 서명으로 확인한다
    assignments: dict[int, dict] = {}
    rejected = []
    for a in meta.get("assignments", []):
        row = _int_or_none(a.get("row"))
        z, road, q, sig = (str(a.get(k) or "") for k in ("zip", "road", "query", "sig"))
        if row is None or not epost.verify(z, road, q, sig):
            rejected.append(row)
            continue
        assignments[row] = {"zip": z, "road": road}
    if rejected:
        return _err(
            "인터넷우체국 조회 결과로 확인되지 않은 우편번호가 있어 저장하지 않았습니다 "
            f"({len(rejected)}건). 서버가 다시 시작되었다면 우편번호 조회를 다시 실행해 주세요.",
            409,
        )

    try:
        out, stats = excel_io.fill(
            data,
            sheet=str(meta.get("sheet") or ""),
            address_col=address_col,
            zip_col=zip_col,
            assignments=assignments,
            clear_unresolved=bool(meta.get("clear_unresolved", True)),
            add_check_column=bool(meta.get("add_check_column", False)),
            max_rows=MAX_ROWS,
        )
    except excel_io.ExcelError as e:
        return _err(str(e))

    stem = Path(name).stem
    import io

    resp = send_file(
        io.BytesIO(out),
        mimetype="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        as_attachment=True,
        download_name=f"{stem}_우편번호.xlsx",
    )
    resp.headers["X-Fill-Stats"] = json.dumps(stats)
    log.info("파일 생성: %s (입력 %s건, 비움 %s건, 미확인 %s건)", name, stats["filled"], stats["cleared"], stats["unresolved"])
    return resp


@app.errorhandler(413)
def too_large(_e):
    return _err(f"파일이 너무 큽니다. {MAX_UPLOAD_MB}MB 이하로 올려 주세요.", 413)


def _already_running(url: str) -> bool:
    """같은 주소에서 이 앱이 이미 실행 중인지 (실행 파일을 두 번 누른 경우)."""
    import urllib.request

    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
    try:
        with opener.open(url + "/api/config", timeout=1.5) as r:
            return b"manual_search_url" in r.read()
    except Exception:
        return False


def _port_free(host: str, port: int) -> bool:
    import socket

    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
        try:
            s.bind((host or "0.0.0.0", port))
            return True
        except OSError:
            return False


def _exit(code: int) -> None:
    if FROZEN:  # .exe 창이 바로 닫혀 메시지를 못 보는 일이 없게
        try:
            input("\n  엔터를 누르면 창이 닫힙니다.")
        except EOFError:
            pass
    sys.exit(code)


def main() -> None:
    import webbrowser

    host = os.environ.get("HOST", "127.0.0.1")
    port = int(os.environ.get("PORT", "8000"))
    url = f"http://{'127.0.0.1' if host in ('0.0.0.0', '') else host}:{port}"
    open_browser = os.environ.get("OPEN_BROWSER", "1") == "1"

    if _already_running(url):
        print(f"\n  이미 실행 중입니다. 브라우저에서 {url} 을 엽니다.")
        if open_browser:
            webbrowser.open(url)
        return
    if not _port_free(host, port):
        print(f"\n  [오류] {port}번 포트를 다른 프로그램이 쓰고 있습니다.\n"
              f"  실행 파일과 같은 폴더의 .env 파일에 PORT=8010 처럼 다른 번호를 적어 주세요.", file=sys.stderr)
        _exit(1)
    try:
        client()
    except ValueError as e:
        print(f"\n  [설정 오류] {e}", file=sys.stderr)
        _exit(1)

    print(f"\n  우편번호 일괄 입력: {url}  (조회 방식: {client().mode})\n"
          f"  브라우저가 열리지 않으면 위 주소를 직접 입력하세요.\n"
          f"  이 창을 닫으면 프로그램이 종료됩니다.\n")
    if open_browser:
        import threading

        threading.Timer(1.0, lambda: webbrowser.open(url)).start()
    try:
        from waitress import serve  # 설치되어 있으면 운영용 서버 사용

        serve(app, host=host, port=port, threads=8)
    except ImportError:
        app.run(host=host, port=port, threaded=True)


if __name__ == "__main__":
    main()
