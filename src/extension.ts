import { ChildProcess, execFileSync, execSync } from 'child_process';
import * as fs from 'fs';
import * as vscode from 'vscode';

/*

TODO LIST:

Make the thing remember the last study session

*/

enum stateKeys {
	isStudySessionOpened = "isOpened",
	workspacePath = "workspacePath",
	language = "codeLanguage"
};

const extensionName = "education-for-vscode";
const fileExtension: Map<string, string> = new Map(
	[
		["python", ".py"]
	]
);
const defaultRunApplication: Map<string, string> = new Map([
	["python", "python3"]
]);
let langList: string[] = [];
let langPath: string[] = [];
let vscodeContext: vscode.ExtensionContext;
let registeredCommands: vscode.Disposable[] = [];
let registeredEvents: vscode.Disposable[] = [];

function logDebug(msg?: any) {
	console.log('\x1b[33m' + `(${extensionName}) DEBUG: ` + msg + '\x1b[0m');
}

function logInfo(msg?: any) {
	console.log('\x1b[32m' + `(${extensionName}) INFO: ` + msg + '\x1b[0m');
}

function logError(msg?: any) {
	console.error(`(${extensionName}) ERROR: ` + msg);
}

export function activate(context: vscode.ExtensionContext) {

	// Make sure the extension is correctly loaded
	logDebug('Congratulations, your extension "education-for-vscode" is now active!');

	// Preserve state after extension restart
	vscodeContext = context;

	// Saves the path of lessons to array for later loading
	fs.promises.readdir(context.extensionPath + "/resources/contents", null).then(folders => {
		langList = folders;
		langList.forEach(folder => {
			langPath.push(context.extensionPath + "/resources/contents/" + folder);
		});
	});

	// Register the command education-vscode.startEducation
	const closeEducationRegister = vscode.commands.registerCommand(
		extensionName + ".endEducation",
		() => {
			if (!context.globalState.get(stateKeys.isStudySessionOpened)) {
				vscode.window.showErrorMessage("No study session opened.");
				return;
			}
			context.globalState.update(stateKeys.isStudySessionOpened, false);
			vscode.commands.executeCommand("workbench.action.closeAllEditors");
			vscode.workspace.updateWorkspaceFolders(0, vscode.workspace.workspaceFolders?.length);
		}
	);
	const startEducationRegister = vscode.commands.registerCommand(
		extensionName + '.startEducation',
		() => {
			if (context.globalState.get(stateKeys.isStudySessionOpened)) {
				vscode.window.showErrorMessage("An study session is already opened.");
				return;
			}
			if (vscode.workspace.name !== undefined) {
				// Warn users that continuing will close all files without saving, if they have files open in workspace
				vscode.window.showWarningMessage("Continuing will close all documents without saving. Continue?", "Yes", "No").then(answer => {
					if (answer === "No") {
						return;
					}
				});
			}
			startEducation();
		});
	const submitCodeRegister = vscode.commands.registerCommand(
		extensionName + '.submitCode',
		() => {
			if (!context.globalState.get(stateKeys.isStudySessionOpened)) {
				vscode.window.showErrorMessage("No study session is opened.");
				return;
			}

			let workspacePath = context.globalState.get(stateKeys.workspacePath, undefined);
			if (workspacePath === undefined) {
				vscode.window.showErrorMessage("Cannot retrieve workspacePath");
				context.globalState.update(stateKeys.isStudySessionOpened, false);
				return;
			}

			testSubmission(workspacePath);
		}
	);

	if (context.globalState.get(stateKeys.isStudySessionOpened)) {
		let workspacePath = context.globalState.get(stateKeys.workspacePath, undefined);
		if (workspacePath === undefined) {
			vscode.window.showErrorMessage("Cannot retrieve workspacePath");
			context.globalState.update(stateKeys.isStudySessionOpened, false);
			return;
		}

		deactivate();
		vscode.workspace.updateWorkspaceFolders(0, vscode.workspace.workspaceFolders?.length, {
			uri: vscode.Uri.file(workspacePath)
		});
		
		vscode.commands.executeCommand("workbench.action.splitEditorToRightGroup");
		let instructionsView = vscode.window.createWebviewPanel(
			"instructions",
			"Instructions",
			vscode.ViewColumn.Two,
			{}
		);
		let language = context.globalState.get(stateKeys.language) || "";
		if (language !== "") {
			logError("language is not defined");
			return;
		}
		let instructionsContent = fs.readFileSync(context.extensionPath + "/resources/contents/instructions/lesson0.html"); // TODO: edit this when option changes
		instructionsView.webview.html = instructionsContent.join("");
		
		// TODO: make chat go chat
	}

	for (let config in stateKeys) {
		logDebug(config + ", " + context.globalState.get(config));
	}

	registeredCommands.push(submitCodeRegister);
	registeredCommands.push(closeEducationRegister);
	registeredCommands.push(startEducationRegister);
	registeredCommands.forEach((v) => {
		context.subscriptions.push(v);
	});
}

function startEducation() {
	let options: vscode.OpenDialogOptions = {
		canSelectMany: false,
		canSelectFiles: false,
		canSelectFolders: true
	};

	// Open a directory selector
	vscode.window.showOpenDialog(options).then(writeDir => {
		if (writeDir && writeDir[0]) {
			// Check if the selected directory is empty
			vscodeContext.globalState.update(stateKeys.isStudySessionOpened, true);
			fs.promises.readdir(writeDir[0].path, null).then(files => {
				if (files.length === 0) {
					// If the selected directory is empty, let the user pick the language they want to learn from the list of options
					vscode.window.showQuickPick(langList, { canPickMany: false }).then(answer => {
						if (!answer) { return; }
						generateCodeFiles(answer, writeDir[0]);
					});
				} else {
					// If the selected directory is not empty, requests the user a deletion of the folder contents
					vscode.window.showWarningMessage("The directory is not empty. Delete contents?(Actions cannot be reversed)", {}, "No", "Yes").then(ans => {
						if (ans !== "Yes") {
							return;
						} else {
							fs.rmSync(writeDir[0].fsPath, { recursive: true, maxRetries: 0, force: true });
							if (fs.existsSync(writeDir[0].fsPath)) {
								vscode.window.showErrorMessage("Cannot remove file");
								return;
							}
							fs.mkdirSync(writeDir[0].fsPath);

							// If the selected directory is empty, let the user pick the language they want to learn from the list of options
							vscode.window.showQuickPick(langList, { canPickMany: false }).then(answer => {
								if (!answer) { return; }

								generateCodeFiles(answer, writeDir[0]);
							});
						}
					});
				}
			});
		}
	});
}

function generateCodeFiles(language: string, writeDir: vscode.Uri) {
	// Open the selected lesson from the path
	let lessonOriginFolder = langPath[langList.findIndex(x => x === language)];

	if (language === "python") {
		let output = execSync("python3 -m venv .venv",
			{
				cwd: writeDir.path
			}
		);
		logDebug(output);
	}

	// Copy the files to the specified path
	let lessonDir = writeDir.path + "/lesson0" + fileExtension.get(language);
	fs.copyFileSync(
		lessonOriginFolder + "/base/base" + fileExtension.get(language),
		writeDir.fsPath + "/base" + fileExtension.get(language)
	);
	fs.copyFileSync(
		lessonOriginFolder + "/lessons/lesson0" + fileExtension.get(language),
		writeDir.fsPath + "/lesson0" + fileExtension.get(language)
	);

	// Update workspace files
	vscode.workspace.openTextDocument(lessonDir).then(doc => {
		vscode.window.showTextDocument(doc).then(editor => {
			vscodeContext.globalState.update(stateKeys.workspacePath, writeDir.path);
			vscodeContext.globalState.update(stateKeys.language, language);
			deactivate();
			vscode.workspace.updateWorkspaceFolders(0, vscode.workspace.workspaceFolders?.length, { uri: writeDir });
		});
	});
}

function testSubmission(workspacePath: string) {
	// TODO: check if workspacePath is not valid

	let codeLanguage = vscodeContext.globalState.get(stateKeys.language, undefined);
	if (codeLanguage === undefined) {
		logError("globalState codeLanguage is undefined");
		return;
	}
	let lessonNumber = Number.MIN_VALUE;
	let baseFilePath = "";
	fs.readdirSync(workspacePath).forEach((v, i, a) => {
		if (v.startsWith("base")) {
			baseFilePath = v;
		}

		if (!v.startsWith("lesson")) { return; }
		let lesson = Number.parseInt(v.split('.')[0].split("lesson")[1]);
		if (lesson <= lessonNumber && Number.isNaN(lesson)) { return; }
		lessonNumber = lesson;
	});
	if (baseFilePath === "") {
		logError("base file path is not in root workspace");
		logError("fix this later or smth"); // TODO: fix this
	}

	let testFilePath = workspacePath + "/test" + fileExtension.get(codeLanguage);
	fs.copyFileSync(
		vscodeContext.extensionPath + "/resources/contents/" + codeLanguage + "/tests/lesson" + lessonNumber + fileExtension.get(codeLanguage),
		testFilePath
	);

	let command = defaultRunApplication.get(codeLanguage) + " " + testFilePath; // rewrite to use child_process instead
	let output = execSync(
		command, 
		{
			cwd: workspacePath
		}
	);
	logDebug(output); // TODO: evaluate output

	fs.rmSync(testFilePath);
}

export function deactivate() {
	logInfo("Cleaning up resources...");
	registeredCommands.forEach((v, i, a) => {
		v.dispose();
	});

	registeredEvents.forEach((v, i, a) => {
		v.dispose();
	});
}