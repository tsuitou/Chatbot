@echo off
REM Chatbot Launch Script for Windows
REM This script automatically installs dependencies, starts the server, and opens the browser

chcp 65001 > NUL
setlocal ENABLEEXTENSIONS

REM === Configuration ===
set "URL=http://localhost:3001/chatbot"
set "MAX_RETRIES=60"

REM === Prerequisites Check ===
where node >NUL 2>&1
if errorlevel 1 (
  echo Node.js not found
  exit /b 1
)

rem Change to script directory
cd /d "%~dp0"

rem === Check dependencies ===
if not exist "node_modules" (
  echo Installing dependencies...
  call npm install
  if errorlevel 1 (
    echo Failed to install dependencies. Please check your npm installation.
    pause
    exit /b 1
  )
  echo Dependencies installed successfully.
)

REM === Start Server ===
start "chatbot-server" cmd /c node server.js

REM === Wait for Server and Open Browser ===
set /a "retries=%MAX_RETRIES%"
:wait_loop
curl -fsS -o NUL "%URL%" >NUL 2>&1
if %errorlevel%==0 goto open_browser

set /a "retries-=1"
if %retries% LEQ 0 goto open_browser
timeout /t 1 /nobreak >NUL
goto wait_loop

:open_browser
start "" "%URL%"
exit /b 0