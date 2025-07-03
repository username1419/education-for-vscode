import * as vscode from 'vscode';
import { Ollama } from 'ollama';
import * as util from './util';
import * as fs from 'fs';

const extensionName = "education-for-vscode";

class ChatRequest {
    constructor(
        public readonly role: 'system' | 'user' | 'assistant', 
        public readonly content: string
    ) { }
}

export class Model {
    // tried the same system message on all models, codeLlama seems to just not be able to follow system instructions that well
    static readonly codeLlama = new Model("education-for-vscode.codellama", "codellama", true);
    static readonly deepseek = new Model("education-for-vscode.deepseek-r1", "deepseek-r1", true);
    static readonly GPT = new Model("education-for-vscode.gpt", "chatGPT", false);

    constructor(
        public readonly id: string, 
        public readonly value: string, 
        public readonly ollamaCompatible: boolean
    ) { }
}

export class Chat implements vscode.WebviewViewProvider {
    private chatHistory: ChatRequest[] = [];
    private readonly ollamaAPI: Ollama = new Ollama();

    constructor(private readonly extensionUri: vscode.Uri, private readonly instructions: string) {
        this.chatHistory.push(
            new ChatRequest(
                'system', 
                `You are a computer science teacher for the user. Don't tell the user the answer or full solution, but rather, provide hints and guide them towards the solution. Refuse to answer politely if the question is not related to programming and/or computer science. The student has been shown the following instruction: "${instructions}"`)
        );
    }

    public async generateChatResponse(userPrompt: string, model: Model, callback: (responsePart: string) => void) {
        const request = new ChatRequest('user', userPrompt);
        this.chatHistory.push(request);

        this.ollamaAPI.chat({
            model: model.value,
            messages: this.chatHistory,
            stream: true
        }).then(async stream => {
            for await (const part of stream) {
                callback(part.message.content);
            }
        });
    }

    resolveWebviewView(webviewView: vscode.WebviewView, context: vscode.WebviewViewResolveContext, token: vscode.CancellationToken) {
        webviewView.webview.options = {
            enableScripts: true,
            enableForms: true,
            localResourceRoots: [vscode.Uri.joinPath(this.extensionUri, 'resources', 'contents', 'chat')]
        };

        

        const htmlPath = vscode.Uri.joinPath(this.extensionUri, 'resources', 'contents', 'chat', 'chat.html');
        let htmlContent = fs.readFileSync(htmlPath.path, { encoding: 'utf-8' });
        webviewView.webview.html = htmlContent;

        webviewView.webview.onDidReceiveMessage(message => {
            if (typeof message.command !== 'string') { return; }
            switch (message.command) {
                case 'reqChatMessage':
                    webviewView.webview.postMessage({ command: 'chatMessageBegin' });

                    this.generateChatResponse(
                        message.content,
                        Model.deepseek, // TODO: change this when implementing the model selector
                        responsePart => {
                            webviewView.webview.postMessage({
                                command: 'chatMessageAppend', 
                                content: responsePart
                            });
                        }
                    );
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
    constructor(private readonly extensionContext: vscode.ExtensionContext) {
        this.extensionUri = extensionContext.extensionUri;
    }

    installOllama() {
        if (vscode.window.terminals.find(t => t.name === "Ollama Installer")) {
            vscode.window.showWarningMessage("Please check the 'Ollama Installer' terminal to install the required programs");
            return;
        }
        const terminal = vscode.window.createTerminal("Ollama Installer");
        terminal.show();
        vscode.window.showInformationMessage('The extension "Education for VSCode" is downloading ollama. You can install your language model after setup.');
        
        switch (process.platform) {
            case 'linux':
                // do this in the terminal: curl -fsSL https://ollama.com/install.sh | sh
                terminal.sendText("curl -fsSL https://ollama.com/install.sh | sh");
                break;

            case 'win32':
                // get request to https://ollama.com/download/OllamaSetup.exe
                terminal.sendText('curl -L -o ollamasetup.exe "https://ollama.com/download/OllamaSetup.exe"');
                // run the executable
                terminal.sendText('ollamasetup.exe');
                break;

            default:
                vscode.window.showInformationMessage("sorry bro youre on your own try downloading ollama yourself");
                break;
        }
    }

    resolveWebviewView(webviewView: vscode.WebviewView, context: vscode.WebviewViewResolveContext, token: vscode.CancellationToken) {
        webviewView.webview.options = {
            enableScripts: true,
            localResourceRoots: [vscode.Uri.joinPath(this.extensionUri, 'resources', 'contents', 'chat')]
        };

        const htmlPath = vscode.Uri.joinPath(this.extensionUri, 'resources', 'contents', 'chat', 'installer.html');
        let htmlContent = fs.readFileSync(htmlPath.path, { encoding: 'utf-8' });
        webviewView.webview.html = htmlContent;

        let messageModelContent = { command: 'createModelOptions', content: [] as string[] };
        messageModelContent.content.push(
            Model.deepseek.value,
            Model.codeLlama.value,
            Model.GPT.value
        );
        webviewView.webview.postMessage(messageModelContent);

        // events
        webviewView.webview.onDidReceiveMessage(message => {
            if (typeof message.command !== 'string') { return; }
            switch (message.command) {
                case 'installModel':
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

                            vscode.window.showWarningMessage("Doing this will require installing 'ollama'(required 1GB, recommended >6GB). Do you want to continue?", 'Yes', 'No')
                                .then(answer => {
                                    if (answer === 'Yes') {
                                        this.installOllama();
                                        return;
                                    }
                                    vscode.window.showInformationMessage("Do you want to set ollama's PATH manually?", "Yes", "No")
                                        .then(answer => {
                                            if (answer === 'No') {
                                                return;
                                            }
                                            util.setOllamaPATH(this.extensionContext);
                                        });
                                });
                            return;
                        }
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

                case 'setParamsReq':

                    if (!(typeof message.model === 'string')) {
                        util.logError(`wrong message model: expected 'string' type instead of ${typeof message.model}`);
                        return;
                    }
                    let messageParamsContent = { command: 'createParamsOptions', content: [] as util.ModelInfo[]};
                    messageParamsContent.content = util.getOllamaModelData(message.model);

                    webviewView.webview.postMessage(messageParamsContent);
                    break;

                default:
                    util.logError(extensionName, `Command not recognized. Command: ${message.command}`);
                    break;
                }
            }
        );
    }

}