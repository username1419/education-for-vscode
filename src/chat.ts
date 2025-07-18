import * as vscode from 'vscode';
import { Ollama } from 'ollama';
import * as util from './util';
import * as fs from 'fs';

class ChatRequest {
    constructor(
        public readonly role: 'system' | 'user' | 'assistant',
        public readonly content: string
    ) { }
}

export class Chat implements vscode.WebviewViewProvider {
    private chatHistory: ChatRequest[] = [];
    private readonly ollamaAPI: Ollama = new Ollama();
    private readonly extensionUri: vscode.Uri;
    private modelInfo: util.Model[] = [];

    constructor(private readonly extensionContext: vscode.ExtensionContext, private readonly instructions: string) {
        this.chatHistory.push(
            new ChatRequest(
                'system',
                `You are a computer science teacher for the user. Don't tell the user the answer or full solution, but rather, provide hints and guide them towards the solution. Refuse to answer politely if the question is not related to programming and/or computer science. 
                Assist with the user's technical issues directly, using the information provided below. In addition, the user can use the following commands in Visual Studio Code's Command Palette: 'Education for VSCode: Reset Lesson' to reset their lesson to its initial state, 'Education for VSCode: Submit Code' to submit their work, and 'Education for VSCode: End Study' to end their lesson.
                The user has been shown the following instructions: \n${instructions || "no instructions"}
                `)
        );

        this.extensionUri = extensionContext.extensionUri;
    }

    public async generateChatResponse(userPrompt: string, model: util.Model, callback: (responsePart: string) => void, callbackEnd: (responseFull: string) => void) {

        const request = new ChatRequest('user', userPrompt);
        this.chatHistory.push(request);

        let assistantResponse = "";
        this.ollamaAPI.chat({
            model: model.toString(),
            messages: this.chatHistory,
            stream: true
        }).then(async stream => {
            for await (const part of stream) {
                callback(part.message.content);
                assistantResponse += part.message.content;
            }
            callbackEnd(assistantResponse);
        });
    }

    resolveWebviewView(webviewView: vscode.WebviewView, context: vscode.WebviewViewResolveContext, token: vscode.CancellationToken) {
        webviewView.webview.options = {
            enableScripts: true,
            enableForms: true,
            localResourceRoots: [util.joinValidPath(this.extensionUri, 'resources', 'contents')]
        };

        const htmlPath = util.joinValidPath(this.extensionUri, 'resources', 'contents', 'chatview', 'chat.html');
        let htmlContent = fs.readFileSync(htmlPath.fsPath, { encoding: 'utf-8' });
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
        const reqModels = (util.execute(ollamaPath, ['list'], { encoding: 'utf-8' }).stdout || "").split('\n');
        reqModels.shift();
        reqModels.pop();
        reqModels.forEach(model => {
            const modelData = model.replaceAll(/\s+/g, ' ').split(' ')[0].split(':');
            if (!!this.modelInfo.find(v => v.modelName === model[0] && v.parameterSize === model[1])) {
                return;
            }
            this.modelInfo.push(new util.Model(modelData[0], modelData[1]));
        });
        webviewView.webview.postMessage({
            command: 'createModelOptions',
            content: this.modelInfo
        });

        webviewView.webview.onDidReceiveMessage(m => this.handleWebviewRequest(m, webviewView));
    }

    handleWebviewRequest(message: any, webviewView: vscode.WebviewView) {
        if (typeof message.command !== 'string') { return; }
        switch (message.command) {
            case 'reqChatMessage':
                webviewView.webview.postMessage({ command: 'chatMessageBegin' });
                const [modelName, parameterSize] = message.content.modelName.split(':');
                const model = new util.Model(modelName, parameterSize);

                const userPrompt = message.content.userPrompt;

                
                try {
                    let isThinking = false;
                    const streamResponseToWebview = (responsePart: string) => {
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
                    };

                    const addResponseToHistory = (response: string) => {
                        webviewView.webview.postMessage({ command: 'chatMessageDone' });
                        const assistantResponse = new ChatRequest('assistant', response);
                        this.chatHistory.push(assistantResponse);
                    };

                    this.generateChatResponse(
                        userPrompt,
                        model,
                        streamResponseToWebview,
                        addResponseToHistory
                    );
                } catch (err) {
                    webviewView.webview.postMessage({ command: 'chatMessageAppend', content: err });
                    webviewView.webview.postMessage({ command: 'chatMessageDone' });
                }
                break;

            default:
                util.logError(this.extensionContext.extension.id, `Command not recognized. Command: ${message.command}`);
                break;

        }
    }
}