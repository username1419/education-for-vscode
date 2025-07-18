import { spawnSync, SpawnSyncReturns } from 'child_process';
import * as fs from 'fs';
import * as vscode from 'vscode';
import * as util from './util';
import { ResultWebView, ResultStatus } from './resultWebview';
import { ChatModelInstaller as ChatModelInstallerView } from './chatInstaller';
import { Chat as ChatModelView } from './chat';
import { NodeHtmlMarkdown } from 'node-html-markdown';

/*

TODO LIST:

Make the thing remember the last study session - 
progress: uhhhh for reasons in the global state updates that this is somewhat already implemented but it deletes your files every time

Redo the comments

Feedback:
- users misunderstand lesson0
	+ instead of: value\nvalue\nvalue\n....
	+ to: value      value      value\n
- language does not update after lesson begins

*/

/** Name of the extension */
const extensionName = "education-for-vscode";
/** Maps the programming language to the file extension of the source code */
const fileExtension: Map<string, string> = new Map(
	[
		["python", ".py"]
	]
);
/** Maps the programming language to the default location of the compiler binary in a virtual environment */
const defaultRunApplication: Map<string, string> = new Map([
	["python", ".venv/bin/python3"]
]);
/** List of possible programming languages the user can choose from */
const langList: string[] = [];
/** List of content Uris of each programming language. Same indexed as {@link defaultRunApplication} */
const langUri: vscode.Uri[] = [];
/** The extension context. Used to access persistent configuration storage among other things */
let extensionContext: vscode.ExtensionContext;
/** The commands that are registered by the extension. Used to dispose safely after extension deactivates */
const registeredCommands: vscode.Disposable[] = [];
/** The events that are registered by the extension. Used to dispose safely after extension deactivates */
const registeredEvents: vscode.Disposable[] = [];
/** Miscellaneous things that are registered by the extension. Used to dispose safely after extension deactivates */
const registeredMiscDisposables: vscode.Disposable[] = [];

/** Function called when the extension activates. Registers commands and webviews, and other things */
export function activate(context: vscode.ExtensionContext) {

	// Make sure the extension is correctly loaded
	util.logDebug(extensionName, `Congratulations, your extension "${extensionName}" is now active!`);
	util.logDebug(extensionName, `Extension globalState path: ${context.globalStorageUri.fsPath}`);

	// Allow other functions to access extension context
	extensionContext = context;

	// Checks for command line permissions
	const result = spawnSync(process.platform === 'linux' ? 'which' : 'where', ["curl"], { encoding: 'utf-8' });
	const isPermissionDenied = result.error ? result.error.name === 'EACCES' || result.error.name === 'EPERM' : false;
	if (isPermissionDenied) {
		vscode.window.showErrorMessage("Process does not have command line access. Major features may be inaccessible.");
	}

	// Notify the user about the startEducation command if this is the first boot
	const isFirstBoot: boolean = !extensionContext.globalState.get(util.stateKeys.isNotFirstBoot);
	if (isFirstBoot) {
		vscode.window.showInformationMessage("Education for VSCode started. Run \'Education for VSCode: Begin Study Session\' in Command Palette(Ctrl+Shift+P) to start.");
		extensionContext.globalState.update(util.stateKeys.isNotFirstBoot, true);
	}

	// Saves the path of lessons to array for later loading
	const contentsUri = util.joinValidPath(context.extensionUri, "resources", "contents", "language");
	fs.promises.readdir(contentsUri.fsPath, null).then(folders => {
		folders.forEach(obj => {
			langList.push(obj);
		});
		langList.forEach(folder => {

			const folderPath = util.joinValidPath(contentsUri, folder);
			langUri.push(folderPath);
		});
	});

	// Register commands in the Command Palette
	const startEducationRegister = vscode.commands.registerCommand(
		extensionName + '.startEducation',
		async function confirmSessionStart() {
			// Check if a study session is already opened
			// If it is, show an error and don't proceed
			if (context.globalState.get(util.stateKeys.isStudySessionOpened)) {
				vscode.window.showErrorMessage("An study session is already opened.");
				return;
			}

			if (vscode.workspace.name !== undefined) {
				// Warn users that continuing will close all files without saving, if they have files open in workspace
				const answer = await vscode.window.showWarningMessage("Continuing will close all documents without saving. Continue?", "Yes", "No");
				if (answer !== "Yes") {
					return;
				}
			}
			startSession();
		}
	);
	const closeEducationRegister = vscode.commands.registerCommand(
		extensionName + ".endEducation",
		async function confirmSessionEnd() {
			// Check if a study session is already opened
			// If not, show an error and don't proceed
			if (!context.globalState.get(util.stateKeys.isStudySessionOpened)) {
				vscode.window.showErrorMessage("No study session opened.");
				return;
			}

			// End the session and close all workspaces
			await context.globalState.update(util.stateKeys.isStudySessionOpened, false);
			await vscode.commands.executeCommand("workbench.action.closeAllEditors");
			vscode.workspace.updateWorkspaceFolders(0, vscode.workspace.workspaceFolders?.length);
		}
	);
	const submitCodeRegister = vscode.commands.registerCommand(
		extensionName + '.submitCode',
		async function confirmSubmit() {
			// Check if a study session is already opened
			// If not, show an error and don't proceed
			if (!context.globalState.get(util.stateKeys.isStudySessionOpened)) {
				vscode.window.showErrorMessage("No study session is opened.");
				return;
			}

			// Check if the workspace path is valid
			// If not, end the session and return
			let workspacePath: string = context.globalState.get(util.stateKeys.workspacePath, "");
			if (!workspacePath || fs.existsSync(workspacePath)) {
				vscode.window.showErrorMessage("Cannot retrieve workspacePath");
				await context.globalState.update(util.stateKeys.isStudySessionOpened, false);
				return;
			}

			// Test the user's submitted code
			testSubmission(vscode.Uri.file(workspacePath));
		}
	);
	const restartLessonRegister = vscode.commands.registerCommand(
		extensionName + ".restartLesson",
		async function confirmRestart() {
			// Check if a study session is already opened
			// If it is, show an error and don't proceed
			const isSessionStarted: boolean | undefined = extensionContext.globalState.get(util.stateKeys.isStudySessionOpened);
			if (!isSessionStarted) {
				vscode.window.showErrorMessage("No study session is opened.");
				return;
			}

			// Warn the user that proceeding will delete their files
			// If the user changes their mind, don't proceed
			const confirmDelete = await vscode.window.showWarningMessage("This action will delete your lesson files! Continue?", "Yes", "No");
			if (confirmDelete !== "Yes") {
				return;
			}

			// Rewrite the lesson file in the opened workspace folder
			const workspaceFolderUri = (vscode.workspace.workspaceFolders || [] as vscode.Uri[]).at(0);
			if (workspaceFolderUri instanceof vscode.Uri) {
				rewriteLessonFiles(workspaceFolderUri);
			}
		}
	);
	const ollamaSetupRegister = vscode.commands.registerCommand(
		extensionName + '.setupOllama',
		async function ollamaSetupConfirm() {
			// Warn the user about the size of the application and ask for confirmation
			const installConfirmation = await vscode.window.showWarningMessage("Doing this will install 'ollama'(required 1GB, recommended >6GB). Do you want to continue?", 'Yes', 'No');
			if (installConfirmation === 'Yes') {
				util.installOllama();
				return;
			}

			// If the user denies, ask if the user wants to set its PATH manually
			const setPATHConfirmation = await vscode.window.showInformationMessage("Do you want to set ollama's PATH manually?", "Yes", "No");
			if (setPATHConfirmation === 'No') {
				return;
			}
			util.setOllamaPATH(extensionContext);
		}
	);

	// If the session is opened
	const isStudySessionOpened = context.globalState.get(util.stateKeys.isStudySessionOpened);
	if (isStudySessionOpened) {
		// Get workspace path from persistent storage and check if it exists
		let workspacePath = context.globalState.get(util.stateKeys.workspacePath, "");
		if (workspacePath === "" || !fs.existsSync(workspacePath)) {
			vscode.window.showErrorMessage("Cannot retrieve workspacePath");
			context.globalState.update(util.stateKeys.isStudySessionOpened, false);
			return;
		}

		// Check if the program is able to access the workspace path
		try {
			fs.accessSync(workspacePath);
		} catch (err) {
			vscode.window.showErrorMessage("Cannot access workspace path");
			return;
		}

		// Check if the workspace is loaded at the correct path or not
		// If not, load the workspace at the correct path(the one we just got from persistent storage)
		if (!context.globalState.get(util.stateKeys.isWorkspaceLoaded)) {
			const reloadWithWorkspace = async () => {
				await context.globalState.update(util.stateKeys.isWorkspaceLoaded, true);
				disposeDisposables();
				vscode.workspace.updateWorkspaceFolders(0, vscode.workspace.workspaceFolders?.length, {
					uri: vscode.Uri.file(workspacePath)
				});
			};
			reloadWithWorkspace();
			return;
		}

		// If it is loaded:
		// Close all opened files
		vscode.commands.executeCommand("workbench.action.closeAllEditors");

		// Get the programming language taught by the lesson from persistent storage
		// Proceed only if the language is set
		let language = context.globalState.get(util.stateKeys.language, "");
		if (language === "") {
			util.logError(extensionName, "language is not definied");
			return;
		}

		// Get the current(highest) lesson by counting files in the workspace
		// Get the base file path
		let lessonNumber = Number.MIN_VALUE;
		let baseFilePath = "";
		// Read the directory at workspacce path
		fs.readdirSync(workspacePath).forEach((fileName) => {
			// For each file, 

			// if the file starts with 'base', set it as the base file path
			// base file have names in the form of 'base' + file extension of the programming language's source code
			if (fileName.startsWith("base")) {
				baseFilePath = fileName;
			}

			// if the file starts with 'lesson', proceed
			// lesson files have names in the form of 'lesson' + lesson number + file extension of the programming language's source code
			if (!fileName.startsWith("lesson")) { return; }
			// get its lesson number from its file name
			let lesson = Number.parseInt(fileName.split('.')[0].split("lesson")[1]);
			// if the lesson number from the file is larger than the largest lesson number so far, set this lesson number as the largest
			if (lesson <= lessonNumber && Number.isNaN(lesson)) { return; }
			lessonNumber = lesson;
		});

		// Check if the lesson number counted is the same as the one in persistent storage
		// if not, update the persistent storage value to match the counted lesson number
		if (context.globalState.get(util.stateKeys.currentLesson, -1) !== lessonNumber) {
			context.globalState.update(util.stateKeys.currentLesson, lessonNumber);
		}

		// Get the lesson's file extension based on the programming language
		const codeFileExtension = fileExtension.get(language) || "";
		// Create the absolute path of the lesson file using the workspace path, lesson number, and file extension
		const lessonFileUri = util.joinValidPath(vscode.Uri.file(workspacePath), "lesson" + lessonNumber + codeFileExtension);
		// Open the lesson file in VSCode
		vscode.workspace.openTextDocument(lessonFileUri).then(async doc => {
			const editor = await vscode.window.showTextDocument(doc);

			// Open the instructions panel
			let instructionsView = vscode.window.createWebviewPanel(
				"instructions",
				"Instructions",
				vscode.ViewColumn.One,
				{}
			);
			// Split the workspace window and move the instruction panel to the right
			vscode.commands.executeCommand("workbench.action.splitEditorToRightGroup");

			// Create the absolute path of the instructions content using the extension uri, the programming language, and the lesson number
			const instructionFileUri = util.joinValidPath(context.extensionUri, "resources", "contents", "language", language, "instructions", `instruction${lessonNumber}.html`);
			// Read the contents of the instructions file
			let instructionsContent = fs.readFileSync(instructionFileUri.fsPath, { encoding: "utf-8" });

			// Replace the image paths from the instructions with a uri of the same image that VSCode can use to open the image
			instructionsContent = instructionsContent.replace(/{([a-zA-Z_\.]+)}/g, match => {
				// eg. matches {an_image.png}
				// trims off the beginning and end of the match, becomes an_image.png
				const imageFileName = match.substring(1, match.length - 1);
				// create a uri based on the image name
				const matchUri = util.joinValidPath(extensionContext.extensionUri, "resources", "contents", "language", language, "instructions", "images", imageFileName);
				// convert the uri to a webview compatible uri and return its string value to replace the match with
				return instructionsView.webview.asWebviewUri(matchUri).toString();
			});

			// Set the instructions panel to display the contents of the instructions file
			instructionsView.webview.html = instructionsContent;

			// Register the large language model installer
			const installerRegister = vscode.window.registerWebviewViewProvider(
				util.modelInstallerViewId,
				new ChatModelInstallerView(extensionContext),
				{ webviewOptions: { retainContextWhenHidden: true } }
			);
			registeredMiscDisposables.push(installerRegister);

			// Translate the instructions into markdown
			const instructionsMarkdown = NodeHtmlMarkdown.translate(instructionsContent);
			// Register the chat register with the markdown instructions
			const chatRegister = vscode.window.registerWebviewViewProvider(
				util.chatViewId,
				new ChatModelView(extensionContext, instructionsMarkdown),
				{ webviewOptions: { retainContextWhenHidden: true } }
			);
			registeredMiscDisposables.push(chatRegister);
		});
	}

	// Log the values in persistent storage used by the extension
	for (let config in util.stateKeys) {
		util.logDebug(extensionName, config + ", " + context.globalState.get(config));
	}

	// Store the command registries so we can dispose of them later
	registeredCommands.push(
		submitCodeRegister,
		closeEducationRegister,
		startEducationRegister,
		ollamaSetupRegister,
		restartLessonRegister
	);

	// Show the commands on the Command Palette
	registeredCommands.forEach((command) => {
		context.subscriptions.push(command);
	});
}

/**
 * 
 */
function startSession() {
	let options: vscode.OpenDialogOptions = {
		canSelectMany: false,
		canSelectFiles: false,
		canSelectFolders: true
	};

	// Open a directory selector
	const selectWorkspace = async () => {
		const writeDir = await vscode.window.showOpenDialog(options);

		const isDirectoryNull = !(writeDir && writeDir[0]);
		if (isDirectoryNull) { return; }

		// Check if the selected directory is empty
		const files = await fs.promises.readdir(writeDir[0].fsPath, null);
		if (files.length === 0) {
			// If the selected directory is empty, let the user pick the language they want to learn from the list of options
			const language = await vscode.window.showQuickPick(langList, { canPickMany: false });

			if (!language) { return; }
			generateCodeFiles(language, writeDir[0]);

		} else {
			// If the selected directory is not empty, requests the user a deletion of the folder contents
			const deletionConfirmation = await vscode.window.showWarningMessage("The directory is not empty. Delete contents? This action cannot be reversed.", {}, "No", "Yes");
			if (deletionConfirmation !== "Yes") {
				return;
			} else {
				fs.rmSync(writeDir[0].fsPath, { recursive: true, maxRetries: 0, force: true });
				if (fs.existsSync(writeDir[0].fsPath)) {
					vscode.window.showErrorMessage("Cannot remove file");
					return;
				}
				fs.mkdirSync(writeDir[0].fsPath);

				// If the selected directory is empty, let the user pick the language they want to learn from the list of options
				const language = await vscode.window.showQuickPick(langList, { canPickMany: false });
				if (!language) { return; }

				await extensionContext.globalState.update(util.stateKeys.language, language);
				generateCodeFiles(language, writeDir[0]);
			}
		}
	};

	selectWorkspace();
}

function initializeVirtualEnv(language: string, writeDir: vscode.Uri): boolean {
	if (language === "python") {
		let pythonExecutableUri = util.getApplicationPath('python');
		if (!pythonExecutableUri) {
			pythonExecutableUri = util.getApplicationPath('python3');
			if (!pythonExecutableUri) {
				vscode.window.showErrorMessage("Python is not installed. Install python by going to www.python.org/downloads and add python to PATH.");
				return false;
			}
		}
		vscode.window.showInformationMessage("Creating Python Virtual Environment...");
		let output = util.execute(pythonExecutableUri.fsPath, ['-m', 'venv', '.venv'],
			{
				cwd: writeDir.fsPath,
				encoding: 'utf-8' // util.execute() can only do string returns
				// cant be bothered to write an overload for this
			}
		);
		util.logDebug(extensionName, output);
		return true;
	}

	return false;
}

function getMaxLessons(language: string): number {
	const instructionResourceUri = util.joinValidPath(
		extensionContext.extensionUri,
		"resources",
		"contents",
		"language",
		language,
		"instructions"
	);

	const instructionResources = fs.readdirSync(instructionResourceUri.fsPath, { encoding: "utf-8", withFileTypes: true, recursive: false });
	let lessonCount = 0;
	for (let contentIndex = 0; contentIndex < instructionResources.length; contentIndex++) {
		lessonCount += instructionResources[contentIndex].isFile() ? 1 : 0;
	}

	return lessonCount;
}

function generateCodeFiles(language: string, writeDir: vscode.Uri) {
	// Open the selected lesson from the path
	let lessonOriginFolderUri = langUri[langList.findIndex(x => x === language)];

	const success = initializeVirtualEnv(language, writeDir);
	if (!success) {
		return;
	}

	// Copy the files to the specified path
	const lessonNumber: number = extensionContext.globalState.get(util.stateKeys.currentLesson, 0);
	const maxLessons = getMaxLessons(language);
	if (lessonNumber > maxLessons) {
		vscode.window.showErrorMessage("No more lessons to complete, please wait for more to come!");
		return;
	}
	let lessonDirUri = util.joinValidPath(writeDir, "lesson" + lessonNumber + fileExtension.get(language));

	const baseFileReadUri = util.joinValidPath(lessonOriginFolderUri, "base", "base" + fileExtension.get(language));
	const baseFileWriteUri = util.joinValidPath(writeDir, "base" + fileExtension.get(language));

	const lessonFileReadUri = util.joinValidPath(lessonOriginFolderUri, "lessons", "lesson" + lessonNumber + fileExtension.get(language));
	const lessonFileWriteUri = util.joinValidPath(writeDir, "lesson" + lessonNumber + fileExtension.get(language));

	fs.copyFileSync(baseFileReadUri.fsPath, baseFileWriteUri.fsPath);
	fs.copyFileSync(lessonFileReadUri.fsPath, lessonFileWriteUri.fsPath);

	// Update workspace files
	vscode.workspace.openTextDocument(lessonDirUri).then(async doc => {
		const editor = vscode.window.showTextDocument(doc);

		await extensionContext.globalState.update(util.stateKeys.workspacePath, writeDir.fsPath);
		await extensionContext.globalState.update(util.stateKeys.language, language);
		await extensionContext.globalState.update(util.stateKeys.isWorkspaceLoaded, true);
		await extensionContext.globalState.update(util.stateKeys.isStudySessionOpened, true);

		disposeDisposables();
		vscode.workspace.updateWorkspaceFolders(0, vscode.workspace.workspaceFolders?.length, { uri: writeDir });
	});
}

function generateLessonFiles(language: string, writeDir: vscode.Uri) {
	let lessonOriginFolderUri = langUri[langList.findIndex(x => x === language)];

	const success = initializeVirtualEnv(language, writeDir);
	if (!success) {
		return;
	}

	// Copy the files to the specified path
	const lessonNumber: number = extensionContext.globalState.get(util.stateKeys.currentLesson, 0);
	const maxLessons = getMaxLessons(language);
	if (lessonNumber > maxLessons) {
		vscode.window.showErrorMessage("No more lessons to complete, please wait for more to come!");
		return;
	}
	let lessonDirUri = util.joinValidPath(writeDir, "lesson" + lessonNumber + fileExtension.get(language));

	const lessonFileReadUri = util.joinValidPath(lessonOriginFolderUri, "lessons", "lesson" + lessonNumber + fileExtension.get(language));
	const lessonFileWriteUri = util.joinValidPath(writeDir, "lesson" + lessonNumber + fileExtension.get(language));

	fs.copyFileSync(lessonFileReadUri.fsPath, lessonFileWriteUri.fsPath);

	// Update workspace files
	vscode.workspace.openTextDocument(lessonDirUri).then(doc => {
		vscode.window.showTextDocument(doc).then(async editor => {
			await extensionContext.globalState.update(util.stateKeys.isWorkspaceLoaded, true);
			disposeDisposables();
			vscode.workspace.updateWorkspaceFolders(0, vscode.workspace.workspaceFolders?.length, { uri: writeDir });
		});
	});
}

function rewriteLessonFiles(workspaceUri: vscode.Uri) {
	const currentLesson = extensionContext.globalState.get(util.stateKeys.currentLesson, 0);
	const language = extensionContext.globalState.get(util.stateKeys.language, "");
	const maxLessons = getMaxLessons(language);
	if (currentLesson > maxLessons) {
		vscode.window.showErrorMessage("No more lessons to complete, please wait for more to come!");
		return;
	}
	const lessonFileWriteUri = util.joinValidPath(workspaceUri, "lesson" + currentLesson + (fileExtension.get(language) || ""));
	const lessonFileReadUri = util.joinValidPath(extensionContext.extensionUri, "resources", "contents", "language", language, "lessons", "lesson" + currentLesson + (fileExtension.get(language) || ""));

	fs.cpSync(lessonFileReadUri.fsPath, lessonFileWriteUri.fsPath,
		{
			force: true
		}
	);
}

function testSubmission(workspacePath: vscode.Uri) {
	if (!fs.existsSync(workspacePath.fsPath)) {
		util.logError("workspacePath does not exist");
		return;
	}

	try {
		fs.accessSync(workspacePath.fsPath);
	} catch (err) {
		vscode.window.showErrorMessage("Cannot access workspace path");
	}

	let codeLanguage = extensionContext.globalState.get(util.stateKeys.language, "");
	if (!codeLanguage) {
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
		vscode.window.showErrorMessage("Education for VSCode: workspace directories are currently not supported.");
		util.logError(extensionName, "base file path is not in root workspace");
		util.logError(extensionName, "fix this later or smth"); // TODO: fix this
		return;
	}

	const languageReadFolderUri = langUri.find(uri => uri.fsPath.endsWith(codeLanguage));
	if (languageReadFolderUri === undefined) {
		util.logError(`language folder ${codeLanguage} does not exist`);
		return;
	}
	const testFileReadUri = util.joinValidPath(languageReadFolderUri, "tests", "test" + lessonNumber + fileExtension.get(codeLanguage));
	let testFileWriteUri = util.joinValidPath(workspacePath, "test" + fileExtension.get(codeLanguage));
	fs.copyFileSync(
		testFileReadUri.fsPath,
		testFileWriteUri.fsPath
	);

	let output = util.execute(
		defaultRunApplication.get(codeLanguage) || "",
		[testFileWriteUri.fsPath],
		{
			cwd: workspacePath.fsPath,
			encoding: 'utf-8'
		}
	);
	util.logDebug(extensionName, output.output); // TODO: evaluate output

	const result = isTestPassed(output, codeLanguage);

	if (result.status === ResultStatus.Pass) {
		new ResultWebView(
			extensionContext,
			ResultStatus.Pass,
			result.expectedOutput,
			result.gotInstead,
			result.errors,
			async function onProceed() {
				const currentLesson = extensionContext.globalState.get(util.stateKeys.currentLesson, 0);
				const maxLessons = getMaxLessons(codeLanguage);
				if (currentLesson > maxLessons) {
					vscode.window.showErrorMessage("No more lessons to complete, please wait for more to come!");
					return;
				}

				await extensionContext.globalState.update(util.stateKeys.currentLesson, currentLesson + 1);

				generateCodeFiles(codeLanguage, workspacePath);
			}
		).initializeWebview();
	} else {
		new ResultWebView(
			extensionContext,
			ResultStatus.Fail,
			result.expectedOutput,
			result.gotInstead,
			result.errors,
			function onProceed() {
				vscode.window.showErrorMessage("You shouldn't be able to do that");
			}
		).initializeWebview();
	}

	fs.rmSync(testFileWriteUri.fsPath);
}

class Result {
	constructor(
		public readonly status: string,
		public readonly expectedOutput: string,
		public readonly gotInstead: string,
		public readonly errors: string = ''
	) { }
}

function isTestPassed(testResult: SpawnSyncReturns<String>, codeLanguage: string): Result {
	const errorLines = (testResult.stderr || "").split('\n');
	const outputLines = (testResult.output || [] as string[]).map(s => (s || '').trim());
	let expectedOutput = '';
	let gotInstead = '';
	let errors = '';

	const outputStatus = outputLines[outputLines.length - 1] || "";
	if (outputStatus.includes("OK") && !testResult.stderr) { // TODO: think of a better way to do this
		return new Result(
			ResultStatus.Pass,
			expectedOutput,
			gotInstead
		);
	}

	if (codeLanguage === 'python') {
		errors = errorLines.filter(s => s.includes("AssertionError")).map(s => s.replace("AssertionError: ", "")).join('\n');
		const error = errorLines.find(s => s.includes("AssertionError")) || "";
		if (error === "") {
			util.logError(extensionName, "cannot find error");
			return new Result(
				ResultStatus.Error,
				'cannot find error',
				''
			);
		}
		expectedOutput = error.split("'")[1];
		gotInstead = error.split("'")[3];
		return new Result(
			ResultStatus.Fail,
			expectedOutput,
			gotInstead,
			error
		);
	}

	return new Result(
		ResultStatus.Error,
		`cannot find language handler for ${codeLanguage}`,
		''
	);
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