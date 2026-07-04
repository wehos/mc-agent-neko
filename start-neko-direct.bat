@echo off
rem 2026-07-04 应急直启器: powershell 全系挂死时的 bot 启动通道 (等价 start-neko.ps1 -Framework)
cd /d C:\Users\Administrator\Downloads\mc-agent-neko
set MC_FRAMEWORK_V2=1
set MC_FRAMEWORK_SHADOW=0
set NEKO_DISABLE_INPROC_VISION=1
set PATH=C:\Users\Administrator\nodejs22;%PATH%
node --max-old-space-size=8192 --expose-gc main.js > agent.log 2> agent.err
