const settings = {
    "minecraft_version": "auto", // or specific version like "1.21.6"
    "host": "localhost", // or "localhost", "your.ip.address.here"
    // ★2026-07-06 session#5 (用户 11:05 裁定): 专用服务器时代结束 — 回连用户自开的客户端 LAN
    // 世界「新的世界」, 端口 55916 显式钉死 (用户在场肉眼监督, 不再 -1 扫描/不再 25565)。
    // 注意: LAN 世界无 RCON (oracle-daemon 已在 watchdog 停用); keepInventory 仅作死亡/跑坟语义观测。
    "port": 55916,
    "auth": "offline", // or "microsoft"
    "player_username": "", // real in-game name of the human owner the bot follows/serves. empty = auto-detect LAN host / single-player owner at runtime

    // the mindserver manages all agents and hosts the UI
    "mindserver_port": 8765,
    "auto_open_ui": false, // opens UI in browser on startup

    "base_profile": "assistant", // survival, assistant, creative, or god_mode
    "profiles": [
        "./neko.json",
        // "./profiles/gpt.json",
        // "./profiles/claude.json",
        // "./profiles/gemini.json",
        // "./profiles/llama.json",
        // "./profiles/qwen.json",
        // "./profiles/grok.json",
        // "./profiles/mistral.json",
        // "./profiles/deepseek.json",
        // "./profiles/mercury.json",
        // "./profiles/andy-4.json", // Supports up to 75 messages!

        // using more than 1 profile requires you to /msg each bot indivually
        // individual profiles override values from the base profile
    ],

    // 模型的「思考模式」总开关。"off" 关掉思考、"low" 少想一点、"auto" 随模型自己的默认。
    // 默认关：游戏机器人要的是快速动作，不是长篇推理；而且不少模型会把思考过程直接
    // 倒进正文里，混进 !command 解析会把动作解析坏掉。
    // 角色配置（profile）里写了同名字段的话，以角色配置为准。
    "thinking": "off",

    "load_memory": false, // load memory from previous session
    "init_message": "", // sends to all on spawn
    // ★2026-09-09 用户实测「在游戏里 @neko 她不理我」的根因：这里原本是 ["admin"]。
    //   agent.js:121 的入站闸是 `only_chat_with.length > 0 && !includes(username) → return`，
    //   也就是**只听一个叫 admin 的玩家**；而玩家的真实 ID 当然不叫 admin，于是他在游戏里
    //   说的每一句话都在所有闸门之前被丢掉，连日志都不留（查起来极难：零 chat 痕迹）。
    //   出站同理 —— agent.js:1343 会把回复 whisper 给 "admin" 这个不存在的人，等于石沉大海。
    //   这是开发机的遗留配置，分发给玩家必然是死的。空数组 = 听所有人、公开发言；
    //   真要限制听谁，用 chat_whitelist（面板「游戏连接」页暴露的就是它，语义不重叠）。
    "only_chat_with": [], // 空 = 听所有真人玩家并公开发言; 非空 = 只听这些人且只私聊他们
    // ★2026-07-14 用户令: 游戏内 chat 指令前缀 + 白名单 (根治 admin 指令风暴)。带 chat_command_prefix 或
    //   ! 开头 = 指令 (adminMission 高优先级); 其余真人聊天节流聚合转发外部 admin llm。前缀设空 = 关闭前缀门。
    "chat_command_prefix": "@neko", // 指令前缀; "" = 关闭 (回旧行为: 所有真人消息都当指令)
    // ★2026-09-09 用户实测: 前缀**绝不能用 "/" 开头** —— Minecraft 客户端会把 / 开头的输入
    //   当成游戏内置命令拦下来, 消息根本不会进聊天频道, bot 一个字都收不到(表现: 在游戏里
    //   怎么喊都没反应, 且日志里连一条 chat 事件都没有)。历史默认值是 "/neko", 全程失效。
    "chat_whitelist": [],           // 允许其消息被处理的玩家名单; [] = 所有真人玩家

    "speak": false,
    // allows all bots to speak through text-to-speech. 
    // specify speech model inside each profile with format: {provider}/{model}/{voice}.
    // if set to "system" it will use basic system text-to-speech. 
    // Works on windows and mac, but linux requires you to install the espeak package through your package manager eg: `apt install espeak` `pacman -S espeak`.

    // 配套改 true：只有它开着 bot 的回复才会出现在游戏聊天里。默认 false 时玩家在游戏里
    //   跟她说话，她会照做但一声不吭 —— 对"AI 伙伴"这个产品形态来说体验是断的。
    "chat_ingame": true, // bot 的回复显示在 Minecraft 聊天框里
    "language": "en", // translate to/from this language. Supports these language names: https://cloud.google.com/translate/docs/languages
    "render_bot_view": false, // show bot's view in browser at localhost:3000, 3001...
    "viewer_type": "prismarine", // "modern" enables the optional Minecraft 1.20.6 renderer
    "viewer_port": 3000, // each additional agent uses the next port
    "modern_viewer_assets_dir": "", // generated assets; see docs/modern-viewer.md
    "modern_viewer_lan_address": "", // optional local IPv4 address for subnet-only viewing
    "modern_viewer_lan_prefix": 24,
    "modern_viewer_max_sessions": 8, // shared across local/LAN pages and all viewpoints (1-16)
    "modern_viewer_self_skin": "", // optional local 64x64 PNG for this bot's browser avatar
    "modern_viewer_self_skin_model": "slim", // "slim" or "classic"

    "allow_insecure_coding": true, // allows newAction command and model can write/run code on your computer. enable at own risk
    "allow_vision": true, // allows vision model to interpret screenshots (enables !lookAtPlayer/!lookAtPosition's real vision path; vision_model falls back to chat_model when not explicitly set in profile)
    // `!restart` and `!stfu` blocked: the mc LLM has been observed entering a
    // self-restart loop where every incoming task is answered with `!restart`,
    // which triggers cleanKill → process exit → parent spawns a fresh agent →
    // it inherits the same history and emits `!restart` again. Blocking the
    // command removes it from the doc set the LLM sees, so the loop can't be
    // re-entered. `!stfu` blocked for the same shape (silences self).
    "blocked_actions": ["!checkBlueprint", "!checkBlueprintLevel", "!getBlueprint", "!getBlueprintLevel", "!restart", "!stfu"], // commands to disable and remove from docs. Ex: ["!setMode"]
    "code_timeout_mins": -1, // minutes code is allowed to run. -1 for no timeout
    "relevant_docs_count": 5, // number of relevant code function docs to select for prompting. -1 for all

    "max_messages": 15, // max number of messages to keep in context
    "num_examples": 2, // number of examples to give to the model
    "max_commands": -1, // max number of commands that can be used in consecutive responses. -1 for no limit
    "show_command_syntax": "full", // "full", "shortened", or "none"
    "narrate_behavior": true, // chat simple automatic actions ('Picking up item!')
    "chat_bot_messages": false, // publicly chat messages to other bots

    "spawn_timeout": 30, // num seconds allowed for the bot to spawn before throwing error. Increase when spawning takes a while.
    "block_place_delay": 50, // delay between placing blocks (ms) if using newAction. helps avoid bot being kicked by anti-cheat mechanisms on servers.

    "log_all_prompts": false, // log ALL prompts to file
};

export default settings;
