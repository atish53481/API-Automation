@echo off
setlocal EnableExtensions
title API Chain Tester
cd /d "%~dp0"

echo ==============================================
echo   API Chain Tester - Local Launcher
echo ==============================================
echo.

REM ---- Locate Python ----
set "PY=python"
where py >nul 2>nul && set "PY=py -3"
%PY% --version >nul 2>nul
if errorlevel 1 (
    echo [ERROR] Python 3.x was not found on this machine.
    echo         Install it from https://www.python.org/downloads/
    echo         and make sure it is added to PATH.
    echo.
    pause
    exit /b 1
)

REM ---- Create virtual environment on first run ----
if not exist ".venv\Scripts\python.exe" (
    echo [1/3] Creating virtual environment .venv ...
    %PY% -m venv .venv
    if errorlevel 1 (
        echo [ERROR] Failed to create the virtual environment.
        pause
        exit /b 1
    )
) else (
    echo [1/3] Virtual environment already exists.
)

set "VENV_PY=.venv\Scripts\python.exe"

REM ---- Install dependencies on first run ----
if not exist ".venv\.deps-installed" (
    echo [2/3] Installing dependencies...
    "%VENV_PY%" -m pip install --upgrade pip >nul 2>nul
    "%VENV_PY%" -m pip install -r requirements.txt
    if errorlevel 1 (
        echo [ERROR] Failed to install dependencies.
        pause
        exit /b 1
    )
    echo ok> ".venv\.deps-installed"
) else (
    echo [2/3] Dependencies already installed.
)

echo [3/3] Starting server at http://localhost:8000
echo        Press Ctrl+C to stop
echo.

REM ---- Open the browser once the server is ready ----
start "" /min cmd /c "timeout /t 3 /nobreak >nul & start http://localhost:8000"

"%VENV_PY%" -m uvicorn main:app --host 0.0.0.0 --port 8000 --reload

echo.
echo Server stopped.
pause
