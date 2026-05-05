import { io } from 'socket.io-client';
import convoManager from './conversation.js';
import { setSettings } from './settings.js';
import { getFullState, getFullStateAsync } from './library/full_state.js';
import PerformanceMonitor from './library/performance_monitor.js';

// agent's individual connection to the mindserver
// always connect to localhost

class MindServerProxy {
    constructor() {
        if (MindServerProxy.instance) {
            return MindServerProxy.instance;
        }
        
        this.socket = null;
        this.connected = false;
        this.agents = [];
        this.reconnectAttempts = 0;
        this.maxReconnectAttempts = 3;
        this.reconnecting = false;
        MindServerProxy.instance = this;
    }

    async connect(name, port) {
        if (this.connected) return;
        
        this.name = name;
        this.port = port;
        
        // Configure Socket.IO client - optimized for fast async operations
        this.socket = io(`http://localhost:${port}`, {
            reconnection: true,          // Enable auto-reconnection
            reconnectionAttempts: Infinity, // Keep trying to reconnect
            reconnectionDelay: 500,      // Start with 500ms delay (faster)
            reconnectionDelayMax: 3000,  // Max 3 seconds between attempts (faster recovery)
            timeout: 20000,              // Connection timeout: 20 seconds
            transports: ['websocket', 'polling'], // Try websocket first, fallback to polling
            upgrade: true,               // Allow transport upgrade
            rememberUpgrade: true,       // Remember successful upgrade
            forceNew: false,             // Reuse existing connection if possible
        });

        await new Promise((resolve, reject) => {
            this.socket.on('connect', resolve);
            this.socket.on('connect_error', (err) => {
                console.error('Connection failed:', err);
                reject(err);
            });
        });

        this.connected = true;
        this.reconnectAttempts = 0; // Reset on successful connection
        console.log(name, 'connected to MindServer');

        // Enhanced connection event handlers
        this.socket.on('disconnect', (reason) => {
            console.log(`⚠️ Disconnected from MindServer. Reason: ${reason}`);
            this.connected = false;
            
            // Don't stop state pushing completely - just mark as disconnected
            // This allows pushing to resume immediately after reconnection
            this.pushInProgress = false;
            
            // Log disconnect reason for debugging
            const criticalDisconnects = ['ping timeout', 'transport error', 'transport close'];
            if (criticalDisconnects.some(r => reason.includes(r))) {
                console.warn(`🚨 Critical disconnect detected: ${reason}`);
                // Print performance metrics if available
                if (this.perfMonitor && process.env.MONITOR_PERFORMANCE === 'true') {
                    console.log('📊 Performance at disconnect:');
                    this.perfMonitor.printReport();
                }
            }
            
            // Socket.IO handles reconnection automatically with our config
            // No need for manual reconnection - rely on built-in mechanism
        });

        this.socket.on('reconnect', (attemptNumber) => {
            console.log(`✅ Reconnected to MindServer after ${attemptNumber} attempts`);
            this.connected = true;
            this.reconnectAttempts = 0;
            
            // Re-login agent after reconnection
            if (this.agent) {
                // Login immediately
                this.login();
                
                // Don't restart state pushing - it's already running
                // Just clear the in-progress flag to allow new pushes
                this.pushInProgress = false;
                
                // Trigger immediate state push to sync state after reconnection
                setImmediate(() => {
                    this.pushStateIfChangedAsync(true, 'reconnect');
                });
            }
        });

        this.socket.on('reconnect_attempt', (attemptNumber) => {
            console.log(`🔄 Socket.IO reconnection attempt ${attemptNumber}...`);
        });

        this.socket.on('reconnect_error', (error) => {
            console.error('Socket.IO reconnection error:', error.message);
        });

        this.socket.on('reconnect_failed', () => {
            console.error('❌ Socket.IO reconnection failed (will keep retrying with infinite attempts)');
            // With reconnectionAttempts: Infinity, this should rarely happen
        });

        this.socket.on('connect_error', (error) => {
            console.error('Connection error:', error.message);
        });

        this.socket.on('error', (error) => {
            console.error('Socket error:', error);
        });

        this.socket.on('chat-message', (agentName, json) => {
            convoManager.receiveFromBot(agentName, json);
        });

        this.socket.on('agents-status', (agents) => {
            this.agents = agents;
            convoManager.updateAgents(agents);
            if (this.agent?.task) {
                console.log(this.agent.name, 'updating available agents');
                this.agent.task.updateAvailableAgents(agents);
            }
        });

        this.socket.on('restart-agent', (agentName) => {
            console.log(`Restarting agent: ${agentName}`);
            this.agent.cleanKill();
        });
		
        this.socket.on('send-message', (data) => {
            try {
                this.agent.respondFunc(data.from, data.message);
            } catch (error) {
                console.error('Error: ', JSON.stringify(error, Object.getOwnPropertyNames(error)));
            }
        });

        // Use cached state instead of real-time query
        this.socket.on('get-full-state', (callback) => {
            try {
                // Return cached state immediately without blocking
                const state = this.getCachedState();
                callback(state);
            } catch (error) {
                console.error('Error getting cached state:', error);
                callback({ error: String(error) });
            }
        });

        // Request settings and wait for response with retry mechanism
        let settingsAttempts = 0;
        const maxSettingsAttempts = 3;
        
        while (settingsAttempts < maxSettingsAttempts) {
            try {
                await new Promise((resolve, reject) => {
                    const timeout = setTimeout(() => {
                        reject(new Error('Settings request timed out after 10 seconds'));
                    }, 10000); // Increased from 5s to 10s

                    this.socket.emit('get-settings', name, (response) => {
                        clearTimeout(timeout);
                        if (response.error) {
                            return reject(new Error(response.error));
                        }
                        setSettings(response.settings);
                        this.socket.emit('connect-agent-process', name);
                        resolve();
                    });
                });
                break; // Success, exit loop
            } catch (error) {
                settingsAttempts++;
                if (settingsAttempts >= maxSettingsAttempts) {
                    throw new Error(`Failed to get settings after ${maxSettingsAttempts} attempts: ${error.message}`);
                }
                console.warn(`Settings request attempt ${settingsAttempts} failed, retrying...`);
                await new Promise(resolve => setTimeout(resolve, 2000)); // Wait 2s before retry
            }
        }
    }

    setAgent(agent) {
        this.agent = agent;
        // Initialize performance monitor
        this.perfMonitor = new PerformanceMonitor(agent.name);
        // Start pushing state updates proactively
        this.startStatePushing();
        
        // Print performance report every 5 minutes if monitoring enabled
        if (process.env.MONITOR_PERFORMANCE === 'true') {
            this.perfReportInterval = setInterval(() => {
                this.perfMonitor.printReport();
            }, 5 * 60 * 1000);
        }
    }

    startStatePushing() {
        // Clear any existing timers first to prevent duplicates
        if (this.statePushInterval) {
            clearInterval(this.statePushInterval);
        }
        
        // Initialize state cache
        this.cachedState = null;
        this.lastStateHash = null;
        this.lastPushTime = 0;
        this.pushThrottleMs = 300; // Minimum 300ms between pushes (aggressive)
        this.pushInProgress = false; // Track if push is in progress
        
        // Event-driven: Push state when critical events occur
        this.setupEventDrivenPush();
        
        // Regular polling: Check for changes at 1 second intervals (restored)
        // Use fully async pattern to never block event loop
        this.statePushInterval = setInterval(() => {
            if (!this.agent || !this.agent.bot || !this.connected || this.pushInProgress) return;
            
            // Schedule async push in next tick - never blocks current tick
            setImmediate(() => {
                this.pushStateIfChangedAsync();
            });
        }, 1000); // 1 second - restored original frequency
    }

    setupEventDrivenPush() {
        if (!this.agent || !this.agent.bot) return;
        
        const bot = this.agent.bot;
        
        // Store handler references for proper cleanup
        this.eventHandlers = new Map();
        
        // Critical events that warrant immediate state push (restored full set)
        const criticalEvents = [
            'health',           // Health changed (combat, fall damage)
            'death',            // Agent died
            'spawn',            // Agent respawned
            'entityHurt',       // Got hurt
            'heldItemChanged',  // Changed held item
        ];
        
        const createHandler = (eventName) => {
            return () => {
                try {
                    // Fully async push - never blocks event handler
                    setImmediate(() => {
                        this.pushStateIfChangedAsync(true, eventName);
                    });
                } catch (error) {
                    console.error(`[${this.agent?.name}] ❌ Error in event handler (${eventName}):`, error.message);
                }
            };
        };
        
        // Register event listeners and store references
        criticalEvents.forEach(event => {
            try {
                const handler = createHandler(event);
                this.eventHandlers.set(event, handler);
                bot.on(event, handler);
            } catch (error) {
                console.error(`[${this.agent?.name}] Failed to register event listener for ${event}:`, error);
            }
        });
    }

    // New async push method - fully non-blocking
    async pushStateIfChangedAsync(forcePush = false, eventName = null) {
        // Prevent concurrent pushes
        if (this.pushInProgress && !forcePush) {
            return;
        }
        
        const startTime = this.perfMonitor ? this.perfMonitor.startTiming() : Date.now();
        
        try {
            this.pushInProgress = true;
            
            // Safety check before getting state
            if (!this.agent || !this.agent.bot) {
                return;
            }
            
            // Throttling: prevent pushes more frequent than pushThrottleMs
            const now = Date.now();
            const timeSinceLastPush = now - this.lastPushTime;
            
            // Skip push if too soon (unless it's a critical event)
            if (timeSinceLastPush < this.pushThrottleMs && !forcePush) {
                return;
            }
            
            // Async state fetching - split into microtasks to avoid blocking
            let state;
            try {
                // Yield to event loop before expensive operation
                await Promise.resolve();
                state = await getFullStateAsync(this.agent);
            } catch (stateError) {
                console.error(`[${this.agent?.name}] ❌ Error in getFullState:`, stateError.message);
                if (this.perfMonitor) this.perfMonitor.recordError();
                // Use cached state if available, otherwise skip this push
                if (this.cachedState) {
                    state = this.cachedState;
                } else {
                    return;
                }
            }
            
            // Create a compact hash of critical fields for change detection
            const stateHash = `${state.isDead}|${state.gameplay?.health}|${state.gameplay?.hunger}|${Math.floor(state.gameplay?.position?.x)}|${Math.floor(state.gameplay?.position?.y)}|${Math.floor(state.gameplay?.position?.z)}|${state.action?.current}|${state.inventory?.stacksUsed}`;
            
            // Only push if changed or forced
            if (forcePush || stateHash !== this.lastStateHash) {
                this.cachedState = state;
                this.lastStateHash = stateHash;
                this.lastPushTime = now;
                
                if (this.socket && this.connected) {
                    // Emit with error boundary - yield before emit
                    try {
                        await Promise.resolve();
                        this.socket.emit('agent-state-push', this.agent.name, state);
                        // Record successful push timing
                        if (this.perfMonitor) {
                            this.perfMonitor.endTiming(startTime, 'state-push');
                        }
                    } catch (emitError) {
                        console.error(`[${this.agent?.name}] ❌ Error emitting state:`, emitError.message);
                        if (this.perfMonitor) this.perfMonitor.recordError();
                    }
                }
            }
        } catch (error) {
            console.error(`[${this.agent?.name || 'Unknown'}] ❌ Error pushing state:`, error.message);
            if (this.perfMonitor) this.perfMonitor.recordError();
        } finally {
            this.pushInProgress = false;
        }
    }

    // Legacy sync method - kept for backward compatibility but delegates to async
    pushStateIfChanged(forcePush = false, eventName = null) {
        // Just schedule async version without waiting
        setImmediate(() => {
            this.pushStateIfChangedAsync(forcePush, eventName);
        });
    }

    stopStatePushing() {
        // Clear interval timer
        if (this.statePushInterval) {
            clearInterval(this.statePushInterval);
            this.statePushInterval = null;
        }
        
        // Clear performance report interval
        if (this.perfReportInterval) {
            clearInterval(this.perfReportInterval);
            this.perfReportInterval = null;
        }
        
        // Print final report before stopping
        if (this.perfMonitor && process.env.MONITOR_PERFORMANCE === 'true') {
            console.log('\n📊 Final Performance Report:');
            this.perfMonitor.printReport();
        }
        
        // CRITICAL FIX: Properly remove event listeners by reference
        if (this.agent && this.agent.bot && this.eventHandlers) {
            this.eventHandlers.forEach((handler, event) => {
                try {
                    this.agent.bot.removeListener(event, handler);
                } catch (error) {
                    console.error(`[${this.agent?.name}] Failed to remove listener for ${event}:`, error.message);
                }
            });
            this.eventHandlers.clear();
            this.eventHandlers = null;
        }
        
        // Clear cached data to free memory
        this.cachedState = null;
        this.lastStateHash = null;
        this.perfMonitor = null;
    }

    getCachedState() {
        return this.cachedState || { error: 'No cached state' };
    }

    getAgents() {
        return this.agents;
    }

    getNumOtherAgents() {
        return this.agents.length - 1;
    }

    login() {
        this.socket.emit('login-agent', this.agent.name);
    }

    shutdown() {
        this.stopStatePushing();
        this.socket.emit('shutdown');
    }

    getSocket() {
        return this.socket;
    }

    // Removed manual reconnection - Socket.IO handles this automatically
    // with connectionStateRecovery and infinite reconnectionAttempts
}

// Create and export a singleton instance
export const serverProxy = new MindServerProxy();

// for chatting with other bots
export function sendBotChatToServer(agentName, json) {
    serverProxy.getSocket().emit('chat-message', agentName, json);
}

// for sending general output to server for display
export function sendOutputToServer(agentName, message) {
    serverProxy.getSocket().emit('bot-output', agentName, message);
}
