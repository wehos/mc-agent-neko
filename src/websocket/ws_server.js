import { WebSocketServer } from 'ws';
import { serverProxy } from '../agent/mindserver_proxy.js';
import { Camera } from '../agent/vision/camera.js';

class WSMessageServer {
    constructor(port = 48909) {
        this.port = port;
        this.wss = null;
        this.clients = new Set();
        this.agent = null;
        this.camera = null;
        this.screenshotInterval = null;
        this.screenshotInProgress = false; // Prevent concurrent screenshots
        this.currentTask = null;
        this.taskStartTime = null;
        this.taskCompleted = false; // Track task completion status
        this.lastTaskCompletionTime = null; // Track when task was completed
        this.nanWarningLogged = false; // Track if NaN warning has been logged
    }

    start() {
        this.wss = new WebSocketServer({ port: this.port, host: '0.0.0.0' });

        console.log(`WebSocket server started on ws://0.0.0.0:${this.port}`);

        this.wss.on('connection', (ws) => {
            console.log('WebSocket client connected');
            this.clients.add(ws);

            // Send welcome message
            ws.send(JSON.stringify({
                type: 'connected',
                message: 'Connected to Mindcraft WebSocket interface'
            }));

            // Check if there's a completed task that needs to be reported
            this.handleReconnection(ws);

            // Send current inventory if agent is online
            this.sendInitialInventory(ws);

            ws.on('message', (data) => {
                try {
                    this.handleMessage(JSON.parse(data.toString()));
                } catch (error) {
                    console.error('Error parsing WebSocket message:', error);
                    ws.send(JSON.stringify({
                        type: 'error',
                        message: 'Invalid JSON format'
                    }));
                }
            });

            ws.on('close', () => {
                console.log('WebSocket client disconnected');
                this.clients.delete(ws);
            });

            ws.on('error', (error) => {
                console.error('WebSocket error:', error);
                this.clients.delete(ws);
            });
        });
    }

    setAgent(agent) {
        this.agent = agent;
        console.log(`WebSocket server connected to agent: ${agent.name}`);

        // Reset NaN warning flag when agent reconnects
        this.nanWarningLogged = false;
        this.nanErrorCount = 0;

        // Wait for bot to be properly spawned before initializing camera
        this.waitForBotSpawn(agent);
    }

    waitForBotSpawn(agent) {
        // Check if bot is properly spawned
        if (!agent.bot.entity || !agent.bot.entity.position) {
            console.log('Waiting for bot to spawn before initializing camera...');
            setTimeout(() => this.waitForBotSpawn(agent), 2000);
            return;
        }

        // Validate bot position data
        const pos = agent.bot.entity.position;
        if (!this.isValidNumber(pos.x) || !this.isValidNumber(pos.y) || !this.isValidNumber(pos.z)) {
            console.log('Bot position data invalid, waiting for valid position...');
            setTimeout(() => this.waitForBotSpawn(agent), 2000);
            return;
        }

        // Bot is ready, initialize camera
        try {
            this.camera = new Camera(agent.bot, `./bots/${agent.name}/screenshots/`);
            this.camera.on('ready', () => {
                console.log('Camera initialized for WebSocket screenshots (forced initialization)');
                // Wait a bit more for bot to be fully ready before starting screenshots
                setTimeout(() => {
                    this.startScreenshotTimer();
                }, 5000); // Wait 5 seconds after camera is ready
            });
        } catch (error) {
            console.error('Failed to initialize camera for WebSocket screenshots:', error);
        }
    }

    handleMessage(data) {
        if (!this.agent) {
            this.broadcast({
                type: 'error',
                error: 'No agent connected'
            });
            return;
        }

        switch (data.type) {
            case 'task':
                this.injectMessage(data.task);
                break;
            case 'ping':
                this.broadcast({
                    type: 'pong'
                });
                break;
            default:
                this.broadcast({
                    type: 'error',
                    error: `Unknown message type: ${data.type}`
                });
        }
    }

    injectMessage(message) {
        if (!message || typeof message !== 'string') {
            this.broadcast({
                type: 'error',
                error: 'Task must be a non-empty string'
            });
            return;
        }

        try {
            // Inject message as if it came from "admin" user
            // This leverages the existing respondFunc mechanism
            console.log(`😊WebSocket injecting task from admin: "${message}"`);

            // Call the agent's respondFunc directly with "admin" as sender
            this.agent.respondFunc('admin', message);

            // Track current task for completion detection
            this.currentTask = message;
            this.taskStartTime = Date.now();
            this.taskCompleted = false; // Reset completion status for new task
            this.lastTaskCompletionTime = null;

        } catch (error) {
            console.error('Error injecting message:', error);
            this.broadcast({
                type: 'error',
                error: 'Failed to inject task'
            });
        }
    }

    // Handle reconnection by checking if there's a completed task to report
    handleReconnection(ws) {
        if (this.taskCompleted && this.lastTaskCompletionTime) {
            // If task was completed recently (within last 30 seconds), report it
            const timeSinceCompletion = Date.now() - this.lastTaskCompletionTime;
            if (timeSinceCompletion < 30000) {
                console.log('Reporting previously completed task to reconnected client');
                ws.send(JSON.stringify({
                    type: 'task_finished',
                    status: 'ok',
                    message: 'Task was completed before reconnection',
                    timestamp: this.lastTaskCompletionTime,
                    reconnected: true
                }));
            }
        }
    }

    // Send initial inventory information when client connects
    sendInitialInventory(ws) {
        if (!this.agent || !this.agent.bot) {
            console.log('Agent not online, skipping initial inventory');
            return;
        }

        try {
            const bot = this.agent.bot;
            const inventory = {};
            for (const item of bot.inventory.items()) {
                if (item != null) {
                    if (!inventory[item.name]) {
                        inventory[item.name] = 0;
                    }
                    inventory[item.name] += item.count;
                }
            }

            // Format inventory as Chinese text
            const items = Object.entries(inventory).filter(([name, count]) => count > 0);
            let inventoryMessage = '';
            if (items.length > 0) {
                inventoryMessage = 'Agent已在线。当前持有道具：' + items.map(([name, count]) =>
                    `${name} x${count}`
                ).join('、');
            } else {
                inventoryMessage = 'Agent已在线。当前持有道具：无';
            }

            // Get agent status
            const status = {
                name: this.agent.name,
                health: bot.health || 0,
                food: bot.food || 0,
                position: bot.entity ? {
                    x: bot.entity.position.x.toFixed(2),
                    y: bot.entity.position.y.toFixed(2),
                    z: bot.entity.position.z.toFixed(2)
                } : null,
                gameMode: bot.game?.gameMode || 'unknown'
            };

            console.log('📦 Sending initial inventory to new client');
            ws.send(JSON.stringify({
                type: 'agent_status',
                message: inventoryMessage,
                inventory: inventory,
                status: status,
                timestamp: Date.now()
            }));
        } catch (err) {
            console.warn('Failed to send initial inventory:', err);
        }
    }

    // Method to be called when task completion is detected by agent
    onTaskCompleted(completionData) {
        this.taskCompleted = true;
        this.lastTaskCompletionTime = Date.now();

        // Get current inventory
        let inventoryInfo = '';
        let inventoryData = {};
        if (this.agent && this.agent.bot) {
            try {
                const bot = this.agent.bot;
                const inventory = {};
                for (const item of bot.inventory.items()) {
                    if (item != null) {
                        if (!inventory[item.name]) {
                            inventory[item.name] = 0;
                        }
                        inventory[item.name] += item.count;
                    }
                }

                // Format inventory as Chinese text
                const items = Object.entries(inventory).filter(([name, count]) => count > 0);
                if (items.length > 0) {
                    inventoryInfo = '\n\n当前持有道具：' + items.map(([name, count]) =>
                        `${name} x${count}`
                    ).join('、');
                } else {
                    inventoryInfo = '\n\n当前持有道具：无';
                }

                inventoryData = inventory;
            } catch (err) {
                console.warn('Failed to get inventory:', err);
                inventoryInfo = '\n\n当前持有道具：获取失败';
            }
        }

        // Highligh debug output for task_finished
        console.log('\n🎯 ===== TASK FINISHED =====');
        console.log('📋 Message:', completionData.message || 'Task completed');
        console.log('📊 Score:', completionData.score);
        console.log('⏰ Timestamp:', new Date(this.lastTaskCompletionTime).toISOString());
        console.log('🔗 Reason:', completionData.reason || 'Normal completion');
        console.log('🎒 Inventory:', inventoryInfo.replace('\n\n当前持有道具：', ''));
        console.log('=============================\n');

        // Append inventory info to message
        const messageWithInventory = (completionData.message || 'Task completed') + inventoryInfo;

        // Broadcast to all connected clients with retry mechanism
        this.broadcastTaskCompletion({
            type: 'task_finished',
            status: 'ok',
            message: messageWithInventory,
            score: completionData.score,
            timestamp: this.lastTaskCompletionTime,
            inventory: inventoryData
        });

        console.log('Task completion broadcasted to all WebSocket clients');
    }

    // Enhanced task completion broadcasting with retry mechanism
    broadcastTaskCompletion(data, retryCount = 0) {
        const maxRetries = 3;
        const message = JSON.stringify(data);
        let sentCount = 0;
        let failedCount = 0;

        this.clients.forEach(client => {
            if (client.readyState === client.OPEN) {
                try {
                    client.send(message);
                    sentCount++;
                } catch (error) {
                    console.error('Failed to send task completion to client:', error);
                    failedCount++;
                    // Remove failed client
                    this.clients.delete(client);
                }
            } else {
                // Remove disconnected clients
                this.clients.delete(client);
            }
        });

        console.log(`Task completion message sent to ${sentCount} clients, ${failedCount} failed (attempt ${retryCount + 1})`);

        // If there were failures and we haven't exceeded max retries, retry after a short delay
        if (failedCount > 0 && retryCount < maxRetries) {
            setTimeout(() => {
                console.log(`Retrying task completion broadcast (attempt ${retryCount + 2})`);
                this.broadcastTaskCompletion(data, retryCount + 1);
            }, 1000); // Retry after 1 second
        }
    }

    // Method to broadcast agent responses back to WebSocket clients
    broadcastAgentResponse(response) {
        console.error('🤖Broadcasting log message:', response);
        this.broadcast({
            type: 'log',
            message: response
        });

        // Note: Task completion detection is now handled by agent.js checkTaskDone()
        // This prevents duplicate detection and ensures consistency
    }

    startScreenshotTimer() {
        // Take screenshot every 2 seconds
        // But only if previous screenshot is complete
        this.screenshotInterval = setInterval(async () => {
            // Skip if previous screenshot is still in progress
            if (this.screenshotInProgress) {
                console.log('⏳ Screenshot still in progress, skipping this cycle');
                return;
            }

            try {
                await this.captureAndBroadcastScreenshot();
            } catch (error) {
                console.warn('Screenshot capture failed:', error);
            }
        }, 2000);
    }

    async captureAndBroadcastScreenshot() {
        if (!this.camera || !this.agent || !this.agent.bot) return;

        // Prevent concurrent screenshot captures
        if (this.screenshotInProgress) {
            return;
        }

        this.screenshotInProgress = true;

        try {
            const bot = this.agent.bot;

            // Check for valid bot position and orientation data
            // Safety check: bot.entity is null when dead
            if (!bot.entity || !bot.entity.position) {
                if (!this.deadWarningLogged) {
                    console.warn('🚨 Bot entity is null (dead/not spawned), skipping screenshot');
                    this.deadWarningLogged = true;
                }
                return;
            }

            // Reset dead warning when bot is alive again
            this.deadWarningLogged = false;

            const pos = bot.entity.position;
            const height = bot.entity.height || 1.62; // Default player height
            const yaw = bot.entity.yaw || 0;
            const pitch = bot.entity.pitch || 0;

            // Validate position and orientation values to prevent NaN errors
            if (!this.isValidNumber(pos.x) || !this.isValidNumber(pos.y) || !this.isValidNumber(pos.z) ||
                !this.isValidNumber(yaw) || !this.isValidNumber(pitch) || !this.isValidNumber(height)) {

                this.nanErrorCount = (this.nanErrorCount || 0) + 1;

                // Log detailed error information
                console.error('❌ Bot position data contains NaN/invalid values:');
                console.error('   Position:', { x: pos.x, y: pos.y, z: pos.z });
                console.error('   Orientation:', { yaw, pitch });
                console.error('   Height:', height);
                console.error(`   Consecutive errors: ${this.nanErrorCount}`);

                this.nanWarningLogged = true;

                // If we've had NaN errors for more than 10 consecutive attempts, try to recover
                if (this.nanErrorCount > 10) {
                    console.warn(`⚠️ NaN errors persisting (${this.nanErrorCount} consecutive), attempting camera reinitialization...`);

                    // Stop current screenshot timer
                    if (this.screenshotInterval) {
                        clearInterval(this.screenshotInterval);
                        this.screenshotInterval = null;
                    }

                    // Reset error count
                    this.nanErrorCount = 0;
                    this.nanWarningLogged = false;

                    // Wait a bit and try to reinitialize camera
                    setTimeout(() => {
                        if (this.agent && this.agent.bot) {
                            console.log('🔄 Attempting to reinitialize camera system...');
                            this.waitForBotSpawn(this.agent);
                        }
                    }, 5000);
                }
                return;
            }

            // Reset NaN error count on successful position read
            this.nanErrorCount = 0;

            // Calculate camera center with validated values
            const center = pos.offset(0, height, 0);

            // Validate center position (should never fail if above checks passed, but double-check)
            if (!this.isValidNumber(center.x) || !this.isValidNumber(center.y) || !this.isValidNumber(center.z)) {
                console.error('❌ Invalid camera center position (NaN detected):');
                console.error('   Center:', { x: center.x, y: center.y, z: center.z });
                console.error('   This should not happen after position validation!');
                return;
            }

            // Set camera position and update world view
            this.camera.viewer.camera.position.set(center.x, center.y, center.z);
            await this.camera.worldView.updatePosition(center);

            // Force first-person camera with validated bot's current yaw and pitch
            this.camera.viewer.setFirstPersonCamera(pos, yaw, pitch);

            // Update and render the scene
            this.camera.viewer.update();
            this.camera.renderer.render(this.camera.viewer.scene, this.camera.viewer.camera);

            // Create JPEG stream with quality optimized for WebSocket transmission
            const imageStream = this.camera.canvas.createJPEGStream({
                bufsize: 4096,
                quality: 50,
                progressive: false
            });

            // Convert stream to base64 for WebSocket transmission
            // Use Promise to properly wait for stream completion
            const base64Image = await new Promise((resolve, reject) => {
                const chunks = [];
                const timeoutId = setTimeout(() => {
                    // Timeout after 5 seconds - stream is stuck
                    reject(new Error('Screenshot stream timeout after 5s'));
                }, 5000);

                imageStream.on('data', chunk => chunks.push(chunk));
                imageStream.on('end', () => {
                    clearTimeout(timeoutId);
                    const buffer = Buffer.concat(chunks);
                    const base64 = buffer.toString('base64');
                    // Explicitly clear chunks array to help GC
                    chunks.length = 0;
                    resolve(base64);
                });
                imageStream.on('error', (err) => {
                    clearTimeout(timeoutId);
                    chunks.length = 0;
                    reject(err);
                });
            });

            this.broadcast({
                type: 'screenshot',
                image: base64Image,
                encoding: 'jpeg-base64'
            });

        } catch (error) {
            console.warn('Failed to capture screenshot:', error);
        } finally {
            // Always reset the flag, even on error
            this.screenshotInProgress = false;
        }
    }

    // Helper method to validate numeric values and prevent NaN
    isValidNumber(value) {
        return typeof value === 'number' && !isNaN(value) && isFinite(value);
    }

    broadcast(data) {
        const message = JSON.stringify(data);
        let sentCount = 0;
        let failedCount = 0;

        this.clients.forEach(client => {
            if (client.readyState === client.OPEN) {
                try {
                    client.send(message);
                    sentCount++;
                } catch (error) {
                    console.error('Failed to send message to client:', error);
                    failedCount++;
                    // Remove failed client
                    this.clients.delete(client);
                }
            } else {
                // Remove disconnected clients
                this.clients.delete(client);
            }
        });

        if (data.type === 'task_finished') {
            console.log(`Task completion message sent to ${sentCount} clients, ${failedCount} failed`);
        }
    }

    stop() {
        if (this.screenshotInterval) {
            clearInterval(this.screenshotInterval);
            this.screenshotInterval = null;
        }
        if (this.wss) {
            this.wss.close();
            console.log('WebSocket server stopped');
        }
    }
}

// Create singleton instance
const wsServer = new WSMessageServer();

export { wsServer };
