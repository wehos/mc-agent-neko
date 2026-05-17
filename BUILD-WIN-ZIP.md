# 构建并分发 mc-agent Windows zip

> 给打包 / 分发任务的接手人：本文档是一个**自包含的指令**。读完按步骤跑，最后产出一个 zip 文件，上传到三个网盘。除了本目录的源码外不依赖其它仓库或外部知识。

## 背景（必读）

mc-agent 是 Node.js 写的独立程序，跟 N.E.K.O. 主程序通过 WebSocket 通信（默认 `ws://localhost:48909`）。**两者解耦分发**——N.E.K.O. 安装包不带 mc-agent，玩 Minecraft 的用户从网盘下载本 zip 自己运行。

最终产物：一个 `mc-agent-win-vX.Y.Z.zip`，解压后用户**双击 `启动mc-agent.bat` 即可运行**，不需要装 Node / npm / Visual Studio Build Tools。

## 产出布局

```
mc-agent-win-vX.Y.Z/
├── node/
│   └── node-v20.11.1-win-x64/
│       ├── node.exe
│       ├── npm.cmd
│       └── ...
├── src/
│   ├── main.js
│   ├── settings.js
│   ├── andy.json
│   ├── package.json
│   ├── node_modules/        ← 已预装，arch 对的上 win-x64
│   └── ...
└── 启动mc-agent.bat
```

## 构建步骤

**前提**：在 Windows 上构建（不能 cross-compile，mineflayer / canvas / prismarine-viewer 有 win-x64 prebuilt native binary，wrong arch 就跑不起来）。

打开 PowerShell，cd 到一个空目录（不要在源 repo 内），跑：

```powershell
$ErrorActionPreference = "Stop"

$VERSION   = "0.1.0"                                          # ← 调
$SRC_REPO  = "C:\Users\wehos\Project\mc-agent-upstream-sync"  # ← 调
$OUT_NAME  = "mc-agent-win-v$VERSION"
$NODE_VER  = "v20.11.1"
$NODE_DIST = "node-$NODE_VER-win-x64"

# 1. 清空 + 建目录
if (Test-Path $OUT_NAME) { Remove-Item -Recurse -Force $OUT_NAME }
New-Item -ItemType Directory -Path "$OUT_NAME/node", "$OUT_NAME/src" | Out-Null

# 2. portable Node
$nodeZip = "$NODE_DIST.zip"
curl.exe -L "https://nodejs.org/dist/$NODE_VER/$nodeZip" -o $nodeZip
Expand-Archive $nodeZip -DestinationPath "$OUT_NAME/node" -Force
Remove-Item $nodeZip

# 3. 复制源码（去掉 .git / node_modules / tests / 评估 harness 等大件）
$EXCLUDE = @('.git', '.github', 'node_modules', 'tests', 'tasks', 'experiments',
             'wandb', 'code_records', 'logs', '.claude', '.codex', '__pycache__',
             'BUILD-WIN-ZIP.md')
$srcDest = "$OUT_NAME/src"
robocopy $SRC_REPO $srcDest /E /XD ($EXCLUDE | %{ Join-Path $SRC_REPO $_ }) /XF *.pyc /NFL /NDL /NJH /NJS | Out-Null

# 4. npm ci --omit=dev（用刚下的 portable Node）
$env:PATH = "$PWD\$OUT_NAME\node\$NODE_DIST;" + $env:PATH
Push-Location $srcDest
& "$PWD\..\node\$NODE_DIST\npm.cmd" ci --omit=dev
Pop-Location

# 5. 写启动 bat（UTF-8 with BOM 避免中文文件名乱码）
$BAT_BODY = @"
@echo off
chcp 65001 >nul 2>&1
echo Starting mc-agent...
echo (close this window or Ctrl+C to stop)
echo.
"%~dp0node\$NODE_DIST\node.exe" "%~dp0src\main.js"
pause
"@
[System.IO.File]::WriteAllText("$PWD\$OUT_NAME\启动mc-agent.bat", $BAT_BODY, (New-Object System.Text.UTF8Encoding $true))

# 6. 打包成 zip
Compress-Archive -Path $OUT_NAME -DestinationPath "$OUT_NAME.zip" -CompressionLevel Optimal -Force

Write-Host ""
Write-Host "==> Built: $OUT_NAME.zip"
Write-Host "Size: $((Get-Item "$OUT_NAME.zip").Length / 1MB) MB"
```

整个过程预计 **5-10 分钟**（npm ci 拖 prebuilt 占大头）。

预期 zip 大小 **~200 MB**（portable Node ~50MB + node_modules ~150MB + src ~10MB）。

## 验证产物

解压到一个干净目录，双击 `启动mc-agent.bat`：

1. 应该开一个黑色 console 窗口
2. 几秒内打出 `WebSocket server started on ws://0.0.0.0:48909`
3. 如果同机已经跑了 N.E.K.O. 且启用了 game_agent_minecraft 插件，N.E.K.O. 那边会自动连上

如果 bat 启动后窗口闪退，把 `node ... main.js` 那行末尾的 `pause` 临时改成 `cmd /k` 跑一次抓错。常见原因：node_modules 没装全（重新 `npm ci`）、Node 版本过老（v18 LTS 或 v20 LTS 才稳，v24+ 已知挂）。

## 上传

把生成的 `mc-agent-win-vX.Y.Z.zip` 上传到三个网盘的对应目录：

- 夸克网盘：<https://pan.quark.cn/s/b662424f7f34>
- Google Drive：<https://drive.google.com/drive/folders/1DSx_y1MsTEvc5ljsjURNJ0aP1ax3RoN-?usp=drive_link>
- 百度网盘（提取码 `kuro`）：<https://pan.baidu.com/s/1i_a6IUQDz-GpEaWGvIcnqw?pwd=kuro>

文件名建议：`mc-agent-win-v0.1.0.zip`（或带日期：`mc-agent-win-20260517.zip`）。

旧版本不要立刻删——保留至少 1-2 个旧版本以防新版有 bug 需要 rollback。

## N.E.K.O. 侧的契合点

用户从网盘下载 zip → 解压到任意位置 → 双击 `启动mc-agent.bat`。N.E.K.O. 主程序里 `game_agent_minecraft` 插件的快速开始页（plugin/plugins/game_agent_minecraft/surfaces/quickstart.tsx）会探测 `ws://localhost:48909` 自动显示连接状态、给用户跳转 mindserver 管理面板（默认 `:8765`）的入口。

**默认端口不要改**——主程序写死 48909 作为 plugin ws_url，改了用户连不上。如果将来要改，要同步改 plugin/plugins/game_agent_minecraft/plugin.toml 的 `ws_url` 字段。

## 后续维护

- mc-agent 源代码改了 → 重跑整个 build 流程产新 zip → 替换网盘里的旧版本
- Node 版本升级（v20.11.1 → 新 LTS）→ 改 `$NODE_VER` 后重跑
- 加新 native 依赖 → 验证 prebuilt binary 在 win-x64 上有，npm ci 不报错
