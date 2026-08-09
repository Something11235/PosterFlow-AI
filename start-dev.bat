@echo off
setlocal
title PosterFlow AI - Development Server

set "PROJECT_ROOT=%~dp0"
set "FRONTEND_DIR=%PROJECT_ROOT%frontend"
set "BACKEND_FILE=%PROJECT_ROOT%backend\server.py"
set "REQUIREMENTS_FILE=%PROJECT_ROOT%backend\requirements.txt"
set "VENV_DIR=%PROJECT_ROOT%.venv"
set "VENV_PYTHON=%VENV_DIR%\Scripts\python.exe"
set "NPM_CACHE_DIR=%PROJECT_ROOT%.npm-cache"
set "PIP_DISABLE_PIP_VERSION_CHECK=1"

echo ========================================
echo   PosterFlow AI - Development Startup
echo ========================================
echo.

where python >nul 2>&1
if errorlevel 1 (
    echo [ERROR] Python was not found. Install Python 3.11 or newer.
    pause
    exit /b 1
)

python -c "import sys; raise SystemExit(0 if sys.version_info >= (3, 11) else 1)" >nul 2>&1
if errorlevel 1 (
    echo [ERROR] Python 3.11 or newer is required.
    python --version
    pause
    exit /b 1
)

where npm.cmd >nul 2>&1
if errorlevel 1 (
    echo [ERROR] npm was not found. Install Node.js 20.19 or newer.
    pause
    exit /b 1
)

node -e "const [major, minor] = process.versions.node.split('.').map(Number); process.exit(major > 20 || (major === 20 && minor >= 19) ? 0 : 1)" >nul 2>&1
if errorlevel 1 (
    echo [ERROR] Node.js 20.19 or newer is required.
    node --version
    pause
    exit /b 1
)

if not exist "%BACKEND_FILE%" (
    echo [ERROR] Missing backend\server.py.
    pause
    exit /b 1
)

if not exist "%FRONTEND_DIR%\package-lock.json" (
    echo [ERROR] Missing frontend\package-lock.json.
    pause
    exit /b 1
)

if /I "%~1"=="--check" (
    echo [OK] Python, npm, backend, and frontend files are available.
    exit /b 0
)

if not exist "%VENV_PYTHON%" (
    echo [1/5] Creating isolated Python environment at .venv ...
    python -m venv "%VENV_DIR%"
    if errorlevel 1 (
        echo [ERROR] Failed to create the Python virtual environment.
        pause
        exit /b 1
    )
) else (
    "%VENV_PYTHON%" -m pip --version >nul 2>&1
    if errorlevel 1 (
        echo [1/5] Repairing an incomplete Python virtual environment ...
        python -m venv --clear "%VENV_DIR%"
        if errorlevel 1 (
            echo [ERROR] Failed to repair the Python virtual environment.
            pause
            exit /b 1
        )
    ) else (
        echo [1/5] Python virtual environment already exists.
    )
)

echo [2/5] Installing backend dependencies into .venv ...
"%VENV_PYTHON%" -m pip install --no-cache-dir -r "%REQUIREMENTS_FILE%" --quiet
if errorlevel 1 (
    echo [ERROR] Backend dependency installation failed.
    pause
    exit /b 1
)

pushd "%FRONTEND_DIR%"
if errorlevel 1 (
    echo [ERROR] Cannot enter frontend directory.
    pause
    exit /b 1
)

if not exist "node_modules" (
    echo [3/5] Installing frontend dependencies into frontend\node_modules ...
    call npm.cmd ci --cache "%NPM_CACHE_DIR%"
    if errorlevel 1 (
        popd
        echo [ERROR] Frontend dependency installation failed.
        pause
        exit /b 1
    )
) else (
    echo [3/5] Frontend dependencies already exist.
)
popd

if /I "%~1"=="--setup-only" (
    echo [OK] Isolated project dependencies are ready.
    exit /b 0
)

echo [4/5] Starting backend at http://localhost:5000 ...
start "PosterFlow AI Backend" /B "%VENV_PYTHON%" "%BACKEND_FILE%"
timeout /T 2 /NOBREAK >nul

echo [5/5] Starting frontend at http://localhost:3000 ...
echo.
echo Keep this window open. Press Ctrl+C to stop the frontend.
echo Close this window to finish the local development session.
echo.

pushd "%FRONTEND_DIR%"
call npm.cmd run dev
popd
pause
