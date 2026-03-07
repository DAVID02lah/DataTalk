@echo off
title Data Talk : Starting...
echo.
echo  ============================================
echo    DATA TALK : Gemini AI Data Analyst
echo  ============================================
echo.

:: Check if Python is available
python --version >nul 2>&1
if %errorlevel% neq 0 (
    echo  [ERROR] Python is not installed or not in PATH.
    echo  Please install Python 3.10+ from https://python.org
    pause
    exit /b 1
)

:: Install dependencies if needed
echo  [1/2] Installing Python dependencies...
pip install -r "%~dp0requirements.txt" --quiet >nul 2>&1
echo        Done.
echo.

:: Start Flask backend
echo  [2/2] Starting Flask backend on http://localhost:5000 ...
start "Data Talk : Flask Backend" cmd /k "cd /d %~dp0 && python server.py"
timeout /t 3 /nobreak >nul

:: Open browser
echo.
echo  Opening Data Talk in your browser...
start http://localhost:5000
echo.
echo  ============================================
echo    Data Talk is now running!
echo.
echo    Main App:   http://localhost:5000
echo.
echo    To stop: close the Flask terminal window.
echo  ============================================
echo.
pause
