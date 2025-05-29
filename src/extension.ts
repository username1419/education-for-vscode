import * as fs from 'fs';
import * as vscode from 'vscode';

const extensionName = "education-for-vscode";
const fileExtension : Map<string, string> = new Map(
	[
		["python", ".py"]
	]
);
let langList: string[] = [];
let langPath: string[] = [];
let vscodeContext: vscode.ExtensionContext;
let registeredCommands: vscode.Disposable[] = [];

export function activate(context: vscode.ExtensionContext) {
	
	context.globalState.update("isOpened", false);
	// Make sure the extension is correctly loaded
	console.log('Congratulations, your extension "education-for-vscode" is now active!');

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
	if (!context.globalState.get("isOpened") || true) {
		
		const startEducationRegister = vscode.commands.registerCommand(extensionName + '.startEducation', () => {
			if (vscode.workspace.name !== undefined) {
				// Warn users that continuing will close all files without saving, if they have files open in workspace
				vscode.window.showWarningMessage("Continuing will close all documents without saving. Are you sure to continue?", "Yes","No").then(answer => {
					if (answer === "No") {
						return;
					}
					startEducation();
					return;
				});
			}
			startEducation();
		});
		//vscode.workspace.onDidChangeWorkspaceFolders.bind()

		// Load the registered commands onto Visual Studio Code
		context.subscriptions.push(
			startEducationRegister
		);
		registeredCommands.push(startEducationRegister);
		console.log("Commands loaded");
	}
}

function startEducation() {
	let options: vscode.OpenDialogOptions = {
		canSelectMany:false,
		canSelectFiles:false,
		canSelectFolders:true
	};
	// Open a directory selector
	vscode.window.showOpenDialog(options).then(writeDir => {
		if (writeDir && writeDir[0]) {
			// Check if the selected directory is empty
			vscodeContext.globalState.update("isOpened", true);
			fs.promises.readdir(writeDir[0].path, null).then(files => {
				if (files.length === 0) {
					// If the selected directory is empty, let the user pick the language they want to learn from the list of options
					vscode.window.showQuickPick(langList, {canPickMany : false}).then(answer => {
						if (!answer) {return;}
						generateCodeFiles(answer, writeDir[0]);
					});
				} else {
					// If the selected directory is not empty, requests the user a deletion of the folder contents
					vscode.window.showWarningMessage("The directory is not empty. Delete contents?(Actions cannot be reversed)", {}, "No", "Yes").then(ans => {
						if (ans === "Yes") {
							fs.rmSync(writeDir[0].fsPath, {recursive: true, maxRetries: 0, force: true});
							if (fs.existsSync(writeDir[0].fsPath)) {
								vscode.window.showErrorMessage("Cannot remove file");
								return;
							}
							fs.mkdirSync(writeDir[0].fsPath);

							// If the selected directory is empty, let the user pick the language they want to learn from the list of options
							vscode.window.showQuickPick(langList, {canPickMany : false}).then(answer => {
								if (!answer) {return;}
								generateCodeFiles(answer, writeDir[0]);
							});
						} else {
							return;
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

	// Copy the file to the specified path
	let lessonDir = writeDir.path + "/base" + fileExtension.get(language);
	fs.copyFileSync(
		lessonOriginFolder + "/base/base" + fileExtension.get(language), 
		writeDir.fsPath + "/base" + fileExtension.get(language)
	);

	// Update workspace files
	// workbench.action.quickOpen
	vscode.workspace.openTextDocument(lessonDir).then(doc => {
		vscode.window.showTextDocument(doc).then(editor => {
			vscode.workspace.updateWorkspaceFolders(0, vscode.workspace.workspaceFolders?.length, {uri : writeDir});
		});
	});
}

export function deactivate() {
	registeredCommands.forEach((v, i, a) => {
		delete vscodeContext.subscriptions[vscodeContext.subscriptions.findIndex(
			command => command === v
		)];
	});
}