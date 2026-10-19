@echo off
cd /d "%~dp0"

if not exist ".venv\Scripts\python.exe" (
  echo [1/2] 처음 실행: 필요한 프로그램을 설치합니다...
  py -3 -m venv .venv 2>nul || python -m venv .venv
  if not exist ".venv\Scripts\python.exe" (
    echo Python 3.10 이상이 설치되어 있어야 합니다. https://www.python.org/downloads/
    pause
    exit /b 1
  )
  ".venv\Scripts\python.exe" -m pip install --upgrade pip
  ".venv\Scripts\python.exe" -m pip install -r requirements.txt
)

echo [2/2] 우편번호 일괄 입력을 시작합니다. 이 창을 닫으면 프로그램이 종료됩니다.
".venv\Scripts\python.exe" app.py
pause
