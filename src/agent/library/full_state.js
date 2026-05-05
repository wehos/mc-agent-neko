import { 
    getPosition,
    getBiomeName,
    getNearbyPlayerNames,
    getInventoryCounts,
    getNearbyEntityTypes,
    getBlockAtPosition,
    getFirstBlockAboveHead
} from "./world.js";
import convoManager from '../conversation.js';

// Cache for expensive operations
const stateCache = new Map();
const CACHE_TTL = 300; // Cache for 300ms (aggressive)

// Async version - non-blocking
export async function getFullStateAsync(agent, useCache = true) {
    const bot = agent.bot;
    
    // Try to use cached state for expensive operations
    const now = Date.now();
    let cachedData = null;
    
    if (useCache && stateCache.has(agent.name)) {
        const cached = stateCache.get(agent.name);
        if (now - cached.timestamp < CACHE_TTL) {
            cachedData = cached.data;
        } else {
            stateCache.delete(agent.name);
        }
    }

    // Check if bot is in a valid state
    const isDead = !bot.entity || bot.health === 0;
    
    // Yield to event loop before position calculation
    await Promise.resolve();
    
    const pos = getPosition(bot);
    const position = {
        x: Number(pos.x.toFixed(2)),
        y: Number(pos.y.toFixed(2)),
        z: Number(pos.z.toFixed(2))
    };

    let weather = 'Clear';
    if (bot.thunderState > 0) weather = 'Thunderstorm';
    else if (bot.rainState > 0) weather = 'Rain';

    let timeLabel = 'Night';
    if (bot.time && bot.time.timeOfDay < 6000) timeLabel = 'Morning';
    else if (bot.time && bot.time.timeOfDay < 12000) timeLabel = 'Afternoon';

    // Use cached expensive operations if available
    let players, entityTypes;
    if (cachedData) {
        players = cachedData.players;
        entityTypes = cachedData.entityTypes;
    } else {
        // Yield before expensive operations
        await Promise.resolve();
        
        // Expensive operations - execute async to allow event loop breathing
        try {
            // Break into chunks with yields
            players = isDead ? [] : await new Promise(resolve => {
                setImmediate(() => {
                    try {
                        const p = getNearbyPlayerNames(bot);
                        const bots = convoManager.getInGameAgents().filter(b => b !== agent.name);
                        resolve(p.filter(player => !bots.includes(player)));
                    } catch (err) {
                        resolve([]);
                    }
                });
            });
            
            await Promise.resolve();
            
            entityTypes = isDead ? [] : await new Promise(resolve => {
                setImmediate(() => {
                    try {
                        const entities = getNearbyEntityTypes(bot).filter(t => t !== 'player' && t !== 'item');
                        resolve(entities);
                    } catch (err) {
                        resolve([]);
                    }
                });
            });
            
            // Cache these expensive results
            stateCache.set(agent.name, {
                timestamp: now,
                data: { players, entityTypes }
            });
        } catch (error) {
            console.warn(`[${agent.name}] Error in expensive state operations:`, error.message);
            players = [];
            entityTypes = [];
        }
    }

    // Fast block queries - with error handling
    let below = 'unknown', legs = 'unknown', head = 'unknown';
    try {
        if (!isDead) {
            below = getBlockAtPosition(bot, 0, -1, 0).name;
            legs = getBlockAtPosition(bot, 0, 0, 0).name;
            head = getBlockAtPosition(bot, 0, 1, 0).name;
        }
    } catch (error) {
        // Silent fail - blocks may not be loaded
    }

    // Check if inventory is ready before accessing slots
    const inventoryReady = bot.inventory && bot.inventory.slots;
    const helmet = inventoryReady ? bot.inventory.slots[5] : null;
    const chestplate = inventoryReady ? bot.inventory.slots[6] : null;
    const leggings = inventoryReady ? bot.inventory.slots[7] : null;
    const boots = inventoryReady ? bot.inventory.slots[8] : null;

    const state = {
        name: agent.name,
        isDead,
        gameplay: {
            position,
            dimension: bot.game?.dimension || 'unknown',
            gamemode: bot.game?.gameMode || 'unknown',
            health: Math.round(bot.health || 0),
            hunger: Math.round(bot.food || 0),
            biome: isDead ? 'unknown' : (cachedData?.biome || getBiomeName(bot)),
            weather,
            timeOfDay: bot.time?.timeOfDay || 0,
            timeLabel
        },
        action: {
            current: isDead ? 'Dead' : (agent.isIdle() ? 'Idle' : agent.actions.currentActionLabel),
            isIdle: agent.isIdle()
        },
        surroundings: {
            below,
            legs,
            head,
            firstBlockAboveHead: isDead ? 'unknown' : 'air' // Skip expensive operation
        },
        inventory: {
            counts: getInventoryCounts(bot),
            stacksUsed: inventoryReady ? bot.inventory.items().length : 0,
            totalSlots: inventoryReady ? bot.inventory.slots.length : 0,
            equipment: {
                helmet: helmet ? helmet.name : null,
                chestplate: chestplate ? chestplate.name : null,
                leggings: leggings ? leggings.name : null,
                boots: boots ? boots.name : null,
                mainHand: bot.heldItem ? bot.heldItem.name : null
            }
        },
        nearby: {
            humanPlayers: players,
            botPlayers: convoManager.getInGameAgents().filter(b => b !== agent.name),
            entityTypes: entityTypes,
        },
        modes: {
            summary: bot.modes?.getMiniDocs() || []
        }
    };

    return state;
}

// Sync version - kept for backward compatibility
export function getFullState(agent, useCache = true) {
    const bot = agent.bot;
    
    // Try to use cached state for expensive operations
    const now = Date.now();
    let cachedData = null;
    
    if (useCache && stateCache.has(agent.name)) {
        const cached = stateCache.get(agent.name);
        if (now - cached.timestamp < CACHE_TTL) {
            cachedData = cached.data;
        } else {
            stateCache.delete(agent.name);
        }
    }

    // Check if bot is in a valid state
    const isDead = !bot.entity || bot.health === 0;
    
    const pos = getPosition(bot);
    const position = {
        x: Number(pos.x.toFixed(2)),
        y: Number(pos.y.toFixed(2)),
        z: Number(pos.z.toFixed(2))
    };

    let weather = 'Clear';
    if (bot.thunderState > 0) weather = 'Thunderstorm';
    else if (bot.rainState > 0) weather = 'Rain';

    let timeLabel = 'Night';
    if (bot.time && bot.time.timeOfDay < 6000) timeLabel = 'Morning';
    else if (bot.time && bot.time.timeOfDay < 12000) timeLabel = 'Afternoon';

    // Use cached expensive operations if available
    let players, entityTypes;
    if (cachedData) {
        players = cachedData.players;
        entityTypes = cachedData.entityTypes;
    } else {
        // Expensive operations - only execute if not cached
        try {
            players = isDead ? [] : getNearbyPlayerNames(bot);
            let bots = convoManager.getInGameAgents().filter(b => b !== agent.name);
            players = players.filter(p => !bots.includes(p));
            
            entityTypes = isDead ? [] : getNearbyEntityTypes(bot).filter(t => t !== 'player' && t !== 'item');
            
            // Cache these expensive results
            stateCache.set(agent.name, {
                timestamp: now,
                data: { players, entityTypes }
            });
        } catch (error) {
            console.warn(`[${agent.name}] Error in expensive state operations:`, error.message);
            players = [];
            entityTypes = [];
        }
    }

    // Fast block queries - with error handling
    let below = 'unknown', legs = 'unknown', head = 'unknown';
    try {
        if (!isDead) {
            below = getBlockAtPosition(bot, 0, -1, 0).name;
            legs = getBlockAtPosition(bot, 0, 0, 0).name;
            head = getBlockAtPosition(bot, 0, 1, 0).name;
        }
    } catch (error) {
        // Silent fail - blocks may not be loaded
    }

    const helmet = bot.inventory.slots[5];
    const chestplate = bot.inventory.slots[6];
    const leggings = bot.inventory.slots[7];
    const boots = bot.inventory.slots[8];

    const state = {
        name: agent.name,
        isDead,  // Add death status
        gameplay: {
            position,
            dimension: bot.game?.dimension || 'unknown',
            gamemode: bot.game?.gameMode || 'unknown',
            health: Math.round(bot.health || 0),
            hunger: Math.round(bot.food || 0),
            biome: isDead ? 'unknown' : (cachedData?.biome || getBiomeName(bot)),
            weather,
            timeOfDay: bot.time?.timeOfDay || 0,
            timeLabel
        },
        action: {
            current: isDead ? 'Dead' : (agent.isIdle() ? 'Idle' : agent.actions.currentActionLabel),
            isIdle: agent.isIdle()
        },
        surroundings: {
            below,
            legs,
            head,
            firstBlockAboveHead: isDead ? 'unknown' : 'air' // Skip expensive operation
        },
        inventory: {
            counts: getInventoryCounts(bot),
            stacksUsed: bot.inventory.items().length,
            totalSlots: bot.inventory.slots.length,
            equipment: {
                helmet: helmet ? helmet.name : null,
                chestplate: chestplate ? chestplate.name : null,
                leggings: leggings ? leggings.name : null,
                boots: boots ? boots.name : null,
                mainHand: bot.heldItem ? bot.heldItem.name : null
            }
        },
        nearby: {
            humanPlayers: players,
            botPlayers: convoManager.getInGameAgents().filter(b => b !== agent.name),
            entityTypes: entityTypes,
        },
        modes: {
            summary: bot.modes?.getMiniDocs() || []
        }
    };

    return state;
}

// Clean up old cache entries periodically
setInterval(() => {
    const now = Date.now();
    for (const [key, value] of stateCache.entries()) {
        if (now - value.timestamp > CACHE_TTL * 2) {
            stateCache.delete(key);
        }
    }
}, 5000); // Clean every 5 seconds