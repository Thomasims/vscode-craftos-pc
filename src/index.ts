import * as vscode from "vscode";
import { CraftConnection } from "./connection";
import { FindConnection, FindWindow, ext } from "./globals";
import { ComputerProvider, MonitorProvider } from "./view_terminals";
import https from "https";
import { getDataPath } from "./utils";

const commands: Record<string, (...args: any[]) => any> = {};

export function activate(context: vscode.ExtensionContext) {
	ext.context = context;
	ext.log = vscode.window.createOutputChannel("CraftOS-PC");
	ext.computer_provider = new ComputerProvider();
	ext.monitor_provider = new MonitorProvider();
	ext.connections = new Map();
	vscode.window.createTreeView("craftos-computers", { treeDataProvider: ext.computer_provider });
	vscode.window.createTreeView("craftos-monitors", { treeDataProvider: ext.monitor_provider });

	for (const name in commands) {
		context.subscriptions.push(vscode.commands.registerCommand(name, commands[name]));
	}
}

export function deactivate() {
	for (const connection of ext.connections.values()) {
		connection.kill();
	}
}

function connectToProcess(extraArgs?: string[]) {
	const nextID = [...ext.connections.keys()].reduce(
		(prev, id) => (id.startsWith("local-") ? Math.max(parseInt(id.substring(6)) + 1, prev) : prev),
		0
	);
	if (nextID > 0) {
		extraArgs = extraArgs || [];
		extraArgs.push('--id', nextID.toFixed(0));
	}
	const connection = CraftConnection.fromProcess("local-" + nextID, extraArgs);
	connection.on("windows", () => {
		ext.computer_provider.fire(null);
		ext.monitor_provider.fire(null);
	});
	ext.computer_provider.fire(null);
	ext.monitor_provider.fire(null);
}

function connectToWebSocket(url) {
	const connection = CraftConnection.fromWebsocket(url, url);
	connection.on("windows", () => {
		ext.computer_provider.fire(null);
		ext.monitor_provider.fire(null);
	});
	ext.computer_provider.fire(null);
	ext.monitor_provider.fire(null);
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

commands["craftos-pc.detach"] = (obj) => {
	if (typeof obj === "object") return FindConnection(obj.globalID)?.detach();
	vscode.window
		.showInputBox({
			prompt: "Enter the window ID:",
			validateInput: (str) => (isNaN(parseInt(str)) ? "Invalid number" : null),
		})
		.then((id) => FindConnection(id)?.detach());
}

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

commands["craftos-pc.open-window"] = (obj) => {
	if (typeof obj === "object") return FindWindow(obj.globalID)?.open();
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

commands['craftos-pc.close'] = () => {
	for (const connection of ext.connections.values()) {
		connection.disconnect();
	}
}

commands["craftos-pc.close-window"] = async obj => {
	const id = typeof obj === 'object' ? obj.globalID : await vscode.window.showInputBox({prompt: "Enter the window ID:"})
	FindConnection(id)?.removeWindow(parseInt(id));
}

commands["craftos-pc.kill"] = async obj => {
	const id = typeof obj === 'object' ? obj.globalID : await vscode.window.showInputBox({prompt: "Enter the window ID:"})
	FindConnection(id)?.kill();
}

commands["craftos-pc.run-file"] = path => {
	if (!path) {
		if (vscode.window.activeTextEditor === undefined || vscode.window.activeTextEditor.document.uri.scheme !== "file") {
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
}