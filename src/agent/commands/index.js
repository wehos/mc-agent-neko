import { getBlockId, getItemId } from "../../utils/mcdata.js";
import { actionsList } from './actions.js';
import { queryList } from './queries.js';

let suppressNoDomainWarning = true;

const commandList = queryList.concat(actionsList);
const commandMap = {};
for (let command of commandList) {
    commandMap[command.name] = command;
}

export function getCommand(name) {
    return commandMap[name];
}

export function blacklistCommands(commands) {
    const unblockable = ['!stop', '!stats', '!inventory', '!goal'];
    for (let command_name of commands) {
        if (unblockable.includes(command_name)){
            console.warn(`Command ${command_name} is unblockable`);
            continue;
        }
        delete commandMap[command_name];
        delete commandList.find(command => command.name === command_name);
    }
}

const commandRegex = /!(\w+)(?:\(((?:-?\d+(?:\.\d+)?|true|false|"[^"]*")(?:\s*,\s*(?:-?\d+(?:\.\d+)?|true|false|"[^"]*"))*)\))?/
const argRegex = /-?\d+(?:\.\d+)?|true|false|"[^"]*"/g;

export function containsCommand(message) {
    const commandMatch = message.match(commandRegex);
    if (commandMatch)
        return "!" + commandMatch[1];
    return null;
}

export function commandExists(commandName) {
    if (!commandName.startsWith("!"))
        commandName = "!" + commandName;
    return commandMap[commandName] !== undefined;
}

/**
 * Converts a string into a boolean.
 * @param {string} input
 * @returns {boolean | null} the boolean or `null` if it could not be parsed.
 * */
function parseBoolean(input) {
    switch(input.toLowerCase()) {
        case 'false': //These are interpreted as flase;
        case 'f':
        case '0':
        case 'off':
            return false;
        case 'true': //These are interpreted as true;
        case 't':
        case '1':
        case 'on':
            return true;
        default:
            return null;
    }
}

/**
 * @param {number} value - the value to check
 * @param {number} lowerBound
 * @param {number} upperBound
 * @param {string} endpointType - The type of the endpoints represented as a two character string. `'[)'` `'()'` 
 */
function checkInInterval(number, lowerBound, upperBound, endpointType) {
    switch (endpointType) {
        case '[)':
            return lowerBound <= number && number < upperBound;
        case '()':
            return lowerBound < number && number < upperBound;
        case '(]':
            return lowerBound < number && number <= upperBound;
        case '[]':
            return lowerBound <= number && number <= upperBound;
        default:
            throw new Error('Unknown endpoint type:', endpointType)
    }
}



// todo: handle arrays?
/**
 * Returns an object containing the command, the command name, and the comand parameters.
 * If parsing unsuccessful, returns an error message as a string.
 * @param {string} message - A message from a player or language model containing a command.
 * @returns {string | Object}
 */
export function parseCommandMessage(message) {
    const commandMatch = message.match(commandRegex);
    if (!commandMatch) return `Command is incorrectly formatted`;

    const commandName = "!"+commandMatch[1];

    let args;
    if (commandMatch[2]) args = commandMatch[2].match(argRegex);
    else args = [];

    const command = getCommand(commandName);
    if(!command) return `${commandName} is not a command.`

    const params = commandParams(command);
    const paramNames = commandParamNames(command);
    
    if (args.length !== params.length)
        return `Command ${command.name} was given ${args.length} args, but requires ${params.length} args.`;

    
    for (let i = 0; i < args.length; i++) {
        const param = params[i];
        //Remove any extra characters
        let arg = args[i].trim();
        if ((arg.startsWith('"') && arg.endsWith('"')) || (arg.startsWith("'") && arg.endsWith("'"))) {
            arg = arg.substring(1, arg.length-1);
        }
        
        //Convert to the correct type
        switch(param.type) {
            case 'int':
                arg = Number.parseInt(arg); break;
            case 'float':
                arg = Number.parseFloat(arg); break;
            case 'boolean':
                arg = parseBoolean(arg); break;
            case 'BlockName':
            case 'BlockOrItemName':
            case 'ItemName':
                if (arg.endsWith('plank') || arg.endsWith('seed'))
                    arg += 's'; // add 's' to for common mistakes like "oak_plank" or "wheat_seed"
            case 'string':
                break;
            default:
                throw new Error(`Command '${commandName}' parameter '${paramNames[i]}' has an unknown type: ${param.type}`);
        }
        if(arg === null || Number.isNaN(arg))
            return `Error: Param '${paramNames[i]}' must be of type ${param.type}.`

        if(typeof arg === 'number') { //Check the domain of numbers
            const domain = param.domain;
            if(domain) {
                /**
                 * Javascript has a built in object for sets but not intervals.
                 * Currently the interval (lowerbound,upperbound] is represented as an Array: `[lowerbound, upperbound, '(]']`
                 */
                if (!domain[2]) domain[2] = '[)'; //By default, lower bound is included. Upper is not.

                if(!checkInInterval(arg, ...domain)) {
                    return `Error: Param '${paramNames[i]}' must be an element of ${domain[2][0]}${domain[0]}, ${domain[1]}${domain[2][1]}.`;
                    //Alternatively arg could be set to the nearest value in the domain.
                }
            } else if (!suppressNoDomainWarning) {
                console.warn(`Command '${commandName}' parameter '${paramNames[i]}' has no domain set. Expect any value [-Infinity, Infinity].`)
                suppressNoDomainWarning = true; //Don't spam console. Only give the warning once.
            }
        } else if(param.type === 'BlockName') { //Check that there is a block with this name
            if(getBlockId(arg) == null) return  `Invalid block type: ${arg}.`
        } else if(param.type === 'ItemName') { //Check that there is an item with this name
            if(getItemId(arg) == null) return `Invalid item type: ${arg}.`
        } else if(param.type === 'BlockOrItemName') {
            if(getBlockId(arg) == null && getItemId(arg) == null) return  `Invalid block or item type: ${arg}.`
        }
        args[i] = arg;
    }
    
    return { commandName, args };
}

export function truncCommandMessage(message) {
    const commandMatch = message.match(commandRegex);
    if (commandMatch) {
        return message.substring(0, commandMatch.index + commandMatch[0].length);
    }
    return message;
}

// ★2026-07-08 (用户令: admin/mission 回合允许多命令一回合) —— 抽出一条回复里【全部】命令(按序),
//   如 "先看看 !inventory 再 !getWood(20)" → ['!inventory', '!getWood(20)']。每个元素都是单条命令
//   子串, 可直接喂给 executeCommand (它内部用非全局 commandRegex 只解析首条)。默认单命令路径不用它,
//   语义不变; 仅 handleMessage 的外部意图独占回合按序执行本数组。
export function parseCommandStrings(message) {
    const g = new RegExp(commandRegex.source, 'g');
    const out = [];
    let m;
    while ((m = g.exec(message)) !== null) {
        out.push(m[0]);
        if (m.index === g.lastIndex) g.lastIndex++;   // 防零长匹配死循环
    }
    return out;
}

// truncCommandMessage 的多命令版: 保留到【最后】一条命令结束(只丢弃末条命令之后的散文/注释),
// 用作多命令回合里写回 history 的 assistant 文本。
export function truncCommandMessageMulti(message) {
    const g = new RegExp(commandRegex.source, 'g');
    let last = null, m;
    while ((m = g.exec(message)) !== null) {
        last = m;
        if (m.index === g.lastIndex) g.lastIndex++;
    }
    if (last) return message.substring(0, last.index + last[0].length);
    return message;
}

export function isAction(name) {
    return actionsList.find(action => action.name === name) !== undefined;
}

/**
 * @param {Object} command
 * @returns {Object[]} The command's parameters.
 */
function commandParams(command) {
    if (!command.params)
        return [];
    return Object.values(command.params);
}

/**
 * @param {Object} command
 * @returns {string[]} The names of the command's parameters.
 */
function commandParamNames(command) {
    if (!command.params)
        return [];
    return Object.keys(command.params);
}

function numParams(command) {
    return commandParams(command).length;
}

export async function executeCommand(agent, message) {
    let parsed = parseCommandMessage(message);
    if (typeof parsed === 'string')
        return parsed; //The command was incorrectly formatted or an invalid input was given.
    else {
        console.log('parsed command:', parsed);
        const command = getCommand(parsed.commandName);
        let numArgs = 0;
        if (parsed.args) {
            numArgs = parsed.args.length;
        }
        if (numArgs !== numParams(command))
            return `Command ${command.name} was given ${numArgs} args, but requires ${numParams(command)} args.`;
        else {
            const result = await command.perform(agent, ...parsed.args);
            return result;
        }
    }
}

export function getCommandDocs(agent) {
    const typeTranslations = {
        //This was added to keep the prompt the same as before type checks were implemented.
        //If the language model is giving invalid inputs changing this might help.
        'float':             'number',
        'int':               'number',
        'BlockName':         'string',
        'ItemName':          'string',
        'BlockOrItemName':   'string',
        'boolean':           'bool'
    }
    let docs = `\n*COMMAND DOCS\n You can use the following commands to perform actions and get information about the world. 
    Use the commands with the syntax: !commandName or !commandName("arg1", 1.2, ...) if the command takes arguments.\n
    Do not use codeblocks. Use double quotes for strings.
    Normally use ONE command per response and wait for its result. BUT when you are working on a commanded task and are certain of a short fixed sequence of steps (e.g. gather then craft then smelt), you MAY chain several commands in one response — they run in order — to finish faster. If you must SEE a command's result before deciding the next step, use just one. Trailing prose after the last command is ignored.\n`;
    for (let command of commandList) {
        if (agent.blocked_actions.includes(command.name)) {
            continue;
        }
        docs += command.name + ': ' + command.description + '\n';
        if (command.params) {
            docs += 'Params:\n';
            for (let param in command.params) {
                docs += `${param}: (${typeTranslations[command.params[param].type]??command.params[param].type}) ${command.params[param].description}\n`;
            }
        }
    }
    // Append the CUSTOM SKILLS catalog so the model sees, alongside the !runSkill command
    // above, exactly which skill names it may pass to it (a code-context variant also feeds
    // $CODE_DOCS for !newAction). Skipped when !runSkill itself is blocked/blacklisted —
    // otherwise every prompt would keep instructing a command that no longer exists.
    // Wrapped — a missing prompter/skill_libary must never break command docs.
    if (commandMap['!runSkill'] && !agent.blocked_actions.includes('!runSkill')) {
        try { docs += agent.prompter.skill_libary.getCustomSkillManifest('command'); } catch (e) {}
    }
    return docs + '*\n';
}
