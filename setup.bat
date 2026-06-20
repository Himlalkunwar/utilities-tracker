@echo off
title Camp Utilities Tracker - Setup & Start
color 0A

echo.
echo  =====================================================
echo    Camp Utility ^& Operations Monitoring Platform
echo  =====================================================
echo.

:: Check Node.js
where node >nul 2>nul
if %errorlevel% neq 0 (
    echo  [ERROR] Node.js is NOT installed.
    echo  Please download and install it from: https://nodejs.org
    echo  Choose the LTS version, then re-run this script.
    pause
    exit /b 1
)

for /f "tokens=*" %%v in ('node -v') do set NODE_VER=%%v
echo  Node.js found: %NODE_VER%

:: Install dependencies if needed
if not exist "node_modules" (
    echo.
    echo  Installing dependencies (first-time setup)...
    call npm install
    if %errorlevel% neq 0 (
        echo  [ERROR] npm install failed. Check your internet connection.
        pause
        exit /b 1
    )
    echo  Dependencies installed.
)

:: Create uploads directory
if not exist "uploads" mkdir uploads

echo.
echo  =====================================================
echo    Starting server on port 3000...
echo  =====================================================
echo.
echo  Desktop:  http://localhost:3000
echo  (Mobile URL will be shown below once server starts)
echo.
echo  Press Ctrl+C to stop the server.
echo.

node server.js
pause
