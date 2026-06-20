# 24/7 watchdog for the Neko agent. Runs DETACHED from any Claude session — keeps
# `node main.js` (the bot) alive forever: if port 48909 (the agent WS plugin) stops
# listening, it clears stale 8765/48909 and relaunches. Does NOT touch the MC LAN
# server (55916) — that's the game world, managed separately. Logs to watchdog.log.
#
# Launch (detached, survives logout/session-end):
#   Start-Process powershell -ArgumentList '-NoProfile','-WindowStyle','Hidden','-File','C:\Users\wehos\Project\mc-agent-upstream-sync\watchdog.ps1' -WindowStyle Hidden
# Stop: kill the powershell process running this file, or: Remove-Item watchdog.stop (create that file to make it exit cleanly).

$ErrorActionPreference = 'SilentlyContinue'
$proj = 'C:\Users\wehos\Project\mc-agent-upstream-sync'
Set-Location $proj
$log = Join-Path $proj 'watchdog.log'
try {
    $self = $PID
    $watchdogPath = Join-Path $proj 'watchdog.ps1'
    $watchdogPathPattern = [regex]::Escape($watchdogPath)
    $watchdogRelativePattern = '(?i)-File\s+["'']?watchdog\.ps1(?:["'']|\s|$)'
    Get-CimInstance Win32_Process |
        Where-Object {
            $_.ProcessId -ne $self -and
            ($_.CommandLine -match $watchdogPathPattern -or $_.CommandLine -match $watchdogRelativePattern)
        } |
        ForEach-Object {
            Add-Content $log "[$(Get-Date -Format o)] watchdog singleton: stopping duplicate pid $($_.ProcessId)"
            Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue
        }
} catch {}
Add-Content $log "[$(Get-Date -Format o)] watchdog started (pid $PID)"
# ★C283 FLIGHT RECORDER: screenshots ON at 15s so bridge.mjs keeps a rolling timestamped
# filmstrip (frames/, pruned to FRAME_RETAIN_MS) — the visual black box for post-hoc replay
# ("frame-at.mjs 04:52"). Was '0' (off, to spare the renderer); 15s is a light cadence. If the
# prismarine renderer ever destabilizes an unattended run, drop this back to '0'.
if (-not $env:NEKO_AGENT_SCREENSHOT_INTERVAL_MS) { $env:NEKO_AGENT_SCREENSHOT_INTERVAL_MS = '15000' }

$progFile = Join-Path $proj 'bots\_supervisor\progress.txt'
$freezeLimitSec = 360    # progress.txt stale this long while agent is up = skill hung -> restart
$wedgeLimitSec  = 1200   # agent.err SILENT this long (no broadcasts) = half-dead MC conn -> restart

function Restart-Agent($reason) {
    Add-Content $log "[$(Get-Date -Format o)] RESTART ($reason)"
    # ── IMMORTAL OS-LEVEL ALERT ────────────────────────────────────────────────────────
    # Chat Monitors/crons are session-bound and die ~1.5h after the user's last message
    # (keepalive plugin window) → session recycle. This watchdog is a detached OS process
    # and NEVER dies, so it is the only place an alert can fire regardless of Claude's state.
    # Append every incident to ALERTS.txt (the chat-side cron reads this and surfaces it) AND
    # best-effort pop a desktop toast so the user is reached even with Claude fully closed.
    try { Add-Content (Join-Path $proj 'ALERTS.txt') ("[{0}] WATCHDOG RESTART: {1}" -f (Get-Date -Format 'MM-dd HH:mm:ss'), $reason) } catch {}
    try {
        $toast = "Neko 监工: agent 异常已自动重启 — $reason"
        # NotifyIcon balloon works on all Win editions without extra modules.
        Add-Type -AssemblyName System.Windows.Forms -ErrorAction SilentlyContinue
        $ni = New-Object System.Windows.Forms.NotifyIcon
        $ni.Icon = [System.Drawing.SystemIcons]::Warning
        $ni.Visible = $true
        $ni.ShowBalloonTip(8000, 'Neko Watchdog', $toast, [System.Windows.Forms.ToolTipIcon]::Warning)
        Start-Sleep -Milliseconds 200
    } catch {}
    # Archive the crash logs BEFORE relaunch overwrites them, so the cause is recoverable
    # (the agent occasionally dies for unknown reasons; without this the evidence is lost).
    $stamp = (Get-Date -Format 'MMdd-HHmmss')
    foreach ($f in 'agent.err', 'agent.log') {
        $src = Join-Path $proj $f
        if (Test-Path $src) { try { Copy-Item $src (Join-Path $proj ("crash-$stamp-$f")) -Force } catch {} }
    }
    foreach ($port in 8765, 48909) {
        $c = Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue
        if ($c) { Stop-Process -Id $c.OwningProcess -Force -ErrorAction SilentlyContinue }
    }
    Start-Sleep -Seconds 2
    Start-Process -FilePath 'node' -ArgumentList 'main.js' -WorkingDirectory $proj `
        -RedirectStandardOutput (Join-Path $proj 'agent.log') `
        -RedirectStandardError (Join-Path $proj 'agent.err') -WindowStyle Hidden
    Add-Content $log "[$(Get-Date -Format o)] relaunched node main.js"
    Start-Sleep -Seconds 25   # boot grace; also gives the skill time to write progress
}

function Send-Control($type, $reason) {
    try {
        $inbox = Join-Path $proj 'bots\_supervisor\inbox.jsonl'
        $payload = [ordered]@{ type = $type; reason = $reason; ts = (Get-Date -Format o) } | ConvertTo-Json -Compress
        Add-Content $inbox $payload
        Add-Content (Join-Path $proj 'ALERTS.txt') ("[{0}] CONTROL SENT: {1} — {2}" -f (Get-Date -Format 'MM-dd HH:mm:ss'), $type, $reason)
    } catch {}
}

# ★wedge 判据用"stale 新增"而非"累积>0":正常长挖矿/爬升会让 agent.err 静默 20+min,若本次
# 生命周期历史有过 stale-state(MC 闪断已恢复)累积>0,旧判据会把正在干活的 bot 误判 wedge 重启
# (实测误杀 digToSurface 爬升)。只有静默期内 stale-state 比上一轮"新增",才是真的 MC 连接死。
$prevStale = 999999   # 首轮不误判;之后每轮 heartbeat 末尾校准为当前值
# ── STUCK DETECTION state ─────────────────────────────────────────────────────────
# The mtime/port checks above all say "alive" while the bot loops a dead task (saw a
# 2.5h chopWood loop: progress.txt ticking, port up, zero actual progress). Only HARD
# metrics expose that: the agent broadcasts vitals (pos/inv/skill) every 15s, the
# bridge persists vitals.json, and we compare across ticks. pos moved <3 blocks AND
# inventory total unchanged → stuck tick. 40 ticks (20min) → ALERT (patrol window);
# 80 ticks (40min) → restart. Night-holds (~7min) stay safely under the threshold.
$stuckTicks = 0; $lastVitPos = $null; $lastInvTotal = -1
$tick = 0; $deathAnchor = -1; $deathAnchorTick = 0; $lastSpiralAlertTick = -999
while ($true) {
    if (Test-Path (Join-Path $proj 'watchdog.stop')) {
        Add-Content $log "[$(Get-Date -Format o)] watchdog.stop found - exiting"
        Remove-Item (Join-Path $proj 'watchdog.stop') -Force
        break
    }
    # BRIDGE KEEP-ALIVE: bridge.mjs (a detached WS client) is what writes frame.jpg from the
    # agent's screenshot frames + relays tasks. It's the screenshot pipeline's weak link — it
    # doesn't survive reboots/session-recycles on its own, and without it the visual diagnostic
    # silently dies (frame.jpg goes stale). Keep it alive here so screenshots stay up 24/7.
    $bridgeAlive = Get-CimInstance Win32_Process -Filter "Name='node.exe'" -ErrorAction SilentlyContinue | Where-Object { $_.CommandLine -like '*bridge.mjs*' }
    if (-not $bridgeAlive) {
        $env:NEKO_WS_URL = 'ws://localhost:48909'
        Start-Process -FilePath 'node' -ArgumentList 'bridge.mjs' -WorkingDirectory (Join-Path $proj 'bots\_supervisor') `
            -RedirectStandardOutput (Join-Path $proj 'bots\_supervisor\bridge.log') `
            -RedirectStandardError (Join-Path $proj 'bots\_supervisor\bridge.err') -WindowStyle Hidden
        Add-Content $log "[$(Get-Date -Format o)] started bridge.mjs (screenshot pipeline)"
    }
    # OVERSEER KEEP-ALIVE: overseer.mjs is the god's-eye risk engine (radar + vitals trend +
    # death heat-map -> advisory.json, with LLM tactical escalation). The strategy layer
    # reads advisory.json every loop; if the overseer dies the bot silently loses its
    # early-warning sense, so keep it alive alongside the bridge.
    $overseerAlive = Get-CimInstance Win32_Process -Filter "Name='node.exe'" -ErrorAction SilentlyContinue | Where-Object { $_.CommandLine -like '*overseer.mjs*' }
    if (-not $overseerAlive) {
        Start-Process -FilePath 'node' -ArgumentList 'overseer.mjs' -WorkingDirectory (Join-Path $proj 'bots\_supervisor') `
            -RedirectStandardOutput (Join-Path $proj 'bots\_supervisor\overseer.out') `
            -RedirectStandardError (Join-Path $proj 'bots\_supervisor\overseer.err') -WindowStyle Hidden
        Add-Content $log "[$(Get-Date -Format o)] started overseer.mjs (risk engine)"
    }
    # TICKET-SERVER KEEP-ALIVE: the resident single-writer ticket store (:48920) that makes the
    # one MC session parallel-fixable (auto+manual tickets, cross-session claim sync, human web
    # UI). botwatch.mjs POSTs auto-tickets to it; a human/agent reads via ticket.mjs / the UI.
    # See docs/parallel-tickets.md. Keep it alive so the board never goes dark.
    $ticketAlive = Get-CimInstance Win32_Process -Filter "Name='node.exe'" -ErrorAction SilentlyContinue | Where-Object { $_.CommandLine -like '*ticket-server.mjs*' }
    if (-not $ticketAlive) {
        $env:TICKET_PORT = '48920'
        Start-Process -FilePath 'node' -ArgumentList 'ticket-server.mjs' -WorkingDirectory (Join-Path $proj 'bots\_supervisor') `
            -RedirectStandardOutput (Join-Path $proj 'bots\_supervisor\ticket-server.log') `
            -RedirectStandardError (Join-Path $proj 'bots\_supervisor\ticket-server.err') -WindowStyle Hidden
        Add-Content $log "[$(Get-Date -Format o)] started ticket-server.mjs (:48920)"
    }
    # BOTWATCH KEEP-ALIVE: the anomaly detector — classifies death/stuck/idle/seal-fail from the
    # telemetry and POSTs auto-tickets to the ticket-server. Without it the board stops filling
    # itself. Needs TICKET_PORT (set above, persists in this PS session).
    $botwatchAlive = Get-CimInstance Win32_Process -Filter "Name='node.exe'" -ErrorAction SilentlyContinue | Where-Object { $_.CommandLine -like '*botwatch.mjs*' }
    if (-not $botwatchAlive) {
        $env:TICKET_PORT = '48920'
        Start-Process -FilePath 'node' -ArgumentList 'botwatch.mjs', '240' -WorkingDirectory (Join-Path $proj 'bots\_supervisor') `
            -RedirectStandardOutput (Join-Path $proj 'bots\_supervisor\botwatch_stdout.log') `
            -RedirectStandardError (Join-Path $proj 'bots\_supervisor\botwatch.err') -WindowStyle Hidden
        Add-Content $log "[$(Get-Date -Format o)] started botwatch.mjs (anomaly->ticket detector)"
    }
    $listening = Get-NetTCPConnection -LocalPort 48909 -State Listen -ErrorAction SilentlyContinue
    if (-not $listening) {
        Restart-Agent 'agent DOWN (48909 not listening)'
    }
    else {
        # FREEZE DETECTION: agent process up but the supervised skill may be hung. Use the
        # FRESHEST of progress.txt and agent.err — agent.err receives every broadcast (the bot
        # logs "bunkering"/"running"/etc. constantly whenever ANY mode fires), so it advances
        # while the bot is merely IDLE-WAITING (e.g. legitimately holed up at night, when
        # progress.txt is intentionally not written). Only when BOTH have been stale past the
        # limit is the bot truly hung. (Earlier this false-positived on night-holds and reset
        # the bot's hard-won progress.)
        $errFile = Join-Path $proj 'agent.err'
        $newest = $null
        foreach ($f in $progFile, $errFile) {
            if (Test-Path $f) { $t = (Get-Item $f).LastWriteTime; if ($null -eq $newest -or $t -gt $newest) { $newest = $t } }
        }
        $frozen = ($null -ne $newest) -and ((((Get-Date) - $newest).TotalSeconds) -gt $freezeLimitSec)
        $errAge = if (Test-Path $errFile) { ((Get-Date) - (Get-Item $errFile).LastWriteTime).TotalSeconds } else { -1 }
        if ($frozen) {
            Restart-Agent ("FROZEN - no progress.txt/agent.err write in " + [int](((Get-Date) - $newest).TotalSeconds) + "s")
        }
        # WEDGE DETECTION (half-dead bot): node process stays up (48909 listening) and the
        # achieve loop keeps writing progress.txt via fs, but the MC connection died ("Cleaned
        # up stale state for agent") so agent.err gets ZERO broadcasts and NO real work happens.
        # The freshest-of-both freeze check MISSES this — progress.txt looks fresh while the bot
        # is actually wedged (saw 84 min of 0 logs / frozen inventory while progress.txt ticked).
        # agent.err advances on EVERY action/mode in a healthy bot (incl. night-holds →
        # "bunkering" spam), so agent.err ALONE silent this long = wedged, not idle. (elseif so
        # we never double-restart in one tick.)
        elseif ($errAge -gt $wedgeLimitSec) {
            # err-silent ALONE is NOT wedge anymore. Since render noise (glow_squid) was moved out
            # of agent.err, normal heads-down work (mining/smelting/long crafts) legitimately emits
            # ZERO broadcasts for 20+ min — progress.txt (fs) and frame.jpg (WS) keep ticking but
            # agent.err stays silent. The old `err-silent>1200s` rule then MISFIRED and restarted a
            # bot that was happily mining diamonds (saw exactly this). A TRUE wedge (MC conn dead)
            # leaves a fingerprint the work-loop can't: 'Cleaned up stale state for agent' in
            # agent.log. Require that evidence — silence without it = just busy, leave it alone.
            $staleHits = 0
            $alog2 = Join-Path $proj 'agent.log'
            if (Test-Path $alog2) { $staleHits = @(Select-String -Path $alog2 -Pattern 'Cleaned up stale state' -ErrorAction SilentlyContinue).Count }
            # 只有 stale 在静默期内 NEW(比上一轮多)才是真 wedge;累积>0 会误杀正常长挖矿/爬升。
            if ($staleHits -gt $prevStale) {
                Restart-Agent ("WEDGED - agent.err silent " + [int]$errAge + "s + stale-state NEW (" + $prevStale + "->" + $staleHits + ", MC conn dead)")
            }
        }
    }
    # ── IMMORTAL HEARTBEAT ─────────────────────────────────────────────────────────────
    # Monitor tasks are bound to the harness SESSION and die on session-recycle (~every few
    # hours — proven by per-session task dirs). This detached watchdog process survives, so
    # heartbeat.log is the never-stopping status record: a Monitor just `tail -f`s it for push
    # notifications, and any session-gap is fully recoverable by reading heartbeat.log. Wrapped
    # in try/catch so a transient read error can never break the keep-alive loop.
    try {
        $hbUp = 0; if (Get-NetTCPConnection -LocalPort 48909 -State Listen -ErrorAction SilentlyContinue) { $hbUp = 1 }
        $hbDeaths = 0; $hbStale = 0
        # deaths = CUMULATIVE death_log.jsonl line count (append-only, survives restarts). The
        # old 'Agent died' count in agent.log RESET on every relaunch (agent.log is truncated on
        # restart), so frequent code-deploy restarts zeroed it and HID a 7-death spiral — every
        # 巡检 read deaths=0 while death_log silently climbed 12→19. Cumulative = the real signal.
        $dlogF = Join-Path $proj 'bots\_supervisor\death_log.jsonl'
        if (Test-Path $dlogF) { $hbDeaths = @(Get-Content $dlogF -ErrorAction SilentlyContinue).Count }
        $al = Join-Path $proj 'agent.log'
        if (Test-Path $al) {
            $hbStale  = @(Select-String -Path $al -Pattern 'Cleaned up stale state' -ErrorAction SilentlyContinue).Count
        }
        $frameF = Join-Path $proj 'bots\_supervisor\frame.jpg'
        $hbFrame = -1; if (Test-Path $frameF) { $hbFrame = [int]((Get-Date) - (Get-Item $frameF).LastWriteTime).TotalSeconds }
        $bedF = Join-Path $proj 'bots\_supervisor\bed.json'
        $hbBed = 'N'; if (Test-Path $bedF) { $hbBed = 'Y' }
        $progLast = ''; if (Test-Path $progFile) { $progLast = ((Get-Content $progFile -Tail 1 -ErrorAction SilentlyContinue) -replace '^\[[^\]]*\]\s*', '') }
        if ($progLast.Length -gt 50) { $progLast = $progLast.Substring(0, 50) }
        # ── VITALS hard metrics (pos/dim/hp/food/hostiles/skill/inv + nether-mission milestones) ──
        $vitF = Join-Path $proj 'bots\_supervisor\vitals.json'
        $vit = $null; $vitFresh = $false; $vitStr = ''; $invTotal = -1
        if (Test-Path $vitF) { try { $vit = Get-Content $vitF -Raw -ErrorAction Stop | ConvertFrom-Json } catch {} }
        if ($vit -and $vit.ts) {
            $vitAge = [int](([DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds() - [double]$vit.ts) / 1000)
            $vitFresh = ($vitAge -ge -60 -and $vitAge -lt 90)
            $invTotal = 0; $dia = 0; $obs = 0; $ipick = 0; $fns = 0
            try {
                foreach ($pp in $vit.inv.PSObject.Properties) { $invTotal += [int]$pp.Value }
                $dia = [int]$vit.inv.diamond; $obs = [int]$vit.inv.obsidian
                $ipick = [int]$vit.inv.iron_pickaxe; $fns = [int]$vit.inv.flint_and_steel
            } catch {}
            $dimS = ("" + $vit.dim) -replace 'minecraft:', ''
            $vitStr = " pos={0},{1},{2} dim={3} hp={4} food={5} host={6} skill={7} mob={8} inv={9} ms=ip{10}/d{11}/o{12}/f{13}" -f $vit.x, $vit.y, $vit.z, $dimS, $vit.hp, $vit.food, $vit.hostiles, $vit.skill, $vit.mob, $invTotal, $ipick, $dia, $obs, $fns
        }
        $hbLine = "[{0}] up={1} err={2}s frame={3}s deaths={4} stale={5} bed={6}{7} | {8}" -f (Get-Date -Format 'MM-dd HH:mm'), $hbUp, [int]$errAge, $hbFrame, $hbDeaths, $hbStale, $hbBed, $vitStr, $progLast
        Add-Content (Join-Path $proj 'heartbeat.log') $hbLine
        if (($tick % 4) -eq 0) {
            Add-Content $log ("[{0}] heartbeat up={1} err={2}s deaths={3}{4}" -f (Get-Date -Format o), $hbUp, [int]$errAge, $hbDeaths, $vitStr)
        }
        $prevStale = $hbStale   # 记录本轮 stale 计数,供下一轮 wedge "新增"判断(agent restart 会截断 agent.log→归0→自然跟随)
        # ── STUCK DETECTION v2: ANCHORED WINDOW (process alive but task dead) ──
        # v1 compared ADJACENT ticks (moved<3) — a bot jittering ±2 blocks (door-probe
        # hops, raw-walk bounces) reset the counter forever, and a 6-block-radius
        # entrapment sat invisible for HOURS (the cliff-hole incident: user found it
        # before the watchdog did). v2 anchors a reference point and asks: has the bot
        # EVER been >10 blocks from it in the last 30 min? Jitter can't fake that.
        if ($hbUp -eq 1 -and $vitFresh) {
            $nowT = Get-Date
            if ($null -eq $lastVitPos) {
                $lastVitPos = @([double]$vit.x, [double]$vit.y, [double]$vit.z); $script:anchorT = $nowT; $script:anchorAlerted = $false
            } else {
                $dx = [double]$vit.x - $lastVitPos[0]; $dy = [double]$vit.y - $lastVitPos[1]; $dz = [double]$vit.z - $lastVitPos[2]
                $dev = [math]::Sqrt($dx * $dx + $dy * $dy + $dz * $dz)
                if ($dev -gt 10) {
                    # escaped the anchor radius — re-anchor here, all clear
                    $lastVitPos = @([double]$vit.x, [double]$vit.y, [double]$vit.z); $script:anchorT = $nowT; $script:anchorAlerted = $false
                } else {
                    $nightHold = $false
                    try {
                        $todN = [int]$vit.tod
                        $nightHold = ($todN -ge 13000 -and $todN -le 23000 -and ("" + $vit.skill) -eq 'missionNether' -and $progLast -match 'NIGHT|入夜|hole up|蹲')
                    } catch {}
                    $noRegenHold = $false
                    $sealedBodyBudgetHold = $false
                    $lowFoodNightShelterHold = $false
                    $tableRecoveryHold = $false
                    $killBoxLowFoodHold = $false
                    try {
                        $normalFood = $false
                        foreach ($pp in $vit.inv.PSObject.Properties) {
                            if ([int]$pp.Value -gt 0 -and $pp.Name -match 'cooked_|_bread|^bread$|apple|carrot|potato|beef|porkchop|chicken|mutton|cod|salmon|melon_slice|sweet_berries|_stew|rabbit|baked_') {
                                $normalFood = $true
                                break
                            }
                        }
                        $advSealed = $false
                        $advFresh = $false
                        $advActionable = 999
                        $advF = Join-Path $proj 'bots\_supervisor\advisory.json'
                        if (Test-Path $advF) {
                            try {
                                $adv = Get-Content $advF -Raw -ErrorAction Stop | ConvertFrom-Json
                                $advAge = [int](([DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds() - [double]$adv.ts) / 1000)
                                $advFresh = ($advAge -ge -60 -and $advAge -lt 45)
                                $advSealed = ($advFresh -and $adv.sealedBodyBudgetHold -eq $true)
                                try { $advActionable = [int]$adv.actionableHostiles } catch {}
                            } catch {}
                        }
                        $mobContained = ("" + $vit.mob) -match 'ENC|POCKET|MAROONED|ENTOMBED'
                        $sealedBodyBudgetHold = (("" + $vit.skill) -eq 'missionNether' -and [double]$vit.hp -le 8 -and [int]$vit.food -le 6 -and -not $normalFood -and ($mobContained -or $advSealed))
                        $noRegenHold = (("" + $vit.skill) -eq 'missionNether' -and [double]$vit.hp -lt 14 -and [int]$vit.food -lt 18 -and -not $normalFood -and [int]$vit.hostiles -eq 0 -and $progLast -match 'low-hp/no-food|HUNGER/LOWHP|BREAKOUT gated: no-regen|SKIP torch kit')
                        $progTailText = ''
                        try {
                            if (Test-Path $progFile) {
                                $progTailText = ((Get-Content $progFile -Tail 12 -ErrorAction Stop) -join "`n")
                            }
                        } catch {}
                        $lowFoodNightShelterHold = (("" + $vit.skill) -eq 'missionNether' -and [int]$vit.food -le 6 -and [double]$vit.hp -ge 10 -and -not $normalFood -and [int]$vit.hostiles -eq 0 -and $mobContained -and $progTailText -match 'HUNGRY/LOWHP .*night|famine-night gate|BREAKOUT gated: prepNether low-food hold evidence|inside cluster but night\+covered|dug-in bunker SEALED')
                        $killBoxLowFoodHold = (("" + $vit.skill) -eq 'missionNether' -and [int]$vit.food -le 6 -and [double]$vit.hp -ge 10 -and -not $normalFood -and $mobContained -and $progTailText -match 'KILL-BOX gated: low-food pocket recovery' -and (($advFresh -and $advActionable -eq 0) -or [int]$vit.hostiles -eq 0))
                        $tableRecoveryHold = (("" + $vit.skill) -eq 'missionNether' -and [double]$vit.hp -ge 14 -and [int]$vit.food -ge 14 -and [int]$vit.hostiles -eq 0 -and $progTailText -match 'TABLE gate for|TABLE recovery for')
                    } catch {}
                    if ($nightHold -or $noRegenHold -or $sealedBodyBudgetHold -or $lowFoodNightShelterHold -or $killBoxLowFoodHold -or $tableRecoveryHold) {
                        # Legit sheltering / no-regen stand-down is intentionally stationary;
                        # don't convert it into a cancel/restart event. Re-anchor so the 25min
                        # restart path is also suppressed while the protected hold remains fresh.
                        # Keep flowing to loop bookkeeping/sleep; a continue here makes the
                        # watchdog look stale and can tight-loop during a valid body-budget hold.
                        $lastVitPos = @([double]$vit.x, [double]$vit.y, [double]$vit.z); $script:anchorT = $nowT; $script:anchorAlerted = $false
                    } else {
                        $stuckMin = ($nowT - $script:anchorT).TotalMinutes
                        if ($stuckMin -ge 10 -and -not $script:anchorAlerted) {
                            $script:anchorAlerted = $true
                            Add-Content (Join-Path $proj 'ALERTS.txt') ("[{0}] STUCK-ZONE: bot within 10b of {1},{2},{3} for {4:n0}min (skill={5} hp={6} food={7}) - ENTRAPMENT?" -f (Get-Date -Format 'MM-dd HH:mm:ss'), $lastVitPos[0], $lastVitPos[1], $lastVitPos[2], $stuckMin, $vit.skill, $vit.hp, $vit.food)
                            Send-Control 'cancel_skill' ("STUCK-ZONE within 10b for " + [int]$stuckMin + "min")
                        }
                        if ($stuckMin -ge 25) {
                            $lastVitPos = $null
                            Restart-Agent ("STUCK-ZONE - bot pinned within 10b for 25min at " + $vit.x + "," + $vit.y + "," + $vit.z)
                        }
                    }
                }
            }
        } else { $lastVitPos = $null }
        # ── DEATH SPIRAL alert (+4 deaths inside a ~10min window) ──
        $tick++
        if ($deathAnchor -lt 0 -or ($tick - $deathAnchorTick) -ge 20) { $deathAnchor = $hbDeaths; $deathAnchorTick = $tick }
        elseif (($hbDeaths - $deathAnchor) -ge 4 -and ($tick - $lastSpiralAlertTick) -gt 30) {
            $lastSpiralAlertTick = $tick
            Add-Content (Join-Path $proj 'ALERTS.txt') ("[{0}] DEATH SPIRAL: +{1} deaths in <10min (now {2})" -f (Get-Date -Format 'MM-dd HH:mm:ss'), ($hbDeaths - $deathAnchor), $hbDeaths)
            Send-Control 'cancel_skill' ("DEATH SPIRAL +" + ($hbDeaths - $deathAnchor) + " deaths")
        }
        # ── LOG ROTATION (hourly; unbounded files kill a 24h+ unattended run) ──
        if ($tick % 120 -eq 1) {
            foreach ($spec in @(@('bots\_supervisor\progress.txt', 20MB), @('bots\_supervisor\events.log', 50MB), @('bots\_supervisor\vitals.jsonl', 30MB), @('agent.err', 50MB))) {
                $rf = Join-Path $proj $spec[0]
                if ((Test-Path $rf) -and ((Get-Item $rf).Length -gt $spec[1])) {
                    $old = "$rf.1"
                    if (Test-Path $old) { Remove-Item $old -Force -ErrorAction SilentlyContinue }
                    try { Move-Item $rf $old -Force } catch { try { Copy-Item $rf $old -Force; Clear-Content $rf } catch {} }
                }
            }
            $hbF = Join-Path $proj 'heartbeat.log'
            if ((Test-Path $hbF) -and ((Get-Item $hbF).Length -gt 5MB)) {
                $keep = Get-Content $hbF -Tail 2000; Set-Content $hbF $keep
            }
            $framesD = Join-Path $proj 'bots\_supervisor\frames'
            if (Test-Path $framesD) {
                Get-ChildItem $framesD -File -ErrorAction SilentlyContinue | Where-Object { $_.LastWriteTime -lt (Get-Date).AddHours(-48) } | Remove-Item -Force -ErrorAction SilentlyContinue
            }
        }
    } catch {}
    Start-Sleep -Seconds 30
}
