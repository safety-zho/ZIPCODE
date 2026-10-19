@echo off
cd /d "%~dp0"
echo.
echo  우편번호 일괄 입력 실행 파일(.exe)을 만듭니다. 몇 분 걸립니다.
echo  이 PC에 Python과 인터넷 연결이 필요합니다. 만든 .exe를 쓰는 PC에는 Python이 필요 없습니다.
echo.

if not exist ".build-venv\Scripts\python.exe" (
  py -3 -m venv .build-venv 2>nul || python -m venv .build-venv
)
if not exist ".build-venv\Scripts\python.exe" (
  echo  Python을 찾을 수 없습니다. python.org 에서 Python을 설치한 뒤 다시 실행하세요.
  pause
  exit /b 1
)

".build-venv\Scripts\python.exe" -m pip install --upgrade pip
".build-venv\Scripts\python.exe" -m pip install -r requirements.txt pyinstaller
if errorlevel 1 goto fail

".build-venv\Scripts\python.exe" -m PyInstaller --noconfirm --clean --onefile --name ZipcodeFiller --add-data "static;static" app.py
if errorlevel 1 goto fail

copy /y .env.example dist\.env.example > nul
echo.
echo  완료: dist 폴더의 ZipcodeFiller.exe 를 구청 PC로 복사해 두 번 누르면 됩니다.
echo  파일 이름은 원하는 대로 바꿔도 됩니다. 예: 우편번호일괄입력.exe
explorer dist
pause
exit /b 0

:fail
echo.
echo  실행 파일을 만들지 못했습니다. 위의 오류 메시지를 확인해 주세요.
pause
exit /b 1
