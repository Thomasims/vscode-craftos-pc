import vscode from "vscode";
import { FindConnection, ext } from "./globals";
import path from "path";

interface WindowRef {
	title: string;
	globalID: string;
}

export class ComputerProvider extends vscode.EventEmitter<null> implements vscode.TreeDataProvider<WindowRef> {
	onDidChangeTreeData = this.event;
	getTreeItem(element: WindowRef): vscode.TreeItem | Thenable<vscode.TreeItem> {
		const r = new vscode.TreeItem(element.title);
		r.iconPath = vscode.Uri.file(path.join(ext.context!.extensionPath, "media/computer.svg"));
		r.command = {
			command: "craftos-pc.open-window",
			title: "CraftOS-PC: Open Window",
			arguments: [element],
		};
		r.tooltip = element.globalID;
		if (FindConnection(element.globalID)?.supportsFilesystem) r.contextValue = "data-available";
		return r;
	}
	getChildren(element?: WindowRef | undefined): vscode.ProviderResult<WindowRef[]> {
		if (element) return null;
		return [...ext.connections.values()]
			.map((connection) =>
				[...connection.windows.values()]
					.filter((window) => !window.isMonitor)
					.map((window) => ({
						title: window.term?.title || "CraftOS-PC Computer",
						globalID: `${window.id}@${connection.id}`,
					}))
			)
			.flat(1);
	}
}

export class MonitorProvider extends vscode.EventEmitter<null> implements vscode.TreeDataProvider<WindowRef> {
	onDidChangeTreeData = this.event;
	getTreeItem(element: WindowRef): vscode.TreeItem | Thenable<vscode.TreeItem> {
		const r = new vscode.TreeItem(element.title);
		r.iconPath = vscode.Uri.file(path.join(ext.context!.extensionPath, "media/monitor.svg"));
		r.command = {
			command: "craftos-pc.open-window",
			title: "CraftOS-PC: Open Window",
			arguments: [element],
		};
		r.tooltip = element.globalID;
		return r;
	}
	getChildren(element?: WindowRef | undefined): vscode.ProviderResult<WindowRef[]> {
		if (element) return null;
		return [...ext.connections.values()]
			.map((connection) =>
				[...connection.windows.values()]
					.filter((window) => window.isMonitor)
					.map((window) => ({
						title: window.term?.title || "CraftOS-PC Computer",
						globalID: `${window.id}@${connection.id}`,
					}))
			)
			.flat(1);
	}
}
