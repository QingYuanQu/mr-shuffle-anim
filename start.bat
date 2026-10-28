@echo off
rem MapReduce Shuffle 动画演示 —— 一键启动脚本 (Windows)
rem 用法:
rem   start.bat            (默认：安装依赖(如需) + 构建 + 预览 http://localhost:4180)
rem   start.bat dev        (开发模式 http://localhost:5180)
rem   start.bat build      (仅构建 dist/)
rem   start.bat preview-only (直接预览已有 dist/，不重新构建)
rem   start.bat check      (运行内核正确性校验)

setlocal
set "PORT=4180"
set "MODE=%~1"
if "%MODE%"=="" set "MODE=preview"

echo [mr-shuffle] 检查依赖 node_modules ...
if not exist node_modules (
  echo [mr-shuffle] 首次运行，安装依赖 (npm install) ...
  call npm install --no-audit --no-fund
  if errorlevel 1 (
    echo [mr-shuffle] 依赖安装失败，请检查网络或 Node 版本
    exit /b 1
  )
)

if "%MODE%"=="dev" (
  echo [mr-shuffle] 启动开发服务器 -^> http://localhost:5180
  call npm run dev
  goto :eof
)
if "%MODE%"=="build" (
  echo [mr-shuffle] 构建生产产物 ...
  call npm run build
  goto :eof
)
if "%MODE%"=="preview-only" (
  echo [mr-shuffle] 预览已有产物 -^> http://localhost:%PORT%
  call npm run preview -- --port %PORT% --strictPort
  goto :eof
)
if "%MODE%"=="check" (
  echo [mr-shuffle] 运行内核校验 ...
  call npm run check
  goto :eof
)

rem 默认 preview：先构建再预览
echo [mr-shuffle] 构建生产产物 ...
call npm run build
if errorlevel 1 (
  echo [mr-shuffle] 构建失败，已中止
  exit /b 1
)
echo [mr-shuffle] 预览演示 -^> http://localhost:%PORT%
call npm run preview -- --port %PORT% --strictPort
