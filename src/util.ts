import { spawnSync, SpawnSyncOptionsWithStringEncoding, SpawnSyncReturns } from 'child_process';
import * as fs from 'fs';
import * as vscode from 'vscode';
import * as chatInstaller from './chatInstaller';
import * as chat from './chat';

/**
 * Logs the message to the console with yellow color
 * @param extensionName The extension to log as
 * @param msg The message to display
 */
export function logDebug(extensionName: string, msg?: any) {
	console.log('\x1b[33m' + `(${extensionName}) DEBUG: `, msg, '\x1b[0m');
}

/**
 * Logs the message to the console with green color
 * @param extensionName The extension to log as
 * @param msg The message to display
*/
export function logInfo(extensionName: string, msg?: any) {
	console.log('\x1b[32m' + `(${extensionName}) INFO: `, msg, '\x1b[0m');
}

/**
 * Logs the message to the standard error
 * @param extensionName The extension to log as
 * @param msg The message to display
*/
export function logError(extensionName: string, msg?: any) {
	console.error(`(${extensionName}) ERROR: `, msg);
}

/**
 * Keys used for globalState storage
 */
export enum stateKeys {
	/** Boolean value. `true` if a study session opened, else `false`. */
	isStudySessionOpened = "isOpened",
	/** String value. Represents the workspace path in the format of the file system. */
	workspacePath = "workspacePath",
	/** String value. Represents the language of the lesson. */
	language = "codeLanguage",
	/** Number value. Represents the lesson number the study session is currently on. Starts at 0. */
	currentLesson = "currentLesson",
	/** Boolean value. `true` if the workspace is opened on VSCode, else `false`. Used to 
	 * initialize the arrangement of tabs on the workspace when the user enters VSCode with 
	 * a study session opened */
	isWorkspaceLoaded = "isworkspaceLoaded",
	/** Boolean value. `true` if ollama is installed, otherwise `false` */
	isOllamaInstalled = "isOllamaInstalled",
	/** String value. Path to the ollama application binary. */
	ollamaPath = "ollamaPath",
	/** Boolean value. `true` if this was the first time this extension is loaded on the user machine, else `false` */
	isNotFirstBoot = "notFirstBoot"
};

// Ids for the webviews of the extension
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
 * Attempts to locate the full path of an executable application by name.
 * 
 * It optionally searches from a specific path, otherwise it will attempt to resolve
 * the executable using the system's `PATH` variable or platform-specific commands.
 * 
 * This function will only search the folder with a depth of 2 (the folder itself and its subfolder)
 * 
 * @param name The application file name to search for
 * @param fromPath The path to start searching from. Falls back to searching system `PATH` variable.
 * @returns A {@link vscode.Uri} containing the path of the application binary
 */
export function getApplicationPath(name: string, fromPath: vscode.Uri | undefined = undefined): vscode.Uri | undefined {
	/**
	 * Search the specified directory for the application binary
	 * 
	 * @param startingDirectory The starting directory to search from
	 * @param directoryContents The contents of the starting directory
	 * @returns A {@link vscode.Uri} containing the path of the application binary or `undefined`
	 */
	function searchApplicationInDirectory(startingDirectory: vscode.Uri, directoryContents: fs.Dirent[]) {
		let out: vscode.Uri | undefined = undefined;

		// Iterate over each item in the directory
		for (let i = 0, len = directoryContents.length; i < len; i++) {
			const filePath = joinValidPath(startingDirectory, directoryContents[i].name);
			
			// If the item is a file, check if it matches the target name
			if (directoryContents[i].isFile()) {
				const doesFileNameMatch = directoryContents[i].name === name || directoryContents[i].name === name + ".exe";
				if (doesFileNameMatch) { return filePath; } // Return immediately if a match is found
				else { continue; }
			}

			// If it's a directory, read its contents and look for a matching file
			const file = fs.readdirSync(filePath.fsPath, { withFileTypes: true }).find(v => v.name === name || v.name === name + ".exe")?.name;
			out = file === undefined ? file : joinValidPath(filePath, file);
			if (out !== undefined) { break; } // Stop searching if a match is found
		}
	}

	// If a starting directory is provided, attempt to manually find the executable there
	if (fromPath) {
		// Ensure fromPath is a valid URI with a filesystem path
		// i dont know if this ever triggers but its good to be sure
		if (!(typeof fromPath.fsPath === 'string')) { return; }

		// Read the contents of the directory
		const paths = fs.readdirSync(fromPath.fsPath, { withFileTypes: true });
	
		const result = searchApplicationInDirectory(fromPath, paths);
		if (result) {
			return result;
		}
		return; // No match found in the provided path
	}

	// If no path is provided, try finding the application using system commands
	const result = execute(
		process.platform === 'linux' ? 'which' : 'powershell',
		process.platform === 'linux' ? [name] : [`(Get-Command ${name}).Path`],
		{ encoding: 'utf-8' });

	// If a valid path is returned and there's no error, return it
	if (result.stdout && !result.error) {
		return vscode.Uri.file(result.stdout.trim());
	}

	// Fallback to search each directory in the PATH variable
	let out: vscode.Uri | undefined = undefined;
	const cmdout = execute('echo', [process.platform === 'linux' ? '$PATH' : '%PATH%'], { encoding: 'utf-8' });

	const PATH = cmdout.stdout;
	if (!(typeof PATH === 'string')) { return; }
	// Split the PATH variable into individual directories
	const paths = PATH.split(":");
	// Search each directory in PATH for a matching file
	for (let searchDirectory in paths) {
		const subDirectories = fs.readdirSync(searchDirectory, {withFileTypes: true});
		out = searchApplicationInDirectory(vscode.Uri.file(searchDirectory), subDirectories);
		if (out !== undefined) { break; }
	}

	return out;
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
export function execute(command: string, args: string[], options: SpawnSyncOptionsWithStringEncoding): SpawnSyncReturns<String> {
	let result: SpawnSyncReturns<String>;
	// Tries to run the command using the default shell (bash for linux and cmd.exe for windows)
	result = spawnSync(command, args, options);

	// Check if the command fails because of permission errors
	const isPermissionDenied = result.error ? result.error.name === 'EACCES' || result.error.name === 'EPERM' : false;
	// If it failed because of a permission error, try to run it with powershell.exe if the machine is a windows machine
	if (isPermissionDenied && process.platform === 'win32') {
		return spawnSync(command, args,
			{
				...options,
				...{ shell: "powershell.exe" }
			}
		);
	}

	// Return the output of the command
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

/**
 * Helper class providing functions required by {@link chatInstaller.ChatModelInstaller} and {@link chat.Chat}
 */
export class ChatHelper {
	/**
	 * Retrieves the ollama binary's path on the local machine using persistent storage or PATH.
	 * 
	 * @param globalState The extension's persistent memory.
	 * @returns The string path to the ollama binary
	 */
	static getOllamaPath(globalState: vscode.Memento) {
		// Get the ollamaPath from persistent storage if it is set
		// Else search the machine for an "ollama" application
		const globalStateValue = globalState.get(stateKeys.ollamaPath, '');
		let ollamaPath = globalStateValue === '' ?
			getApplicationPath("ollama")?.fsPath || '' : globalStateValue;

		if (globalStateValue === '') {
			if (ollamaPath !== '') {
				// If the value in persistent storage is not set but the ollama binary is found, add it to the storage
				// We do this because its *in theory* faster to access the value in persistent storage than it is to search all PATH variables for the desired application binary.
				globalState.update(stateKeys.ollamaPath, ollamaPath);
			} else {
				// If the ollama binary is not found, show an error and return
				vscode.window.showErrorMessage("Ollama not found. Go to Command Palette(Ctrl+Shift+P) > Education for VSCode: Run Ollama Setup");
				return "";
			}
		}

		// return ollama's path if it is found
		return ollamaPath;
	};

	/**
	 * Installs ollama on the local machine using the integrated terminal. Supports Linux and Windows.
	 */
	static installOllama() {
		// Check if the installer terminal already exists
		if (vscode.window.terminals.find(t => t.name === "Ollama Installer")) {
			vscode.window.showWarningMessage("Please check the 'Ollama Installer' terminal to install the required programs");
			return;
		}

		// Create and show a new terminal for Ollama installation
		const terminal = vscode.window.createTerminal("Ollama Installer");
		terminal.show();
		// Inform the user that the process is starting
		vscode.window.showInformationMessage('The extension "Education for VSCode" is downloading ollama. You can install your language model after setup.');

		// Send platform-specific commands to the terminal
		switch (process.platform) {
			case 'linux':
				// For Linux, run installation script via curl.exe
				terminal.sendText("curl -fsSL https://ollama.com/install.sh | sh");
				break;

			case 'win32':
				// For Windows, download the installer using curl.exe and run the setup executable
				terminal.sendText('curl.exe -L -o ollamasetup.exe "https://ollama.com/download/OllamaSetup.exe"');
				terminal.sendText('\"./ollamasetup.exe\"');
				break;

			default:
				// For unsupported platforms, prompt manual installation
				vscode.window.showInformationMessage("sorry bro youre on your own try downloading ollama yourself");
				break;
		}
	}

	/**
	 * Enables a file selection to allow user to manually select ollama's executable path
	 * @param extensionContext The extension context. Used to modify the extension's globalState
	 */
	static async setOllamaPATH(extensionContext: vscode.ExtensionContext) {
		// Opens a file selection window that lets users choose only single files
		const applicationPath = await vscode.window.showOpenDialog({ canSelectMany: false, canSelectFiles: true, canSelectFolders: false });
		// Validate the selected paths
		if (!applicationPath) {
			return;
		}

		// Get and validate ollama path
		const ollamaPath = applicationPath.at(0)?.fsPath;
		if (!ollamaPath) {
			return;
		}

		// Update ollama path
		extensionContext.globalState.update(stateKeys.ollamaPath, ollamaPath);

	}
}