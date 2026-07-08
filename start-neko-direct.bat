@echo off
rem 2026-07-04 应急直启器: powershell 全系挂死时的 bot 启动通道 (等价 start-neko.ps1 默认: framework LIVE)
cd /d C:\Users\Administrator\Downloads\mc-agent-neko
set MC_FRAMEWORK_V2=1
set MC_FRAMEWORK_SHADOW=0
rem ★2026-07-08 用户令: 临时禁用 饥饿/种田/食物 本能 (乱逛源)。要恢复改成 1。详见 docs/food-instincts-disabled.md
set MC_FOOD_INSTINCTS=0
rem ★2026-07-09 用户令: 低血本能熔断 (低血不打断任何行动)。要恢复改成 1。详见 docs/hp-instincts-disabled.md
set MC_HP_INSTINCTS=0
set NEKO_DISABLE_INPROC_VISION=1
set PATH=C:\Users\Administrator\nodejs22;%PATH%
node --max-old-space-size=8192 --expose-gc main.js > agent.log 2> agent.err
