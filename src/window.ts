import * as vscode from "vscode";
import * as os from "os";
import * as fs from "fs";

import { getSetting } from "./utils";
import { CraftConnection } from "./connection";
import * as path from "path";
import {
	CraftPacket,
	CraftPacketRaw,
	CraftPacketTerminalChange,
	CraftPacketTerminalContents,
	newPacket,
} from "./packet";
import { ext } from "./globals";
import EventEmitter from "events";

function loadFont() {
	const customFont = vscode.workspace.getConfiguration("craftos-pc.customFont");
	let fontPath = customFont.get("path") as string;
	if (fontPath === "hdfont") {
		const execPath = getSetting("craftos-pc.executablePath");
		if (os.platform() === "win32") fontPath = execPath.replace(/[\/\\][^\/\\]+$/, "/") + "hdfont.bmp";
		else if (os.platform() === "darwin" && execPath.indexOf("MacOS/craftos") !== -1)
			fontPath = execPath.replace(/MacOS\/[^\/]+$/, "") + "Resources/hdfont.bmp";
		else if (
			os.platform() === "darwin" ||
			(os.platform() === "linux" && !fs.existsSync("/usr/share/craftos/hdfont.bmp"))
		)
			fontPath = "/usr/local/share/craftos/hdfont.bmp";
		else if (os.platform() === "linux") fontPath = "/usr/share/craftos/hdfont.bmp";
		if (!fs.existsSync(fontPath)) {
			vscode.window.showWarningMessage(
				"The path to the HD font could not be found; the default font will be used instead. Please set the path to the HD font manually."
			);
			fontPath = null;
		}
	}
	return fontPath;
}

export interface Term {
	mode: number;
	blink: boolean;
	width: number;
	height: number;
	cursorX: number;
	cursorY: number;
	grayscale: boolean;

	screen: number[][];
	colors: number[][];
	pixels: number[][];
	palette: { r: number; g: number; b: number }[];

	title: string;
}

export class CraftWindow extends EventEmitter {
	private panel: vscode.WebviewPanel;
	public isMonitor = false;
	public computerID: number;
	public term?: Partial<Term>;

	constructor(public readonly parent: CraftConnection, public readonly id: number) {
		super();
	}

	open() {
		if (this.panel) {
			this.panel.reveal();
			return;
		}
		const fontPath = loadFont();
		this.panel = vscode.window.createWebviewPanel(
			"craftos-pc",
			"CraftOS-PC Terminal",
			(vscode.window.activeTextEditor && vscode.window.activeTextEditor.viewColumn) || vscode.ViewColumn.One,
			{
				enableScripts: true,
				retainContextWhenHidden: false,
				localResourceRoots:
					fontPath !== null && fontPath !== ""
						? [vscode.Uri.file(fontPath.replace(/[\/\\][^\/\\]*$/, ""))]
						: null,
			}
		);
		ext.context.subscriptions.push(this.panel);
		this.panel.iconPath = vscode.Uri.file(
			path.join(ext.context.extensionPath, this.isMonitor ? "media/monitor.svg" : "media/computer.svg")
		);
		this.panel.webview.html = fs.readFileSync(path.join(ext.context.extensionPath, "index.html"), "utf8");
		this.panel.webview.onDidReceiveMessage((message) => {
			if (typeof message !== "object") return;
			if (message.getFontPath === true) {
				if (fontPath !== null && fontPath !== "")
					this.panel.webview.postMessage({
						fontPath: this.panel.webview.asWebviewUri(vscode.Uri.file(fontPath)).toString(),
					});
				return;
			}
			this.parent.send(
				CraftPacketRaw.new({
					type: message.type,
					window: this.id,
					data: Buffer.from(message.data, "hex"),
				})
			);
		});
		this.panel.onDidChangeViewState((e) => {
			if (e.webviewPanel.active && this.term !== undefined) {
				this.updateTerm({});
			}
		});
		this.panel.onDidDispose(() => delete this.panel);
		if (this.term) {
			this.updateTerm({});
		}
	}

	close() {
		this.panel.dispose();
		delete this.panel;
	}

	updateTerm(term: CraftPacketTerminalContents | CraftPacketTerminalChange | {}) {
		const prevIsMonitor = this.isMonitor;
		const prevTitle = this.panel?.title;
		if ("title" in term) {
			this.isMonitor = term.title.indexOf("Monitor") !== -1;
			if (!this.isMonitor) {
				const m = term.title.match(/Computer (\d+)$/);
				if (m) {
					this.computerID = parseInt(m[1]);
				}
			}
		}
		if ("id" in term) {
			if (term.id > 0) {
				this.computerID = term.id - 1;
				this.isMonitor = false;
			}
		}
		if (!this.term) this.term = {};
		Object.assign(this.term, term);
		if (this.panel) {
			this.panel.webview.postMessage(this.term);
			this.panel.title = this.term.title || "CraftOS-PC Terminal";
		}
		if (prevIsMonitor !== this.isMonitor || this.panel?.title !== prevTitle) {
			this.emit('change');
		}
	}
}
