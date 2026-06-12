import { Vec3 } from 'vec3';
import { Camera } from "./camera.js";
import fs from 'fs';

export class VisionInterpreter {
    constructor(agent, allow_vision) {
        this.agent = agent;
        // HARD-DISABLED vision: this `new Camera(...)` is the THIRD prismarine-viewer
        // renderer (besides ws_server's screenshot Camera and agent.js's addBrowserViewer),
        // and it's the residual source of the agent-subprocess crash churn (texture errors
        // → exit 1 → auto-restart → bot offline → AFK death). Force vision off so the Camera
        // is never created; all vision methods below already guard on this.allow_vision and
        // return "disabled". (We've given up the visual feed to keep the bot alive/online.)
        this.allow_vision = false;
        this.fp = './bots/'+agent.name+'/screenshots/';
        // Camera intentionally NOT created (renderer churn). To restore vision, revert this.
    }

    async lookAtPlayer(player_name, direction) {
        if (!this.allow_vision || !this.agent.prompter.vision_model.sendVisionRequest) {
            return "Vision is disabled. Use other methods to describe the environment.";
        }
        let result = "";
        const bot = this.agent.bot;
        const player = bot.players[player_name]?.entity;
        if (!player) {
            return `Could not find player ${player_name}`;
        }

        let filename;
        if (direction === 'with') {
            await bot.look(player.yaw, player.pitch);
            result = `Looking in the same direction as ${player_name}\n`;
            filename = await this.camera.capture();
        } else {
            await bot.lookAt(new Vec3(player.position.x, player.position.y + player.height, player.position.z));
            result = `Looking at player ${player_name}\n`;
            filename = await this.camera.capture();

        }

        return result + `Image analysis: "${await this.analyzeImage(filename)}"`;
    }

    async lookAtPosition(x, y, z) {
        if (!this.allow_vision || !this.agent.prompter.vision_model.sendVisionRequest) {
            return "Vision is disabled. Use other methods to describe the environment.";
        }
        let result = "";
        const bot = this.agent.bot;
        await bot.lookAt(new Vec3(x, y + 2, z));
        result = `Looking at coordinate ${x}, ${y}, ${z}\n`;

        let filename = await this.camera.capture();

        return result + `Image analysis: "${await this.analyzeImage(filename)}"`;
    }

    getCenterBlockInfo() {
        const bot = this.agent.bot;
        const maxDistance = 128; // Maximum distance to check for blocks
        const targetBlock = bot.blockAtCursor(maxDistance);
        
        if (targetBlock) {
            return `Block at center view: ${targetBlock.name} at (${targetBlock.position.x}, ${targetBlock.position.y}, ${targetBlock.position.z})`;
        } else {
            return "No block in center view";
        }
    }

    async analyzeImage(filename) {
        try {
            const imageBuffer = fs.readFileSync(`${this.fp}/${filename}.jpg`);
            const messages = this.agent.history.getHistory();

            const blockInfo = this.getCenterBlockInfo();
            const result = await this.agent.prompter.promptVision(messages, imageBuffer);
            return result + `\n${blockInfo}`;

        } catch (error) {
            console.warn('Error reading image:', error);
            return `Error reading image: ${error.message}`;
        }
    }
} 