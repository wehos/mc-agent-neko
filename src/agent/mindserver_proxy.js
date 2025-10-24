import { io } from 'socket.io-client';
import convoManager from './conversation.js';
import { setSettings } from './settings.js';
import { getFullState } from './library/full_state.js';

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
        
        // Configure Socket.IO client with appropriate timeouts
        this.socket = io(`http://localhost:${port}`, {
            reconnection: true,          // Enable auto-reconnection
            reconnectionAttempts: 5,     // Try 5 times before giving up
            reconnectionDelay: 1000,     // Start with 1 second delay
            reconnectionDelayMax: 5000,  // Max 5 seconds between attempts
            timeout: 20000,              // Connection timeout: 20 seconds
            transports: ['websocket', 'polling'], // Try websocket first, fallback to polling
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
            console.log(`Disconnected from MindServer. Reason: ${reason}`);
            this.connected = false;
            
            // Stop state pushing when disconnected
            this.stopStatePushing();
            
            // Socket.IO has built-in auto-reconnection, but we also have our manual reconnection
            // Only trigger manual reconnection if it's not a clean disconnect
            if (reason !== 'io client disconnect' && this.agent && !this.reconnecting) {
                this.attemptReconnect();
            }
        });

        this.socket.on('reconnect', (attemptNumber) => {
            console.log(`✅ Reconnected to MindServer after ${attemptNumber} attempts`);
            this.connected = true;
            this.reconnectAttempts = 0;
            
            // Re-login agent after reconnection
            if (this.agent) {
                this.login();
                // Restart state pushing after reconnection
                this.startStatePushing();
            }
        });

        this.socket.on('reconnect_attempt', (attemptNumber) => {
            console.log(`🔄 Socket.IO reconnection attempt ${attemptNumber}...`);
        });

        this.socket.on('reconnect_error', (error) => {
            console.error('Socket.IO reconnection error:', error.message);
        });

        this.socket.on('reconnect_failed', () => {
            console.error('❌ Socket.IO reconnection failed after all attempts');
            // Our manual reconnection will take over
            if (this.agent && !this.reconnecting) {
                this.attemptReconnect();
            }
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
        // Start pushing state updates proactively
        this.startStatePushing();
    }

    startStatePushing() {
        // Clear any existing timers first to prevent duplicates
        if (this.statePushInterval) {
            clearInterval(this.statePushInterval);
        }
        
        // Initialize state cache
        this.cachedState = null;
        this.lastStateHash = null;
        
        // Event-driven: Push state when critical events occur
        this.setupEventDrivenPush();
        
        // Fallback: Check for changes at moderate frequency (every 1s)
        // Reduced from 500ms to 1000ms to lower CPU/memory pressure
        this.statePushInterval = setInterval(() => {
            if (!this.agent || !this.agent.bot || !this.connected) return;
            
            setImmediate(() => {
                this.pushStateIfChanged();
            });
        }, 1000); // Reduced to 1 second to save memory
    }

    setupEventDrivenPush() {
        if (!this.agent || !this.agent.bot) return;
        
        const bot = this.agent.bot;
        
        // CRITICAL FIX: Store handler references for proper cleanup
        this.eventHandlers = new Map();
        
        // Reduced critical events to avoid memory leaks
        // Removed physicsTick - too high frequency causes memory issues
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
                    // Non-blocking push
                    setImmediate(() => {
                        this.pushStateIfChanged(true);
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

    pushStateIfChanged(forcePush = false) {
        try {
            // Safety check before getting state
            if (!this.agent || !this.agent.bot) {
                return;
            }
            
            const state = getFullState(this.agent);
            
            // Create a compact hash of critical fields for change detection
            // Use smaller representation to reduce memory
            const stateHash = `${state.isDead}|${state.gameplay?.health}|${state.gameplay?.hunger}|${Math.floor(state.gameplay?.position?.x)}|${Math.floor(state.gameplay?.position?.y)}|${Math.floor(state.gameplay?.position?.z)}|${state.action?.current}|${state.inventory?.stacksUsed}`;
            
            // Only push if changed or forced
            if (forcePush || stateHash !== this.lastStateHash) {
                this.cachedState = state;
                this.lastStateHash = stateHash;
                
                if (this.socket && this.connected) {
                    this.socket.emit('agent-state-push', this.agent.name, state);
                }
            }
        } catch (error) {
            console.error(`[${this.agent?.name || 'Unknown'}] ❌ Error pushing state:`);
            console.error('Message:', error.message);
            console.error('Stack:', error.stack);
            // Don't crash, just skip this push
        }
    }

    stopStatePushing() {
        // Clear interval timer
        if (this.statePushInterval) {
            clearInterval(this.statePushInterval);
            this.statePushInterval = null;
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

    async attemptReconnect() {
        if (this.reconnecting) return;
        
        this.reconnecting = true;
        this.reconnectAttempts++;
        
        console.log(`\n🔄 ===== MINDSERVER RECONNECTION ATTEMPT =====`);
        console.log(`🔗 Attempt: ${this.reconnectAttempts}/${this.maxReconnectAttempts}`);
        console.log(`🤖 Agent: ${this.name}`);
        console.log(`⏰ Timestamp: ${new Date().toISOString()}`);
        console.log(`=============================================\n`);
        
        if (this.reconnectAttempts > this.maxReconnectAttempts) {
            console.error('Max MindServer reconnection attempts reached. Killing agent process.');
            this.reconnecting = false;
            if (this.agent) {
                this.agent.cleanKill('Disconnected from MindServer. Max reconnection attempts reached.');
            }
            return;
        }
        
        // Wait before attempting reconnection
        const delay = Math.min(2000 * this.reconnectAttempts, 10000); // 2s, 4s, 6s... max 10s
        await new Promise(resolve => setTimeout(resolve, delay));
        
        try {
            // Clean up old socket
            if (this.socket) {
                this.socket.removeAllListeners();
                this.socket.close();
            }
            
            // Reset connection state
            this.connected = false;
            this.reconnecting = false;
            
            // Attempt new connection
            await this.connect(this.name, this.port);
            
            console.log(`✅ Successfully reconnected to MindServer (attempt ${this.reconnectAttempts})`);
            
            // Re-login the agent
            if (this.agent) {
                this.login();
            }
        } catch (error) {
            console.error(`❌ MindServer reconnection attempt ${this.reconnectAttempts} failed:`, error);
            this.reconnecting = false;
            
            // Try again
            this.attemptReconnect();
        }
    }
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
