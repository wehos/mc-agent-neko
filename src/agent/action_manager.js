export class ActionManager {
    constructor(agent) {
        this.agent = agent;
        this.executing = false;
        this.currentActionLabel = '';
        this.currentActionFn = null;
        this.timedout = false;
        this.resume_func = null;
        this.resume_name = '';
        this.last_action_time = 0;
        this.recent_action_counter = 0;
    }

    async resumeAction(actionFn, timeout) {
        return this._executeResume(actionFn, timeout);
    }

    async runAction(actionLabel, actionFn, { timeout, resume = false } = {}) {
        if (resume) {
            return this._executeResume(actionLabel, actionFn, timeout);
        } else {
            return this._executeAction(actionLabel, actionFn, timeout);
        }
    }

    async stop() {
        if (!this.executing) return;

        let waitTime = 0;
        const checkInterval = 300; // Check every 300ms
        const logInterval = 2000; // Only log every 2 seconds to reduce spam
        // ★2026-07-08 用户令: 软卡顿阶梯 = 先脱困(这里靠 requestInterrupt 循环打断) 15s,
        //   到点仍没停【才重连】(不再 cleanKill→process.exit)。
        const maxWaitTime = 15000; // 15s interrupt window before escalating
        let lastLogTime = 0;

        while (this.executing && waitTime < maxWaitTime) {
            this.agent.requestInterrupt();

            // Only log occasionally to avoid spam
            if (waitTime - lastLogTime >= logInterval) {
                console.log(`Waiting for code to finish executing... (${(waitTime / 1000).toFixed(1)}s)`);
                lastLogTime = waitTime;
            }

            await new Promise(resolve => setTimeout(resolve, checkInterval));
            waitTime += checkInterval;
        }

        if (this.executing) {
            // ★2026-07-08 用户令: 动作 15s 拒绝停止【绝不 process.exit】。强制放行(置 executing=false,
            //   让重连后的新动作能跑) + reconnectNow 重进世界。挂死的旧动作攥着旧 bot, 重连后对旧 bot
            //   的操作自然空转/被拒, 其 catch 也会再次置 executing=false, 无害。
            console.warn('Code did not stop after 15s — forcing release + reconnect (NO process exit).');
            this.executing = false;
            this.currentActionLabel = '';
            this.currentActionFn = null;
            try { this.agent.reconnectNow('action-refused-stop'); } catch (e) {}
        }
    }

    cancelResume() {
        this.resume_func = null;
        this.resume_name = null;
    }

    async _executeResume(actionLabel = null, actionFn = null, timeout = 10) {
        const new_resume = actionFn != null;
        if (new_resume) { // start new resume
            this.resume_func = actionFn;
            assert(actionLabel != null, 'actionLabel is required for new resume');
            this.resume_name = actionLabel;
        }
        if (this.resume_func != null && (this.agent.isIdle() || new_resume) && (!this.agent.self_prompter.isActive() || new_resume)) {
            this.currentActionLabel = this.resume_name;
            let res = await this._executeAction(this.resume_name, this.resume_func, timeout);
            this.currentActionLabel = '';
            return res;
        } else {
            return { success: false, message: null, interrupted: false, timedout: false };
        }
    }

    async _executeAction(actionLabel, actionFn, timeout = 10) {
        let TIMEOUT;
        try {
            if (this.last_action_time > 0) {
                let time_diff = Date.now() - this.last_action_time;
                if (time_diff < 20) {
                    this.recent_action_counter++;
                }
                else {
                    this.recent_action_counter = 0;
                }
                if (this.recent_action_counter > 3) {
                    console.warn('Fast action loop detected, cancelling resume.');
                    this.cancelResume(); // likely cause of repetition
                }
                if (this.recent_action_counter > 5) {
                    // ★2026-07-08 用户令: 动作打转【不再 cleanKill→process.exit】。counter>3 已 cancelResume
                    //   试图断掉重复源; 到 >5 仍在死循环 → reconnectNow 重进世界打断它, 进程照常活着。
                    console.error('Infinite action loop detected — cancelling resume + reconnect (NO process exit).');
                    this.cancelResume();
                    this.recent_action_counter = 0;
                    try { this.agent.reconnectNow('infinite-action-loop'); } catch (e) {}
                    return { success: false, message: 'Infinite action loop detected, reconnecting.', interrupted: true, timedout: false };
                }
            }
            this.last_action_time = Date.now();
            console.log('executing code...\n');

            // await current action to finish (executing=false), with 10 seconds timeout
            // also tell agent.bot to stop various actions
            if (this.executing) {
                console.log(`action "${actionLabel}" trying to interrupt current action "${this.currentActionLabel}"`);
            }
            await this.stop();

            // clear bot logs and reset interrupt code
            this.agent.clearBotLogs();

            this.executing = true;
            this.currentActionLabel = actionLabel;
            this.currentActionFn = actionFn;

            // timeout in minutes
            if (timeout > 0) {
                TIMEOUT = this._startTimeout(timeout);
            }

            // start the action
            await actionFn();

            // mark action as finished + cleanup
            this.executing = false;
            this.currentActionLabel = '';
            this.currentActionFn = null;
            clearTimeout(TIMEOUT);

            // get bot activity summary
            let output = this.getBotOutputSummary();
            let interrupted = this.agent.bot.interrupt_code;
            let timedout = this.timedout;
            this.agent.clearBotLogs();

            // if not interrupted and not generating, emit idle event
            if (!interrupted) {
                this.agent.bot.emit('idle');
            }

            // return action status report
            return { success: true, message: output, interrupted, timedout };
        } catch (err) {
            this.executing = false;
            this.currentActionLabel = '';
            this.currentActionFn = null;
            clearTimeout(TIMEOUT);
            this.cancelResume();
            
            const errMsg = err.message || err.toString();
            const isInterrupt = errMsg.includes('interrupted') || errMsg.includes('Interrupted') || this.agent.bot.interrupt_code;
            
            // Only log full stack for real errors, not normal interrupts
            if (isInterrupt) {
                // Interrupts are expected behavior, minimal logging
                console.log(`Action interrupted: ${actionLabel}`);
            } else {
                console.error("Code execution triggered catch:", err);
                console.error(err.stack);
            }
            
            await this.stop();
            const errStr = err.toString();

            let message;
            if (isInterrupt) {
                // Clean message for interrupts
                message = this.getBotOutputSummary() + '(action interrupted)\n';
            } else {
                message = this.getBotOutputSummary() +
                    '!!Code threw exception!!\n' +
                    'Error: ' + errStr + '\n' +
                    'Stack trace:\n' + err.stack + '\n';
            }

            let interrupted = this.agent.bot.interrupt_code;
            this.agent.clearBotLogs();
            if (!interrupted) {
                this.agent.bot.emit('idle');
            }
            return { success: false, message, interrupted: isInterrupt || interrupted, timedout: false };
        }
    }

    getBotOutputSummary() {
        const { bot } = this.agent;
        if (bot.interrupt_code && !this.timedout) return '';
        let output = bot.output;
        const MAX_OUT = 500;
        if (output.length > MAX_OUT) {
            output = `Action output is very long (${output.length} chars) and has been shortened.\n
          First outputs:\n${output.substring(0, MAX_OUT / 2)}\n...skipping many lines.\nFinal outputs:\n ${output.substring(output.length - MAX_OUT / 2)}`;
        }
        else {
            output = 'Action output:\n' + output.toString();
        }
        bot.output = '';
        return output;
    }

    _startTimeout(TIMEOUT_MINS = 10) {
        return setTimeout(async () => {
            console.warn(`Code execution timed out after ${TIMEOUT_MINS} minutes. Attempting force stop.`);
            this.timedout = true;
            this.agent.history.add('system', `Code execution timed out after ${TIMEOUT_MINS} minutes. Attempting force stop.`);
            await this.stop(); // last attempt to stop
        }, TIMEOUT_MINS * 60 * 1000);
    }

}