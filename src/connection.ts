import { CraftWindow } from "./window";
import {
	CraftPacket,
	CraftPacketFileData,
	CraftPacketFileRequest,
	CraftPacketFileResponse,
	CraftPacketShowMessage,
	CraftPacketTerminalChange,
	CraftPacketTerminalContents,
	CraftPacketType,
	CraftPacketVersionSupport,
	FileRequestType,
	TerminalChangeType,
} from "./packet";
import { crc32, getExecutable, getExtensionSetting } from "./utils";
import { RegisterConnection, UnregisterConnection, ext } from "./globals";
import { spawn } from "child_process";
import * as vscode from "vscode";
import WebSocket from "ws";
import EventEmitter from "events";
import { constants } from "os";

interface CraftSocket {
	write(data: string): void;
	disconnect(): void;
	kill(): void;
}

type DataRequestCallback = (data?: CraftPacketFileResponse | CraftPacketFileData, err?: string) => void;

let nextUniqueID = 0;
export class CraftConnection extends EventEmitter {
	private socket: CraftSocket;
	private dataContinuation?: Buffer;
	private gotMessage = false;
	private nextDataRequestID = 0;
	private dataRequestCallbacks = new Map<number, DataRequestCallback>();
	public windows = new Map<number, CraftWindow>();
	public useBinaryChecksum = false;
	public retryChecksum = true;
	public supportsFilesystem = false;
	public isVersion11 = false;
	public isRemote = false;
	public localInfo?: {
		id: number,
		script?: string,
	};

	public readonly uid = crc32(this.id);

	constructor(public readonly id: string) {
		super();
		RegisterConnection(this);
	}

	public send(packet: CraftPacket) {
		this.socket.write(
			packet.wrap({
				binaryChecksum: this.useBinaryChecksum,
				extended: this.isVersion11,
			})
		);
	}

	public detach() {
		this.socket.disconnect();
	}

	public disconnect() {
		this.send(CraftPacketTerminalChange.new({ type2: TerminalChangeType.QUIT }));
		this.socket.disconnect();
	}

	public kill() {
		this.removeWindows();
		this.socket.kill();
	}

	public closeWindows() {
		for (const window of this.windows.values()) window.close();
	}

	public closeWindow(id: number) {
		this.windows.get(id)?.close();
	}

	public openWindow(id: number, oldPanel?: vscode.WebviewPanel) {
		this.windows.get(id)?.open(oldPanel);
	}

	public removeWindows() {
		this.closeWindows();
		this.windows.clear();
		this.emit("windows");
		UnregisterConnection(this);
		this.emit("close");
		if (!this.isRemote) setTimeout(() => this.socket.kill(), 2000);
	}

	public removeWindow(id: number) {
		this.closeWindow(id);
		this.send(CraftPacketTerminalChange.new({ type2: TerminalChangeType.CLOSE, window: id }));
		this.windows.delete(id);
		this.emit("windows");
		if (this.windows.size === 0) {
			UnregisterConnection(this);
			this.emit("close");
			if (!this.isRemote) setTimeout(() => this.socket.kill(), 2000);
		}
	}

	public newWindow(id: number, keepClosed?: boolean) {
		if (!this.windows.has(id)) {
			const window = new CraftWindow(this, id);
			this.windows.set(id, window);
			if (id === 0 && !keepClosed) window.open();
			window.on("change", () => this.emit("windows"));
			this.emit("windows");
			return window;
		}
		return this.windows.get(id);
	}

	private processChunk(chunk: Buffer | string) {
		if (typeof chunk === "string") chunk = Buffer.from(chunk, "utf8");
		if (this.dataContinuation) {
			chunk = Buffer.concat([this.dataContinuation, chunk]);
			delete this.dataContinuation;
		}
		while (chunk.length > 0) {
			const start = chunk.indexOf(33); // Seek to '!'
			if (start === -1) return;
			chunk = chunk.subarray(start);

			const magic = chunk.subarray(0, 4).toString();
			let off;
			if (magic === "!CPC") off = 8;
			else if (magic === "!CPD" && this.isVersion11) off = 16;
			else return;

			const size = parseInt(chunk.subarray(4, off).toString(), 16);
			if (size > chunk.length - off - 8) {
				this.dataContinuation = chunk;
				return;
			}

			const data = Buffer.from(chunk.subarray(off, size + off).toString(), "base64");
			const goodChecksum = parseInt(chunk.subarray(size + off, size + off + 8).toString(), 16);
			const dataChecksum = crc32(
				this.useBinaryChecksum ? data.toString("binary") : chunk.subarray(off, size + off).toString()
			);
			chunk = chunk.subarray(size + off + 8);
			if (goodChecksum !== dataChecksum) {
				ext.log.appendLine(
					"Bad checksum: expected " + goodChecksum.toString(16) + ", got " + dataChecksum.toString(16)
				);
				if (this.retryChecksum) {
					const otherDataChecksum = crc32(
						this.useBinaryChecksum ? chunk.subarray(off, size + off).toString() : data.toString("binary")
					);
					if (goodChecksum !== otherDataChecksum) {
						this.retryChecksum = false;
						continue;
					}
					ext.log.appendLine("Checksum matched in other mode, switching.");
					this.useBinaryChecksum = !this.useBinaryChecksum;
				} else {
					continue;
				}
			}
			this.retryChecksum = false;
			this.handlePacket(CraftPacket.from(data));
		}
	}

	private handlePacket(packet: CraftPacket) {
		switch (packet.type) {
			case CraftPacketType.TERMINAL_CONTENTS:
				this.handleTerminalContentsPacket(packet as CraftPacketTerminalContents);
				break;
			case CraftPacketType.TERMINAL_CHANGE:
				this.handleTerminalChangePacket(packet as CraftPacketTerminalChange);
				break;
			case CraftPacketType.SHOW_MESSAGE:
				this.handleShowMessagePacket(packet as CraftPacketShowMessage);
				break;
			case CraftPacketType.VERSION_SUPPORT:
				this.handleVersionSupportPacket(packet as CraftPacketVersionSupport);
				break;
			case CraftPacketType.FILE_RESPONSE:
				this.handleFileResponsePacket(packet as CraftPacketFileResponse);
				break;
			case CraftPacketType.FILE_DATA:
				this.handleFileDataPacket(packet as CraftPacketFileData);
				break;
		}
		this.gotMessage = true;
	}

	private handleTerminalContentsPacket(packet: CraftPacketTerminalContents) {
		this.windows.get(packet.window)?.updateTerm(packet);
	}

	private handleTerminalChangePacket(packet: CraftPacketTerminalChange) {
		if (!this.gotMessage)
			this.send(CraftPacketVersionSupport.new({ binaryChecksum: true, supportFilesystem: true }));
		switch (packet.type2) {
			case TerminalChangeType.UPDATE:
				if (this.windows.has(packet.window)) {
					this.windows.get(packet.window)!.updateTerm(packet);
				} else {
					this.newWindow(packet.window)!.updateTerm(packet);
				}
				break;
			case TerminalChangeType.CLOSE:
				if (this.windows.has(packet.window)) {
					this.removeWindow(packet.window);
				}
				break;
			case TerminalChangeType.QUIT:
				if (this.isRemote) {
					this.socket.write("\n");
					this.socket.disconnect();
				} else {
					this.socket.kill();
				}
				return;
		}
	}

	private handleShowMessagePacket(packet: CraftPacketShowMessage) {
		switch (packet.kind) {
			case "unknown":
			case "info":
				vscode.window.showInformationMessage("CraftOS-PC: " + packet.title + ": " + packet.message);
				break;
			case "warning":
				vscode.window.showWarningMessage("CraftOS-PC: " + packet.title + ": " + packet.message);
				break;
			case "error":
				vscode.window.showErrorMessage("CraftOS-PC: " + packet.title + ": " + packet.message);
				break;
		}
	}

	private handleVersionSupportPacket(packet: CraftPacketVersionSupport) {
		this.isVersion11 = true;
		this.useBinaryChecksum = packet.binaryChecksum;
		this.supportsFilesystem = packet.supportFilesystem;
		this.emit("version");
	}

	private handleFileResponsePacket(packet: CraftPacketFileResponse) {
		if (!this.dataRequestCallbacks.has(packet.id)) {
			ext.log.appendLine("Got stray response for request ID " + packet.id + ", ignoring.");
			return;
		}
		const callback = this.dataRequestCallbacks.get(packet.id)!;
		if (packet.isError) callback(undefined, packet.error || "Operation failed");
		else callback(packet);
	}

	private handleFileDataPacket(packet: CraftPacketFileData) {
		if (!this.dataRequestCallbacks.has(packet.id)) {
			ext.log.appendLine("Got stray response for request ID " + packet.id + ", ignoring.");
			return;
		}
		const callback = this.dataRequestCallbacks.get(packet.id)!;
		if (packet.isError) callback(undefined, packet.data.toString());
		else callback(packet);
	}

	private queueFilePacket(
		packet: CraftPacketFileRequest,
		data?: Buffer
	): Promise<CraftPacketFileResponse | CraftPacketFileData> {
		const requestID = this.nextDataRequestID;
		this.nextDataRequestID = (this.nextDataRequestID + 1) & 0xff;
		packet.id = requestID;
		this.send(packet);
		if (packet.isWrite) {
			this.send(CraftPacketFileData.new({ id: requestID, data, window: packet.window, isError: false }));
		}
		return new Promise<CraftPacketFileResponse | CraftPacketFileData>((resolve, reject) => {
			const tid = setTimeout(() => {
				this.dataRequestCallbacks.delete(requestID);
				reject("Timeout");
			}, 3000);
			this.dataRequestCallbacks.set(requestID, (data, err) => {
				clearTimeout(tid);
				this.dataRequestCallbacks.delete(requestID);
				if (data) resolve(data);
				else reject(err);
			});
		});
	}

	public queueFileRequest(packet: CraftPacketFileRequest): Promise<CraftPacketFileResponse> {
		return this.queueFilePacket(packet) as Promise<CraftPacketFileResponse>;
	}

	public queueFileWrite(
		path: string,
		data: Buffer,
		isBinary?: boolean,
		isAppend?: boolean
	): Promise<CraftPacketFileResponse> {
		return this.queueFilePacket(
			CraftPacketFileRequest.new({
				type2: FileRequestType.OPEN,
				path,
				isWrite: true,
				isAppend,
				isBinary,
			}),
			data
		) as Promise<CraftPacketFileResponse>;
	}

	public queueFileRead(path: string): Promise<CraftPacketFileData> {
		return this.queueFilePacket(
			CraftPacketFileRequest.new({
				type2: FileRequestType.OPEN,
				path,
			})
		) as Promise<CraftPacketFileData>;
	}

	public static fromProcess(id: string, extraArgs?: string[], keepClosed?: boolean) {
		const exePath = getExecutable();
		if (!exePath) return null;
		const connection = new CraftConnection(id);
		connection.isRemote = false;
		const args = ["--raw"];
		const additionalArguments = getExtensionSetting("additionalArguments");
		if (additionalArguments !== null) {
			args.push(...additionalArguments.split(" "));
		}
		const dataPath = getExtensionSetting("dataPath");
		if (dataPath !== null) {
			args.push("-d", dataPath);
		}
		if (extraArgs) {
			args.push(...extraArgs);
		}
		ext.log.appendLine("Running: " + exePath + " " + args.join(" "));
		try {
			const process = spawn(exePath, args, { windowsHide: true });
			process.on("error", () => {
				vscode.window.showErrorMessage(
					"The CraftOS-PC worker process could not be launched. Check the path to the executable in the settings."
				);
				connection.removeWindows();
			});
			process.on("exit", (code) => {
				vscode.window.showInformationMessage(`The CraftOS-PC worker process exited with code ${code}.`);
				connection.removeWindows();
			});
			process.on("disconnect", () => {
				vscode.window.showErrorMessage(`The CraftOS-PC worker process was disconnected from the window.`);
				connection.removeWindows();
			});
			process.on("close", () => {
				//vscode.window.showInformationMessage(`The CraftOS-PC worker process closed all IO streams with code ${code}.`)
				connection.removeWindows();
			});
			process.stdout.on("data", (data) => connection.processChunk(data));
			process.stderr.on("data", (data) => ext.log.appendLine(data.toString()));

			connection.socket = {
				disconnect: () => process.disconnect(),
				kill: () => process.kill(constants.signals.SIGKILL),
				write: (data) => process.stdin.write(data, "utf8"),
			};
		} catch (e) {
			vscode.window.showErrorMessage(
				"The CraftOS-PC worker process could not be launched. Check the path to the executable in the settings."
			);
			ext.log.appendLine(e);
			return;
		}
		connection.send(
			CraftPacketVersionSupport.new({
				binaryChecksum: true,
				supportFilesystem: true,
			})
		);
		vscode.window.showInformationMessage("A new CraftOS-PC worker process has been started.");
		connection.newWindow(0, keepClosed);
		return connection;
	}

	public static fromWebsocket(id: string, url: string, keepClosed?: boolean) {
		const connection = new CraftConnection(id);
		connection.isRemote = true;
		ext.log.appendLine("Connecting to: " + url);
		const rawSocket = new WebSocket(url);
		connection.socket = {
			disconnect: () => rawSocket.close(),
			kill: () => rawSocket.close(),
			write: (data) => {
				for (let i = 0; i < data.length; i += 65530)
					rawSocket.send(data.substring(i, Math.min(i + 65530, data.length)));
			},
		};
		rawSocket.on("open", () => {
			connection.send(
				CraftPacketVersionSupport.new({
					binaryChecksum: true,
					supportFilesystem: true,
					requestAllWindows: true,
				})
			);
			vscode.window.showInformationMessage("Successfully connected to the WebSocket server.");
		});
		rawSocket.on("error", (e) => {
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
			else vscode.window.showErrorMessage("An error occurred while connecting to the server: " + e.message);
			connection.removeWindows();
		});
		rawSocket.on("close", () => {
			vscode.window.showInformationMessage("Disconnected from the WebSocket server.");
			connection.removeWindows();
		});
		rawSocket.on("message", (data) =>
			connection.processChunk(Array.isArray(data) ? Buffer.concat(data) : Buffer.from(data))
		);
		connection.newWindow(0, keepClosed);
		return connection;
	}
}
