import { fork, spawnSync } from 'child_process';
import * as fs from 'fs';
import * as vscode from 'vscode';
import * as cheerio from 'cheerio';

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
	ollamaPath = "ollamaPath"
};

export const modelInstallerViewId = 'model-installer-view';
export const chatViewId = 'chat-view';
export const resultViewId = 'result-view';

/**
 * Search PATH for application path
 * @param name The application file name to search for
 * @returns A {@link vscode.Uri} containing the path of the application binary
 */
export function getApplicationPath(name: string): vscode.Uri | undefined {
	const result = spawnSync(process.platform === 'linux' ? 'which' : 'where', [name], {encoding: 'utf-8'});
	if (result.stdout && result.stdout !== "INFO: Could not find files for the given pattern(s).") {
		return vscode.Uri.file(result.stdout.trim());
	}
	
	let out: vscode.Uri | undefined = undefined;
	const cmdout = spawnSync('echo' , [process.platform === 'linux' ? '$PATH' : '%PATH%'], { encoding: 'utf-8' });

	const PATH = cmdout.stdout;
	if (!(typeof PATH === 'string')) { return; }
	const paths = PATH.split(":");
	for (let i = 0, len = paths.length; i < len; i++) {
		try {
			const file = fs.readdirSync(paths[i], null).find(v => v === name || v === name + ".exe");
			out = file === undefined ? file : vscode.Uri.joinPath(vscode.Uri.file(paths[i]), file);
			if (out !== undefined) { break; }
		} catch (error) { }
	}

	return out;
}

export class ModelInfo {
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

export function getOllamaModelData(model: string): ModelInfo[] {

	vscode.window.showInformationMessage("Fetching model parameters...");

	const request = spawnSync('curl' , ['-Ls', `https://ollama.com/library/${model}/tags`], { encoding: 'utf-8' });
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

// TODO: make a better name for this
export function setOllamaPATH(extensionContext: vscode.ExtensionContext) {
	vscode.window.showOpenDialog({canSelectMany: false, canSelectFiles: true, canSelectFolders: false})
		.then(applicationPath => {
			if (!applicationPath) {
				return;
			}
			extensionContext.globalState.update(stateKeys.ollamaPath, applicationPath);
		});
}

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

/**
 * Fetches the total VRAM(in bytes) of the running machine
 */
export function getMachineVRAM(): number {
	let vram = 0;
	switch (process.platform) {
		case 'linux': {
			// no, i will not implement this for wayland(at least for now)
			const vramStr = (spawnSync('glxinfo', ['-B'], {encoding: 'utf-8'}) // get graphics info
				.stdout.split('\n').find(s => s.includes("Video memory")) || '') // parse to get video memory
				.trim().split(' ')[2]; // parse again to get video memory amount
			vram = Number.parseInt(vramStr.split(/[^0-9]/)[0]) * 1024**2;
			break;
		}
		case 'win32': {
			const vramStr = spawnSync('powershell', ['"(Get-WmiObject Win32_VideoController).AdapterRAM"'], {encoding: 'utf-8'});
			vramStr.stdout.split('\n').forEach(v => vram += Number.parseInt(v));
			break;
		}
		default: {
			break;
		}
	}

	return vram;
}