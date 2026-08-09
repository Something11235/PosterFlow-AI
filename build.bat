@echo off
setlocal
title PosterFlow AI - Production Build

set "PROJECT_ROOT=%~dp0"
set "FRONTEND_DIR=%PROJECT_ROOT%frontend"

echo ========================================
echo   PosterFlow AI - Production Build
echo ========================================
echo.

echo [1/3] Preparing isolated project dependencies...
call "%PROJECT_ROOT%start-dev.bat" --setup-only
if errorlevel 1 (
    echo [ERROR] Project dependency setup failed.
    pause
    exit /b 1
)

pushd "%FRONTEND_DIR%"
if errorlevel 1 (
    echo [ERROR] Cannot enter frontend directory.
    pause
    exit /b 1
)

echo [2/3] Building frontend assets...
call npm.cmd run build
if errorlevel 1 (
    popd
    echo [ERROR] Frontend build failed.
    pause
    exit /b 1
)
popd

echo.
echo [3/3] Production build completed.
echo Run: .venv\Scripts\python.exe backend\server.py
echo Open: http://127.0.0.1:5000
echo For public deployment, use Dockerfile or a production WSGI server.
pause
