import * as vscode from 'vscode';
import { Ollama } from 'ollama';
import * as util from './util';
import * as fs from 'fs';

/**
 * Conatiner for a chat message between the system, the user, and the language model. Same 
 * structure as a JSON object required by ollama API at http://localhost:11434/api/chat
 */
class ChatRequest {
    constructor(
        /** The role of the message */
        public readonly role: 'system' | 'user' | 'assistant',
        /** The content of the message */
        public readonly content: string
    ) { }
}

/**
 * Provider to create user interface to interact with large language models. See {@link vscode.WebviewViewProvider}
 */
export class Chat implements vscode.WebviewViewProvider {
    /** The chat history. Used because ollama chat API does not keep chat history. */
    private chatHistory: ChatRequest[] = [];
    /**The ollama API */
    private readonly ollamaAPI: Ollama = new Ollama();
    /** The path to the running extension's file contents. Used to setup `webviewView`. */
    private readonly extensionUri: vscode.Uri;
    /** The list of models the user can chat with. */
    private modelInfo: util.Model[] = [];

    /**
     * @param extensionContext A collection of utilities private to the running extension
     * @param instructions The instruction of the lesson, formatted in Markdown. Used to give context to the language model.
     */
    constructor(private readonly extensionContext: vscode.ExtensionContext, private readonly instructions: string) {
        // Create instructions and context for the language model to follow
        this.chatHistory.push(
            new ChatRequest(
                'system',
                `You are a computer science teacher for the user. Don't tell the user the answer or full solution, but rather, provide hints and guide them towards the solution. Refuse to answer politely if the question is not related to programming and/or computer science. 
                Assist with the user's technical issues directly, using the information provided below. In addition, the user can use the following commands in Visual Studio Code's Command Palette: 'Education for VSCode: Restart Lesson' to reset their lesson progress to its initial state, 'Education for VSCode: Submit Code' to submit their work, and 'Education for VSCode: End Study' to end their lesson.
                The user has been shown the following instructions: \n${instructions || "no instructions"}
                `)
        );

        // Set the extension path for later use
        this.extensionUri = extensionContext.extensionUri;
    }

    /**
     * Generate the next response based on the chat history and the user prompt.
     * 
     * @param userPrompt The user's message content to the model
     * @param model The model that is used to generate the next response
     * @param callback  A function that is executed when a part of the model's response is sent back
     * @param callbackEnd A function that is executed when the model's response is completed
     */
    public async generateChatResponse(userPrompt: string, model: util.Model, callback: (responsePart: string) => void, callbackEnd: (responseFull: string) => void) {
        // Create a new chat request for the user's prompt
        const request = new ChatRequest('user', userPrompt);
        // Add the message to chat history
        this.chatHistory.push(request);

        // Start storing the model's response
        let assistantResponse = "";
        // Send a response request to the ollama API to generate the next response based on the chat history
        this.ollamaAPI.chat({
            model: model.toString(),
            messages: this.chatHistory,
            stream: true
        }).then(async stream => {
            // Loop through the generated message chunks
            for await (const part of stream) {
                // Call the function for the message chunk's content
                callback(part.message.content);
                // Add the chunk's content to the total response
                assistantResponse += part.message.content;
            }
            // Call the function for the total response message
            callbackEnd(assistantResponse);
        });
    }

    // Resolves a webviewView. Ran when the webviewView's contents need to be set up.
    async resolveWebviewView(webviewView: vscode.WebviewView, context: vscode.WebviewViewResolveContext, token: vscode.CancellationToken) {
        // Default to show this if the instructions are not provided
        if (!this.instructions) {
            webviewView.webview.html = '<html><body><p>Start the session to run the chatbot</p></body></html>';
        }

        // Enable scripts, forms, and restrict the access of the webviewView contents to the extension resources
        webviewView.webview.options = {
            enableScripts: true,
            enableForms: true,
            localResourceRoots: [util.joinValidPath(this.extensionUri, 'resources', 'contents')]
        };

        // Read the webviewView content in html from extension resources and set up the webviewView contents using it
        const htmlPath = util.joinValidPath(this.extensionUri, 'resources', 'contents', 'chatview', 'chat.html');
        let htmlContent = fs.readFileSync(htmlPath.fsPath, { encoding: 'utf-8' });
        webviewView.webview.html = htmlContent;

        // Verify that ollama is installed and can be accessed by the process
        // We don't need to use this variable but it is better to verify before doing anything with ollama
        const ollamaPath = util.ChatHelper.getOllamaPath(this.extensionContext.globalState);
        if (!ollamaPath) { return; }

        // Request a list of models installed on the local machine from the ollama API
        const reqModels = await this.ollamaAPI.list();
        reqModels.models.forEach(model => {
            // For each model, add it to our list of models if it isnt already present
            // Doing this prevents having to send requests to the API every time we want to access it (which we dont, but maybe in the future)
            const modelData = model.name.split(":");
            const modelInfoMatches = !!this.modelInfo.find(v => v.modelName === modelData[0] && v.parameterSize === modelData[1]);

            if (modelInfoMatches) {
                return;
            }
            this.modelInfo.push(new util.Model(modelData[0], modelData[1]));
        });
        // Send a message to the webviewView contents to create the options to select the models found
        webviewView.webview.postMessage({
            command: 'createModelOptions',
            content: this.modelInfo
        });

        // Set an event listener to handle messages received from the webviewView contents
        webviewView.webview.onDidReceiveMessage(message => this.handleWebviewRequest(message, webviewView));
    }

    /**
     * Handles messages sent by the webviewView contents. 
     * 
     * @param message The message sent by the webviewView contents
     * @param webviewView The webviewView created by this provider. Used to send messages to the webviewView contents.
     */
    private async handleWebviewRequest(message: any, webviewView: vscode.WebviewView) {
        // Vaildate the message command
        if (typeof message.command !== 'string') { return; }
        // Check if the message command matches the supported commands
        switch (message.command) {
            case 'reqChatMessage': {
                // webview requests a response generated by the specified language model and the provided user prompt
                // Validate the message's contents
                if (!(typeof message.content.modelName === 'string')) {
                    util.logError(`wrong message modelName: expected 'string' type instead of ${typeof message.model}`);
                    return;
                }
                if (!(typeof message.content.userPrompt === 'string')) {
                    util.logError(`wrong message userPrompt: expected 'string' instead of ${typeof message.params}`);
                    return;
                }

                // Send message to webview to start listening for message response chunks
                webviewView.webview.postMessage({ command: 'chatMessageBegin' });
                // Get the model, parameters, and user prompt from the message contents
                const [modelName, parameterSize] = message.content.modelName.split(':');
                const model = new util.Model(modelName, parameterSize);

                const userPrompt = message.content.userPrompt;

                // Handles the errors thrown by generating the language model's response
                try {
                    
                    let isThinking = false;
                    // For each chunk in the generated response from the model, tell the webview to append it to the existing response if the model is not thinking
                    const streamResponseChunkToWebview = (responsePart: string) => {
                        // This is used because deepseek-r1 generates 2 newlines after thinking, and will make the message bubble look weird on the webview
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

                        // Send a message to the webview to append the chunk to the message
                        webviewView.webview.postMessage({
                            command: 'chatMessageAppend',
                            content: isThinking ? {} : responsePart
                        });
                    };

                    // After the language model's response completes, add the full response to history as a message from assistant
                    const addResponseToHistory = (response: string) => {
                        webviewView.webview.postMessage({ command: 'chatMessageDone' });
                        const assistantResponse = new ChatRequest('assistant', response);
                        this.chatHistory.push(assistantResponse);
                    };

                    // Generates the response using the user prompt and model, and call the previously defined functions after a chunk is generated and after the response completes respectively
                    this.generateChatResponse(
                        userPrompt,
                        model,
                        streamResponseChunkToWebview,
                        addResponseToHistory
                    );
                } catch (err) {
                    // Send an error to the webview if one is encountered and tell it to stop listening for responses
                    webviewView.webview.postMessage({ command: 'chatMessageAppend', content: err });
                    webviewView.webview.postMessage({ command: 'chatMessageDone' });
                }
                break;
            }

            case 'reqKnownModels': {
                // Request a list of models installed on the local machine from the ollama API
                const reqModels = await this.ollamaAPI.list();
                reqModels.models.forEach(model => {
                    // For each model, add it to our list of models if it isnt already present
                    // Doing this prevents having to send requests to the API every time we want to access it (which we dont, but maybe in the future)
                    const modelData = model.name.split(":");
                    const modelInfoMatches = !!this.modelInfo.find(v => v.modelName === modelData[0] && v.parameterSize === modelData[1]);

                    if (modelInfoMatches) {
                        return;
                    }
                    this.modelInfo.push(new util.Model(modelData[0], modelData[1]));
                });
                // Send a message to the webviewView contents to create the options to select the models found
                webviewView.webview.postMessage({
                    command: 'createModelOptions',
                    content: this.modelInfo
                });
                break;
            }

            default: {
                // Log the command when it does not match the handled commands
                util.logError(this.extensionContext.extension.id, `Command not recognized. Command: ${message.command}`);
                break;
            }
        }
    }
}