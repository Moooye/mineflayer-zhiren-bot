@echo off
rem ============================================================
rem  诊断内存（排查「机器人内存一直涨、隔一两小时就重启」）
rem  - 用和 start.bat 完全一样的 Node 与堆上限启动，只是额外打开「内存明细探针」
rem  - 每分钟往 logs\runtime\当天.log 写一行「内存明细（定时）：堆 xx/xxMB … 实体 … 区块 … 监听 … 记分板 …」
rem  - 让它跑 30 分钟以上（最好跨过一次服务器重启），然后把 logs\runtime 发出来
rem  - 本脚本不会自动重启进程，方便看单次进程里的完整增长曲线
rem ============================================================
chcp 65001 >nul
title 诊断内存（跑 30 分钟以上，然后把 logs\runtime 发出来）
cd /d "%~dp0"

set "NODE_EXE="
if exist "%~dp0runtime\node.exe" set "NODE_EXE=%~dp0runtime\node.exe"
if defined NODE_EXE goto :node_ready
for /f "delims=" %%I in ('where node 2^>nul') do if not defined NODE_EXE set "NODE_EXE=%%I"
:node_ready
if not defined NODE_EXE (
  echo [错误] 没找到 Node：runtime\node.exe 不存在，系统里也没装 Node.js。
  pause
  exit /b 1
)

"%NODE_EXE%" -e "require.resolve('mineflayer')" >nul 2>nul
if errorlevel 1 (
  echo [错误] 依赖不完整（node_modules 里没有 mineflayer），请先用 start.bat 跑一次把依赖装好。
  pause
  exit /b 1
)

set "HEAP_MB="
for /f "delims=" %%M in ('powershell -NoProfile -Command "try{[math]::Floor(((Get-CimInstance Win32_ComputerSystem).TotalPhysicalMemory/1MB)*0.5)}catch{0}" 2^>nul') do set "HEAP_MB=%%M"
if not defined HEAP_MB set "HEAP_MB=2048"
if %HEAP_MB% LSS 1024 set "HEAP_MB=1024"
if %HEAP_MB% GTR 4096 set "HEAP_MB=4096"

set "NODE_OPTIONS=--max-old-space-size=%HEAP_MB%"
set "MEM_PROBE=1"
set "MEM_PROBE_MS=60000"

echo.
echo ============================================================
echo  内存诊断模式：每 60 秒记录一行「内存明细」
echo  Node ：%NODE_EXE%
echo  堆上限：%HEAP_MB% MB
echo  面板 ：http://127.0.0.1:8848 （照常可用）
echo.
echo  请让它跑 30 分钟以上（最好跨过一次服务器例行重启），
echo  然后把这个文件发出来： logs\runtime\ 里当天那个 .log
echo  （也可以用项目里的 收集诊断包.bat 一键打包）
echo.
echo  要停止：直接按 Ctrl+C 或关窗口（不会自动重启）
echo ============================================================
echo.

"%NODE_EXE%" src\main.js

echo.
echo 程序已退出。日志在 logs\runtime\ 下，按日期命名。
pause
