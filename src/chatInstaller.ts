import * as vscode from 'vscode';
import * as util from './util';
import * as fs from 'fs';
import si from 'systeminformation';
import * as cheerio from 'cheerio';

export class ChatModelInstaller implements vscode.WebviewViewProvider {
    private readonly extensionUri;
    private modelInfo: ModelInfo[] = [];
    constructor(private readonly extensionContext: vscode.ExtensionContext) {
        this.extensionUri = extensionContext.extensionUri;
    }

    resolveWebviewView(webviewView: vscode.WebviewView, context: vscode.WebviewViewResolveContext, token: vscode.CancellationToken) {
        webviewView.webview.options = {
            enableScripts: true,
            localResourceRoots: [util.joinValidPath(this.extensionUri, 'resources', 'contents')]
        };

        const htmlPath = util.joinValidPath(this.extensionUri, 'resources', 'contents', 'chatview', 'installer.html');
        let htmlContent = fs.readFileSync(htmlPath.fsPath, { encoding: 'utf-8' });
        webviewView.webview.html = htmlContent;

        let messageModelContent = { command: 'createModelOptions', content: [] as string[] };
        messageModelContent.content.push(...util.Model.availableModels);
        webviewView.webview.postMessage(messageModelContent);

        // events
        webviewView.webview.onDidReceiveMessage(m => this.handleWebviewRequest(m, webviewView));
    }

    handleWebviewRequest(message: any, webviewView: vscode.WebviewView) {
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

                if (this.extensionContext.globalState.get(util.stateKeys.ollamaPath, '')) {
                    if (filePath === '') {
                        vscode.window.showErrorMessage("Ollama not found. Go to Command Palette(Ctrl+Shift+P) > Education for VSCode: Run Ollama Setup");
                        return;
                    }
                    this.extensionContext.globalState.update(util.stateKeys.ollamaPath, filePath);
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
                const ollamaPath = this.extensionContext.globalState.get(util.stateKeys.ollamaPath);
                if (!(ollamaPath instanceof vscode.Uri)) {
                    return;
                }
                terminal.sendText(`${ollamaPath.fsPath} pull ${model}:${params}`);
                terminal.show();
                break;
            }
            case 'setParamsReq': {

                if (!(typeof message.model === 'string')) {
                    util.logError(`wrong message model: expected 'string' type instead of ${typeof message.model}`);
                    return;
                }
                let messageParamsContent = { command: 'createParamsOptions', content: [] as ModelInfo[] };
                this.modelInfo = getOllamaModelData(message.model);
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
                    const currentVRAM = Number.parseFloat((this.getMachineVRAM() / gigabyte).toFixed(1));
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
                util.logError(this.extensionContext.extension.id, `Command not recognized. Command: ${message.command}`);
                break;
            }
        }
    }

    /**
     * Fetches the total VRAM of the running machine
     * @returns The total VRAM of the running machine in bytes
     */
    getMachineVRAM(): number {
        let vram = 0;
        switch (process.platform) {
            case 'linux': {
                // no, i will not implement this for wayland(at least for now)
                const vramStr = ((util.execute('glxinfo', ['-B'], {encoding: 'utf-8'}) // get graphics info
                    .stdout || "").split('\n').find(s => s.includes("Video memory")) || '') // parse to get video memory
                    .trim().split(' ')[2]; // parse again to get video memory amount
                vram = Number.parseInt(vramStr.split(/[^0-9]/)[0]) * 1024**2;
                break;
            }
            case 'win32': {
                const vramStr = util.execute('powershell', ['"(Get-WmiObject Win32_VideoController).AdapterRAM"'], {encoding: 'utf-8'});
                (vramStr.stdout || '').split('\n').forEach(v => vram += Number.parseInt(v));
                break;
            }
            default: {
                break;
            }
        }
    
        return vram;
    }
    
}

/**
 * Container for language model information
 */
class ModelInfo {
    public static readonly null = new ModelInfo('', '', -1, '', '');

    constructor(
        /** The name of the model */
        public readonly name: string,
        /** The model's quantization format */
        public readonly quantization: string,
        /** The model's parameter bit precision */
        public readonly quantizationSize: number,
        /** The amount of parameters the model has */
        public readonly parameterSize: string,
        /** The disk size of the model when downloaded */
        public readonly size: string
    ) { }
}

/**
 * Scrape all model variants data from ollama.com for a certain model
 * @param model The name of the model
 * @returns An array of all unique variants of the model
 */
function getOllamaModelData(model: string): ModelInfo[] {

    vscode.window.showInformationMessage("Fetching model parameters...");

    const request = util.execute('curl.exe' , ['-Ls', `https://ollama.com/library/${model}/tags`], { encoding: 'utf-8' });
    if (typeof request.stdout !== 'string') {
        util.logError('stdout wrong type');
        return [ModelInfo.null];
    }
    const getHtmlContent = cheerio.load(request.stdout);
    let modelInfo = getHtmlContent.extract({
        id: [{
            selector: 'input.command.hidden',
            value: 'value'
        }],
        size: [
            'p.col-span-2.text-neutral-500.text-\\[13px\\]'
            // every even index is the model size 
            // every odd index is the context size
            // idk why they made it like this they just do
        ]
    });
    
    modelInfo.size = modelInfo.size.filter((_, index) => index % 2 === 0);

    const output: ModelInfo[] = [];
    const uniqueParameters: string[] = [];
    modelInfo.id.forEach((identifier, index) => {
        // model format [modelName]:[parameterSize]-[version]-[quantization (formats: https://www.reddit.com/r/LocalLLaMA/comments/1ba55rj/overview_of_gguf_quantization_methods/)]
        const identifierParts = identifier.split(':')[1].split('-');

        const modelName = identifier.split(':')[0];
        const quantization = identifierParts[identifierParts.length - 1];
        const quantizationSize = Number.isNaN(Number.parseInt(quantization.split('_')[0])) ? 
            4 : Number.parseInt(quantization.split('_')[0]);

        const parameterSize = identifierParts[0]; // TODO: change this
        const size = modelInfo.size[index];

        if (parameterSize.match('[0-9]') === null || uniqueParameters.includes(parameterSize)) {
            return;
        }
        uniqueParameters.push(parameterSize);
        output.push(new ModelInfo(modelName, quantization, quantizationSize, parameterSize, size));
    });

    return output;
}