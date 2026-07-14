import * as skills from '../library/skills.js';
import settings from '../settings.js';
import convoManager from '../conversation.js';


// The portal/WS path injects incoming chat as if it came from a synthetic
// "admin" user (see ws_server.injectMessage), but "admin" is never a real
// in-game entity. The LLM echoes that name straight into player-targeting
// commands like !goToPlayer, which then can't find anyone. Resolve the
// intended *human* player before handing the name to a skill:
//   1. the requested name, if the server actually knows it
//   2. settings.player_username, if configured and currently online
//      (authoritative override set in the portal)
//   3. best-effort auto-detect: the lone human in the tablist — the LAN
//      host / single-player owner — excluding the bot and sibling agents.
//      This is the common one-human-one-bot setup.
//   4. the configured name even if not currently visible, so a far-away
//      owner yields "Could not find <owner>" rather than a confusing miss
//      on "admin".
function resolveHumanPlayerName(agent, requested) {
    const bot = agent.bot;
    if (requested && bot.players[requested])
        return requested;

    const configured = (settings.player_username || '').trim();
    if (configured && bot.players[configured])
        return configured;

    const siblingAgents = new Set(convoManager.getInGameAgents());
    const humans = Object.keys(bot.players).filter(
        name => name !== bot.username && !siblingAgents.has(name)
    );
    if (humans.length === 1)
        return humans[0];

    if (configured)
        return configured;
    return requested;
}


function runAsAction (actionFn, resume = false, timeout = -1) {
    let actionLabel = null;  // Will be set on first use
    
    const wrappedAction = async function (agent, ...args) {
        // Set actionLabel only once, when the action is first created
        if (!actionLabel) {
            const actionObj = actionsList.find(a => a.perform === wrappedAction);
            actionLabel = actionObj.name.substring(1); // Remove the ! prefix
        }

        const actionFnWithAgent = async () => {
            await actionFn(agent, ...args);
        };
        const code_return = await agent.actions.runAction(`action:${actionLabel}`, actionFnWithAgent, { timeout, resume });
        if (code_return.interrupted && !code_return.timedout)
            return;
        return code_return.message;
    }

    return wrappedAction;
}

// ★!runSkill arg decoding — turns the flat arg string the chat parser can carry (it cannot
//   carry JSON: no inner quotes allowed) into the argv for customSkill, VALIDATED against the
//   skill's catalog entry ({sig, params, paramNames, takesObject, trailingObject, hasRest}
//   from skill_library). Returns { argv, note? } on success or { error } — an error means the
//   call was NOT dispatched (dispatching a known-mis-bound call just burns the exclusive
//   action slot on a silent NaN no-op; reviewers confirmed live cases).
//   Encodings:
//     ""              → no args
//     key=val;key=val → keys map onto the signature's named slots (works for positional and
//                       options-object skills alike); ',' also accepted as a pair separator
//                       (the #1 observed mis-encoding); unmatched keys ride in the trailing
//                       opts={} param when the signature has one; if ALL keys are unknown and
//                       the first param is required (no default), the keys are passed as an
//                       object-shaped first argument (e.g. achieve's goal accepts {item,count})
//     v1,v2           → positional values in order; interior empty slots become undefined so
//                       the skill's own default applies (no left-shift); trailing empties drop
export function decodeRunSkillArgs(entry, raw) {   // exported for tests
    // Coerce one token: number, true/false (any case), null/undefined, else trimmed string.
    const cast = (s) => {
        const v = String(s).trim();
        if (/^-?\d+(\.\d+)?$/.test(v)) return Number(v);
        if (/^true$/i.test(v)) return true;
        if (/^false$/i.test(v)) return false;
        if (/^null$/i.test(v)) return null;
        if (/^undefined$/i.test(v)) return undefined;
        return v;
    };
    if (raw === '') return { argv: [] };
    const sigKnown = entry.sig != null;
    if (sigKnown && entry.sig === '') {
        // No-arg skill given args: run it anyway (the intent — run this skill — is clear),
        // but say so; silently ignoring taught the model its args "worked".
        return { argv: [], note: `Note: '${entry.name}' takes no args — ignored "${raw}".` };
    }

    if (raw.includes('=')) {
        // named mode — key=val pairs, ';' or ',' separated
        const kvs = [];
        const bare = [];
        for (const seg of raw.split(/[;,]/)) {
            const t = seg.trim();
            if (!t) continue;
            const i = t.indexOf('=');          // split on the FIRST '=' (values may contain '=')
            if (i <= 0) { bare.push(t); continue; }
            kvs.push([t.slice(0, i).trim(), cast(t.slice(i + 1))]);
        }
        if (bare.length) {
            return { error: `Bad args for '${entry.name}': segment(s) without key= — ${bare.join(' | ')}. `
                + `Write EVERY arg as key=val, e.g. !runSkill("${entry.name}", "${entry.paramNames?.[0] || 'key'}=..."). `
                + `Signature: ${entry.name}(${entry.sig ?? 'unknown'}). Nothing was run.` };
        }
        const toObj = () => { const o = {}; for (const [k, v] of kvs) o[k] = v; return o; };
        if (!sigKnown)
            return { argv: [toObj()], note: `Note: '${entry.name}' signature is unknown — passed your keys as one options object.` };
        if (entry.takesObject)
            return { argv: [toObj()] };
        // Positional/mixed signature: map keys onto named slots.
        const slots = new Array(entry.paramNames.length).fill(undefined);
        const extras = {};
        let extraCount = 0;
        for (const [k, v] of kvs) {
            const idx = entry.paramNames.indexOf(k);
            if (idx >= 0) slots[idx] = v;
            else { extras[k] = v; extraCount++; }
        }
        if (extraCount) {
            if (entry.trailingObject && slots[slots.length - 1] === undefined) {
                slots[slots.length - 1] = extras;   // extra keys ride in the trailing opts={}
            } else if (extraCount === kvs.length && entry.params.length && !entry.params[0].includes('=')) {
                // ALL keys unknown + first param required: object-shaped first argument.
                return { argv: [extras], note: `Note: passed your keys as one object to '${entry.paramNames[0]}' — they match none of (${entry.sig}).` };
            } else {
                return { error: `Unknown key(s) for '${entry.name}': ${Object.keys(extras).join(', ')}. `
                    + `Valid params: ${entry.paramNames.join(', ')}. Signature: ${entry.name}(${entry.sig}). Nothing was run.` };
            }
        }
        while (slots.length && slots[slots.length - 1] === undefined) slots.pop();   // let defaults apply
        return { argv: slots };
    }

    // positional mode
    if (sigKnown && entry.takesObject) {
        return { error: `'${entry.name}' takes a single options object — use key=val, e.g. `
            + `!runSkill("${entry.name}", "key=value"). Signature: ${entry.name}(${entry.sig}). Nothing was run.` };
    }
    const parts = raw.split(',').map(s => s.trim());
    while (parts.length && parts[parts.length - 1] === '') parts.pop();
    let values = parts.map(p => (p === '' ? undefined : cast(p)));
    let note;
    if (sigKnown && !entry.hasRest && values.length > entry.paramNames.length) {
        const extra = values.slice(entry.paramNames.length);
        values = values.slice(0, entry.paramNames.length);
        note = `Note: dropped extra positional value(s) ${extra.map(v => String(v)).join(', ')} — '${entry.name}' takes (${entry.sig}).`;
    }
    return { argv: values, note };
}

export const actionsList = [
    {
        name: '!newAction',
        description: 'Perform new and unknown custom behaviors that are not available as a command.', 
        params: {
            'prompt': { type: 'string', description: 'A natural language prompt to guide code generation. Make a detailed step-by-step plan.' }
        },
        perform: async function(agent, prompt) {
            // just ignore prompt - it is now in context in chat history
            if (!settings.allow_insecure_coding) { 
                agent.openChat('newAction is disabled. Enable with allow_insecure_coding=true in settings.js');
                return "newAction not allowed! Code writing is disabled in settings. Notify the user.";
            }
            let result = "";
            const actionFn = async () => {
                try {
                    result = await agent.coder.generateCode(agent.history);
                } catch (e) {
                    result = 'Error generating code: ' + e.toString();
                }
            };
            await agent.actions.runAction('action:newAction', actionFn, {timeout: settings.code_timeout_mins});
            return result;
        }
    },
    {
        name: '!stop',
        description: 'Force stop all actions and commands that are currently executing.',
        perform: async function (agent) {
            await agent.actions.stop();
            agent.clearBotLogs();
            agent.actions.cancelResume();
            agent.bot.emit('idle');
            let msg = 'Agent stopped.';
            if (agent.self_prompter.isActive())
                msg += ' Self-prompting still active.';
            return msg;
        }
    },
    {
        name: '!vetoInstinct',
        description: 'VETO an executing instinct (e.g. go_to_bed_sleep) — it stops NOW and stays suppressed for the rest of this trigger cycle (e.g. this night), re-arming only when the trigger lapses. Use when an instinct is acting but you judge it wrong right now (a reflex notified you "[本能] ...执行中"). SPECIAL: name "march" (or "mobility"/"marooned") releases the MAROONED road-march that suppresses navigation ("goToPosition/goToGoal suppressed: MAROONED") — use it when you are locally free (open ground, has exits) but movement is stuck being "occupied" by the march; it hands control back to the task layer for ~90s.',
        params: {
            'name': { type: 'string', description: 'instinct name to veto, e.g. "go_to_bed_sleep"; or "march"/"mobility" to release a MAROONED movement lock' },
            'reason': { type: 'string', description: 'short reason for the veto' }
        },
        perform: async function (agent, name, reason) {
            try {
                const fw = await import('../framework/index.js');
                fw.instinct.vetoInstinct(agent.bot, name, reason || 'llm-veto');
                try { if (agent.bot.interrupt_code !== undefined) agent.bot.interrupt_code = true; } catch (e) {}
                // ★MARCH RELEASE: vetoInstinct set bot._maroonedVetoUntil; flip the broadcast state to FREE
                // NOW so the very next goToPosition/goToGoal isn't blocked for up to the mobility mode's 2s
                // re-eval. The mobility mode keeps it FREE while the veto window is live (modes.js FREE branch).
                const isMarch = /^(march|mobility|marooned)$/i.test(String(name || ''));
                if (isMarch) {
                    try {
                        const b = agent.bot;
                        if (b._mobility && b._mobility.state === 'MAROONED') b._mobility = { ...b._mobility, state: 'FREE', since: Date.now() };
                        b._marchDir = null; b._marchFails = 0; b._maroonedMarchOrigin = null;
                        try { b.pathfinder && b.pathfinder.setGoal && b.pathfinder.setGoal(null); } catch (e) {}
                        try { b.clearControlStates && b.clearControlStates(); } catch (e) {}
                    } catch (e) {}
                    return `Released MAROONED march (${reason || 'no reason'}) — navigation handed back to the task layer for ~90s. Path now.`;
                }
                return `Vetoed instinct '${name}' for this cycle (${reason || 'no reason'}).`;
            } catch (e) { return `Veto failed: ${e && e.message || e}`; }
        }
    },
    {
        name: '!stfu',
        description: 'Stop all chatting and self prompting, but continue current action.',
        perform: async function (agent) {
            agent.openChat('Shutting up.');
            agent.shutUp();
            return;
        }
    },
    {
        name: '!restart',
        description: 'Restart the agent process.',
        perform: async function (agent) {
            agent.cleanKill();
        }
    },
    {
        name: '!clearChat',
        description: 'Clear the chat history.',
        perform: async function (agent) {
            agent.history.clear();
            return agent.name + "'s chat history was cleared, starting new conversation from scratch.";
        }
    },
    {
        name: '!goToPlayer',
        description: 'Go to the given player.',
        params: {
            'player_name': {type: 'string', description: 'The name of the player to go to.'},
            'closeness': {type: 'float', description: 'How close to get to the player.', domain: [0, Infinity]}
        },
        perform: runAsAction(async (agent, player_name, closeness) => {
            player_name = resolveHumanPlayerName(agent, player_name);
            await skills.goToPlayer(agent.bot, player_name, closeness);
        })
    },
    {
        name: '!followPlayer',
        description: 'Endlessly follow the given player.',
        params: {
            'player_name': {type: 'string', description: 'name of the player to follow.'},
            'follow_dist': {type: 'float', description: 'The distance to follow from.', domain: [0, Infinity]}
        },
        perform: runAsAction(async (agent, player_name, follow_dist) => {
            player_name = resolveHumanPlayerName(agent, player_name);
            await skills.followPlayer(agent.bot, player_name, follow_dist);
        }, true)
    },
    {
        name: '!goToCoordinates',
        description: 'Go to the given x, y, z location.',
        params: {
            'x': {type: 'float', description: 'The x coordinate.', domain: [-Infinity, Infinity]},
            'y': {type: 'float', description: 'The y coordinate.', domain: [-64, 320]},
            'z': {type: 'float', description: 'The z coordinate.', domain: [-Infinity, Infinity]},
            'closeness': {type: 'float', description: 'How close to get to the location.', domain: [0, Infinity]}
        },
        perform: runAsAction(async (agent, x, y, z, closeness) => {
            await skills.goToPosition(agent.bot, x, y, z, closeness);
        })
    },
    {
        name: '!searchForBlock',
        description: 'Find and go to the nearest block of a given type in a given range.',
        params: {
            'type': { type: 'BlockName', description: 'The block type to go to.' },
            'search_range': { type: 'float', description: 'The range to search for the block. Minimum 32, maximum 256.', domain: [10, 256] }
        },
        perform: runAsAction(async (agent, block_type, range) => {
            if (range < 32) {
                skills.log(agent.bot, `Minimum search range is 32.`);
                range = 32;
            }
            await skills.goToNearestBlock(agent.bot, block_type, 4, range);
        })
    },
    {
        name: '!searchForEntity',
        description: 'Find and go to the nearest entity of a given type in a given range.',
        params: {
            'type': { type: 'string', description: 'The type of entity to go to.' },
            'search_range': { type: 'float', description: 'The range to search for the entity. Maximum 256.', domain: [32, 256] }
        },
        perform: runAsAction(async (agent, entity_type, range) => {
            await skills.goToNearestEntity(agent.bot, entity_type, 4, range);
        })
    },
    {
        name: '!moveAway',
        description: 'Move away from the current location in any direction by a given distance.',
        params: {'distance': { type: 'float', description: 'The distance to move away.', domain: [0, Infinity] }},
        perform: runAsAction(async (agent, distance) => {
            await skills.moveAway(agent.bot, distance);
        })
    },
    {
        name: '!rememberHere',
        description: 'Save the current location with a given name.',
        params: {'name': { type: 'string', description: 'The name to remember the location as.' }},
        perform: async function (agent, name) {
            const pos = agent.bot.entity.position;
            agent.memory_bank.rememberPlace(name, pos.x, pos.y, pos.z);
            return `Location saved as "${name}".`;
        }
    },
    {
        name: '!goToRememberedPlace',
        description: 'Go to a saved location.',
        params: {'name': { type: 'string', description: 'The name of the location to go to.' }},
        perform: runAsAction(async (agent, name) => {
            const pos = agent.memory_bank.recallPlace(name);
            if (!pos) {
            skills.log(agent.bot, `No location named "${name}" saved.`);
            return;
            }
            await skills.goToPosition(agent.bot, pos[0], pos[1], pos[2], 1);
        })
    },
    {
        name: '!givePlayer',
        description: 'Give the specified item to the given player.',
        params: { 
            'player_name': { type: 'string', description: 'The name of the player to give the item to.' }, 
            'item_name': { type: 'ItemName', description: 'The name of the item to give.' },
            'num': { type: 'int', description: 'The number of items to give.', domain: [1, Number.MAX_SAFE_INTEGER] }
        },
        perform: runAsAction(async (agent, player_name, item_name, num) => {
            player_name = resolveHumanPlayerName(agent, player_name);
            await skills.giveToPlayer(agent.bot, item_name, player_name, num);
        })
    },
    {
        name: '!consume',
        description: 'Eat/drink the given item.',
        params: {'item_name': { type: 'ItemName', description: 'The name of the item to consume.' }},
        perform: runAsAction(async (agent, item_name) => {
            await skills.consume(agent.bot, item_name);
        })
    },
    {
        name: '!equip',
        description: 'Equip the given item.',
        params: {'item_name': { type: 'ItemName', description: 'The name of the item to equip.' }},
        perform: runAsAction(async (agent, item_name) => {
            await skills.equip(agent.bot, item_name);
        })
    },
    {
        name: '!putInChest',
        description: 'Put the given item in the nearest chest.',
        params: {
            'item_name': { type: 'ItemName', description: 'The name of the item to put in the chest.' },
            'num': { type: 'int', description: 'The number of items to put in the chest.', domain: [1, Number.MAX_SAFE_INTEGER] }
        },
        perform: runAsAction(async (agent, item_name, num) => {
            await skills.putInChest(agent.bot, item_name, num);
        })
    },
    {
        name: '!takeFromChest',
        description: 'Take the given items from the nearest chest.',
        params: {
            'item_name': { type: 'ItemName', description: 'The name of the item to take.' },
            'num': { type: 'int', description: 'The number of items to take.', domain: [1, Number.MAX_SAFE_INTEGER] }
        },
        perform: runAsAction(async (agent, item_name, num) => {
            await skills.takeFromChest(agent.bot, item_name, num);
        })
    },
    {
        name: '!viewChest',
        description: 'View the items/counts of the nearest chest.',
        params: { },
        perform: runAsAction(async (agent) => {
            await skills.viewChest(agent.bot);
        })
    },
    {
        name: '!discard',
        description: 'Discard the given item from the inventory for good (tosses it into nearby low ground or a freshly dug pit so it cannot be picked back up).',
        params: {
            'item_name': { type: 'ItemName', description: 'The name of the item to discard.' },
            'num': { type: 'int', description: 'The number of items to discard.', domain: [1, Number.MAX_SAFE_INTEGER] }
        },
        perform: runAsAction(async (agent, item_name, num) => {
            await skills.discardAway(agent.bot, item_name, num);
        })
    },
    {
        name: '!collectBlocks',
        description: 'Collect the nearest blocks of a given type.',
        params: {
            'type': { type: 'BlockName', description: 'The block type to collect.' },
            'num': { type: 'int', description: 'The number of blocks to collect.', domain: [1, Number.MAX_SAFE_INTEGER] }
        },
        perform: runAsAction(async (agent, type, num) => {
            await skills.collectBlock(agent.bot, type, num);
        }, false, 10) // 10 minute timeout
    },
    // ★2026-07-07 用户令: 提升内部 gpt-5.4-mini 的行动力 —— 把成量的监督技能(mineOres/chopWood/feedUp)
    //   包成命令给它, 这样"mine iron"能贯彻到底(挖到缓冲, 而非 !collectBlocks 那样 collect 1 就收工)。
    //   走 customSkill(=run_skill 同一入口), 由 runAsAction 纳入 ActionManager, admin 回合独占期内运行。
    {
        name: '!mineOres',
        description: 'Mine a target ore to a healthy STOCKPILE — automatically descends to the correct depth band, tunnels, and collects until it has a useful buffer (NOT just one). ALWAYS prefer this over !collectBlocks for "mine iron/coal/gold/copper/diamonds": !collectBlocks only grabs a fixed count and will not go find the ore underground.',
        params: {
            'ore': { type: 'string', description: 'one of: iron, coal, gold, copper, diamonds' }
        },
        perform: runAsAction(async (agent, ore) => {
            await skills.customSkill(agent.bot, 'mineOres', { ore: String(ore || 'iron').toLowerCase().trim() });
        }, false, 10) // 10 minute timeout
    },
    {
        name: '!getWood',
        description: 'Find trees and chop wood until you have the requested number of logs (locates trees, paths to them, fells them, and collects the drops). Prefer this over !collectBlocks for gathering wood.',
        params: {
            'num': { type: 'int', description: 'number of logs to gather', domain: [1, 512] }
        },
        perform: runAsAction(async (agent, num) => {
            await skills.customSkill(agent.bot, 'chopWood', Math.max(1, parseInt(num) || 8));
        }, false, 10) // 10 minute timeout
    },
    {
        name: '!getFood',
        description: 'Solve hunger: forage, hunt animals, or eat stocked food until the food bar reaches the target level. Use whenever hungry or told to eat / get food.',
        params: {
            'target_food': { type: 'int', description: 'food level to reach (1-20), default 18', domain: [1, 20] }
        },
        perform: runAsAction(async (agent, target_food) => {
            // ★2026-07-09 用户令「食物本能熔断」: MC_FOOD_INSTINCTS 关(默认)时 !getFood 不再派 feedUp
            //   主动觅食/捕猎(那正是"接指令就乱逛"的来源)。背包已有食物由 auto-eat 插件自动吃, 无需主动觅食。
            //   恢复原行为: MC_FOOD_INSTINCTS=1。见 contracts.foodInstinctsEnabled / docs/food-instincts-disabled.md。
            if (process.env.MC_FOOD_INSTINCTS !== '1') {
                return 'Food instincts disabled (MC_FOOD_INSTINCTS off): not foraging/hunting; auto-eat handles any food already in the bag.';
            }
            await skills.customSkill(agent.bot, 'feedUp', Math.max(1, Math.min(20, parseInt(target_food) || 18)));
        }, false, 10) // 10 minute timeout
    },
    {
        name: '!smeltIron',
        description: 'Smelt raw iron into iron ingots at a furnace (places/uses a furnace + fuel automatically). Use after mining iron, or when told to smelt iron.',
        params: {
            'num': { type: 'int', description: 'how many raw_iron to smelt', domain: [1, 128, '[]'] }
        },
        perform: runAsAction(async (agent, num) => {
            await skills.customSkill(agent.bot, 'smeltSafe', 'raw_iron', Math.max(1, parseInt(num) || 1));
        }, false, 30) // ★2026-07-14: 等炼完 (10s/件, 128 件≈22min) — 10min 超时会把长炉次拦腰打断
    },
    {
        name: '!digDownTo',
        description: 'Safely dig straight down to a target Y level with hazard checks (avoids dropping into lava/caves). Use for "dig down to the iron/diamond layer" — iron≈y14, diamond≈y-54.',
        params: {
            'y': { type: 'int', description: 'target Y level to reach', domain: [-63, 320] }
        },
        perform: runAsAction(async (agent, y) => {
            await skills.customSkill(agent.bot, 'mineDown', { targetY: parseInt(y) });
        }, false, 10)
    },
    // ★2026-07-13 generic entry into the CUSTOM SKILLS catalog. The named commands above
    //   (!mineOres/!getWood/…) only cover a handful of skills; most tested procedures
    //   (realNetherPortal/branchMine/bankGear/setBed/slayDragon/…) had no one-liner and the
    //   model had to hand-roll them inside !newAction. !runSkill reaches ANY allowlisted skill
    //   in one line. Design points (post-review 2026-07-14):
    //   • name/args are validated BEFORE agent.actions.runAction — an unknown name or a
    //     known-wrong-shape call returns a corrective message WITHOUT interrupting whatever
    //     action is in flight (validating inside the action fn made every typo a free !stop).
    //   • key=val args are MAPPED onto the signature's named slots (skill_library provides
    //     params/paramNames), so "targetY=-54" works on positional skills, and extra keys ride
    //     in a trailing opts={} param (mixed sigs like chopWood(count, opts) are expressible).
    //     Undecodable calls are REJECTED with the correct form — never dispatched mis-bound.
    //   • 30-min timeout: still a hang-stop backstop, but roomy enough for the long-horizon
    //     skills the catalog steers to (slayDragon/realNetherPortal/setupEndPortal) — 10min
    //     cut those off mid-run while the discouraged !newAction path ran unlimited.
    {
        name: '!runSkill',
        description: 'Run one of the tested CUSTOM SKILLS from the CUSTOM SKILLS catalog (the catalog lists names, signatures, and the args encoding). STRONGLY prefer this over !newAction whenever the catalog has the skill. args: "" if the skill takes none; otherwise prefer "key=val;key=val" matching the signature\'s param names. No JSON, no quotes inside args.',
        params: {
            'name': { type: 'string', description: 'exact skill name from the CUSTOM SKILLS catalog, e.g. "realNetherPortal", "mineOres", "branchMine".' },
            'args': { type: 'string', description: 'encoded arguments per the catalog\'s encoding rules. Use "" for a skill that takes no args.' }
        },
        perform: async function (agent, name, args) {
            name = String(name).trim();
            const lib = agent.prompter?.skill_libary;
            if (!lib) return 'Skill catalog unavailable (agent still starting?). Try again.';
            const entry = lib.getRunnableSkillEntry(name);
            if (!entry) {
                const names = [...lib.getRunnableSkillNames()].sort().join(', ');
                return `Unknown or non-runnable skill '${name}'. Available: ${names}`;
            }
            // The parser already stripped the outer quotes, so `args` is the raw inner string.
            const decoded = decodeRunSkillArgs(entry, String(args == null ? '' : args).trim());
            if (decoded.error) return decoded.error;   // reject before touching the ActionManager

            const actionFn = async () => {
                await skills.customSkill(agent.bot, name, ...decoded.argv);
            };
            const code_return = await agent.actions.runAction('action:runSkill', actionFn, { timeout: 30 });
            if (code_return.interrupted && !code_return.timedout)
                return;
            return (decoded.note ? decoded.note + '\n' : '') + code_return.message;
        }
    },
    {
        name: '!goSleep',
        description: 'Go to a known bed (or place one) and sleep through the night to skip it. Use at night or when told to sleep.',
        params: {},
        perform: runAsAction(async (agent) => {
            await skills.customSkill(agent.bot, 'goBedSleep');
        }, false, 5)
    },
    {
        name: '!getArmor',
        description: 'Craft and equip a set of armor (smelts iron first if needed). Use when told to gear up / make armor.',
        params: {
            'tier': { type: 'string', description: 'iron or diamond (default iron)' }
        },
        perform: runAsAction(async (agent, tier) => {
            const t = String(tier || 'iron').toLowerCase().includes('dia') ? 'diamond' : 'iron';
            await skills.customSkill(agent.bot, 'craftArmor', { tier: t });
        }, false, 10)
    },
    {
        name: '!craftRecipe',
        description: 'Craft the given recipe a given number of times.',
        params: {
            'recipe_name': { type: 'ItemName', description: 'The name of the output item to craft.' },
            'num': { type: 'int', description: 'The number of times to craft the recipe. This is NOT the number of output items, as it may craft many more items depending on the recipe.', domain: [1, Number.MAX_SAFE_INTEGER] }
        },
        perform: runAsAction(async (agent, recipe_name, num) => {
            await skills.craftRecipe(agent.bot, recipe_name, num);
        })
    },
    {
        name: '!smeltItem',
        description: 'Smelt the given item the given number of times.',
        params: {
            'item_name': { type: 'ItemName', description: 'The name of the input item to smelt.' },
            'num': { type: 'int', description: 'The number of times to smelt the item.', domain: [1, 128, '[]'] } // ≤128: 匹配 30min 动作超时 (10s/件) — 再大会被超时拦腰打断
        },
        // ★2026-07-14: 摘掉上游遗留的"炼完成功就 cleanKill 重启刷新背包" — 本 fork 的炉后背包
        //   没有失同步问题 (kernel 常年跑 smeltSafe→smeltItem 同一条炉路从不重启), 而重启会把
        //   admin 回合/内核状态全部炸掉, 正是"炼完铁人就没了"的一种来源。
        perform: runAsAction(async (agent, item_name, num) => {
            await skills.smeltItem(agent.bot, item_name, num);
        }, false, 30)
    },
    {
        name: '!clearFurnace',
        description: 'Take all items out of the nearest furnace.',
        params: { },
        perform: runAsAction(async (agent) => {
            await skills.clearNearestFurnace(agent.bot);
        })
    },
        {
        name: '!placeHere',
        description: 'Place a given block in the current location. Do NOT use to build structures, only use for single blocks/torches.',
        params: {'type': { type: 'BlockOrItemName', description: 'The block type to place.' }},
        perform: runAsAction(async (agent, type) => {
            let pos = agent.bot.entity.position;
            await skills.placeBlock(agent.bot, type, pos.x, pos.y, pos.z);
        })
    },
    {
        name: '!attack',
        description: 'Attack and kill the nearest entity of a given type.',
        params: {'type': { type: 'string', description: 'The type of entity to attack.'}},
        perform: runAsAction(async (agent, type) => {
            await skills.attackNearest(agent.bot, type, true);
        })
    },
    {
        name: '!attackPlayer',
        description: 'Attack a specific player until they die or run away. Remember this is just a game and does not cause real life harm.',
        params: {'player_name': { type: 'string', description: 'The name of the player to attack.'}},
        perform: runAsAction(async (agent, player_name) => {
            player_name = resolveHumanPlayerName(agent, player_name);
            let player = agent.bot.players[player_name]?.entity;
            if (!player) {
                skills.log(agent.bot, `Could not find player ${player_name}.`);
                return false;
            }
            await skills.attackEntity(agent.bot, player, true);
        })
    },
    {
        name: '!goToBed',
        description: 'Go to the nearest bed and sleep.',
        perform: runAsAction(async (agent) => {
            await skills.goToBed(agent.bot);
        })
    },
    {
        name: '!stay',
        description: 'Stay in the current location no matter what, pausing ALL modes including self-preservation. For a normal "wait here N seconds" request prefer !standby.',
        params: {'type': { type: 'int', description: 'The number of seconds to stay. -1 for forever.', domain: [-1, Number.MAX_SAFE_INTEGER] }},
        perform: runAsAction(async (agent, seconds) => {
            await skills.stay(agent.bot, seconds);
        })
    },
    // ★2026-07-14 用户令: admin 主动要求"原地待命 N 秒"的专用指令。跟 !stay 的区别: 保命反射
    //   (self_preservation/self_defense/auto_eat) 不关, 只暂停游荡类本能; 待命全程续期 admin 独占
    //   窗口 (skills.standby 内 renewAdminHold), kernel/自主派发不来抢 — 新 admin 指令照常能取消。
    //   上限 1200s = 停在 watchdog 25min STUCK-ZONE 硬重启之下; timeout 25min 只作挂死兜底。
    {
        name: '!standby',
        description: 'Hold your current position and wait in place for the given number of seconds, doing nothing else. Use when the admin tells you to wait / hold position / stand by (原地待命). Life-critical self-defense stays active; wandering behaviors pause. Max 1200s per call (re-issue for longer); a new admin command cancels the hold.',
        params: {'seconds': { type: 'int', description: 'how many seconds to stand by (max 1200)', domain: [1, 1200, '[]'] }},
        perform: runAsAction(async (agent, seconds) => {
            await skills.standby(agent.bot, seconds);
        }, false, 25)
    },
    {
        name: '!setMode',
        description: 'Set a mode to on or off. A mode is an automatic behavior that constantly checks and responds to the environment.',
        params: {
            'mode_name': { type: 'string', description: 'The name of the mode to enable.' },
            'on': { type: 'boolean', description: 'Whether to enable or disable the mode.' }
        },
        perform: async function (agent, mode_name, on) {
            const modes = agent.bot.modes;
            if (!modes.exists(mode_name))
            return `Mode ${mode_name} does not exist.` + modes.getDocs();
            if (modes.isOn(mode_name) === on)
            return `Mode ${mode_name} is already ${on ? 'on' : 'off'}.`;
            modes.setOn(mode_name, on);
            return `Mode ${mode_name} is now ${on ? 'on' : 'off'}.`;
        }
    },
    {
        name: '!goal',
        description: 'Set a goal prompt to endlessly work towards with continuous self-prompting.',
        params: {
            'selfPrompt': { type: 'string', description: 'The goal prompt.' },
        },
        perform: async function (agent, prompt) {
            // ★2026-07-07 ADMIN MISSION owns the shared self_prompter singleton while active — don't
            //   fork a second goal on top of it (it would race the mission for the loop/body).
            if (agent._missionEnabled && agent.adminMission && agent.adminMission.isActive()) {
                return 'An admin task is already in progress; ignoring !goal.';
            }
            if (convoManager.inConversation()) {
                agent.self_prompter.setPromptPaused(prompt);
            }
            else {
                agent.self_prompter.start(prompt);
            }
        }
    },
    {
        name: '!endGoal',
        description: 'Call when you have accomplished your goal / assigned task. It will stop self-prompting and the current action. ',
        perform: async function (agent) {
            // ★2026-07-07 ADMIN MISSION: this is the DONE signal. End the mission (fires exactly one
            //   task_finished status=ok). Falls back to legacy self-prompt stop for a plain !goal.
            if (agent._missionEnabled && agent.adminMission && agent.adminMission.isActive()) {
                await agent.adminMission.end('done');
                return 'Mission complete.';
            }
            agent.self_prompter.stop();
            return 'Self-prompting stopped.';
        }
    },
    {
        name: '!cannotComplete',
        description: 'Call ONLY when the current assigned task is genuinely impossible to complete (e.g. a required resource does not exist anywhere reachable, or a needed tool cannot be obtained). Reports failure with your reason and stops. Do NOT use this for a task that is merely slow or hard.',
        params: {
            'reason': { type: 'string', description: 'A short reason why the task cannot be completed.' },
        },
        perform: async function (agent, reason) {
            // ★2026-07-07 ADMIN MISSION: the IMPOSSIBLE signal. End the mission (task_finished status=failed).
            if (agent._missionEnabled && agent.adminMission && agent.adminMission.isActive()) {
                await agent.adminMission.end('impossible', reason);
                return 'Marked the task as impossible.';
            }
            if (agent.self_prompter && !agent.self_prompter.isStopped()) agent.self_prompter.stop();
            return 'No active task.';
        }
    },
    {
        name: '!showVillagerTrades',
        description: 'Show trades of a specified villager.',
        params: {'id': { type: 'int', description: 'The id number of the villager that you want to trade with.' }},
        perform: runAsAction(async (agent, id) => {
            await skills.showVillagerTrades(agent.bot, id);
        })
    },
    {
        name: '!tradeWithVillager',
        description: 'Trade with a specified villager.',
        params: {
            'id': { type: 'int', description: 'The id number of the villager that you want to trade with.' },
            'index': { type: 'int', description: 'The index of the trade you want executed (1-indexed).', domain: [1, Number.MAX_SAFE_INTEGER] },
            'count': { type: 'int', description: 'How many times that trade should be executed.', domain: [1, Number.MAX_SAFE_INTEGER] },
        },
        perform: runAsAction(async (agent, id, index, count) => {
            await skills.tradeWithVillager(agent.bot, id, index, count);
        })
    },
    {
        name: '!startConversation',
        description: 'Start a conversation with a bot. (FOR OTHER BOTS ONLY)',
        params: {
            'player_name': { type: 'string', description: 'The name of the player to send the message to.' },
            'message': { type: 'string', description: 'The message to send.' },
        },
        perform: async function (agent, player_name, message) {
            if (!convoManager.isOtherAgent(player_name))
                return player_name + ' is not a bot, cannot start conversation.';
            if (convoManager.inConversation() && !convoManager.inConversation(player_name)) 
                convoManager.forceEndCurrentConversation();
            else if (convoManager.inConversation(player_name))
                agent.history.add('system', 'You are already in conversation with ' + player_name + '. Don\'t use this command to talk to them.');
            convoManager.startConversation(player_name, message);
        }
    },
    {
        name: '!endConversation',
        description: 'End the conversation with the given bot. (FOR OTHER BOTS ONLY)',
        params: {
            'player_name': { type: 'string', description: 'The name of the player to end the conversation with.' }
        },
        perform: async function (agent, player_name) {
            if (!convoManager.inConversation(player_name))
                return `Not in conversation with ${player_name}.`;
            convoManager.endConversation(player_name);
            return `Converstaion with ${player_name} ended.`;
        }
    },
    {
        name: '!lookAtPlayer',
        description: 'Look at a player or look in the same direction as the player.',
        params: {
            'player_name': { type: 'string', description: 'Name of the target player' },
            'direction': {
                type: 'string',
                description: 'How to look ("at": look at the player, "with": look in the same direction as the player)',
            }
        },
        perform: async function(agent, player_name, direction) {
            if (direction !== 'at' && direction !== 'with') {
                return "Invalid direction. Use 'at' or 'with'.";
            }
            player_name = resolveHumanPlayerName(agent, player_name);
            let result = "";
            const actionFn = async () => {
                result = await agent.vision_interpreter.lookAtPlayer(player_name, direction);
            };
            await agent.actions.runAction('action:lookAtPlayer', actionFn);
            return result;
        }
    },
    {
        name: '!lookAtPosition',
        description: 'Look at specified coordinates.',
        params: {
            'x': { type: 'int', description: 'x coordinate' },
            'y': { type: 'int', description: 'y coordinate' },
            'z': { type: 'int', description: 'z coordinate' }
        },
        perform: async function(agent, x, y, z) {
            let result = "";
            const actionFn = async () => {
                result = await agent.vision_interpreter.lookAtPosition(x, y, z);
            };
            await agent.actions.runAction('action:lookAtPosition', actionFn);
            return result;
        }
    },
    {
        name: '!digDown',
        description: 'Digs down a specified distance. Will stop if it reaches lava, water, or a fall of >=4 blocks below the bot.',
        params: {'distance': { type: 'int', description: 'Distance to dig down', domain: [1, Number.MAX_SAFE_INTEGER] }},
        perform: runAsAction(async (agent, distance) => {
            await skills.digDown(agent.bot, distance)
        })
    },
    {
        name: '!goToSurface',
        description: 'Moves the bot to the highest block above it (usually the surface).',
        params: {},
        perform: runAsAction(async (agent) => {
            await skills.goToSurface(agent.bot);
        })
    },
    {
        name: '!pillarUp',
        description: 'Pillar straight up IN PLACE: stand where you are and jump-and-place blocks under your feet, over and over, until you run out of blocks (or reach an optional target Y). Does NOT walk anywhere or pathfind — the atomic "climb out RIGHT HERE" action. Works in dry pits and flooded water columns. Requires placeable full blocks (dirt, cobblestone, terracotta, etc.) in inventory.',
        params: {
            'target_y': { type: 'int', description: 'The Y level to climb to. Use -1 to pillar in place until blocks run out.', domain: [-1, 320] }
        },
        perform: runAsAction(async (agent, target_y) => {
            await skills.pillarUp(agent.bot, (target_y == null || target_y < 0) ? null : target_y);
        })
    },
    {
        name: '!useOn',
        description: 'Use (right click) the given tool on the nearest target of the given type.',
        params: {
            'tool_name': { type: 'string', description: 'Name of the tool to use, or "hand" for no tool.' },
            'target': { type: 'string', description: 'The target as an entity type, block type, or "nothing" for no target.' }
        },
        perform: runAsAction(async (agent, tool_name, target) => {
            await skills.useToolOn(agent.bot, tool_name, target);
        })
    },
];
