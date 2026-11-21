@echo off
rem ============================================================
rem  打包更新包（给云电脑/新电脑用）
rem  - 只打包「源码 src + 文档 + 功能指令表 + 启动脚本」
rem  - 不含 config / logs / auth-cache / node_modules / runtime
rem    （照包覆盖不会动到账号配置、授权缓存与依赖）
rem  - 产物：项目文件夹的“上一级目录”里的  mineflayer-bot-更新包.zip
rem ============================================================
chcp 65001 >nul
title 打包更新包
cd /d "%~dp0"

powershell -NoProfile -ExecutionPolicy Bypass -Command "$ErrorActionPreference='Stop'; $root=(Get-Location).Path; $zip=Join-Path (Split-Path $root -Parent) 'mineflayer-bot-更新包.zip'; $stage=Join-Path $env:TEMP ('kun-pack-' + [guid]::NewGuid().ToString('N').Substring(0,8)); New-Item -ItemType Directory -Path $stage -Force | Out-Null; Copy-Item (Join-Path $root 'src') (Join-Path $stage 'src') -Recurse -Force; foreach($f in @('README.md','项目结构说明.md','新电脑快速上手.md','功能指令表.xlsx','start.bat','start-local.bat','2.bat','打包更新包.bat','收集诊断包.bat','诊断内存.bat')){ $p=Join-Path $root $f; if(Test-Path $p){ Copy-Item $p $stage -Force } }; if(Test-Path $zip){ Remove-Item $zip -Force }; Compress-Archive -Path (Join-Path $stage '*') -DestinationPath $zip -CompressionLevel Optimal -Force; Remove-Item $stage -Recurse -Force; $kb=[math]::Round((Get-Item $zip).Length/1KB,1); $n=([System.IO.Compression.ZipFile]::OpenRead($zip)).Entries.Count; Write-Host ''; Write-Host ('[完成] 更新包已生成：' + $zip) -ForegroundColor Green; Write-Host ('[内容] ' + $n + ' 个文件，' + $kb + ' KB') -ForegroundColor Green"

echo.
echo 用法：把上面显示的 zip 拷到云电脑（远程桌面剪贴板/共享盘），
echo       解压覆盖到 C:\mineflayer-bot 即可；不要去覆盖 config、logs、auth-cache。
echo       覆盖后关闭控制台窗口，重新双击 start.bat。
echo.
pause
