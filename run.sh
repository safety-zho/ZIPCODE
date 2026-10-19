#!/usr/bin/env sh
# macOS / Linux 실행 스크립트
set -e
cd "$(dirname "$0")"
if [ ! -x .venv/bin/python ]; then
  echo "처음 실행: 필요한 프로그램을 설치합니다..."
  python3 -m venv .venv
  .venv/bin/python -m pip install --upgrade pip
  .venv/bin/python -m pip install -r requirements.txt
fi
exec .venv/bin/python app.py
