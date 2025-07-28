import * as vscode from 'vscode';
import * as util from './util';
import * as fs from 'fs';

/**
 * Enum representing the result status of the test.
 */
export enum ResultStatus {
    Pass = "pass",
    Fail = "fail",
    Error = "error"
}

/**
 * Handles the results webview panel. Displays test result's status, outputs, expected outputs, errors, and handles proceeding callbacks.
 */
export class ResultWebView {
    
    /**
     * @param extensionContext The extension context used to access resources.
     * @param status The test result status (pass, fail, or error).
     * @param expectedOutput The expected output to be displayed.
     * @param output The actual output produced.
     * @param errors Any errors to be shown.
     * @param onProceed Callback to invoke when the user clicks the "Proceed" button.
     */

    constructor(
        private readonly extensionContext: vscode.ExtensionContext, 
        private readonly status: ResultStatus,
        private readonly expectedOutput: string,
        private readonly output: string,
        private readonly errors: string,
        private readonly onProceed: () => void
    ) {

    }

    /**
     * Initializes and displays the test result webview panel.
     * Loads HTML content and communicates the test results to the webview.
     * Sets up a message listener to handle user interactions from the webview.
     */
    initializeWebview() {
        // Create a new Webview Panel beside the current editor
        const webviewView = vscode.window.createWebviewPanel(
            util.resultViewId,
            "Results",
            { viewColumn: vscode.ViewColumn.Beside, preserveFocus: true }
        );

        // Resolve the path to the HTML file for the webview content
        const htmlContentUri = vscode.Uri.joinPath(this.extensionContext.extensionUri, "resources", "contents", "resultview", "resultWebview.html");
        // Read the webview contents from the file system
        const htmlContent = fs.readFileSync(htmlContentUri.fsPath, {encoding: 'utf-8'});
        
        // Configure the webview: allow scripts and restrict access to the resources path
        webviewView.webview.options = {
            enableScripts: true,
            localResourceRoots: [vscode.Uri.joinPath(this.extensionContext.extensionUri, 'resources', 'contents')]
        };
        // Set the user interface in the webview using the webview contents
        webviewView.webview.html = htmlContent;

        // Send the test result properties the webview needs to display
        const postMessage = {
            command: "postResults",
            content: {
                status: this.status,
                expected: this.expectedOutput,
                output: this.output,
                errors: this.errors
            }
        };
        webviewView.webview.postMessage(postMessage);

        // Listen for messages from the webview
        webviewView.webview.onDidReceiveMessage(message => {
            switch (message.command) {
                case "postLessonProceed": {
                    // Trigger the callback when the user chooses to proceed
                    this.onProceed();
                    break;
                }

                default: {
                    // Log an error if an unrecognized command is received
                    util.logError(this.extensionContext.extension.id, `Command not recognized. Command: ${message.command}`);
                    break;
                }
            }
        });
    }
}