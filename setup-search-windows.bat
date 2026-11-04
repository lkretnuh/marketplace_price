@echo off
cd /d "%~dp0"
py -3.14 --version >nul 2>nul
if errorlevel 1 (
  echo Python 3.14 is required. Install it from python.org.
  pause
  exit /b 1
)
py -3.14 -m pip install -r requirements-search.txt
if errorlevel 1 goto failed
py -3.14 -m playwright install chromium
if errorlevel 1 goto failed
echo Search is installed. Run start-windows.bat and open http://localhost:8000
pause
exit /b 0
:failed
echo Installation failed. Check the error above and your Internet connection.
pause
exit /b 1
