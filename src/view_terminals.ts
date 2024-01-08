import vscode from "vscode";
import { FindConnection, ext } from "./globals";
import path from "path";

export interface WindowRef {
	title: string;
	connection: string;
	window: number;
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
		r.tooltip = `${element.window}@${element.connection}`;
		if (ext.connections.get(element.connection)?.isRemote) r.contextValue = "is-remote";
		return r;
	}
	getChildren(element?: WindowRef | undefined): vscode.ProviderResult<WindowRef[]> {
		if (element) return null;
		return [...ext.connections.values()]
			.map((connection) =>
				[...connection.windows.values()]
					.filter((window) => !window.isMonitor)
					.map((window) => ({
						title: window.term?.title?.replace(/[^ ]+ (Remote )?Terminal: /, "$1") || "Unknown Computer",
						connection: connection.id,
						window: window.id,
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
		r.tooltip = `${element.window}@${element.connection}`;
		return r;
	}
	getChildren(element?: WindowRef | undefined): vscode.ProviderResult<WindowRef[]> {
		if (element) return null;
		return [...ext.connections.values()]
			.map((connection) =>
				[...connection.windows.values()]
					.filter((window) => window.isMonitor)
					.map((window) => ({
						title: window.term?.title?.replace(/[^ ]+ (Remote )?Terminal: /, "$1") || "Unknown Monitor",
						connection: connection.id,
						window: window.id,
					}))
			)
			.flat(1);
	}
}
