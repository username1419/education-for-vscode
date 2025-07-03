import { ChildProcess, execFileSync, execSync } from 'child_process';
import * as fs from 'fs';
import * as vscode from 'vscode';
import * as util from './util';
import * as chat from './chat';

/*

TODO LIST:

Make the thing remember the last study session

Redo the comments

Path compatability

*/

const extensionName = "education-for-vscode";
const fileExtension: Map<string, string> = new Map(
	[
		["python", ".py"]
	]
);
const defaultRunApplication: Map<string, string> = new Map([
	["python", "/.venv/bin/python3"]
]);
const langList: string[] = [];
const langUri: vscode.Uri[] = [];
let extensionContext: vscode.ExtensionContext;
const registeredCommands: vscode.Disposable[] = [];
const registeredEvents: vscode.Disposable[] = [];
const registeredMiscDisposables: vscode.Disposable[] = [];

export function activate(context: vscode.ExtensionContext) {

	// Make sure the extension is correctly loaded
	util.logDebug(extensionName, `Congratulations, your extension "${extensionName}" is now active!`);
	util.logDebug(extensionName, `Extension globalState path: ${context.globalStorageUri.fsPath}`);

	// Preserve state after extension restart
	extensionContext = context;

	// Saves the path of lessons to array for later loading
	const contentsUri = vscode.Uri.joinPath(context.extensionUri, "resources", "contents");
	fs.promises.readdir(contentsUri.fsPath, null).then(folders => {
		folders.forEach(obj => {
			langList.push(obj);
		});
		langList.forEach(folder => {

			const folderPath = vscode.Uri.joinPath(contentsUri, folder);
			langUri.push(folderPath);
		});
	});

	// Register the command education-vscode.startEducation
	const closeEducationRegister = vscode.commands.registerCommand(
		extensionName + ".endEducation",
		() => {
			if (!context.globalState.get(util.stateKeys.isStudySessionOpened)) {
				vscode.window.showErrorMessage("No study session opened.");
				return;
			}
			context.globalState.update(util.stateKeys.isStudySessionOpened, false);
			vscode.commands.executeCommand("workbench.action.closeAllEditors");
			vscode.workspace.updateWorkspaceFolders(0, vscode.workspace.workspaceFolders?.length);
		}
	);
	const startEducationRegister = vscode.commands.registerCommand(
		extensionName + '.startEducation',
		() => {
			if (context.globalState.get(util.stateKeys.isStudySessionOpened)) {
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
		}
	);
	const submitCodeRegister = vscode.commands.registerCommand(
		extensionName + '.submitCode',
		() => {
			if (!context.globalState.get(util.stateKeys.isStudySessionOpened)) {
				vscode.window.showErrorMessage("No study session is opened.");
				return;
			}

			let workspaceUri = context.globalState.get(util.stateKeys.workspacePath, "");
			if (workspaceUri === "") {
				vscode.window.showErrorMessage("Cannot retrieve workspacePath");
				context.globalState.update(util.stateKeys.isStudySessionOpened, false);
				return;
			}

			testSubmission(vscode.Uri.file(workspaceUri));
		}
	);

	if (context.globalState.get(util.stateKeys.isStudySessionOpened)) {
		let workspacePath = context.globalState.get(util.stateKeys.workspacePath, "");
		if (workspacePath === "") {
			vscode.window.showErrorMessage("Cannot retrieve workspacePath");
			context.globalState.update(util.stateKeys.isStudySessionOpened, false);
			return;
		}

		if (!context.globalState.get(util.stateKeys.isWorkspaceLoaded)) {
			context.globalState.update(util.stateKeys.isWorkspaceLoaded, true);
			disposeDisposables();
			vscode.workspace.updateWorkspaceFolders(0, vscode.workspace.workspaceFolders?.length, {
				uri: vscode.Uri.file(workspacePath)
			});
		}
		vscode.commands.executeCommand("workbench.action.closeAllEditors");
		let language = context.globalState.get(util.stateKeys.language, "");
		if (language === "") {
			util.logError(extensionName, "language is not definied");
			return;
		}
		let lessonNumber = Number.MIN_VALUE;
		let baseFilePath = "";
		fs.readdirSync(workspacePath).forEach((fileName) => {
			if (fileName.startsWith("base")) {
				baseFilePath = fileName;
			}

			if (!fileName.startsWith("lesson")) { return; }
			let lesson = Number.parseInt(fileName.split('.')[0].split("lesson")[1]);
			if (lesson <= lessonNumber && Number.isNaN(lesson)) { return; }
			lessonNumber = lesson;
		});
		if (context.globalState.get(util.stateKeys.currentLesson, -1) !== lessonNumber) {
			context.globalState.update(util.stateKeys.currentLesson, lessonNumber);
		}

		const codeFileExtension = fileExtension.get(language) || "";
		const lessonFileUri = vscode.Uri.joinPath(vscode.Uri.file(workspacePath), "lesson" + lessonNumber + codeFileExtension);
		vscode.workspace.openTextDocument(lessonFileUri).then(doc => {
			vscode.window.showTextDocument(doc).then(editor => {

				let instructionsView = vscode.window.createWebviewPanel(
					"instructions",
					"Instructions",
					vscode.ViewColumn.One,
					{}
				);
				vscode.commands.executeCommand("workbench.action.splitEditorToRightGroup");

				const instructionFileUri = vscode.Uri.joinPath(context.extensionUri, "resources", "contents", "instructions", `lesson${lessonNumber}.html`);
				let instructionsContent = fs.readFileSync(instructionFileUri.fsPath, { encoding: "utf-8" }); // TODO: edit this when option changes
				instructionsView.webview.html = instructionsContent;

				if (!context.globalState.get(util.stateKeys.isOllamaInstalled)) {
					const installerRegister = vscode.window.registerWebviewViewProvider(
						util.modelInstallerViewId, 
						new chat.ChatModelInstaller(extensionContext)
					);
					registeredMiscDisposables.push(installerRegister);
				} else {
					const chatRegister = vscode.window.registerWebviewViewProvider(
						util.chatViewId,
						new chat.Chat(extensionContext.extensionUri, instructionsContent),
						{ webviewOptions: { retainContextWhenHidden: true } }
					);
					registeredMiscDisposables.push(chatRegister);
				}
				// TODO: make chat go chat
			});
		});
	}

	for (let config in util.stateKeys) {
		util.logDebug(extensionName, config + ", " + context.globalState.get(config));
	}

	registeredCommands.push(
		submitCodeRegister,
		closeEducationRegister,
		startEducationRegister);

	registeredCommands.forEach((command) => {
		context.subscriptions.push(command);
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
			extensionContext.globalState.update(util.stateKeys.isStudySessionOpened, true);
			fs.promises.readdir(writeDir[0].fsPath, null).then(files => {
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
	let lessonOriginFolderUri = langUri[langList.findIndex(x => x === language)];

	if (language === "python") {
		let output = execSync(`${defaultRunApplication.get(language)} -m venv .venv`,
			{
				cwd: writeDir.fsPath
			}
		);
		util.logDebug(extensionName, output);
	}

	// Copy the files to the specified path
	const lessonNumber: number = extensionContext.globalState.get(util.stateKeys.currentLesson, 0);
	let lessonDirUri = vscode.Uri.joinPath(writeDir, "lesson" + lessonNumber + fileExtension.get(language));

	const baseFileReadUri = vscode.Uri.joinPath(lessonOriginFolderUri, "base", "base" + fileExtension.get(language));
	const baseFileWriteUri = vscode.Uri.joinPath(writeDir, "base" + fileExtension.get(language));

	const lessonFileReadUri = vscode.Uri.joinPath(lessonOriginFolderUri, "lessons", "lesson" + lessonNumber + fileExtension.get(language));
	const lessonFileWriteUri = vscode.Uri.joinPath(writeDir, "lesson" + lessonNumber + fileExtension.get(language));

	fs.copyFileSync(baseFileReadUri.fsPath, baseFileWriteUri.fsPath);
	fs.copyFileSync(lessonFileReadUri.fsPath, lessonFileWriteUri.fsPath);

	// Update workspace files
	vscode.workspace.openTextDocument(lessonDirUri).then(doc => {
		vscode.window.showTextDocument(doc).then(editor => {
			extensionContext.globalState.update(util.stateKeys.workspacePath, writeDir.fsPath);
			extensionContext.globalState.update(util.stateKeys.language, language);
			extensionContext.globalState.update(util.stateKeys.isWorkspaceLoaded, true);
			disposeDisposables();
			vscode.workspace.updateWorkspaceFolders(0, vscode.workspace.workspaceFolders?.length, { uri: writeDir });
		});
	});
}

function testSubmission(workspacePath: vscode.Uri) {
	// TODO: check if workspacePath is not valid

	let codeLanguage = extensionContext.globalState.get(util.stateKeys.language, undefined);
	if (codeLanguage === undefined) {
		util.logError(extensionName, "globalState codeLanguage is undefined");
		return;
	}
	let lessonNumber = Number.MIN_VALUE;
	let baseFilePath = "";
	fs.readdirSync(workspacePath.fsPath).forEach((fileName) => {
		if (fileName.startsWith("base")) {
			baseFilePath = fileName;
		}

		if (!fileName.startsWith("lesson")) { return; }
		let lesson = Number.parseInt(fileName.split('.')[0].split("lesson")[1]);
		if (lesson <= lessonNumber && Number.isNaN(lesson)) { return; }
		lessonNumber = lesson;
	});
	if (baseFilePath === "") {
		util.logError(extensionName, "base file path is not in root workspace");
		util.logError(extensionName, "fix this later or smth"); // TODO: fix this
		return;
	}

	const languageReadFolderUri = langUri.find(uri => uri.fsPath.endsWith(codeLanguage));
	if (languageReadFolderUri === undefined) {
		util.logError(`language folder ${codeLanguage} does not exist`);
		return;
	}
	const testFileReadUri = vscode.Uri.joinPath(languageReadFolderUri, "tests", "lesson" + lessonNumber + fileExtension.get(codeLanguage));
	let testFileWriteUri = vscode.Uri.joinPath(workspacePath, "test" + fileExtension.get(codeLanguage));
	fs.copyFileSync(
		testFileReadUri.fsPath,
		testFileWriteUri.fsPath
	);

	let command = defaultRunApplication.get(codeLanguage) + " " + testFileWriteUri;
	let output = execSync(
		command,
		{
			cwd: workspacePath.fsPath
		}
	);
	util.logDebug(extensionName, output); // TODO: evaluate output

	fs.rmSync(testFileWriteUri.fsPath);
}

function disposeDisposables() {
	util.logInfo(extensionName, "Cleaning up resources...");
	registeredCommands.forEach((v, i, a) => {
		v.dispose();
	});

	registeredEvents.forEach((v, i, a) => {
		v.dispose();
	});

	registeredMiscDisposables.forEach((v, i, a) => {
		v.dispose();
	});
}

export function deactivate() {
	disposeDisposables();
	extensionContext.globalState.update(util.stateKeys.isWorkspaceLoaded, false);
}