@echo off
cd /d "%~dp0"
py -3.14 --version >nul 2>nul
if errorlevel 1 (
  echo Install Python 3.14 from python.org. Search is tested with Python 3.14.
  pause
  exit /b 1
)
py -3.14 app.py
pause
