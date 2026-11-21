@echo off
rem ============================================================
rem  Mineflayer 机器人 · 连接“本机”离线服务器（127.0.0.1:25565）
rem  前提：你已在本机启动一个离线模式（online-mode=false）的 MC 服务器
rem  若要连接公网服务器，请改用 start.bat，并在网页面板填写服务器IP
rem  程序崩溃 / 内存吃满会自动重启（见文件末尾的 :run 循环）
rem ============================================================
chcp 65001 >nul
title Mineflayer 机器人 - 本地离线服
cd /d "%~dp0"

echo 【提示】本脚本连接本机服务器 127.0.0.1:25565。
echo         请先启动本机离线服务器；连公网服务器请改用 start.bat。
echo.

rem ---- 选择 Node 运行时：优先项目自带的，其次系统 PATH ----
set "NODE_EXE="
if exist "%~dp0runtime\node.exe" set "NODE_EXE=%~dp0runtime\node.exe"
if defined NODE_EXE goto :node_ready
for /f "delims=" %%I in ('where node 2^>nul') do if not defined NODE_EXE set "NODE_EXE=%%I"
:node_ready
if not defined NODE_EXE goto :no_node

rem ---- 依赖检测：真实校验 mineflayer 能否加载（安装中断过的 node_modules 会被识别出来）----
"%NODE_EXE%" -e "require.resolve('mineflayer')" >nul 2>nul
if not errorlevel 1 goto :deps_ok

rem ---- 依赖缺失：找 npm 重装 ----
set "NPM_CMD="
if exist "%~dp0runtime\npm.cmd" set "NPM_CMD=%~dp0runtime\npm.cmd"
if defined NPM_CMD goto :npm_ready
for /f "delims=" %%I in ('where npm 2^>nul') do if not defined NPM_CMD set "NPM_CMD=%%I"
:npm_ready
if not defined NPM_CMD goto :no_npm

echo 正在安装依赖：国内镜像，约 1 到 3 分钟，请勿关闭本窗口...
call "%NPM_CMD%" install --registry https://registry.npmmirror.com
"%NODE_EXE%" -e "require.resolve('mineflayer')" >nul 2>nul
if not errorlevel 1 goto :deps_ok
echo 国内镜像失败，用官方源重试...
call "%NPM_CMD%" install
"%NODE_EXE%" -e "require.resolve('mineflayer')" >nul 2>nul
if not errorlevel 1 goto :deps_ok
echo [错误] 依赖安装失败，机器人无法启动，请检查网络。
pause
exit /b 1

:no_node
echo [错误] 没找到可用的 Node：runtime\node.exe 不存在，系统里也没有装 Node.js。
echo 请安装 Node.js LTS：https://nodejs.org/ ，或把 node.exe 放回 runtime 目录。
start "" https://nodejs.org/
pause
exit /b 1

:no_npm
echo [错误] 依赖不完整且没找到 npm，无法自动重装依赖。
echo 请安装 Node.js LTS（https://nodejs.org/），或从已装好依赖的电脑拷贝 node_modules 文件夹过来。
pause
exit /b 1

:deps_ok
echo.
echo 使用 Node：%NODE_EXE%
rem ---- Node 堆上限：取物理内存的一半，夹在 1024~4096MB ----
set "HEAP_MB="
for /f "delims=" %%M in ('powershell -NoProfile -Command "try{[math]::Floor(((Get-CimInstance Win32_ComputerSystem).TotalPhysicalMemory/1MB)*0.5)}catch{0}" 2^>nul') do set "HEAP_MB=%%M"
if not defined HEAP_MB set "HEAP_MB=2048"
if %HEAP_MB% LSS 1024 set "HEAP_MB=1024"
if %HEAP_MB% GTR 4096 set "HEAP_MB=4096"
set "NODE_OPTIONS=--max-old-space-size=%HEAP_MB%"
echo Node 堆上限：%HEAP_MB% MB
echo === 连接本地离线服务器，控制面板 http://127.0.0.1:8848 ===
echo.

:run
"%NODE_EXE%" src\main.js config\local-offline.config.js
echo.
echo 程序已退出（退出码 %ERRORLEVEL%），5 秒后自动重启；要彻底停止请按 Ctrl+C 或直接关窗口。
timeout /t 5 /nobreak >nul 2>nul || ping -n 6 127.0.0.1 >nul
goto :run
