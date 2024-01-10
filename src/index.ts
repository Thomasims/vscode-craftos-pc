import * as vscode from "vscode";
import { CraftConnection } from "./connection";
import { FindConnection, FindWindow, ext } from "./globals";
import { ComputerProvider, MonitorProvider, WindowRef } from "./view_terminals";
import https from "https";
import { getDataPath } from "./utils";
import { CraftFile, CraftFileSystemProvider, FileProvider } from "./view_explorer";
import { basename, dirname, join } from "path";

const commands: Record<string, (...args: any[]) => any> = {};

let computer_provider: ComputerProvider;
let monitor_provider: MonitorProvider;
let file_provider: FileProvider;

export function activate(context: vscode.ExtensionContext) {
	ext.context = context;
	ext.log = vscode.window.createOutputChannel("CraftOS-PC");
	computer_provider = new ComputerProvider();
	monitor_provider = new MonitorProvider();
	file_provider = new FileProvider();
	ext.connections = new Map();
	vscode.window.createTreeView("craftos-computers", { treeDataProvider: computer_provider });
	vscode.window.createTreeView("craftos-monitors", { treeDataProvider: monitor_provider });
	vscode.window.createTreeView("craftos-files", {
		treeDataProvider: file_provider,
		dragAndDropController: file_provider,
		canSelectMany: true,
		showCollapseAll: true,
	});
	context.subscriptions.push(
		vscode.workspace.registerFileSystemProvider("craftos-pc", new CraftFileSystemProvider())
	);
	context.subscriptions.push(
		vscode.window.registerUriHandler({
			handleUri: (uri) => {
				vscode.commands.executeCommand("craftos-pc.open-websocket", uri.path.replace(/^\//, ""));
			},
		})
	);

	for (const name in commands) {
		context.subscriptions.push(vscode.commands.registerCommand(name, commands[name]));
	}

	vscode.window.registerWebviewPanelSerializer("craftos-pc", {
		deserializeWebviewPanel: (panel, state: { connectionID: string; windowID: number }) => {
			if (!state) return panel.dispose();
			connectToID(state.connectionID, true).newWindow(state.windowID).open(panel);
		},
	});
	restoreConnections();
	const knownConnections = ext.context.workspaceState.get("connections") as string[];
	if (knownConnections) knownConnections.forEach((connectionID) => connectToID(connectionID, true));
}

export function deactivate(closeWindows?: boolean) {
	for (const connection of ext.connections.values()) {
		if (!closeWindows) connection.windows.clear();
		connection.kill();
	}
	ext.connections.clear();
}

function computerFSCount() {
	let total = 0;
	for (const connection of ext.connections.values()) {
		if (connection.supportsFilesystem) total++;
	}
	return total;
}

function saveConnections() {
	ext.context.globalState.update("savedConnections", [...ext.connections.keys()]);
}

function restoreConnections() {
	const saved = ext.context.globalState.get("savedConnections") as string[];
	if (saved) saved.forEach((connectionID) => connectToID(connectionID, true));
}

function updateViews() {
	computer_provider.fire(null);
	monitor_provider.fire(null);
	file_provider.fire(null);

	vscode.commands.executeCommand("setContext", "craftos.computerFSCount", computerFSCount());
	ext.context.workspaceState.update("connections", [...ext.connections.keys()]);
}

function connectToID(id: string, keepClosed?: boolean) {
	if (!ext.connections.has(id)) {
		const localid = id.match(/^local-(\d+)$/);
		if (localid) return connectToProcess([], parseInt(localid[1]), keepClosed);
		else return connectToWebSocket(id, keepClosed);
	}
	return ext.connections.get(id);
}

function connectToProcess(extraArgs?: string[], id?: number, keepClosed?: boolean) {
	let nextID = ext.connections.size;
	if (id !== undefined) {
		nextID = id;
	} else {
		for (let i = 0; i < ext.connections.size; i++) {
			if (!ext.connections.has(`local-${i}`)) {
				nextID = i;
				break;
			}
		}
	}
	if (nextID > 0) {
		extraArgs = extraArgs || [];
		extraArgs.push("--id", nextID.toFixed(0));
	}
	const connection = CraftConnection.fromProcess("local-" + nextID, extraArgs, keepClosed);
	connection.on("windows", () => updateViews());
	connection.on("close", () => updateViews());
	connection.on("version", () => updateViews());
	updateViews();
	return connection;
}

function connectToWebSocket(url, keepClosed?: boolean) {
	const connection = CraftConnection.fromWebsocket(url, url, keepClosed);
	connection.on("windows", () => updateViews());
	connection.on("close", () => updateViews());
	connection.on("version", () => updateViews());
	updateViews();
	return connection;
}

commands["craftos-pc.open"] = () => connectToProcess();

function validateURL(str) {
	try {
		let url = new URL(str);
		return url.protocol.toLowerCase() == "ws:" || url.protocol.toLowerCase() == "wss:";
	} catch (e) {
		return false;
	}
}

commands["craftos-pc.open-websocket"] = async (url) => {
	if (typeof url === "string") return connectToWebSocket(url);
	let wsHistory = ext.context.globalState.get("JackMacWindows.craftos-pc/websocket-history", [""]);
	let quickPick = vscode.window.createQuickPick();
	quickPick.items = wsHistory.map((val) => {
		return { label: val };
	});
	quickPick.title = "Enter the WebSocket URL:";
	quickPick.placeholder = "wss://";
	quickPick.canSelectMany = false;
	quickPick.onDidChangeValue(() => {
		wsHistory[0] = quickPick.value;
		quickPick.items = wsHistory.map((val) => {
			return { label: val };
		});
	});
	quickPick.onDidAccept(() => {
		let str = quickPick.selectedItems[0].label;
		if (!validateURL(str)) vscode.window.showErrorMessage("The URL you entered is not valid.");
		else {
			wsHistory[0] = str;
			if (wsHistory.slice(1).includes(str)) wsHistory.splice(wsHistory.slice(1).indexOf(str) + 1, 1);
			wsHistory.unshift("");
			ext.context.globalState.update("JackMacWindows.craftos-pc/websocket-history", wsHistory);
			connectToWebSocket(str);
		}
	});
	quickPick.show();
};

commands["craftos-pc.detach"] = (obj: WindowRef) => {
	if (typeof obj === "object") return ext.connections.get(obj.connection)?.detach();
	vscode.window
		.showInputBox({
			prompt: "Enter the window ID:",
			validateInput: (str) => (isNaN(parseInt(str)) ? "Invalid number" : null),
		})
		.then((id) => FindConnection(id)?.detach());
};

commands["craftos-pc.clear-history"] = () =>
	ext.context.globalState.update("JackMacWindows.craftos-pc/websocket-history", [""]);

let didShowBetaMessage = false;
commands["craftos-pc.open-new-remote"] = () => {
	if (!didShowBetaMessage) {
		vscode.window.showWarningMessage(
			"remote.craftos-pc.cc is currently in beta. Be aware that things may not work as expected. If you run into issues, please report them [on GitHub](https://github.com/MCJack123/remote.craftos-pc.cc/issues). If things break, use Shift+Ctrl+P (Shift+Cmd+P on Mac), then type 'reload window' and press Enter."
		);
		didShowBetaMessage = true;
	}
	https
		.get("https://remote.craftos-pc.cc/new", (res) => {
			if (Math.floor(res.statusCode / 100) !== 2) {
				vscode.window.showErrorMessage("Could not connect to remote.craftos-pc.cc: HTTP " + res.statusCode);
				res.resume();
				return;
			}
			res.setEncoding("utf8");
			let id = "";
			res.on("data", (chunk) => (id += chunk));
			res.on("end", () => {
				vscode.env.clipboard.writeText("wget run https://remote.craftos-pc.cc/server.lua " + id);
				vscode.window.showInformationMessage(
					"A command has been copied to the clipboard. Paste that into the ComputerCraft computer to establish the connection."
				);
				connectToWebSocket("wss://remote.craftos-pc.cc/" + id);
			});
		})
		.on("error", (e) => {
			if (e.message.match("certificate has expired"))
				vscode.window
					.showErrorMessage(
						"A bug in VS Code is causing the connection to fail. Please go to https://www.craftos-pc.cc/docs/remote#certificate-has-expired-error to fix it.",
						"Open Page",
						"OK"
					)
					.then((res) => {
						if (res === "OK") return;
						vscode.env.openExternal(
							vscode.Uri.parse("https://www.craftos-pc.cc/docs/remote#certificate-has-expired-error")
						);
					});
			else vscode.window.showErrorMessage("Could not connect to remote.craftos-pc.cc: " + e.message);
		});
};

commands["craftos-pc.open-window"] = (obj: WindowRef) => {
	if (typeof obj === "object") return ext.connections.get(obj.connection)?.windows.get(obj.window)?.open();
	vscode.window
		.showInputBox({
			prompt: "Enter the window ID:",
			validateInput: (str) => (isNaN(parseInt(str)) ? "Invalid number" : null),
		})
		.then((id) => FindWindow(id)?.open());
};

commands["craftos-pc.open-config"] = () => {
	if (getDataPath() === null) {
		vscode.window.showErrorMessage("Please set the path to the CraftOS-PC data directory manually.");
		return;
	}
	vscode.commands.executeCommand("vscode.open", vscode.Uri.file(getDataPath() + "/config/global.json"));
};

commands["craftos-pc.close"] = () => {
	for (const connection of ext.connections.values()) {
		connection.disconnect();
	}
};

commands["craftos-pc.close-window"] = async (obj: WindowRef) => {
	if (typeof obj === "object") return FindConnection(obj.connection)?.removeWindow(obj.window);
	const id = await vscode.window.showInputBox({ prompt: "Enter the window ID:" });
	FindConnection(id)?.removeWindow(parseInt(id));
};

commands["craftos-pc.kill"] = async (obj: WindowRef) => {
	if (typeof obj === "object") return FindConnection(obj.connection)?.kill();
	const id = await vscode.window.showInputBox({ prompt: "Enter the window ID:" });
	FindConnection(id)?.kill();
};

commands["craftos-pc.run-file"] = (path) => {
	if (!path) {
		if (
			vscode.window.activeTextEditor === undefined ||
			vscode.window.activeTextEditor.document.uri.scheme !== "file"
		) {
			vscode.window.showErrorMessage("Please open or save a file on disk before using this command.");
			return;
		}
		path = vscode.window.activeTextEditor.document.uri.fsPath;
	} else if (typeof path === "object" && path instanceof vscode.Uri) {
		if (path.scheme !== "file") {
			vscode.window.showErrorMessage("Please open or save a file on disk before using this command.");
			return;
		}
		path = path.fsPath;
	}
	return connectToProcess(["--script", path]);
};

commands["craftos-pc.open-remote-data"] = async (obj: CraftFile | WindowRef) => {
	const connectionID = obj
		? obj.connection
		: await vscode.window.showInputBox({ prompt: "Enter the connection ID:" });
	const connection = ext.connections.get(connectionID);
	if (!connection) {
		vscode.window.showErrorMessage("The connection does not exist.");
		return;
	}
	if (!connection.supportsFilesystem) {
		vscode.window.showErrorMessage("The connection does not support file access.");
		return;
	}
	let cleanWindows = false;
	if (!vscode.workspace.workspaceFile) {
		const opt = await vscode.window.showWarningMessage(
			"Due to technical limitations, opening the computer data will cause the connection to restart and windows to close. Please reopen windows after running this. Are you sure you want to continue?",
			"No",
			"Yes"
		);
		if (opt === "No") return;
		cleanWindows = true;
		saveConnections(); // Try to reopen connections
	}
	vscode.workspace.updateWorkspaceFolders(
		vscode.workspace.workspaceFolders ? vscode.workspace.workspaceFolders.length : 0,
		null,
		{ name: connection.windows.get(0)?.title, uri: vscode.Uri.parse(`craftos-pc://${connection.uid}/`) }
	);
	if (cleanWindows) deactivate(true);
};

async function exists(uri: vscode.Uri) {
	try {
		await vscode.workspace.fs.stat(uri);
		return true;
	} catch (_) {
		return false;
	}
}

commands["craftos-pc.file-new"] = async (obj: CraftFile) => {
	if (!obj || !obj.isFolder) return;
	const name = await vscode.window.showInputBox({ prompt: "Enter the file name:" });
	const newUri = vscode.Uri.joinPath(obj.resourceUri, name);
	if (await exists(newUri)) return;
	await vscode.workspace.fs.writeFile(newUri, new Uint8Array(0));
	vscode.commands.executeCommand("vscode.open", newUri);
	updateViews();
};

commands["craftos-pc.file-new-folder"] = async (obj: CraftFile) => {
	if (!obj || !obj.isFolder) return;
	const name = await vscode.window.showInputBox({ prompt: "Enter the folder name:" });
	const newUri = vscode.Uri.joinPath(obj.resourceUri, name);
	await vscode.workspace.fs.createDirectory(newUri);
	updateViews();
};

commands["craftos-pc.file-copy-path"] = async (obj: CraftFile) => {
	if (!obj) return;
	vscode.env.clipboard.writeText(obj.resourceUri.path);
	updateViews();
};

commands["craftos-pc.file-copy-uri"] = async (obj: CraftFile) => {
	if (!obj) return;
	vscode.env.clipboard.writeText(obj.resourceUri.toString());
	updateViews();
};

commands["craftos-pc.file-rename"] = async (obj: CraftFile) => {
	if (!obj) return;
	const name = await vscode.window.showInputBox({
		prompt: "Enter the new name:",
		value: basename(obj.resourceUri.path),
	});
	const newUri = vscode.Uri.from({
		scheme: obj.resourceUri.scheme,
		authority: obj.resourceUri.authority,
		path: join(dirname(obj.resourceUri.path), name),
	});
	if (await exists(newUri)) return;
	await vscode.workspace.fs.rename(obj.resourceUri, newUri);
	updateViews();
};

commands["craftos-pc.file-delete"] = async (obj: CraftFile) => {
	if (!obj) return;
	if (!(await exists(obj.resourceUri))) return;
	await vscode.workspace.fs.delete(obj.resourceUri);
	updateViews();
};
