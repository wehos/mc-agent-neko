import { writeFile, readFile, mkdirSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { makeCompartment, lockdown } from './library/lockdown.js';
import * as skills from './library/skills.js';
import * as world from './library/world.js';
import * as tick_confirm from './library/tick_confirm.js';
import { Vec3 } from 'vec3';
import {ESLint} from "eslint";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export class Coder {
    constructor(agent) {
        this.agent = agent;
        this.file_counter = 0;
        this.fp = '/bots/'+agent.name+'/action-code/';
        this.code_template = '';
        this.code_lint_template = '';

        readFile(path.join(__dirname, '../../bots/execTemplate.js'), 'utf8', (err, data) => {
            if (err) throw err;
            this.code_template = data;
        });
        readFile(path.join(__dirname, '../../bots/lintTemplate.js'), 'utf8', (err, data) => {
            if (err) throw err;
            this.code_lint_template = data;
        });
        mkdirSync('.' + this.fp, { recursive: true });
    }

    // ★2026-07-09 用户令 (newAction 期间铁律): 代码【编写(LLM 调用)+执行】的整个窗口标记
    //   bot._newActionActive。此期间 bot 常静止(等 LLM 出码 / 码在跑), 各卡顿看门狗把静止
    //   误判成"卡住"→断线重连 / 内核自主派别的任务 / 灰区求生抢身体, 把正在进行的 newAction 打断。
    //   这层布尔闸让 kernel 冻结自主提案+灰区求生、unstuck 停止累计卡顿, 直到码真跑完(finally 清)。
    //   真·终止仍走各自的确凿证据: 任务完成/失败/被新指令覆盖/code_timeout(真卡死)。
    async generateCode(agent_history) {
        const bot = this.agent.bot;
        try { bot._newActionActive = true; } catch (e) {}
        try {
            return await this._generateCode(agent_history);
        } finally {
            try { bot._newActionActive = false; } catch (e) {}
        }
    }

    async _generateCode(agent_history) {
        this.agent.bot.modes.pause('unstuck');
        lockdown();
        // this message history is transient and only maintained in this function
        let messages = agent_history.getHistory(); 
        messages.push({role: 'system', content: 'Code generation started. Write code in codeblock in your response:'});

        const MAX_ATTEMPTS = 5;
        const MAX_NO_CODE = 3;

        let code = null;
        let no_code_failures = 0;
        for (let i=0; i<MAX_ATTEMPTS; i++) {
            if (this.agent.bot.interrupt_code)
                return null;
            const messages_copy = JSON.parse(JSON.stringify(messages));
            let res = await this.agent.prompter.promptCoding(messages_copy);
            if (this.agent.bot.interrupt_code)
                return null;
            let contains_code = res.indexOf('```') !== -1;
            if (!contains_code) {
                if (res.indexOf('!newAction') !== -1) {
                    messages.push({
                        role: 'assistant', 
                        content: res.substring(0, res.indexOf('!newAction'))
                    });
                    continue; // using newaction will continue the loop
                }
                
                if (no_code_failures >= MAX_NO_CODE) {
                    console.warn("Action failed, agent would not write code.");
                    return 'Action failed, agent would not write code.';
                }
                messages.push({
                    role: 'system', 
                    content: 'Error: no code provided. Write code in codeblock in your response. ``` // example ```'}
                );
                console.warn("No code block generated. Trying again.");
                no_code_failures++;
                continue;
            }
            code = res.substring(res.indexOf('```')+3, res.lastIndexOf('```'));
            const result = await this._stageCode(code);
            if (!result) {
                console.warn("Failed to stage code, something is wrong.");
                return 'Failed to stage code, something is wrong.';
            }
            if (result.syntaxError) {
                const message = 'Error: Code failed to compile (syntax error):\n' + result.syntaxError
                    + '\nWrite ONLY the raw statements of the action body — do NOT wrap them in '
                    + '`export`, `function main(){...}`, or `module.exports`. Please try again.';
                console.warn('Syntax error staging code:\n' + result.syntaxError + '\n');
                messages.push({ role: 'assistant', content: res });
                messages.push({ role: 'system', content: message });
                continue;
            }
            const executionModule = result.func;
            const lintResult = await this._lintCode(result.src_lint_copy);
            if (lintResult) {
                const message = 'Error: Code lint error:'+'\n'+lintResult+'\nPlease try again.';
                console.warn("Linting error:"+'\n'+lintResult+'\n');
                messages.push({ role: 'system', content: message });
                continue;
            }
            if (!executionModule) {
                console.warn("Failed to stage code, something is wrong.");
                return 'Failed to stage code, something is wrong.';
            }

            try {
                console.log('Executing code...');
                await executionModule.main(this.agent.bot);

                const code_output = this.agent.actions.getBotOutputSummary();
                const summary = "Agent wrote this code: \n```" + this._sanitizeCode(code) + "```\nCode Output:\n" + code_output;
                return summary;
            } catch (e) {
                if (this.agent.bot.interrupt_code)
                    return null;
                
                console.warn('Generated code threw error: ' + e.toString());
                console.warn('trying again...');

                const code_output = this.agent.actions.getBotOutputSummary();

                messages.push({
                    role: 'assistant',
                    content: res
                });
                messages.push({
                    role: 'system',
                    content: `Code Output:\n${code_output}\nCODE EXECUTION THREW ERROR: ${e.toString()}\n Please try again:`
                });
            }
        }
        return `Code generation failed after ${MAX_ATTEMPTS} attempts.`;
    }
    
    async  _lintCode(code) {
        let result = '#### CODE ERROR INFO ###\n';
        const codeNoComments = code.replace(/\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '');
        // 只匹配真正的调用 skills.foo( / world.bar( —— 函数名必须是合法标识符。
        // 旧正则 (.*?) 会把出现在字符串/日志文本里的 "skills.breakBlockAt failed..." 一路
        // 贪吃到后面(尤其是 _stageCode 注入的 "; if(bot.interrupt_code)" 里的 '(')，
        // 造出一个根本不存在的"函数名"，把合法代码误判成缺失技能 → 无限重生成 → 任务永远做不动。
        const skillRegex = /((?:skills|world)\.([A-Za-z_$][\w$]*))\s*\(/g;
        const skills = [];
        let match;
        while ((match = skillRegex.exec(codeNoComments)) !== null) {
            skills.push(match[1]);
        }
        const allDocs = await this.agent.prompter.skill_libary.getAllSkillDocs();
        const knownSkills = new Set(allDocs.map(doc => doc.split('\n')[0]));
        const missingSkills = skills.filter(skill => !knownSkills.has(skill));
        if (missingSkills.length > 0) {
            result += 'These functions do not exist:\n';
            result += missingSkills.join('\n');
            console.log(result)
            return result;
        }

        const eslint = new ESLint();
        const results = await eslint.lintText(code);
        const codeLines = code.split('\n');
        const exceptions = results.map(r => r.messages).flat();

        if (exceptions.length > 0) {
            exceptions.forEach((exc, index) => {
                if (exc.line && exc.column ) {
                    const errorLine = codeLines[exc.line - 1]?.trim() || 'Unable to retrieve error line content';
                    result += `#ERROR ${index + 1}\n`;
                    result += `Message: ${exc.message}\n`;
                    result += `Location: Line ${exc.line}, Column ${exc.column}\n`;
                    result += `Related Code Line: ${errorLine}\n`;
                }
            });
            result += 'The code contains exceptions and cannot continue execution.';
        } else {
            return null;//no error
        }

        return result ;
    }
    // write custom code to file and import it
    // write custom code to file and prepare for evaluation
    async _stageCode(code) {
        code = this._sanitizeCode(code);
        let src = '';
        code = code.replaceAll('console.log(', 'log(bot,');
        code = code.replaceAll('log("', 'log(bot,"');

        console.log(`Generated code: """${code}"""`);

        // this may cause problems in callback functions
        code = code.replaceAll(';\n', '; if(bot.interrupt_code) {log(bot, "Code interrupted.");return;}\n');
        for (let line of code.split('\n')) {
            src += `    ${line}\n`;
        }
        let src_lint_copy = this.code_lint_template.replace('/* CODE HERE */', src);
        src = this.code_template.replace('/* CODE HERE */', src);

        let filename = this.file_counter + '.js';
        // if (this.file_counter > 0) {
        //     let prev_filename = this.fp + (this.file_counter-1) + '.js';
        //     unlink(prev_filename, (err) => {
        //         console.log("deleted file " + prev_filename);
        //         if (err) console.error(err);
        //     });
        // } commented for now, useful to keep files for debugging
        this.file_counter++;
        
        let write_result = await this._writeFilePromise('.' + this.fp + filename, src);
        // This is where we determine the environment the agent's code should be exposed to.
        // It will only have access to these things, (in addition to basic javascript objects like Array, Object, etc.)
        // Note that the code may be able to modify the exposed objects.
        const compartment = makeCompartment({
            skills,
            log: skills.log,
            world,
            tick_confirm,
            Vec3,
        });
        // ★2026-07-09: evaluate 抛的语法错误(如残留 `export` / 括号不配)以前直接冒泡出
        //   _generateCode 无 try/catch → 整条 newAction 一次性夭折, 不重试。改为捕获成可反馈的
        //   syntaxError, 让上层当作 lint 错误喂回模型, 用掉剩余 attempt 自我纠正。
        let mainFn = null;
        try {
            mainFn = compartment.evaluate(src);
        } catch (e) {
            console.warn('Compartment evaluate (syntax) error: ' + (e && e.message || e));
            return { syntaxError: (e && e.message) ? e.message : String(e), src_lint_copy };
        }

        if (write_result) {
            console.error('Error writing code execution file: ' + write_result);
            return null;
        }
        return { func:{main: mainFn}, src_lint_copy: src_lint_copy };
    }

    _sanitizeCode(code) {
        code = code.trim();
        const remove_strs = ['Javascript', 'javascript', 'js']
        for (let r of remove_strs) {
            if (code.startsWith(r)) {
                code = code.slice(r.length);
                break;
            }
        }
        code = code.trim();
        // ★2026-07-09: coding 模型(尤其 gpt-5.x-mini)时不时把整段包成模块 `export async function
        //   main(bot){ ... }` / `async function main(bot){ ... }`。execTemplate 把代码塞进
        //   `(async (bot)=>{ /* CODE HERE */ })`, 于是 `export` 落在函数体里 → compartment.evaluate
        //   直接抛 `SyntaxError: Unexpected token 'export'`, 把整条(本来正确的) newAction 一次性打死。
        //   这里把这种 main 包裹拆成裸函数体, 顺带清掉裸 `export ` 前缀。
        const mainWrap = code.match(/^export\s+default\s+|^export\s+|^module\.exports\s*=\s*/);
        let stripped = mainWrap ? code.slice(mainWrap[0].length).trim() : code;
        const fnHead = stripped.match(/^(?:async\s+)?function\s+\w*\s*\([^)]*\)\s*\{/);
        if (fnHead) {
            const bodyStart = stripped.indexOf('{');
            const bodyEnd = stripped.lastIndexOf('}');
            if (bodyStart !== -1 && bodyEnd > bodyStart) {
                return stripped.slice(bodyStart + 1, bodyEnd).trim();
            }
        }
        // 无 main 包裹但仍有裸 `export ` 前缀(如 `export const ...`)→ 去掉关键字保留声明。
        if (mainWrap && !fnHead) return stripped;
        return code;
    }

    _writeFilePromise(filename, src) {
        // makes it so we can await this function
        return new Promise((resolve, reject) => {
            writeFile(filename, src, (err) => {
                if (err) {
                    reject(err);
                } else {
                    resolve();
                }
            });
        });
    }
}