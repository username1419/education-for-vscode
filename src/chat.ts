import * as vscode from 'vscode';
import { Ollama } from 'ollama';
import * as util from './util';
import * as fs from 'fs';
import si from 'systeminformation';
import { spawnSync } from 'child_process';

const extensionName = "education-for-vscode";

class ChatRequest {
    constructor(
        public readonly role: 'system' | 'user' | 'assistant',
        public readonly content: string
    ) { }
}

export class Model {
    // tried the same system message on all models, codeLlama seems to just not be able to follow system instructions that well
    // TODO: do the chatGPT api thing
    public static availableModels = ['deepseek-r1', 'codellama', 'gpt'];

    constructor(
        public readonly modelName: string,
        public readonly parameterSize: string
    ) { }

    public toString() {
        return `${this.modelName}:${this.parameterSize}`;
    }
}

export class Chat implements vscode.WebviewViewProvider {
    private chatHistory: ChatRequest[] = [];
    private readonly ollamaAPI: Ollama = new Ollama();
    private readonly extensionUri: vscode.Uri;
    private modelInfo: Model[] = [];

    constructor(private readonly extensionContext: vscode.ExtensionContext, private readonly instructions: string) {
        this.chatHistory.push(
            new ChatRequest(
                'system',
                `You are a computer science teacher for the user. Don't tell the user the answer or full solution, but rather, provide hints and guide them towards the solution. Refuse to answer politely if the question is not related to programming and/or computer science. 
                Assist with the user's technical issues directly, using the information provided below. In addition, the user can use the following commands in Visual Studio Code's Command Palette: 'Education for VSCode: Reset Lesson' to reset their lesson to its initial state, 'Education for VSCode: Submit Code' to submit their work, and 'Education for VSCode: End Study' to end their lesson.
                The user has been shown the rendered representation of the following html file: \`\`\`html\n${instructions || "no instructions"}\`\`\`
                `)
        );

        this.extensionUri = extensionContext.extensionUri;
    }

    public async generateChatResponse(userPrompt: string, model: Model, callback: (responsePart: string) => void, callbackEnd: () => void) {
        const request = new ChatRequest('user', userPrompt);
        this.chatHistory.push(request);

        this.ollamaAPI.chat({
            model: model.toString(),
            messages: this.chatHistory,
            stream: true
        }).then(async stream => {
            for await (const part of stream) {
                callback(part.message.content);
            }
            callbackEnd();
        });
    }

    resolveWebviewView(webviewView: vscode.WebviewView, context: vscode.WebviewViewResolveContext, token: vscode.CancellationToken) {
        webviewView.webview.options = {
            enableScripts: true,
            enableForms: true,
            localResourceRoots: [vscode.Uri.joinPath(this.extensionUri, 'resources', 'contents')]
        };

        const htmlPath = vscode.Uri.joinPath(this.extensionUri, 'resources', 'contents', 'chatview', 'chat.html');
        let htmlContent = fs.readFileSync(htmlPath.path, { encoding: 'utf-8' });
        webviewView.webview.html = htmlContent;

        // post the available models
        let ollamaPath: string = this.extensionContext.globalState.get(util.stateKeys.ollamaPath, '') === '' ?
            util.getApplicationPath("ollama")?.fsPath || '' : this.extensionContext.globalState.get(util.stateKeys.ollamaPath, '');

        if (this.extensionContext.globalState.get(util.stateKeys.ollamaPath, '') === '') {
            if (ollamaPath !== '') {
                this.extensionContext.globalState.update(util.stateKeys.ollamaPath, ollamaPath);
            } else {
                vscode.window.showErrorMessage("Ollama not found. Go to Command Palette(Ctrl+Shift+P) > Education for VSCode: Run Ollama Setup");
                return;
            }
        }
        const reqModels = spawnSync(ollamaPath, ['list'], {encoding: 'utf-8'}).stdout.split('\n');
        reqModels.shift();
        reqModels.pop();
        reqModels.forEach(model => {
            const modelData = model.replaceAll(/\s+/g, ' ').split(' ')[0].split(':');
            if (!!this.modelInfo.find(v => v.modelName === model[0] && v.parameterSize === model[1])) {
                return;
            }
            this.modelInfo.push(new Model(modelData[0], modelData[1]));
        });
        webviewView.webview.postMessage({
            command: 'createModelOptions',
            content: this.modelInfo
        });

        webviewView.webview.onDidReceiveMessage(message => {
            if (typeof message.command !== 'string') { return; }
            switch (message.command) {
                case 'reqChatMessage':
                    webviewView.webview.postMessage({ command: 'chatMessageBegin' });
                    const modelName = message.content.modelName;
                    const parameterSize = message.content.parameterSize;
                    const model = new Model(modelName, parameterSize);

                    const userPrompt = message.content.userPrompt;

                    try {
                        let isThinking = false;
                        this.generateChatResponse(
                            userPrompt,
                            model,
                            responsePart => {
                                if (responsePart === '\n\n') {
                                    return;
                                }
                                if (responsePart === '</think>') {
                                    isThinking = false;
                                    return;
                                }
                                if (responsePart === '<think>' || isThinking) {
                                    isThinking = true;
                                }
                                webviewView.webview.postMessage({
                                    command: 'chatMessageAppend',
                                    content: isThinking ? {} : responsePart
                                });
                            },
                            () => webviewView.webview.postMessage({command: 'chatMessgaeDone'})
                        );
                    } catch (err) {
                        webviewView.webview.postMessage({command: 'chatMessageAppend', content: err});
                        webviewView.webview.postMessage({command: 'chatMessageDone'});
                    }
                    break;

                default:
                    util.logError(extensionName, `Command not recognized. Command: ${message.command}`);
                    break;

            }
        });
    }
}

export class ChatModelInstaller implements vscode.WebviewViewProvider {
    private readonly extensionUri;
    private modelInfo: util.ModelInfo[] = [];
    constructor(private readonly extensionContext: vscode.ExtensionContext) {
        this.extensionUri = extensionContext.extensionUri;
    }

    resolveWebviewView(webviewView: vscode.WebviewView, context: vscode.WebviewViewResolveContext, token: vscode.CancellationToken) {
        webviewView.webview.options = {
            enableScripts: true,
            localResourceRoots: [vscode.Uri.joinPath(this.extensionUri, 'resources', 'contents')]
        };

        const htmlPath = vscode.Uri.joinPath(this.extensionUri, 'resources', 'contents', 'chatview', 'installer.html');
        let htmlContent = fs.readFileSync(htmlPath.path, { encoding: 'utf-8' });
        webviewView.webview.html = htmlContent;

        let messageModelContent = { command: 'createModelOptions', content: [] as string[] };
        messageModelContent.content.push(...Model.availableModels);
        webviewView.webview.postMessage(messageModelContent);

        // events
        webviewView.webview.onDidReceiveMessage(message => {
            if (typeof message.command !== 'string') { return; }
            switch (message.command) {
                case 'installModel': {
                    if (!(typeof message.model === 'string')) {
                        util.logError(`wrong message model: expected 'string' type instead of ${typeof message.model}`);
                        return;
                    }
                    if (!(typeof message.params === 'string')) {
                        util.logError(`wrong message content: expected 'string' instead of ${typeof message.params}`);
                        return;
                    }

                    let filePath: string = this.extensionContext.globalState.get(util.stateKeys.ollamaPath, '') === '' ?
                        util.getApplicationPath("ollama")?.fsPath || '' : this.extensionContext.globalState.get(util.stateKeys.ollamaPath, '');

                    if (this.extensionContext.globalState.get(util.stateKeys.ollamaPath, '') === '') {
                        if (filePath !== '') {
                            this.extensionContext.globalState.update(util.stateKeys.ollamaPath, filePath);
                        } else {
                            vscode.window.showErrorMessage("Ollama not found. Go to Command Palette(Ctrl+Shift+P) > Education for VSCode: Run Ollama Setup");
                            return;
                        }
                    }

                    if (!this.extensionContext.globalState.get(util.stateKeys.isOllamaInstalled)) {
                        this.extensionContext.globalState.update(util.stateKeys.isOllamaInstalled, true);
                    }

                    // install the models
                    if (typeof message.model !== 'string' || typeof message.params !== 'string') {
                        return;
                    }
                    const model = message.model;
                    const params = message.params;
                    const terminal = vscode.window.createTerminal("Model Installer");
                    terminal.sendText(`${this.extensionContext.globalState.get(util.stateKeys.ollamaPath)} pull ${model}:${params}`);
                    terminal.show();
                    break;
                }
                case 'setParamsReq': {

                    if (!(typeof message.model === 'string')) {
                        util.logError(`wrong message model: expected 'string' type instead of ${typeof message.model}`);
                        return;
                    }
                    let messageParamsContent = { command: 'createParamsOptions', content: [] as util.ModelInfo[] };
                    this.modelInfo = util.getOllamaModelData(message.model);
                    messageParamsContent.content = this.modelInfo;

                    webviewView.webview.postMessage(messageParamsContent);
                    break;
                }
                case 'validateParamsReq': {
                    if (!(typeof message.param === "string")) {
                        util.logError(`wrong message param: expected 'string' instead got ${typeof message.param}`);
                        return;
                    }
                    const checkModelRequirements = async () => {
                        let warning = "";
                        const gigabyte = 1000000000;

                        const param: string = message.param;
                        const paramMultiplier = param.substring(param.length - 1).toLowerCase() === 'b' ? 1 : 0.001;
                        const paramValue = Number.parseInt(param.substring(0, param.length - 1));

                        const selectedModel = this.modelInfo.find(v => v.parameterSize === param);
                        if (selectedModel === undefined) { return; }
                        const requiredDiskSpace = selectedModel.size;
                        const requiredRAM = paramValue * paramMultiplier; // more accurate formula needed
                        const currentRAM = Number.parseFloat(((await si.mem()).total / gigabyte).toFixed(1)); // total memory in GB


                        // formula taken from https://www.substratus.ai/blog/calculating-gpu-memory-for-llm
                        const requiredVRAM = ((paramValue * paramMultiplier) * 4) / (32 / selectedModel.quantizationSize);
                        const currentVRAM = Number.parseFloat((util.getMachineVRAM() / gigabyte).toFixed(1));
                        const recommendedVRAM = requiredVRAM * 1.2;

                        // TODO: do the param confirmation
                        warning += `This model requires ${requiredDiskSpace} to download.\n`;
                        warning += `This model requires ${requiredRAM}GB of RAM to run.\n`;
                        warning += `You currently have ${currentRAM}GB of RAM in total.\n`;
                        warning += `\nThis model requires ${requiredVRAM}GB of VRAM to run.\n`;
                        warning += `It is recommended to have ${recommendedVRAM}GB of VRAM to run\n`;
                        if (requiredVRAM >= currentVRAM) {
                            warning += `You don't have enough VRAM to load the model to GPU memory. Running the model in this state may take a lot longer.\n`;
                        }
                        if (requiredRAM >= currentRAM) {
                            warning += `You don't have enough RAM to run this model.\n`;
                        }
                        webviewView.webview.postMessage({command: 'setWarningMessage', content: warning});
                    };

                    checkModelRequirements();
                    break;
                }
                default: {
                    util.logError(extensionName, `Command not recognized. Command: ${message.command}`);
                    break;
                }
            }
        });
    }
}