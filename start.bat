@echo off
rem ============================================================
rem  Mineflayer 多账号机器人 · 一键启动（Windows）
rem  - 自带 Node 运行时（runtime\node.exe）：新电脑不装 Node 也能直接跑
rem  - 依赖（node_modules）已随包附带；万一缺失或损坏，会用 npm 自动重装（需系统有 npm）
rem  连公网服务器用本脚本；连本机离线服务器用 start-local.bat
rem  程序崩溃 / 内存吃满会自动重启（见文件末尾的 :run 循环）
rem ============================================================
chcp 65001 >nul
title Mineflayer 多账号机器人
cd /d "%~dp0"

rem ---- 选择 Node 运行时：优先项目自带的，其次系统 PATH ----
set "NODE_EXE="
if exist "%~dp0runtime\node.exe" set "NODE_EXE=%~dp0runtime\node.exe"
if defined NODE_EXE goto :node_ready
for /f "delims=" %%I in ('where node 2^>nul') do if not defined NODE_EXE set "NODE_EXE=%%I"
:node_ready
if not defined NODE_EXE goto :no_node

rem ---- 依赖检测：真实校验 mineflayer 能否加载（node_modules 存在但安装中断过也能识别）----
"%NODE_EXE%" -e "require.resolve('mineflayer')" >nul 2>nul
if not errorlevel 1 goto :deps_ok

rem ---- 依赖缺失：找 npm 重装 ----
set "NPM_CMD="
if exist "%~dp0runtime\npm.cmd" set "NPM_CMD=%~dp0runtime\npm.cmd"
if defined NPM_CMD goto :npm_ready
for /f "delims=" %%I in ('where npm 2^>nul') do if not defined NPM_CMD set "NPM_CMD=%%I"
:npm_ready
if not defined NPM_CMD goto :no_npm

echo 正在安装依赖：国内镜像，约 1 到 3 分钟，期间没有新提示，请勿关闭本窗口...
call "%NPM_CMD%" install --registry https://registry.npmmirror.com
"%NODE_EXE%" -e "require.resolve('mineflayer')" >nul 2>nul
if not errorlevel 1 goto :deps_ok
echo 国内镜像安装失败，正在用官方源重试...
call "%NPM_CMD%" install
"%NODE_EXE%" -e "require.resolve('mineflayer')" >nul 2>nul
if not errorlevel 1 goto :deps_ok
echo [错误] 依赖安装失败，机器人无法启动，请检查网络后重新运行本脚本。
echo 也可在本文件夹地址栏输入 cmd 回车，手动执行：
echo    npm install --registry https://registry.npmmirror.com
pause
exit /b 1

:no_node
echo [错误] 没找到可用的 Node：runtime\node.exe 不存在，系统里也没有装 Node.js。
echo 请安装 Node.js LTS（18 或以上）：https://nodejs.org/ ，装完重新双击本脚本；
echo 或者把 node.exe 放回本文件夹的 runtime 目录里。
start "" https://nodejs.org/
pause
exit /b 1

:no_npm
echo [错误] 依赖不完整，需要用 npm 重新安装，但没找到 npm。
echo 请安装 Node.js LTS（https://nodejs.org/）；
echo 或者从已装好依赖的电脑，把整个 node_modules 文件夹拷贝到本文件夹里。
pause
exit /b 1

:deps_ok
echo.
echo 使用 Node：%NODE_EXE%
rem ---- Node 堆上限：取物理内存的一半，夹在 1024~4096MB（默认约 2GB，一 OOM 就崩）----
set "HEAP_MB="
for /f "delims=" %%M in ('powershell -NoProfile -Command "try{[math]::Floor(((Get-CimInstance Win32_ComputerSystem).TotalPhysicalMemory/1MB)*0.5)}catch{0}" 2^>nul') do set "HEAP_MB=%%M"
if not defined HEAP_MB set "HEAP_MB=2048"
if %HEAP_MB% LSS 1024 set "HEAP_MB=1024"
if %HEAP_MB% GTR 4096 set "HEAP_MB=4096"
set "NODE_OPTIONS=--max-old-space-size=%HEAP_MB%"
echo Node 堆上限：%HEAP_MB% MB（想手动调就改本文件里这段）
echo 正在启动机器人，控制面板地址：http://127.0.0.1:8848
echo 如果浏览器没有自动打开，请手动在浏览器访问上面的地址。
echo 挂机中：程序崩溃或内存吃满会自动重启；要彻底停止请按 Ctrl+C 或直接关窗口。
echo.

:run
"%NODE_EXE%" src\main.js
echo.
echo 程序已退出（退出码 %ERRORLEVEL%），5 秒后自动重启；要彻底停止请按 Ctrl+C 或直接关窗口。
timeout /t 5 /nobreak >nul 2>nul || ping -n 6 127.0.0.1 >nul
goto :run
