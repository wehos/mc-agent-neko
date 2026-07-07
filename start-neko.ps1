# start-neko.ps1 — convenience launcher for this deployment.
# Uses the locally-installed Node 22 (required: mineflayer/minecraft-protocol need node>=22),
# then runs the mindcraft/neko agent.
#
# Usage:
#   .\start-neko.ps1                      # DEFAULT: framework-v2 LIVE drives the bot + admin 指令独占优先
#   .\start-neko.ps1 -FrameworkShadow     # framework-v2 enabled but SHADOW-only (logs decisions, doesn't act)
#   .\start-neko.ps1 -Baseline            # opt out: baseline modes + LLM brain, framework-v2 OFF (老空转模式)
#   .\start-neko.ps1 -ScreenshotMs 5000   # also stream periodic POV screenshots every 5s (vision feed)
#
# Framework-v2 (P1): the deterministic progression engine (wood->stone->iron->diamond->...).
#   ★2026-07-07 用户令: 默认既开 framework 自主, 又听 admin —— admin 指令通过"外部意图独占"压过
#     framework 自主派发(硬保命凌驾一切)。默认 => MC_FRAMEWORK_V2=1 + MC_FRAMEWORK_SHADOW=0。
#   -Baseline        => MC_FRAMEWORK_V2=0 (kernel off, 只跑 modes + LLM)
#   -FrameworkShadow => MC_FRAMEWORK_V2=1 + MC_FRAMEWORK_SHADOW=1 (kernel logs to framework-shadow.log, no dispatch)
#   Watch decisions live:  Get-Content .\bots\_supervisor\framework-shadow.log -Wait -Tail 20
#
# Vision: on-demand vision is always enabled (settings.allow_vision). -ScreenshotMs>0 adds the
#   continuous ws_server POV camera feed (heavier; isolated child renderer).
param(
    [switch]$Baseline,
    [switch]$FrameworkShadow,
    [int]$ScreenshotMs = 0
)
$ErrorActionPreference = 'Stop'
$node22 = 'C:\Users\Administrator\nodejs22'
if (-not (Test-Path (Join-Path $node22 'node.exe'))) {
    Write-Error "Node 22 not found at $node22"
    exit 1
}
$env:PATH = "$node22;$env:PATH"

if ($Baseline) {
    # explicit opt-out: kernel off (baseline modes + LLM brain, old idle-prone mode)
    $env:MC_FRAMEWORK_V2 = '0'
    Remove-Item Env:MC_FRAMEWORK_SHADOW -ErrorAction SilentlyContinue
    Write-Host "framework-v2: OFF (baseline modes + LLM — 只在被 admin 指令驱动时行动)"
} elseif ($FrameworkShadow) {
    $env:MC_FRAMEWORK_V2 = '1'
    $env:MC_FRAMEWORK_SHADOW = '1'
    Write-Host "framework-v2: SHADOW (logs decisions to bots/_supervisor/framework-shadow.log, no dispatch)"
} else {
    # ★2026-07-07 用户令 default: framework LIVE 自主 + admin 独占优先 (explicit, not relying on unset)
    $env:MC_FRAMEWORK_V2 = '1'
    $env:MC_FRAMEWORK_SHADOW = '0'
    Write-Host "framework-v2: LIVE (自主 tier chain 驱动 bot; admin 指令独占优先, 硬保命凌驾一切)"
}

# ★2026-07-08 用户令: 临时禁用「饥饿/种田/食物」本能 (bot 接到命令后到处乱逛的源头 — 主动觅食/种麦/
#   村庄采集提案 + 灰区低饥饿求生; auto_eat 改为只补血不补体力)。代码默认亦为禁用, 这里显式钉死以求跨
#   watchdog 自动重启也一致。回头有空要恢复: 改成 '1' (或删除本行), 并重启 watchdog + bot。
#   详见 docs/food-instincts-disabled.md。
$env:MC_FOOD_INSTINCTS = '0'
Write-Host "food/hunger/farming instincts: DISABLED (MC_FOOD_INSTINCTS=0 — 只补血不补体力; 设 1 恢复)"

# In-proc vision kill switch ON by default (2026-07-02 task#12): the lazy Camera path is
# BROKEN — prismarine-viewer's entity meshes need global.THREE which nothing sets in-proc,
# so every vision call floods 'ReferenceError: THREE is not defined' + per-entity mesh
# failures (observed ~19:25, console unusable). A broken feature is safer disabled; remove
# this once vision_interpreter injects globalThis.THREE (task #12).
$env:NEKO_DISABLE_INPROC_VISION = '1'

if ($ScreenshotMs -gt 0) {
    $env:NEKO_AGENT_SCREENSHOT_INTERVAL_MS = "$ScreenshotMs"
    Write-Host "Periodic POV camera feed ENABLED: every ${ScreenshotMs}ms"
} else {
    # explicit safe default: a stale value left by a previous -ScreenshotMs run in this
    # same shell would silently re-enable the heavy (crash-prone renderer) camera feed —
    # clear it, same as the MC_FRAMEWORK_* vars above.
    Remove-Item Env:NEKO_AGENT_SCREENSHOT_INTERVAL_MS -ErrorAction SilentlyContinue
}

Set-Location -Path $PSScriptRoot
# Rotate runaway diagnostic logs at boot (mine_motion.jsonl hit 76MB in one day of
# supervision — appendFileSync cost grows and post-mortem greps crawl; one .old
# generation is enough history for any postmortem that matters).
foreach ($lg in @('bots\_supervisor\mine_motion.jsonl', 'bots\_supervisor\act_trace.jsonl', 'bots\_supervisor\combat_log.jsonl')) {
    try {
        if ((Test-Path $lg) -and ((Get-Item $lg).Length -gt 50MB)) {
            Move-Item -Force $lg "$lg.old"
            Write-Host "rotated $lg (>50MB) -> .old"
        }
    } catch {}
}
Write-Host "node: $(node --version)  (repo: $PSScriptRoot)"
# --max-old-space-size / --expose-gc mirror package.json's "start" script.
node --max-old-space-size=8192 --expose-gc main.js
