import * as fs from 'fs';
import * as vscode from 'vscode';

const extensionName = "education-for-vscode";
let langList: string[] = [];
let langPath: string[] = [];
let vscodeContext: vscode.ExtensionContext;

export function activate(context: vscode.ExtensionContext) {
	
	context.globalState.update("isOpened", false);
	// Make sure the extension is correctly loaded
	console.log('Congratulations, your extension "education-for-vscode" is now active!');

	// Preserve state after extension restart
	vscodeContext = context;

	// Saves the path of lessons to array for later loading
	fs.promises.readdir(context.extensionPath + "/resources/lessons", null).then(files => {
		langList = files;
		for (let i = 0; i < files.length; i++) {
			langPath.push(context.extensionPath + "/resources/lessons/" + files[i]);
			langList[i] = langList[i].split(".")[0];
			console.log("Loaded " + langList[i] + " lesson.");
		}
	});

	// Register the command education-vscode.startEducation
	if (!context.globalState.get("isOpened")) {
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
					vscode.window.showWarningMessage("The directory is not empty. Delete contents?(Actions cannot be reversed)", {}, "Yes", "No").then(ans => {
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
	// Open the selected lesson from the path and save its contents to memory
	let readPath = langPath[langList.findIndex(x => x === language)];
	let plainText = fs.readFileSync(readPath, 'utf-8');
	var contents = JSON.parse(plainText);

	// Create the base code file for the user's project in the selected directory
	let baseFileContents : string = contents[0].code.join('\n');
	fs.writeFileSync(writeDir.path + "/base." + contents[0].extension, baseFileContents);
	
	// Create the code file for the user to edit
	let nLessonContents : string = contents[1].code.join('\n');
	fs.writeFileSync(writeDir.path + "/lesson_0." + contents[0].extension, nLessonContents);

	// Update workspace files
	// workbench.action.quickOpen
	vscode.workspace.openTextDocument(writeDir.path + "/lesson_0." + contents[0].extension).then(doc => {
		vscode.window.showTextDocument(doc).then(editor => {
			console.log("damn");
		});
	});

	vscode.workspace.updateWorkspaceFolders(0, vscode.workspace.workspaceFolders?.length, {uri : writeDir});
}

export function deactivate() {}
