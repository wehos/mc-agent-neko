/**
 * devTool — hot-loaded DEV harness to manually fire a single framework v2 tool
 * on demand, so a human can WATCH it work in-game (validation, not mock).
 * See docs/framework-v2-plan.md §0 (working method) + memory validation-not-mock.
 *
 * Fire it via bots/_supervisor/dev_trigger.mjs (WS run_skill devTool <toolName> [args]).
 * Run main.js WITHOUT the bridge so no sticky missionNether holds the lock.
 *
 * Signature: (bot, ctx, toolName, ...args)
 */
export default async function devTool(bot, ctx, toolName, ...args) {
    const log = (m) => { try { ctx.log(bot, m); } catch (e) { try { console.log(m); } catch (_) {} } };
    log(`[devTool] ▶ fire ${toolName}(${args.join(', ')})`);
    let tools;
    try {
        tools = await import('../../../src/agent/framework/tools/index.js');
    } catch (e) {
        log(`[devTool] ✗ failed to load framework tools: ${e.message}`);
        return { ok: false, error: String(e.message) };
    }
    const prog = (m) => log(m);
    try {
        let res;
        switch (toolName) {
            case 'sealBunker':
                res = await tools.sealBunker(bot, { log: prog });
                break;
            case 'clutchWater':
                res = await tools.clutchWater(bot, { log: prog });
                break;
            case 'retractWater':
                res = await tools.retractWater(bot, prog);
                break;
            case 'placeUnderFeet':
                res = await tools.placeUnderFeet(bot, args[0] || 'dirt', { log: prog });
                break;
            case 'pillarUp':
                res = await tools.pillarUp(bot, args[0] ? Number(args[0]) : null, { log: prog });
                break;
            // predicates (read-only, just report)
            case 'safeToDigDown':
                res = tools.safeToDigDown(bot);
                break;
            case 'canClutchWater':
                res = tools.canClutchWater(bot);
                break;
            case 'fallImminent':
                res = tools.fallImminent(bot);
                break;
            case 'list':
                res = (tools.TOOL_CATALOG || []).map(t => `${t.name}[${t.lane}]`);
                break;
            default:
                log(`[devTool] ✗ unknown tool '${toolName}'. Known: sealBunker, clutchWater, retractWater, placeUnderFeet, pillarUp, safeToDigDown, canClutchWater, fallImminent, list`);
                return { ok: false, error: `unknown tool ${toolName}` };
        }
        log(`[devTool] ✓ ${toolName} → ${JSON.stringify(res)}`);
        return { ok: true, tool: toolName, result: res };
    } catch (e) {
        log(`[devTool] ✗ ${toolName} threw: ${e && e.message}`);
        return { ok: false, error: String(e && e.message || e) };
    }
}
