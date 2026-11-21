@echo off
rem ============================================================
rem  收集诊断包（双击就行，不用敲命令）
rem  收集内容：logs\runtime（运行日志）、logs\whisper（私聊日志）、
rem            src（源码，用来核对版本）、config（配置）、package.json
rem  不含：auth-cache（微软登录令牌）/ node_modules / runtime（node.exe）
rem  产物：桌面上的  bot诊断包.zip  —— 直接拖到聊天窗口发给开发者
rem ============================================================
chcp 65001 >nul
title 收集诊断包
cd /d "%~dp0"

powershell -NoProfile -ExecutionPolicy Bypass -Command "$ErrorActionPreference='SilentlyContinue'; $src=(Get-Location).Path; $desk=[Environment]::GetFolderPath('Desktop'); $dst=Join-Path $desk 'bot诊断包.zip'; $tmp=Join-Path $env:TEMP ('botdiag-' + [guid]::NewGuid().ToString('N').Substring(0,6)); New-Item -ItemType Directory -Path $tmp -Force | Out-Null; foreach($d in @('logs\runtime','logs\whisper','src','config')){ $p=Join-Path $src $d; if(Test-Path $p){ Copy-Item $p (Join-Path $tmp (Split-Path $d -Leaf)) -Recurse -Force } }; foreach($f in @('package.json','README.md')){ $p=Join-Path $src $f; if(Test-Path $p){ Copy-Item $p $tmp -Force } }; $nodeVer='node 未找到'; try { $nodeVer=(& node -v) } catch { }; $memGB=[math]::Round((Get-CimInstance Win32_ComputerSystem).TotalPhysicalMemory/1GB,1); ('node ' + $nodeVer + ' / 物理内存 ' + $memGB + ' GB / 收集时间 ' + (Get-Date -Format 'yyyy-MM-dd HH:mm:ss')) | Out-File (Join-Path $tmp 'env.txt') -Encoding utf8; if(Test-Path $dst){ Remove-Item $dst -Force }; Compress-Archive -Path (Join-Path $tmp '*') -DestinationPath $dst -Force; Remove-Item $tmp -Recurse -Force; $kb=[math]::Round((Get-Item $dst).Length/1KB,1); $n=([System.IO.Compression.ZipFile]::OpenRead($dst)).Entries.Count; Write-Host ''; Write-Host ('[完成] 诊断包已生成：' + $dst) -ForegroundColor Green; Write-Host ('[内容] ' + $n + ' 个文件，' + $kb + ' KB') -ForegroundColor Green; Write-Host '把这个 zip 拖到聊天窗口发给开发者即可。' -ForegroundColor Green; explorer.exe $desk"

echo.
pause
