import { spawnSync, SpawnSyncOptionsWithStringEncoding, SpawnSyncReturns } from 'child_process';
import * as fs from 'fs';
import * as vscode from 'vscode';

export function logDebug(extensionName: string, msg?: any) {
	console.log('\x1b[33m' + `(${extensionName}) DEBUG: `, msg, '\x1b[0m');
}

export function logInfo(extensionName: string, msg?: any) {
	console.log('\x1b[32m' + `(${extensionName}) INFO: `, msg, '\x1b[0m');
}

export function logError(extensionName: string, msg?: any) {
	console.error(`(${extensionName}) ERROR: `, msg);
}

export enum stateKeys {
	isStudySessionOpened = "isOpened",
	workspacePath = "workspacePath",
	language = "codeLanguage",
	currentLesson = "currentLesson",
	isWorkspaceLoaded = "isworkspaceLoaded",
	isOllamaInstalled = "isOllamaInstalled",
	ollamaPath = "ollamaPath",
	isNotFirstBoot = "notFirstBoot"
};

export const modelInstallerViewId = 'model-installer-view';
export const chatViewId = 'chat-view';
export const resultViewId = 'result-view';


export class Model {
    // tried the same system message on all models, codeLlama seems to just not be able to follow system instructions that well
	// gemma3 can't do so that well either
    public static availableModels = ['deepseek-r1', 'codellama', 'gemma3'];

    constructor(
        public readonly modelName: string,
        public readonly parameterSize: string
    ) { }

    public toString() {
        return `${this.modelName}:${this.parameterSize}`;
    }
}

/**
 * Search PATH for application path
 * @param name The application file name to search for
 * @returns A {@link vscode.Uri} containing the path of the application binary
 */
export function getApplicationPath(name: string): vscode.Uri | undefined {
	const result = execute(
		process.platform === 'linux' ? 'which' : 'powershell', 
		process.platform === 'linux' ? [name] : [`(Get-Command ${name}).Path`], 
		{encoding: 'utf-8'});

	if (result.stdout && !result.stderr) {
		return vscode.Uri.file(result.stdout.trim());
	}
	
	let out: vscode.Uri | undefined = undefined;
	const cmdout = execute('echo' , [process.platform === 'linux' ? '$PATH' : '%PATH%'], { encoding: 'utf-8' });

	const PATH = cmdout.stdout;
	if (!(typeof PATH === 'string')) { return; }
	const paths = PATH.split(":");
	for (let i = 0, len = paths.length; i < len; i++) {
		try {
			const file = fs.readdirSync(paths[i], null).find(v => v === name || v === name + ".exe");
			out = file === undefined ? file : joinValidPath(vscode.Uri.file(paths[i]), file);
			if (out !== undefined) { break; }
		} catch (error) { }
	}

	return out;
}

/**
 * Enables a file selection to allow user to manually select ollama's executable path
 * @param extensionContext The extension context. Used to modify the extension's globalState
 */
export function setOllamaPATH(extensionContext: vscode.ExtensionContext) {
	vscode.window.showOpenDialog({canSelectMany: false, canSelectFiles: true, canSelectFolders: false})
		.then(applicationPath => {
			if (!applicationPath) {
				return;
			}

			const ollamaPath = applicationPath.at(0)?.fsPath;
			if (!ollamaPath) {
				return;
			}
			extensionContext.globalState.update(stateKeys.ollamaPath, ollamaPath);
		});
}

/**
 * Installs ollama on the local machine using the integrated terminal. Supports Linux and Windows.
 */
export function installOllama() {
	if (vscode.window.terminals.find(t => t.name === "Ollama Installer")) {
		vscode.window.showWarningMessage("Please check the 'Ollama Installer' terminal to install the required programs");
		return;
	}
	const terminal = vscode.window.createTerminal("Ollama Installer");
	terminal.show();
	vscode.window.showInformationMessage('The extension "Education for VSCode" is downloading ollama. You can install your language model after setup.');
	
	switch (process.platform) {
		case 'linux':
			// do this in the terminal: curl.exe -fsSL https://ollama.com/install.sh | sh
			terminal.sendText("curl.exe -fsSL https://ollama.com/install.sh | sh");
			break;

		case 'win32':
			// get request to https://ollama.com/download/OllamaSetup.exe
			terminal.sendText('curl.exe -L -o ollamasetup.exe "https://ollama.com/download/OllamaSetup.exe"');
			// run the executable
			terminal.sendText('\"./ollamasetup.exe\"');
			break;

		default:
			vscode.window.showInformationMessage("sorry bro youre on your own try downloading ollama yourself");
			break;
	}
}

/**
 * Runs the commands with the provided arguments using the provided options. See {@link spawnSync()}.
 * 
 * Additionally tests the process again with powershell.exe if the initial process fails.
 * @param command The command to run
 * @param args The arguments of the command
 * @param options The options of the running process
 * @returns The output of the process
 */
export function execute(command: string, args : string[], options: SpawnSyncOptionsWithStringEncoding) : SpawnSyncReturns<String> {
	let result: SpawnSyncReturns<String>;
	result = spawnSync(command, args, options);

	const isPermissionDenied = result.error ? result.error.name === 'EACCES' || result.error.name === 'EPERM' : false;

	if (isPermissionDenied && process.platform === 'win32') {
		return spawnSync(command, args,
			{
				...options,
				...{ shell: "powershell.exe" }
			}
		);
	}
	
	return result;
}

/**
 * Create a new uri which path is the result of joining the path of the base uri with the provided path segments.

 * Additionally tries to validate the path using {@link vscode.Uri.file()}
 * @param base — An uri. Must have a path.
 * @param pathSegments — One more more path fragments
 * @returns — A new uri which path is joined with the given fragments
 */
export function joinValidPath(base: vscode.Uri, ...pathSegments: string[]): vscode.Uri {
	// workaround for vscode's janky joinPath() function
	return vscode.Uri.file(vscode.Uri.joinPath(base, ...pathSegments).fsPath); 
}