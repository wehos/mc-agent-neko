const settings = {
    "minecraft_version": "auto", // or specific version like "1.21.6"
    "host": "localhost", // or "localhost", "your.ip.address.here"
    "port": 55916, // set to -1 to automatically scan for open ports (LAN port changes each time the world is reopened)
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

    "load_memory": false, // load memory from previous session
    "init_message": "", // sends to all on spawn
    "only_chat_with": ["admin"], // users that the bots listen to and send general messages to. if empty it will chat publicly

    "speak": false,
    // allows all bots to speak through text-to-speech. 
    // specify speech model inside each profile with format: {provider}/{model}/{voice}.
    // if set to "system" it will use basic system text-to-speech. 
    // Works on windows and mac, but linux requires you to install the espeak package through your package manager eg: `apt install espeak` `pacman -S espeak`.

    "chat_ingame": false, // bot responses are shown in minecraft chat
    "language": "en", // translate to/from this language. Supports these language names: https://cloud.google.com/translate/docs/languages
    "render_bot_view": false, // show bot's view in browser at localhost:3000, 3001...

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
