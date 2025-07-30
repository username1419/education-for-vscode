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
	["python", process.platform === 'win32' ? ".venv\\Scripts\\python.exe" : ".venv/bin/python3"]
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

/** 
 * Function called when the extension activates. Registers commands and webviews, and other things
 * 
 * @param context A collection of utilities private to this extension.
 */
export function activate(context: vscode.ExtensionContext) {

	// Make sure the extension is correctly loaded
	util.logDebug(extensionName, `Congratulations, your extension "${extensionName}" is now active!`);
	util.logDebug(extensionName, `Extension globalState path: ${context.globalStorageUri.fsPath}`);
	process.on("uncaughtException", err => {
		util.logError(`Unhandled exception occured: 
			name: ${err.name}, 
			message: ${err.message}, 
			cause: ${err.cause}`);
		vscode.window.showErrorMessage(`Education for VSCode: Error encountered: ${err.name}, ${err.message}`);
	});

	process.on("unhandledRejection", (reason, promise) => {
		util.logError(`Unhandled exception occured: 
			reason: ${reason}`);
		vscode.window.showErrorMessage(`Education for VSCode: Error encountered: ${reason}`);
	});

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
			if (!workspacePath || !fs.existsSync(workspacePath)) {
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
			const installConfirmation = await vscode.window.showWarningMessage("Doing this will install 'ollama'(required 1GB, recommended >6GB). Do you want to continue?", 'Yes', 'I already have ollama', 'No');
			if (installConfirmation === "No" || !installConfirmation) { return; }

			if (installConfirmation === 'Yes') {
				util.ChatHelper.installOllama();
				return;
			}

			// If the user denies, ask if the user wants to set its PATH manually
			const setPATHConfirmation = await vscode.window.showInformationMessage("Do you want to set ollama's PATH manually?", "Yes", "No");
			if (setPATHConfirmation === 'No') { return; }
			util.ChatHelper.setOllamaPATH(extensionContext);
		}
	);
	const clearGlobalStorageRegister = vscode.commands.registerCommand(
		extensionName + ".debugClearGlobalStorage",
		async function clearGlobalStorage() {
			// Warn users about the effects of the command and let them return if they didn't mean to run it
			const confirm = await vscode.window.showWarningMessage("This will revert ALL of your progress to default. DO NOT PROCEED unless you know exactly what you are doing! Proceed?", "Yes", "No");
			if (confirm !== 'Yes') {
				return;
			}

			// Remove all keys used by the extension from globalState
			for (let config in util.stateKeys) {
				extensionContext.globalState.update(config, undefined);
			}
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
 * Let the user choose a directory and start creating the lesson environment
 */
async function startSession() {
	let options: vscode.OpenDialogOptions = {
		canSelectMany: false,
		canSelectFiles: false,
		canSelectFolders: true
	};

	// Open a directory selector
	const writeDir = await vscode.window.showOpenDialog(options);

	const isDirectoryNull = !(writeDir && writeDir[0]);
	if (isDirectoryNull) { return; }

	// Check if the selected directory is empty
	const files = await fs.promises.readdir(writeDir[0].fsPath, null);
	if (files.length === 0) {
		// If the selected directory is empty, let the user pick the language they want to learn from the list of options
		const language = await vscode.window.showQuickPick(langList, { canPickMany: false });

		// Sets the language the user wants
		if (!language) { return; }
		// Create files for the lesson
		generateCodeFiles(language, writeDir[0]);

	} else {
		// If the selected directory is not empty, requests the user a deletion of the folder contents
		const deletionConfirmation = await vscode.window.showWarningMessage("The directory is not empty. Delete contents? This action cannot be reversed.", {}, "No", "Yes");
		if (deletionConfirmation !== "Yes") {
			return;
		} else {
			// Delete the directory recursively
			fs.rmSync(writeDir[0].fsPath, { recursive: true, maxRetries: 0, force: true });
			if (fs.existsSync(writeDir[0].fsPath)) {
				vscode.window.showErrorMessage("Cannot remove file");
				return;
			}

			// Create a directory with the same name
			fs.mkdirSync(writeDir[0].fsPath);

			// If the selected directory is empty, let the user pick the language they want to learn from the list of options
			const language = await vscode.window.showQuickPick(langList, { canPickMany: false });
			if (!language) { return; }

			// Sets the language the user wants
			await extensionContext.globalState.update(util.stateKeys.language, language);
			// Create files for the lesson
			generateCodeFiles(language, writeDir[0]);
		}
	}
}

/**
 * Initializes the virtual environment depending on the language. Returns `true` if successful, `false` otherwise.
 * @param language The language of the virtual environment
 * @param writeDir The path where the virtual environment will be created at
 */
function initializeVirtualEnv(language: string, writeDir: vscode.Uri): boolean {
	// If language is python
	if (language === "python") {
		// Get python executable path
		let pythonExecutableUri = util.getApplicationPath('python');
		if (!pythonExecutableUri) {
			pythonExecutableUri = util.getApplicationPath('python3');
			// If python is not found, notify the user and return unsuccessful
			if (!pythonExecutableUri) {
				vscode.window.showErrorMessage("Python is not installed. Install python by going to www.python.org/downloads and add python to PATH.");
				return false;
			}
		}
		// Notify the user
		vscode.window.showInformationMessage("Creating Python Virtual Environment, this may take a few minutes...");
		// Create the virtual environment
		let output = util.execute(pythonExecutableUri.fsPath, ['-m', 'venv', '.venv'],
			{
				cwd: writeDir.fsPath,
				encoding: 'utf-8'
			}
		);
		// Notify the user if there is an error
		if (output.error) {
			vscode.window.showErrorMessage(`Creating Python Virtual Environment failed. Error: ${output.stderr}`);
			return false;
		}
		util.logDebug(extensionName, output);
		return true;
	}

	return false;
}

/**
 * Retrieves the number of lesson instruction files available for a given language.
 * 
 * @param language The target language used to construct the instructions directory path
 * @returns The amount of instructions files found for the target language
 */
function getMaxLessons(language: string): number {
	// Construct the instructions Uri
	const instructionResourceUri = util.joinValidPath(
		extensionContext.extensionUri,
		"resources",
		"contents",
		"language",
		language,
		"instructions"
	);

	// Read all files in the instructions directory
	const instructionResources = fs.readdirSync(instructionResourceUri.fsPath, { encoding: "utf-8", withFileTypes: true, recursive: false });
	// Loop through the files and count them
	let lessonCount = 0;
	for (let contentIndex = 0; contentIndex < instructionResources.length; contentIndex++) {
		lessonCount += instructionResources[contentIndex].isFile() ? 1 : 0;
	}

	return lessonCount;
}

/**
 * Generates code files for the given language at the provided path.
 * 
 * The function does the following:
 * - Gets the origin folder for the provided language
 * - Creates a virtual environment based on the language
 * - Retrieves the current lesson number and check it against the maximum lesson available
 * - Copies the base and lesson files from the origin to the path provided
 * - Opens the lesson file in VSCode
 * - Replaces the workspace directory with the path provided
 * 
 * Returns early if creating the virtual environment fails or the max lesson is reached
 * 
 * @param language Target language to create lesson code files from
 * @param writeDir The target location to create code files to
 */
function generateCodeFiles(language: string, writeDir: vscode.Uri) {
	// Retrieves the lesson origin directory path
	let lessonOriginFolderUri = langUri[langList.findIndex(x => x === language)];

	// Initialize the virtual environment
	const success = initializeVirtualEnv(language, writeDir);
	if (!success) {
		return;
	}

	// Retrieve the lesson number and check if the max lesson is reached
	const lessonNumber: number = extensionContext.globalState.get(util.stateKeys.currentLesson, 0);
	const maxLessons = getMaxLessons(language);
	if (lessonNumber > maxLessons) {
		vscode.window.showErrorMessage("No more lessons to complete, please wait for more to come!");
		return;
	}

	// Copy the files to the specified path
	const baseFileReadUri = util.joinValidPath(lessonOriginFolderUri, "base", "base" + fileExtension.get(language));
	const baseFileWriteUri = util.joinValidPath(writeDir, "base" + fileExtension.get(language));

	const lessonFileReadUri = util.joinValidPath(lessonOriginFolderUri, "lessons", "lesson" + lessonNumber + fileExtension.get(language));
	const lessonFileWriteUri = util.joinValidPath(writeDir, "lesson" + lessonNumber + fileExtension.get(language));

	fs.copyFileSync(baseFileReadUri.fsPath, baseFileWriteUri.fsPath);
	fs.copyFileSync(lessonFileReadUri.fsPath, lessonFileWriteUri.fsPath);

	// Update workspace files
	let lessonDirUri = util.joinValidPath(writeDir, "lesson" + lessonNumber + fileExtension.get(language));
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

/**
 * Generates code files for the given language at the provided path. Does the same 
 * thing as {@link generateCodeFiles} other than copying the base file and initialize 
 * the virtual environment.
 * 
 * @param language Target language to create lesson code files from
 * @param writeDir The target location to create code files to
 */
function generateLessonFiles(language: string, writeDir: vscode.Uri) {
	// Retrieves the lesson origin directory path
	let lessonOriginFolderUri = langUri[langList.findIndex(x => x === language)];

	// Retrieve the lesson number and check if the max lesson is reached
	const lessonNumber: number = extensionContext.globalState.get(util.stateKeys.currentLesson, 0);
	const maxLessons = getMaxLessons(language);
	if (lessonNumber > maxLessons) {
		vscode.window.showErrorMessage("No more lessons to complete, please wait for more to come!");
		return;
	}

	// Copy the files to the specified path
	const lessonFileReadUri = util.joinValidPath(lessonOriginFolderUri, "lessons", "lesson" + lessonNumber + fileExtension.get(language));
	const lessonFileWriteUri = util.joinValidPath(writeDir, "lesson" + lessonNumber + fileExtension.get(language));

	fs.copyFileSync(lessonFileReadUri.fsPath, lessonFileWriteUri.fsPath);

	// Update workspace files
	let lessonDirUri = util.joinValidPath(writeDir, "lesson" + lessonNumber + fileExtension.get(language));
	vscode.workspace.openTextDocument(lessonDirUri).then(doc => {
		vscode.window.showTextDocument(doc).then(async editor => {
			await extensionContext.globalState.update(util.stateKeys.isWorkspaceLoaded, true);
			disposeDisposables();
			vscode.workspace.updateWorkspaceFolders(0, vscode.workspace.workspaceFolders?.length, { uri: writeDir });
		});
	});
}

/**
 * Rewrites the lesson file of the current lesson at the provided directory
 * @param workspaceUri The path of the file's directory
 */
function rewriteLessonFiles(workspaceUri: vscode.Uri) {
	// Get the language
	const language = extensionContext.globalState.get(util.stateKeys.language, "");

	// Retrieve the lesson number and check if the max lesson is reached
	const currentLesson = extensionContext.globalState.get(util.stateKeys.currentLesson, 0);
	const maxLessons = getMaxLessons(language);
	if (currentLesson > maxLessons) {
		vscode.window.showErrorMessage("No more lessons to complete, please wait for more to come!");
		return;
	}

	// Copy the files to the specified path
	const lessonFileWriteUri = util.joinValidPath(workspaceUri, "lesson" + currentLesson + (fileExtension.get(language) || ""));
	const lessonFileReadUri = util.joinValidPath(extensionContext.extensionUri, "resources", "contents", "language", language, "lessons", "lesson" + currentLesson + (fileExtension.get(language) || ""));

	fs.cpSync(lessonFileReadUri.fsPath, lessonFileWriteUri.fsPath,
		{
			force: true
		}
	);
}

/**
 * Tests the user's lesson submission within the given workspace.
 * 
 * This function verifies the workspace exists and is accessible, identifies the most current lesson file,
 * copies the corresponding test file from the language resources, executes it, and shows the result in a webview.
 * 
 * If the test passes, the lesson is marked complete and the next lesson is prepared. If the test fails,
 * an error message and feedback are shown. Temporary test files are cleaned up at the end.

 * @param workspacePath The path of the workspace directory containing the lesson
 */
function testSubmission(workspacePath: vscode.Uri) {
	// Check if the workspace path is accessible to the process
	try {
		fs.accessSync(workspacePath.fsPath);
	} catch (err) {
		vscode.window.showErrorMessage("Cannot access workspace path");
		return;
	}

	// Get the programming language of the lesson
	let language = extensionContext.globalState.get(util.stateKeys.language, "");
	if (!language) {
		util.logError(extensionName, "globalState codeLanguage is undefined");
		return;
	}

	// Get the lesson number from the workspace
	let lessonNumber = Number.MIN_VALUE;
	fs.readdirSync(workspacePath.fsPath).forEach((fileName) => {

		if (!fileName.startsWith("lesson")) { return; }
		let lesson = Number.parseInt(fileName.split('.')[0].split("lesson")[1]);
		if (lesson <= lessonNumber && Number.isNaN(lesson)) { return; }
		lessonNumber = lesson;
	});

	// Check if the lesson number matches the one in the storage, if not, exit
	if (lessonNumber !== extensionContext.globalState.get(util.stateKeys.currentLesson)) {
		util.logError(extensionName, `lesson number and globalstate do not match. lesson number: ${lessonNumber}, global state ${extensionContext.globalState.get(util.stateKeys.currentLesson)}`);
		vscode.window.showErrorMessage("Lesson numbers do not match. Exiting...");

		extensionContext.globalState.update(util.stateKeys.currentLesson, 0);
		extensionContext.globalState.update(util.stateKeys.isStudySessionOpened, false);
		vscode.workspace.updateWorkspaceFolders(0, vscode.workspace.workspaceFolders?.length);
	}

	// Get language folder path from storage
	const languageReadFolderUri = langUri.find(uri => uri.fsPath.endsWith(language));
	if (languageReadFolderUri === undefined) {
		util.logError(`language folder ${language} does not exist`);
		return;
	}

	// Get the test path from the language folder
	const testFileReadUri = util.joinValidPath(languageReadFolderUri, "tests", "test" + lessonNumber + fileExtension.get(language));
	let testFileWriteUri = util.joinValidPath(workspacePath, "test" + fileExtension.get(language));
	// Copy the test path to the workspace
	fs.copyFileSync(
		testFileReadUri.fsPath,
		testFileWriteUri.fsPath
	);

	// Execute the test using the specific language's compiler
	vscode.window.showInformationMessage("Education for VSCode: Testing submission...");
	let output = util.execute(
		defaultRunApplication.get(language) || "",
		[testFileWriteUri.fsPath],
		{
			cwd: workspacePath.fsPath,
			encoding: 'utf-8'
		}
	);
	util.logDebug(extensionName, output);

	// Evaluate the test output into a easy to understand result we can show the user
	const result = evaluateResult(output, language);

	if (result.status === ResultStatus.Pass) {
		// If test passes, create a result window that tells the user their results
		new ResultWebView(
			extensionContext,
			ResultStatus.Pass,
			result.expectedOutput,
			result.gotInstead,
			result.errors,
			async function onProceed() {
				// Get the current lesson number and verify it is not the maximum lesson the uesr can complete
				const currentLesson = extensionContext.globalState.get(util.stateKeys.currentLesson, 0);
				const maxLessons = getMaxLessons(language);
				if (currentLesson > maxLessons) {
					vscode.window.showErrorMessage("No more lessons to complete, please wait for more to come!");
					return;
				}

				// Increment the current lesson
				await extensionContext.globalState.update(util.stateKeys.currentLesson, currentLesson + 1);
				await extensionContext.globalState.update(util.stateKeys.isWorkspaceLoaded, false);

				// Close all editors and create the files required for the next lesson
				await vscode.commands.executeCommand("workbench.actions.closeAllEditors");
				generateLessonFiles(language, workspacePath);
			}
		).initializeWebview(); // Render the window
	} else {
		// If the test fails, detail the expected results and what the program outputs
		new ResultWebView(
			extensionContext,
			ResultStatus.Fail,
			result.expectedOutput,
			result.gotInstead,
			result.errors,
			function onProceed() {
				vscode.window.showErrorMessage("You shouldn't be able to do that");
			}
		).initializeWebview(); // Render the window
	}

	// Remove the test files
	fs.rmSync(testFileWriteUri.fsPath);
}

/**
 * Container class for properties required for initialization of {@link	ResultWebView}
 */
class Result {
	constructor(
		/** The status of the result. Eg. Pass, Fail */
		public readonly status: string,
		/** The output the program was expected to produce */
		public readonly expectedOutput: string,
		/** The output the program did produce */
		public readonly gotInstead: string,
		/** The errors given from the compiler */
		public readonly errors: string = ''
	) { }
}

/**
 * Evaluates the result and formats them into expected values, actual output gotten, 
 * and the status of the result, depending on the language.
 * 
 * @param testResult Output from the command line after running the test
 * @param codeLanguage The language of the tested program
 * @returns A object containing the expected value, the actual output gotten, and whether the test passed or failed.
 */
function evaluateResult(testResult: SpawnSyncReturns<String>, codeLanguage: string): Result {

	// Splits standard error by line into an array for easy parsing
	const errorLines = (testResult.stderr || "").split('\n');
	// Splits output(stdout & stderr) by line into an array and remove all trailing & leading whitespace and newlines
	const outputLines = (testResult.output || [] as string[])
		.map(s => (s || '').trim())
		.filter(s => s);
	let expectedOutput = '';
	let gotInstead = '';
	let errors = '';

	// If the last line contains "OK", the test passes
	// TODO: think of a better way to do this
	const outputStatus = outputLines[outputLines.length - 1] || "";
	if (outputStatus.includes("OK") && !testResult.error) {
		return new Result(
			ResultStatus.Pass,
			expectedOutput,
			gotInstead
		);
	}

	// Evaluate the error for python code
	if (codeLanguage === 'python') {
		// Find lines in standard error that contains the error details
		errors = errorLines.filter(s => s.includes("AssertionError")).map(s => s.replace("AssertionError: ", "")).join('\n');
		// Find the line which contains the error
		const error = errorLines.find(s => s.includes("AssertionError")) || "";
		// If the assertion error details cannot be found, a different error is causing the program to quit early
		if (error === "") {
			// In that case, we log the error and show the user what went wrong
			util.logError(extensionName, `cannot find error, output: ${testResult}`);
			return new Result(
				ResultStatus.Error,
				'',
				'',
				errorLines.join('\n')
			);
		}

		// 2 assertion messages are formatted
		// There are more that can be displayed but these are the only ones displayed in the provided tests
		if (error.includes("'")) {
			// eg. error = "AssertionError: 'expected_output' not found in 'actual_output'"
			// Split the error message into chunks at the ' characters
			const chunks = error.split("'"); // -> ["AssertionError: ", "expected_output", " not found in ", "actual_output", ""]
			// Get the expected and actual output values from the split chunks
			expectedOutput = chunks[1]; // -> "expected_output"
			gotInstead = chunks[3]; // -> "actual_output"
		} else if (error.includes("=!")) {
			// eg. error = "AssertionError: expected_output != actual_output"
			// Remove the error name from the error details
			error.replace("AssertionError: ", ""); // -> "expected_output != actual_output"
			// Split the error message into chunks at the " != "
			const chunks = error.split(" =! "); // -> ["expected_output", "actual_output"]
			// Get the expected and actual output values from the split chunks
			expectedOutput = chunks[0];
			expectedOutput = chunks[1];
		}

		// Return a Result object containing information about the test that the program failed at
		return new Result(
			ResultStatus.Fail,
			expectedOutput,
			gotInstead,
			error
		);
	}

	// Return an error if the language is not able to be evaluated
	return new Result(
		ResultStatus.Error,
		`cannot find language handler for ${codeLanguage}`,
		''
	);
}


/**
 * Disposes of commands, events, webviews, and more.
 * 
 * Created to use before {@link vscode.workspace.updateWorkspaceFolders()} to not cause a memory leak
 */
function disposeDisposables() {
	util.logInfo(extensionName, "Cleaning up resources...");
	registeredCommands.forEach(command => {
		command.dispose();
	});

	registeredEvents.forEach(event => {
		event.dispose();
	});

	registeredMiscDisposables.forEach(disposable => {
		disposable.dispose();
	});
}

/**
 * Called when this function deactivates. 
 */
export function deactivate() {
	// Disposes all disposable objects
	disposeDisposables();
	// Unloads the workspace
	extensionContext.globalState.update(util.stateKeys.isWorkspaceLoaded, false);
}