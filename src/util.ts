import { exec, execSync } from 'child_process';
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

/**
 * Search PATH for application path
 * @param name The application file name to search for
 * @returns A {@link vscode.Uri} containing the path of the application binary
 */
export function getApplicationPath(name: string): vscode.Uri | undefined {
	const result = execSync(`${process.platform === 'linux' ? 'which' : 'where'} ${name}`, {encoding: 'utf-8'});
	if (result !== '' && result !== "INFO: Could not find files for the given pattern(s).") {
		return vscode.Uri.file(result);
	}
	
	let out: vscode.Uri | undefined = undefined;
	const cmdout = execSync(`echo ${process.platform === 'linux' ? '$PATH' : '%PATH%'}`, { encoding: 'utf-8' });

	const PATH = cmdout;
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
		public readonly name: string,
		public readonly quantization: string,
		public readonly parameterSize: string,
		public readonly size: string
	) { }
}

export function getOllamaModelData(model: string): ModelInfo[] {

	vscode.window.showInformationMessage("Fetching model parameters...");

	const request = execSync(`curl -L https://ollama.com/library/${model}/tags`, { encoding: 'utf-8' });
	const getHtmlContent = cheerio.load(request);
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
		const parameterSize = identifierParts[0];
		const size = modelInfo.size[index];

		if (parameterSize.match('[0-9]') === null || uniqueParameters.includes(parameterSize)) {
			return;
		}
		uniqueParameters.push(parameterSize);
		output.push(new ModelInfo(modelName, quantization, parameterSize, size));
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