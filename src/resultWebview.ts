import * as vscode from 'vscode';
import * as util from './util';
import * as fs from 'fs';

export enum ResultStatus {
    Pass = "pass",
    Fail = "fail"
}

export class ResultWebView {
    
    constructor(
        private readonly extensionContext: vscode.ExtensionContext, 
        private readonly status: ResultStatus,
        private readonly expectedOutput: string,
        private readonly output: string,
        private readonly errors: string,
        private readonly onProceed: () => void
    ) {

    }

    initializeWebview() {
        const webviewView = vscode.window.createWebviewPanel(
            util.resultViewId,
            "Results",
            { viewColumn: vscode.ViewColumn.Beside, preserveFocus: true }
        );

        const htmlContentUri = vscode.Uri.joinPath(this.extensionContext.extensionUri, "resources", "contents", "resultview", "resultWebview.html");
        const htmlContent = fs.readFileSync(htmlContentUri.fsPath, {encoding: 'utf-8'});
        
        webviewView.webview.options = {
            enableScripts: true,
            localResourceRoots: [vscode.Uri.joinPath(this.extensionContext.extensionUri, 'resources', 'contents')]
        };
        webviewView.webview.html = htmlContent;

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

        webviewView.webview.onDidReceiveMessage(message => {
            switch (message.command) {
                case "postLessonProceed": {
                    this.onProceed();
                    break;
                }

                default: {
                    util.logError(this.extensionContext.extension.id, `Command not recognized. Command: ${message.command}`);
                    break;
                }
            }
        });
    }
}