import * as vscode from 'vscode';
import * as util from './util';
import * as fs from 'fs';
import si from 'systeminformation';
import * as cheerio from 'cheerio';

/**
 * Provider to create user interface to interact with ollama to download large language models. See {@link vscode.WebviewViewProvider}
 */
export class ChatModelInstaller implements vscode.WebviewViewProvider {
    /** The path to the running extension's file contents. Used to setup `webviewView`. */
    private readonly extensionUri;
    /** The list of models the user can download. */
    private modelInfo: ModelInfo[] = [];

    /**
     * @param extensionContext A collection of utilities private to the running extension
     */
    constructor(private readonly extensionContext: vscode.ExtensionContext) {
        this.extensionUri = extensionContext.extensionUri;
    }

    // Resolves a webviewView. Ran when the webviewView's contents need to be set up.
    resolveWebviewView(webviewView: vscode.WebviewView, context: vscode.WebviewViewResolveContext, token: vscode.CancellationToken) {
        
        // Enable scripts, forms, and restrict the access of the webviewView contents to the extension resources
        webviewView.webview.options = {
            enableScripts: true,
            localResourceRoots: [util.joinValidPath(this.extensionUri, 'resources', 'contents')]
        };

        // Read the webviewView content in html from extension resources and set up the webviewView contents using it
        const htmlPath = util.joinValidPath(this.extensionUri, 'resources', 'contents', 'chatview', 'installer.html');
        let htmlContent = fs.readFileSync(htmlPath.fsPath, { encoding: 'utf-8' });
        webviewView.webview.html = htmlContent;

        // Send the webview the models we can detect on the user machine
        let messageModelContent = { command: 'createModelOptions', content: [] as string[] };
        messageModelContent.content.push(...util.Model.availableModels);
        webviewView.webview.postMessage(messageModelContent);

        // Set an event listener to handle messages received from the webviewView contents
        webviewView.webview.onDidReceiveMessage(m => this.handleWebviewRequest(m, webviewView));
    }

    /**
     * Handles messages sent by the webviewView contents. 
     * 
     * @param message The message sent by the webviewView contents
     * @param webviewView The webviewView created by this provider. Used to send messages to the webviewView contents.
     */
    private handleWebviewRequest(message: any, webviewView: vscode.WebviewView) {

        // Vaildate the message command
        if (typeof message.command !== 'string') { return; }
        // Check if the message command matches the supported commands
        switch (message.command) {
            case 'installModel': {
                // webview requests an installation of the selected model
                // Validate the message's contents
                if (!(typeof message.model === 'string')) {
                    util.logError(`wrong message model: expected 'string' type instead of ${typeof message.model}`);
                    return;
                }
                if (!(typeof message.params === 'string')) {
                    util.logError(`wrong message params: expected 'string' instead of ${typeof message.params}`);
                    return;
                }

                // Set ollama path and validate if it is present
                let ollamaPath: string = util.ChatHelper.getOllamaPath(this.extensionContext.globalState);
                if (!ollamaPath) { return; }

                // Set ollama path in persistent storage so the user doesnt have to configure it every time if they set ollama path manually
                if (!this.extensionContext.globalState.get(util.stateKeys.isOllamaInstalled)) {
                    this.extensionContext.globalState.update(util.stateKeys.isOllamaInstalled, true);
                }
                
                const model: string = message.model;
                const params: string = message.params;
                // Open an integrated terminal in vscode
                const terminal = vscode.window.createTerminal("Model Installer");
                // Send the command to the terminal to install the model
                terminal.sendText(`${ollamaPath} pull ${model}:${params}`);
                // Display the terminal so the user knows progress is happening
                terminal.show();
                break;
            }
            case 'setParamsReq': {
                // webview requests a list of parameter sizes available to download for the selected model
                // Validate the message's contents
                if (!(typeof message.model === 'string')) {
                    util.logError(`wrong message model: expected 'string' type instead of ${typeof message.model}`);
                    return;
                }

                let messageParamsContent = { command: 'createParamsOptions', content: [] as ModelInfo[] };
                // Get model data for the selected model
                this.modelInfo = getOllamaModelData(message.model);
                messageParamsContent.content = this.modelInfo;

                // Send the data to the webview
                webviewView.webview.postMessage(messageParamsContent);
                break;
            }
            case 'validateParamsReq': {
                // webview requests to check the model's parameter size against the specs of the user machine
                // Validate the message's contents
                if (!(typeof message.param === "string")) {
                    util.logError(`wrong message param: expected 'string' instead got ${typeof message.param}`);
                    return;
                }
                /**
                 * Check the specified model's requirements against the specs of the user machine
                 */
                const checkModelRequirements = async () => {
                    let warning = "";
                    const gigabyte = 1000000000;

                    const param: string = message.param;
                    // parameter size in bytes = paramExponent * paramSignificand * 1 000 000 000
                    // Get the exponent of the parameter size
                    const paramExponent = param.substring(param.length - 1).toLowerCase() === 'b' ? 1 : 0.001;
                    // Get the significand/mantissa of the parameter size
                    const paramSignificand = Number.parseInt(param.substring(0, param.length - 1));

                    // Get the selected model and validate
                    const selectedModel = this.modelInfo.find(v => v.parameterSize === param);
                    if (selectedModel === undefined) { return; }
                    // Get the required disk space for the model
                    const requiredDiskSpace = selectedModel.size;
                    // Get the required RAM of the model
                    const requiredRAM = paramSignificand * paramExponent; // more accurate formula needed
                    // Get the amount of RAM the user machine has
                    const currentRAM = Number.parseFloat(((await si.mem()).total / gigabyte).toFixed(1)); // total memory in GB

                    // Get the required VRAM to run the model
                    // formula taken from https://www.substratus.ai/blog/calculating-gpu-memory-for-llm
                    const requiredVRAM = ((paramSignificand * paramExponent) * 4) / (32 / selectedModel.quantizationSize);
                    // Get the current VRAM on the user machine
                    const currentVRAM = Number.parseFloat((this.getMachineVRAM() / gigabyte).toFixed(1));
                    // Get the amount of VRAM needed to run the model smoothly
                    const recommendedVRAM = requiredVRAM * 1.2;

                    // Send the warning messages to be displayed on the webview
                    warning += `This model requires ${requiredDiskSpace} to download.\n`;
                    warning += `This model requires ${requiredRAM}GB of RAM to run.\n`;
                    warning += `You currently have ${currentRAM}GB of RAM in total.\n`;
                    warning += `\nThis model requires ${requiredVRAM}GB of VRAM to run.\n`;
                    warning += `It is recommended to have ${recommendedVRAM}GB of VRAM to run\n`;
                    warning += `You currently have ${currentVRAM}GB of VRAM\n`;
                    if (requiredVRAM >= currentVRAM) {
                        warning += `You don't have enough VRAM to load the model to GPU memory. Running the model in this state may take a lot longer.\n`;
                    }
                    if (requiredRAM >= currentRAM) {
                        warning += `You don't have enough RAM to run this model.\n`;
                    }
                    webviewView.webview.postMessage({ command: 'setWarningMessage', content: warning });

                };

                checkModelRequirements();
                break;
            }
            default: {
                // Log the command when it does not match the handled commands
                util.logError(this.extensionContext.extension.id, `Command not recognized. Command: ${message.command}`);
                break;
            }
        }
    }

    /**
     * Fetches the total VRAM of the running machine
     * @returns The total VRAM of the running machine in bytes
     */
    private getMachineVRAM(): number {
        let vram = 0;

        // Get vram based on operating system
        switch (process.platform) {
            case 'linux': {
                // If on linux
                // Call `glxinfo -B` to retrieve gpu specifications
                const vramStr = ((util.execute('glxinfo', ['-B'], { encoding: 'utf-8' }).stdout || "")
                    .split('\n') // Split output per line
                    .find(s => s.includes("Video memory")) || '') // find line containing video memory
                    .trim().split(' ')[2]; // get video memory amount
                
                // Parse the number and convert the amount from MB to B
                vram = Number.parseInt(vramStr.split(/[^0-9]/)[0]) * 1024 ** 2;
                break;
            }
            case 'win32': {
                // If on windows
                // Call `(Get-WmiObject Win32_VideoController).AdapterRAM` in powershell to get vram amount in bytes
                const vramStr = util.execute('powershell', ['"(Get-WmiObject Win32_VideoController).AdapterRAM"'], { encoding: 'utf-8' });
                // Parse the output and sum the vram counts
                (vramStr.stdout || '').split('\n').forEach(v => vram += Number.parseInt(v));
                break;
            }
            default: {
                break;
            }
        }

        // return the vram
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
    // Notify the user
    vscode.window.showInformationMessage("Fetching model parameters...");

    // Fetch the model tags from ollama.com and validate the response
    const request = util.execute(process.platform === 'linux' ? 'curl' : 'curl.exe', ['-Ls', `https://ollama.com/library/${model}/tags`], { encoding: 'utf-8' });
    if (typeof request.stdout !== 'string') {
        util.logError('stdout wrong type');
        vscode.window.showErrorMessage("Failed to retrieve model parameter size, please check your internet connection.");
        return [ModelInfo.null];
    }

    // Load the response output into a html parser
    const getHtmlContent = cheerio.load(request.stdout);
    // Extract the model id, context size, and parameter size
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

    // filter out the context size
    modelInfo.size = modelInfo.size.filter((_, index) => index % 2 === 0);

    const output: ModelInfo[] = [];
    const uniqueParameters: string[] = [];

    // Iterate through the extracted model information
    modelInfo.id.forEach((identifier, index) => {
        // model format [modelName]:[parameterSize]-[version]-[quantization (formats: https://www.reddit.com/r/LocalLLaMA/comments/1ba55rj/overview_of_gguf_quantization_methods/)]
        const identifierParts = identifier.split(':')[1].split('-');

        // Extract the model name and quantization format based on the format above
        const modelName = identifier.split(':')[0];
        const quantization = identifierParts[identifierParts.length - 1];
        // Get quantization size, default to 4 bit floating point percision
        const quantizationSize = Number.isNaN(Number.parseInt(quantization.split('_')[0])) ?
            4 : Number.parseInt(quantization.split('_')[0]);

        // Get parameter size based on the model format above
        const parameterSize = identifierParts[0]; // TODO: this does not work with certain model formats
        // Get the model size
        const size = modelInfo.size[index];

        // Skip if parameterSize is invalid or already added
        if (parameterSize.match('[0-9]') === null || uniqueParameters.includes(parameterSize)) {
            return;
        }

        // Mark this parameter size as added
        uniqueParameters.push(parameterSize);
        // Create a new ModelInfo object and add it to the output array
        output.push(new ModelInfo(modelName, quantization, quantizationSize, parameterSize, size));
    });

    return output;
}