# start-neko.ps1 — convenience launcher for this deployment.
# Uses the locally-installed Node 22 (required: mineflayer/minecraft-protocol need node>=22),
# then runs the mindcraft/neko agent.
#
# Usage:
#   .\start-neko.ps1                      # baseline: modes + LLM brain (framework-v2 OFF)
#   .\start-neko.ps1 -Framework           # LIVE: framework-v2 tier chain DRIVES the bot (speedrun brain)
#   .\start-neko.ps1 -FrameworkShadow     # framework-v2 enabled but SHADOW-only (logs decisions, doesn't act)
#   .\start-neko.ps1 -ScreenshotMs 5000   # also stream periodic POV screenshots every 5s (vision feed)
#
# Framework-v2 (P1): the deterministic progression engine (wood->stone->iron->diamond->...).
#   -Framework       => MC_FRAMEWORK_V2=1 + MC_FRAMEWORK_SHADOW=0 (kernel dispatches skills)
#   -FrameworkShadow => MC_FRAMEWORK_V2=1 only (kernel logs to bots/_supervisor/framework-shadow.log, no dispatch)
#   Watch decisions live:  Get-Content .\bots\_supervisor\framework-shadow.log -Wait -Tail 20
#
# Vision: on-demand vision is always enabled (settings.allow_vision). -ScreenshotMs>0 adds the
#   continuous ws_server POV camera feed (heavier; isolated child renderer).
param(
    [switch]$Framework,
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

if ($Framework) {
    $env:MC_FRAMEWORK_V2 = '1'
    $env:MC_FRAMEWORK_SHADOW = '0'
    Write-Host "framework-v2: LIVE (tier chain drives the bot)"
} elseif ($FrameworkShadow) {
    $env:MC_FRAMEWORK_V2 = '1'
    $env:MC_FRAMEWORK_SHADOW = '1'
    Write-Host "framework-v2: SHADOW (logs decisions to bots/_supervisor/framework-shadow.log, no dispatch)"
} else {
    # explicit safe default: kernel off (baseline modes + LLM)
    Remove-Item Env:MC_FRAMEWORK_V2 -ErrorAction SilentlyContinue
    Remove-Item Env:MC_FRAMEWORK_SHADOW -ErrorAction SilentlyContinue
}

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
