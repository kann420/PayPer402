@echo off
rem Double-click to run the local stack (facilitator :4020, demo seller :4021, web app :3000)
rem and open the web app in the browser. Close the "PayPer402 stack" window to stop it.
setlocal EnableExtensions
cd /d "%~dp0"

set "WEB_URL=http://localhost:3000"

if not exist ".env" (
  echo No .env in %CD%. Copy .env.example to .env and fill in the sandbox credentials.
  pause
  exit /b 1
)

where node >nul 2>nul
if errorlevel 1 (
  echo Node.js was not found. Install Node.js 22 or later.
  pause
  exit /b 1
)

if not exist "node_modules" (
  echo Installing dependencies...
  call npm.cmd install
  if errorlevel 1 (
    echo npm install failed.
    pause
    exit /b 1
  )
)

powershell -NoProfile -Command "$c = New-Object Net.Sockets.TcpClient; try { $c.Connect('127.0.0.1', 3000); exit 0 } catch { exit 1 } finally { $c.Close() }"
if not errorlevel 1 (
  echo Port 3000 is already in use. Opening %WEB_URL% without starting another stack.
  start "" "%WEB_URL%"
  exit /b 0
)

echo Starting the stack in a new window...
start "PayPer402 stack" cmd /k "npm.cmd run dev:stack"

echo Waiting for %WEB_URL% (up to 2 minutes)...
powershell -NoProfile -Command "$deadline = (Get-Date).AddSeconds(120); while ((Get-Date) -lt $deadline) { $c = New-Object Net.Sockets.TcpClient; try { $c.Connect('127.0.0.1', 3000); exit 0 } catch { Start-Sleep -Milliseconds 500 } finally { $c.Close() } }; exit 1"
if errorlevel 1 (
  echo The web app did not come up. Check the "PayPer402 stack" window for errors.
  pause
  exit /b 1
)

start "" "%WEB_URL%"
echo Opened %WEB_URL%. Close the "PayPer402 stack" window to stop the servers.
ping -n 4 127.0.0.1 >nul
exit /b 0
