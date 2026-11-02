@echo off
chcp 65001 >nul
setlocal
set "IPI_NODE_EXE="
for /f "delims=" %%N in ('where node.exe 2^>nul') do if not defined IPI_NODE_EXE set "IPI_NODE_EXE=%%N"
if not defined IPI_NODE_EXE set "IPI_NODE_EXE=%USERPROFILE%\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe"
if not exist "%IPI_NODE_EXE%" (
  echo Node.js was not found. Install Node.js 18 or later.
  pause
  exit /b 1
)
echo Starting IPI audio tool: http://127.0.0.1:4173
echo Keep this window open while using the tool.
"%IPI_NODE_EXE%" "%~dp0dev-server.mjs" --open
if errorlevel 1 (
  echo Startup failed. See the error above.
  pause
  exit /b 1
)
endlocal
