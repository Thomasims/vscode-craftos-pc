/******/ (() => { // webpackBootstrap
/******/ 	"use strict";
/******/ 	var __webpack_modules__ = ({

/***/ "./src/connection.ts":
/*!***************************!*\
  !*** ./src/connection.ts ***!
  \***************************/
/***/ (function(__unused_webpack_module, exports, __webpack_require__) {


var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || function (mod) {
    if (mod && mod.__esModule) return mod;
    var result = {};
    if (mod != null) for (var k in mod) if (k !== "default" && Object.prototype.hasOwnProperty.call(mod, k)) __createBinding(result, mod, k);
    __setModuleDefault(result, mod);
    return result;
};
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", ({ value: true }));
exports.CraftConnection = void 0;
const window_1 = __webpack_require__(/*! ./window */ "./src/window.ts");
const packet_1 = __webpack_require__(/*! ./packet */ "./src/packet.ts");
const utils_1 = __webpack_require__(/*! ./utils */ "./src/utils.ts");
const globals_1 = __webpack_require__(/*! ./globals */ "./src/globals.ts");
const child_process_1 = __webpack_require__(/*! child_process */ "child_process");
const vscode = __importStar(__webpack_require__(/*! vscode */ "vscode"));
const ws_1 = __importDefault(__webpack_require__(/*! ws */ "ws"));
const events_1 = __importDefault(__webpack_require__(/*! events */ "events"));
class CraftConnection extends events_1.default {
    constructor(id) {
        super();
        this.id = id;
        this.gotMessage = false;
        this.nextDataRequestID = 0;
        this.dataRequestCallbacks = new Map();
        this.windows = new Map();
        this.useBinaryChecksum = false;
        this.retryChecksum = true;
        this.supportsFilesystem = false;
        this.isVersion11 = false;
        this.isRemote = false;
    }
    send(packet) {
        this.socket.write(packet.wrap({
            binaryChecksum: this.useBinaryChecksum,
            extended: this.isVersion11,
        }));
    }
    disconnect() {
        this.send(packet_1.CraftPacketTerminalChange.new({ type2: packet_1.TerminalChangeType.QUIT }));
        this.socket.disconnect();
    }
    kill() {
        this.removeWindows();
        this.socket.kill();
    }
    closeWindows() {
        for (const window of this.windows.values())
            window.close();
    }
    closeWindow(id) {
        this.windows.get(id)?.close();
    }
    openWindow(id) {
        this.windows.get(id)?.open();
    }
    removeWindows() {
        this.closeWindows();
        this.windows.clear();
        this.emit('windows');
        globals_1.ext.connections.delete(this.id);
    }
    removeWindow(id) {
        this.closeWindow(id);
        this.windows.delete(id);
        this.emit('windows');
    }
    newWindow(id) {
        if (!this.windows.has(id)) {
            const window = new window_1.CraftWindow(this, id);
            this.windows.set(id, window);
            window.open();
            window.on('type_change', () => this.emit('windows'));
            this.emit('windows');
            return window;
        }
    }
    processChunk(chunk) {
        if (typeof chunk === "string")
            chunk = Buffer.from(chunk, "utf8");
        if (this.dataContinuation) {
            chunk = Buffer.concat([this.dataContinuation, chunk]);
            delete this.dataContinuation;
        }
        while (chunk.length > 0) {
            const start = chunk.indexOf(33); // Seek to '!'
            if (start === -1)
                return;
            chunk = chunk.subarray(start);
            const magic = chunk.subarray(0, 4).toString();
            let off;
            if (magic === "!CPC")
                off = 8;
            else if (magic === "!CPD" && this.isVersion11)
                off = 16;
            else
                return;
            const size = parseInt(chunk.subarray(4, off).toString(), 16);
            if (size > chunk.length - off - 8) {
                this.dataContinuation = chunk;
                return;
            }
            const data = Buffer.from(chunk.subarray(off, size + off).toString(), "base64");
            const goodChecksum = parseInt(chunk.subarray(size + off, size + off + 8).toString(), 16);
            const dataChecksum = (0, utils_1.crc32)(this.useBinaryChecksum ? data.toString("binary") : chunk.subarray(off, size + off).toString());
            chunk = chunk.subarray(size + off + 8);
            if (goodChecksum !== dataChecksum) {
                globals_1.ext.log.appendLine("Bad checksum: expected " + goodChecksum.toString(16) + ", got " + dataChecksum.toString(16));
                if (this.retryChecksum) {
                    const otherDataChecksum = (0, utils_1.crc32)(this.useBinaryChecksum ? chunk.subarray(off, size + off).toString() : data.toString("binary"));
                    if (goodChecksum !== otherDataChecksum) {
                        this.retryChecksum = false;
                        continue;
                    }
                    globals_1.ext.log.appendLine("Checksum matched in other mode, switching.");
                    this.useBinaryChecksum = !this.useBinaryChecksum;
                }
                else {
                    continue;
                }
            }
            this.retryChecksum = false;
            this.handlePacket(packet_1.CraftPacket.from(data));
        }
    }
    handlePacket(packet) {
        switch (packet.type) {
            case packet_1.CraftPacketType.TERMINAL_CONTENTS:
                this.handleTerminalContentsPacket(packet);
                break;
            case packet_1.CraftPacketType.TERMINAL_CHANGE:
                this.handleTerminalChangePacket(packet);
                break;
            case packet_1.CraftPacketType.SHOW_MESSAGE:
                this.handleShowMessagePacket(packet);
                break;
            case packet_1.CraftPacketType.VERSION_SUPPORT:
                this.handleVersionSupportPacket(packet);
                break;
            case packet_1.CraftPacketType.FILE_RESPONSE:
                this.handleFileResponsePacket(packet);
                break;
            case packet_1.CraftPacketType.FILE_DATA:
                this.handleFileDataPacket(packet);
                break;
        }
        this.gotMessage = true;
    }
    handleTerminalContentsPacket(packet) {
        this.windows.get(packet.window)?.updateTerm(packet);
    }
    handleTerminalChangePacket(packet) {
        if (!this.gotMessage)
            this.send(packet_1.CraftPacketVersionSupport.new({ binaryChecksum: true, supportFilesystem: true }));
        switch (packet.type2) {
            case packet_1.TerminalChangeType.UPDATE:
                if (this.windows.has(packet.window)) {
                    this.windows.get(packet.window).updateTerm(packet);
                }
                else {
                    this.newWindow(packet.window).updateTerm(packet);
                }
                break;
            case packet_1.TerminalChangeType.CLOSE:
                if (this.windows.has(packet.window)) {
                    this.removeWindow(packet.window);
                }
                break;
            case packet_1.TerminalChangeType.QUIT:
                if (this.isRemote) {
                    this.socket.write("\n");
                    this.socket.disconnect();
                }
                else {
                    this.socket.kill();
                }
                return;
        }
    }
    handleShowMessagePacket(packet) {
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
    handleVersionSupportPacket(packet) {
        this.isVersion11 = true;
        this.useBinaryChecksum = packet.binaryChecksum;
        this.supportsFilesystem = packet.supportFilesystem;
    }
    handleFileResponsePacket(packet) {
        if (!this.dataRequestCallbacks.has(packet.id)) {
            globals_1.ext.log.appendLine("Got stray response for request ID " + packet.id + ", ignoring.");
            return;
        }
        const callback = this.dataRequestCallbacks.get(packet.id);
        if (packet.isError)
            callback(undefined, packet.error || "Operation failed");
        else
            callback(packet);
    }
    handleFileDataPacket(packet) {
        if (!this.dataRequestCallbacks.has(packet.id)) {
            globals_1.ext.log.appendLine("Got stray response for request ID " + packet.id + ", ignoring.");
            return;
        }
        const callback = this.dataRequestCallbacks.get(packet.id);
        if (packet.isError)
            callback(undefined, packet.data.toString());
        else
            callback(packet);
    }
    queueDataRequest(packet, data) {
        const requestID = this.nextDataRequestID;
        this.nextDataRequestID = (this.nextDataRequestID + 1) & 0xff;
        const isWrite = (packet.type2 & 0xf1) === 0x11;
        packet.id = requestID;
        this.send(packet);
        if (isWrite) {
            this.send(packet_1.CraftPacketFileData.new({ id: requestID, data, window: packet.window }));
        }
        return new Promise((resolve, reject) => {
            const tid = setTimeout(() => {
                this.dataRequestCallbacks.delete(requestID);
                reject("Timeout");
            });
            this.dataRequestCallbacks.set(requestID, (data, err) => {
                clearTimeout(tid);
                this.dataRequestCallbacks.delete(requestID);
                if (data)
                    resolve(data);
                else
                    reject(err);
            });
        });
    }
    static fromProcess(id, extraArgs) {
        const exePath = (0, utils_1.getExecutable)();
        if (!exePath)
            return null;
        const connection = new CraftConnection(id);
        globals_1.ext.connections.set(id, connection);
        connection.isRemote = false;
        const args = ["--raw"];
        const additionalArguments = (0, utils_1.getExtensionSetting)("additionalArguments");
        if (additionalArguments !== null) {
            args.push(...additionalArguments.split(" "));
        }
        const dataPath = (0, utils_1.getExtensionSetting)("dataPath");
        if (dataPath !== null) {
            args.push("-d", dataPath);
        }
        if (extraArgs) {
            args.push(...extraArgs);
        }
        globals_1.ext.log.appendLine("Running: " + exePath + " " + args.join(" "));
        try {
            const process = (0, child_process_1.spawn)(exePath, args, { windowsHide: true });
            process.on("error", () => {
                vscode.window.showErrorMessage("The CraftOS-PC worker process could not be launched. Check the path to the executable in the settings.");
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
            process.stderr.on("data", (data) => globals_1.ext.log.appendLine(data.toString()));
            connection.socket = {
                disconnect: () => process.disconnect(),
                kill: () => process.kill(),
                write: (data) => process.stdin.write(data, "utf8"),
            };
        }
        catch (e) {
            vscode.window.showErrorMessage("The CraftOS-PC worker process could not be launched. Check the path to the executable in the settings.");
            globals_1.ext.log.appendLine(e);
            return;
        }
        connection.send(packet_1.CraftPacketVersionSupport.new({
            binaryChecksum: true,
            supportFilesystem: true,
        }));
        vscode.window.showInformationMessage("A new CraftOS-PC worker process has been started.");
        connection.newWindow(0);
        return connection;
    }
    static fromWebsocket(id, url) {
        const connection = new CraftConnection(id);
        globals_1.ext.connections.set(id, connection);
        connection.isRemote = true;
        globals_1.ext.log.appendLine("Connecting to: " + url);
        const rawSocket = new ws_1.default(url);
        connection.socket = {
            disconnect: () => rawSocket.close(),
            kill: () => rawSocket.close(),
            write: (data) => {
                for (let i = 0; i < data.length; i += 65530)
                    rawSocket.send(data.substring(i, Math.min(i + 65530, data.length)));
            },
        };
        rawSocket.on("open", () => {
            connection.send(packet_1.CraftPacketVersionSupport.new({
                binaryChecksum: true,
                supportFilesystem: true,
                requestAllWindows: true,
            }));
            vscode.window.showInformationMessage("Successfully connected to the WebSocket server.");
        });
        rawSocket.on("error", (e) => {
            if (e.message.match("certificate has expired"))
                vscode.window
                    .showErrorMessage("A bug in VS Code is causing the connection to fail. Please go to https://www.craftos-pc.cc/docs/remote#certificate-has-expired-error to fix it.", "Open Page", "OK")
                    .then((res) => {
                    if (res === "OK")
                        return;
                    vscode.env.openExternal(vscode.Uri.parse("https://www.craftos-pc.cc/docs/remote#certificate-has-expired-error"));
                });
            else
                vscode.window.showErrorMessage("An error occurred while connecting to the server: " + e.message);
            connection.removeWindows();
        });
        rawSocket.on("close", () => {
            vscode.window.showInformationMessage("Disconnected from the WebSocket server.");
            connection.removeWindows();
        });
        rawSocket.on("message", (data) => connection.processChunk(Array.isArray(data) ? Buffer.concat(data) : Buffer.from(data)));
        return connection;
    }
}
exports.CraftConnection = CraftConnection;


/***/ }),

/***/ "./src/globals.ts":
/*!************************!*\
  !*** ./src/globals.ts ***!
  \************************/
/***/ ((__unused_webpack_module, exports) => {


Object.defineProperty(exports, "__esModule", ({ value: true }));
exports.FindWindow = exports.FindConnection = exports.ext = void 0;
exports.ext = {
    connections: new Map(),
};
function FindConnection(globalID) {
    const sep = globalID.indexOf("@");
    if (sep !== -1)
        globalID = globalID.substring(sep + 1);
    return exports.ext.connections.get(globalID);
}
exports.FindConnection = FindConnection;
function FindWindow(globalID) {
    const sep = globalID.indexOf("@");
    if (sep === -1)
        return;
    return exports.ext.connections.get(globalID.substring(sep + 1))?.windows.get(parseInt(globalID.substring(0, sep)));
}
exports.FindWindow = FindWindow;


/***/ }),

/***/ "./src/index.ts":
/*!**********************!*\
  !*** ./src/index.ts ***!
  \**********************/
/***/ (function(__unused_webpack_module, exports, __webpack_require__) {


var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || function (mod) {
    if (mod && mod.__esModule) return mod;
    var result = {};
    if (mod != null) for (var k in mod) if (k !== "default" && Object.prototype.hasOwnProperty.call(mod, k)) __createBinding(result, mod, k);
    __setModuleDefault(result, mod);
    return result;
};
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", ({ value: true }));
exports.deactivate = exports.activate = void 0;
console.log("preimport");
const vscode = __importStar(__webpack_require__(/*! vscode */ "vscode"));
const connection_1 = __webpack_require__(/*! ./connection */ "./src/connection.ts");
const globals_1 = __webpack_require__(/*! ./globals */ "./src/globals.ts");
const view_terminals_1 = __webpack_require__(/*! ./view_terminals */ "./src/view_terminals.ts");
const https_1 = __importDefault(__webpack_require__(/*! https */ "https"));
const utils_1 = __webpack_require__(/*! ./utils */ "./src/utils.ts");
const commands = {};
function activate(context) {
    globals_1.ext.context = context;
    globals_1.ext.log = vscode.window.createOutputChannel("CraftOS-PC");
    globals_1.ext.computer_provider = new view_terminals_1.ComputerProvider();
    globals_1.ext.monitor_provider = new view_terminals_1.MonitorProvider();
    vscode.window.createTreeView("craftos-computers", { treeDataProvider: globals_1.ext.computer_provider });
    vscode.window.createTreeView("craftos-monitors", { treeDataProvider: globals_1.ext.monitor_provider });
    for (const name in commands) {
        context.subscriptions.push(vscode.commands.registerCommand(name, commands[name]));
    }
}
exports.activate = activate;
function deactivate() {
    for (const connection of globals_1.ext.connections.values()) {
        connection.kill();
    }
}
exports.deactivate = deactivate;
function connectToProcess(extraArgs) {
    const nextID = [...globals_1.ext.connections.keys()].reduce((prev, id) => (id.startsWith("local-") ? Math.max(parseInt(id.substring(6)), prev) : prev), 0);
    if (nextID > 0) {
        extraArgs = extraArgs || [];
        extraArgs.push('--id', nextID.toFixed(0));
    }
    const connection = connection_1.CraftConnection.fromProcess("local-" + nextID, extraArgs);
    connection.on("windows", () => {
        globals_1.ext.computer_provider.fire(null);
        globals_1.ext.monitor_provider.fire(null);
    });
    console.log(connection);
}
function connectToWebSocket(url) {
    const connection = connection_1.CraftConnection.fromWebsocket("websocket", url);
    connection.on("windows", () => {
        globals_1.ext.computer_provider.fire(null);
        globals_1.ext.monitor_provider.fire(null);
    });
    console.log(connection);
}
commands["craftos-pc.open"] = () => connectToProcess();
function validateURL(str) {
    try {
        let url = new URL(str);
        return url.protocol.toLowerCase() == "ws:" || url.protocol.toLowerCase() == "wss:";
    }
    catch (e) {
        return false;
    }
}
commands["craftos-pc.open-websocket"] = async (url) => {
    if (typeof url === "string")
        return connectToWebSocket(url);
    let wsHistory = globals_1.ext.context.globalState.get("JackMacWindows.craftos-pc/websocket-history", [""]);
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
        if (!validateURL(str))
            vscode.window.showErrorMessage("The URL you entered is not valid.");
        else {
            wsHistory[0] = str;
            if (wsHistory.slice(1).includes(str))
                wsHistory.splice(wsHistory.slice(1).indexOf(str) + 1, 1);
            wsHistory.unshift("");
            globals_1.ext.context.globalState.update("JackMacWindows.craftos-pc/websocket-history", wsHistory);
            connectToWebSocket(str);
        }
    });
    quickPick.show();
};
commands["craftos-pc.clear-history"] = () => globals_1.ext.context.globalState.update("JackMacWindows.craftos-pc/websocket-history", [""]);
let didShowBetaMessage = false;
commands["craftos-pc.open-new-remote"] = () => {
    if (!didShowBetaMessage) {
        vscode.window.showWarningMessage("remote.craftos-pc.cc is currently in beta. Be aware that things may not work as expected. If you run into issues, please report them [on GitHub](https://github.com/MCJack123/remote.craftos-pc.cc/issues). If things break, use Shift+Ctrl+P (Shift+Cmd+P on Mac), then type 'reload window' and press Enter.");
        didShowBetaMessage = true;
    }
    https_1.default
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
            vscode.window.showInformationMessage("A command has been copied to the clipboard. Paste that into the ComputerCraft computer to establish the connection.");
            connectToWebSocket("wss://remote.craftos-pc.cc/" + id);
        });
    })
        .on("error", (e) => {
        if (e.message.match("certificate has expired"))
            vscode.window
                .showErrorMessage("A bug in VS Code is causing the connection to fail. Please go to https://www.craftos-pc.cc/docs/remote#certificate-has-expired-error to fix it.", "Open Page", "OK")
                .then((res) => {
                if (res === "OK")
                    return;
                vscode.env.openExternal(vscode.Uri.parse("https://www.craftos-pc.cc/docs/remote#certificate-has-expired-error"));
            });
        else
            vscode.window.showErrorMessage("Could not connect to remote.craftos-pc.cc: " + e.message);
    });
};
commands["craftos-pc.open-window"] = (obj) => {
    if (typeof obj === "object")
        return (0, globals_1.FindWindow)(obj.globalID)?.open();
    vscode.window
        .showInputBox({
        prompt: "Enter the window ID:",
        validateInput: (str) => (isNaN(parseInt(str)) ? "Invalid number" : null),
    })
        .then((id) => (0, globals_1.FindWindow)(id)?.open());
};
commands["craftos-pc.open-config"] = () => {
    if ((0, utils_1.getDataPath)() === null) {
        vscode.window.showErrorMessage("Please set the path to the CraftOS-PC data directory manually.");
        return;
    }
    vscode.commands.executeCommand("vscode.open", vscode.Uri.file((0, utils_1.getDataPath)() + "/config/global.json"));
};
commands['craftos-pc.close'] = () => {
    for (const connection of globals_1.ext.connections.values()) {
        connection.disconnect();
    }
};
commands["craftos-pc.close-window"] = async (obj) => {
    const id = typeof obj === 'object' ? obj.globalID : await vscode.window.showInputBox({ prompt: "Enter the window ID:" });
    (0, globals_1.FindWindow)(id)?.close();
};
commands["craftos-pc.kill"] = async (obj) => {
    const id = typeof obj === 'object' ? obj.globalID : await vscode.window.showInputBox({ prompt: "Enter the window ID:" });
    (0, globals_1.FindConnection)(id)?.kill();
};
commands["craftos-pc.run-file"] = path => {
    if (!path) {
        if (vscode.window.activeTextEditor === undefined || vscode.window.activeTextEditor.document.uri.scheme !== "file") {
            vscode.window.showErrorMessage("Please open or save a file on disk before using this command.");
            return;
        }
        path = vscode.window.activeTextEditor.document.uri.fsPath;
    }
    else if (typeof path === "object" && path instanceof vscode.Uri) {
        if (path.scheme !== "file") {
            vscode.window.showErrorMessage("Please open or save a file on disk before using this command.");
            return;
        }
        path = path.fsPath;
    }
    return connectToProcess(["--script", path]);
};


/***/ }),

/***/ "./src/packet.ts":
/*!***********************!*\
  !*** ./src/packet.ts ***!
  \***********************/
/***/ ((__unused_webpack_module, exports, __webpack_require__) => {


Object.defineProperty(exports, "__esModule", ({ value: true }));
exports.newPacket = exports.CraftPacketSpeakerSound = exports.CraftPacketFileData = exports.CraftPacketFileResponse = exports.CraftPacketFileRequest = exports.FileRequestType = exports.CraftPacketVersionSupport = exports.CraftPacketShowMessage = exports.CraftPacketTerminalChange = exports.TerminalChangeType = exports.CraftPacketGenericEvent = exports.CraftPacketMouseEvent = exports.MouseEventType = exports.CraftPacketKeyEvent = exports.CraftPacketTerminalContents = exports.CraftPacketRaw = exports.CraftPacket = exports.CraftPacketType = void 0;
const utils_1 = __webpack_require__(/*! ./utils */ "./src/utils.ts");
var CraftPacketType;
(function (CraftPacketType) {
    CraftPacketType[CraftPacketType["TERMINAL_CONTENTS"] = 0] = "TERMINAL_CONTENTS";
    CraftPacketType[CraftPacketType["KEY_EVENT"] = 1] = "KEY_EVENT";
    CraftPacketType[CraftPacketType["MOUSE_EVENT"] = 2] = "MOUSE_EVENT";
    CraftPacketType[CraftPacketType["GENERIC_EVENT"] = 3] = "GENERIC_EVENT";
    CraftPacketType[CraftPacketType["TERMINAL_CHANGE"] = 4] = "TERMINAL_CHANGE";
    CraftPacketType[CraftPacketType["SHOW_MESSAGE"] = 5] = "SHOW_MESSAGE";
    CraftPacketType[CraftPacketType["VERSION_SUPPORT"] = 6] = "VERSION_SUPPORT";
    CraftPacketType[CraftPacketType["FILE_REQUEST"] = 7] = "FILE_REQUEST";
    CraftPacketType[CraftPacketType["FILE_RESPONSE"] = 8] = "FILE_RESPONSE";
    CraftPacketType[CraftPacketType["FILE_DATA"] = 9] = "FILE_DATA";
    CraftPacketType[CraftPacketType["SPEAKER_SOUND"] = 10] = "SPEAKER_SOUND";
})(CraftPacketType || (exports.CraftPacketType = CraftPacketType = {}));
class CraftPacket {
    constructor() {
        this.window = 0;
    }
    static from(buf) {
        let packet = null;
        switch (buf[0]) {
            case CraftPacketType.TERMINAL_CONTENTS:
                packet = new CraftPacketTerminalContents();
                break;
            case CraftPacketType.TERMINAL_CHANGE:
                packet = new CraftPacketTerminalChange();
                break;
            case CraftPacketType.SHOW_MESSAGE:
                packet = new CraftPacketShowMessage();
                break;
            case CraftPacketType.VERSION_SUPPORT:
                packet = new CraftPacketVersionSupport();
                break;
            case CraftPacketType.FILE_RESPONSE:
                packet = new CraftPacketFileResponse();
                break;
            case CraftPacketType.FILE_DATA:
                packet = new CraftPacketFileData();
                break;
            case CraftPacketType.SPEAKER_SOUND:
                packet = new CraftPacketSpeakerSound();
                break;
        }
        if (packet) {
            packet.read(buf);
        }
        return packet;
    }
    read(buf) {
        this.type = buf[0];
        this.window = buf[1];
    }
    write() {
        const buf = Buffer.alloc(this.length + 2);
        buf.fill(0);
        buf[0] = this.type;
        buf[1] = this.window;
        return buf;
    }
    get length() {
        return 2;
    }
    wrap(options) {
        const data = this.write();
        const b64 = data.toString("base64");
        if (b64.length <= 0xffff) {
            return ("!CPC" +
                b64.length.toString(16).padStart(4, "0") +
                b64 +
                (0, utils_1.crc32)(options?.binaryChecksum ? data.toString("binary") : b64)
                    .toString(16)
                    .padStart(8, "0") +
                "\n");
        }
        else {
            if (!options?.extended)
                throw new Error("Packet is too large");
            return ("!CPD" +
                b64.length.toString(16).padStart(12, "0") +
                b64 +
                (0, utils_1.crc32)(options?.binaryChecksum ? data.toString("binary") : b64)
                    .toString(16)
                    .padStart(8, "0") +
                "\n");
        }
    }
}
exports.CraftPacket = CraftPacket;
class CraftPacketRaw extends CraftPacket {
    write() {
        const buf = super.write();
        this.data.copy(buf, 2);
        return buf;
    }
    get length() {
        return 2 + this.data.byteLength;
    }
    static new(data) {
        return newPacket(this, data);
    }
}
exports.CraftPacketRaw = CraftPacketRaw;
// Server --> Client
class CraftPacketTerminalContents extends CraftPacket {
    static from(buf) {
        const packet = new CraftPacketTerminalContents();
        packet.read(buf);
        return packet;
    }
    readRLE(target, width, height, buf) {
        let offset = 0;
        let c = 0;
        let n = 0;
        for (let y = 0; y < height; y++) {
            target[y] = [];
            for (let x = 0; x < width; x++) {
                while (n <= 0) {
                    c = buf[offset++];
                    n = buf[offset++];
                }
                target[y][x] = c;
                n--;
            }
        }
        return offset;
    }
    read(buf) {
        super.read(buf);
        this.mode = buf[0x02];
        this.blink = buf[0x03] === 1;
        this.width = buf[0x04] | (buf[0x05] << 8);
        this.height = buf[0x06] | (buf[0x07] << 8);
        this.cursorX = buf[0x08] | (buf[0x09] << 8);
        this.cursorY = buf[0x0a] | (buf[0x0b] << 8);
        this.grayscale = buf[0x0c] === 1;
        let bufCursor = 0x10;
        if (this.mode === 0) {
            this.screen = [];
            this.colors = [];
            bufCursor += this.readRLE(this.screen, this.width, this.height, buf.subarray(bufCursor));
            bufCursor += this.readRLE(this.colors, this.width, this.height, buf.subarray(bufCursor));
        }
        else if (this.mode === 1 || this.mode === 2) {
            this.pixels = [];
            bufCursor += this.readRLE(this.pixels, this.width * 6, this.height * 9, buf.subarray(bufCursor));
        }
        this.palette = [];
        const numPalette = this.mode < 2 ? 16 : 256;
        for (let i = 0; i < numPalette; i++) {
            this.palette[i] = {
                r: buf[bufCursor++],
                g: buf[bufCursor++],
                b: buf[bufCursor++],
            };
        }
    }
    static new(data) {
        return newPacket(this, data);
    }
}
exports.CraftPacketTerminalContents = CraftPacketTerminalContents;
// Server <-- Client
class CraftPacketKeyEvent extends CraftPacket {
    constructor() {
        super(...arguments);
        this.data = 0;
        this.isDown = false;
        this.isHeld = false;
        this.isControl = false;
    }
    write() {
        const buf = super.write();
        let flags = (this.isDown ? 1 : 0) | (this.isHeld ? 2 : 0) | (this.isControl ? 4 : 0);
        let data = this.data;
        if (typeof data === "string") {
            data = data.charCodeAt(0);
            flags |= 8;
        }
        buf[0x02] = data;
        buf[0x03] = flags;
        return buf;
    }
    get length() {
        return 4;
    }
    static new(data) {
        return newPacket(this, data);
    }
}
exports.CraftPacketKeyEvent = CraftPacketKeyEvent;
var MouseEventType;
(function (MouseEventType) {
    MouseEventType[MouseEventType["MOUSE_DOWN"] = 0] = "MOUSE_DOWN";
    MouseEventType[MouseEventType["MOUSE_UP"] = 1] = "MOUSE_UP";
    MouseEventType[MouseEventType["MOUSE_SCROLL"] = 2] = "MOUSE_SCROLL";
    MouseEventType[MouseEventType["MOUSE_DRAG"] = 3] = "MOUSE_DRAG";
})(MouseEventType || (exports.MouseEventType = MouseEventType = {}));
// Server <-- Client
class CraftPacketMouseEvent extends CraftPacket {
    constructor() {
        super(...arguments);
        this.button = 0;
        this.x = 0;
        this.y = 0;
    }
    write() {
        const buf = super.write();
        buf[0x02] = this.event;
        buf[0x03] = this.event === MouseEventType.MOUSE_SCROLL ? (this.scroll === "up" ? 0 : 1) : this.button;
        buf.writeUint32LE(this.x, 0x04);
        buf.writeUint32LE(this.y, 0x08);
        return buf;
    }
    get length() {
        return 12;
    }
    static new(data) {
        return newPacket(this, data);
    }
}
exports.CraftPacketMouseEvent = CraftPacketMouseEvent;
// Server <-- Client
// TODO
class CraftPacketGenericEvent extends CraftPacket {
    write() {
        const buf = super.write();
        return buf;
    }
    static new(data) {
        return newPacket(this, data);
    }
}
exports.CraftPacketGenericEvent = CraftPacketGenericEvent;
var TerminalChangeType;
(function (TerminalChangeType) {
    TerminalChangeType[TerminalChangeType["UPDATE"] = 0] = "UPDATE";
    TerminalChangeType[TerminalChangeType["CLOSE"] = 1] = "CLOSE";
    TerminalChangeType[TerminalChangeType["QUIT"] = 2] = "QUIT";
})(TerminalChangeType || (exports.TerminalChangeType = TerminalChangeType = {}));
// Server <-> Client
class CraftPacketTerminalChange extends CraftPacket {
    constructor() {
        super(...arguments);
        this.type2 = TerminalChangeType.UPDATE;
        this.id = 0;
        this.width = 0;
        this.height = 0;
        this.title = "";
    }
    read(buf) {
        super.read(buf);
        this.type2 = buf[0x02];
        this.id = buf[0x03];
        this.width = buf.readUInt16LE(0x04);
        this.height = buf.readUInt16LE(0x06);
        const titleEnd = buf.indexOf(0, 0x08);
        this.title = new TextDecoder("utf8").decode(buf.subarray(0x08, titleEnd));
    }
    write() {
        const buf = super.write();
        buf[0x02] = this.type2;
        buf[0x03] = this.id;
        buf.writeUInt16LE(this.width, 0x04);
        buf.writeUInt16LE(this.height, 0x06);
        return buf;
    }
    get length() {
        return 9;
    }
    static new(data) {
        return newPacket(this, data);
    }
}
exports.CraftPacketTerminalChange = CraftPacketTerminalChange;
// Server --> Client
class CraftPacketShowMessage extends CraftPacket {
    constructor() {
        super(...arguments);
        this.kind = "unknown";
        this.title = "";
        this.message = "";
    }
    read(buf) {
        super.read(buf);
        switch (buf.readUInt32LE(0x02)) {
            case 0x10:
                this.kind = "error";
                break;
            case 0x20:
                this.kind = "warning";
                break;
            case 0x40:
                this.kind = "info";
                break;
            default:
                this.kind = "unknown";
        }
        const titleEnd = buf.indexOf(0, 0x06);
        const messageEnd = buf.indexOf(0, titleEnd + 1);
        const decoder = new TextDecoder("utf8");
        this.title = decoder.decode(buf.subarray(0x06, titleEnd));
        this.message = decoder.decode(buf.subarray(titleEnd + 1, messageEnd));
    }
    static new(data) {
        return newPacket(this, data);
    }
}
exports.CraftPacketShowMessage = CraftPacketShowMessage;
// Server <-> Client
class CraftPacketVersionSupport extends CraftPacket {
    constructor() {
        super(...arguments);
        this.binaryChecksum = false;
        this.supportFilesystem = false;
        this.requestAllWindows = false;
        this.supportSpeaker = false;
    }
    read(buf) {
        super.read(buf);
        const flags = buf.readUInt16LE(0x02);
        this.binaryChecksum = (flags & 0x01) !== 0;
        this.supportFilesystem = (flags & 0x02) !== 0;
        this.requestAllWindows = (flags & 0x04) !== 0;
        this.supportSpeaker = (flags & 0x08) !== 0;
    }
    write() {
        const buf = super.write();
        buf.writeUInt16LE((this.binaryChecksum ? 1 : 0) |
            (this.supportFilesystem ? 2 : 0) |
            (this.requestAllWindows ? 4 : 0) |
            (this.supportSpeaker ? 8 : 0), 0x02);
        return buf;
    }
    get length() {
        return 4;
    }
    static new(data) {
        return newPacket(this, data);
    }
}
exports.CraftPacketVersionSupport = CraftPacketVersionSupport;
var FileRequestType;
(function (FileRequestType) {
    FileRequestType[FileRequestType["EXISTS"] = 0] = "EXISTS";
    FileRequestType[FileRequestType["IS_DIR"] = 1] = "IS_DIR";
    FileRequestType[FileRequestType["IS_READONLY"] = 2] = "IS_READONLY";
    FileRequestType[FileRequestType["GET_SIZE"] = 3] = "GET_SIZE";
    FileRequestType[FileRequestType["GET_DRIVE"] = 4] = "GET_DRIVE";
    FileRequestType[FileRequestType["GET_CAPACITY"] = 5] = "GET_CAPACITY";
    FileRequestType[FileRequestType["GET_FREE_SPACE"] = 6] = "GET_FREE_SPACE";
    FileRequestType[FileRequestType["LIST"] = 7] = "LIST";
    FileRequestType[FileRequestType["ATTRIBUTES"] = 8] = "ATTRIBUTES";
    FileRequestType[FileRequestType["FIND"] = 9] = "FIND";
    FileRequestType[FileRequestType["MAKE_DIR"] = 10] = "MAKE_DIR";
    FileRequestType[FileRequestType["DELETE"] = 11] = "DELETE";
    FileRequestType[FileRequestType["COPY"] = 12] = "COPY";
    FileRequestType[FileRequestType["MOVE"] = 13] = "MOVE";
    FileRequestType[FileRequestType["OPEN"] = 16] = "OPEN";
})(FileRequestType || (exports.FileRequestType = FileRequestType = {}));
// Server <-- Client
class CraftPacketFileRequest extends CraftPacket {
    set path(val) {
        this._path = new TextEncoder().encode(val);
    }
    set path2(val) {
        this._path2 = new TextEncoder().encode(val);
    }
    write() {
        const buf = super.write();
        let t = this.type2;
        if (t === FileRequestType.OPEN) {
            t |= (this.isWrite ? 1 : 0) | (this.isAppend ? 2 : 0) | (this.isBinary ? 4 : 0);
        }
        buf[0x02] = t;
        buf[0x03] = this.id;
        if (this._path) {
            Buffer.from(this._path).copy(buf, 0x04);
            buf[0x04 + this._path.byteLength] = 0;
            if (this._path2) {
                Buffer.from(this._path2).copy(buf, 0x05 + this._path.byteLength);
                buf[0x05 + this._path.byteLength + this._path2.byteLength] = 0;
            }
        }
        return buf;
    }
    get length() {
        return 6 + (this._path ? this._path.byteLength : 0) + (this._path2 ? this._path2.byteLength : 0);
    }
    static new(data) {
        return newPacket(this, data);
    }
}
exports.CraftPacketFileRequest = CraftPacketFileRequest;
// Server --> Client
class CraftPacketFileResponse extends CraftPacket {
    read(buf) {
        super.read(buf);
        this.type2 = buf[0x02];
        this.id = buf[0x03];
        switch (Math.min(this.type2, 16)) {
            case FileRequestType.MAKE_DIR:
            case FileRequestType.DELETE:
            case FileRequestType.COPY:
            case FileRequestType.MOVE:
            case FileRequestType.OPEN:
                const msgEnd = buf.indexOf(0, 0x04);
                this.success = msgEnd === 0x04;
                this.isError = !this.success;
                if (!this.success)
                    this.error = new TextDecoder("utf8").decode(buf.subarray(0x04, msgEnd));
                break;
            case FileRequestType.EXISTS:
            case FileRequestType.IS_DIR:
            case FileRequestType.IS_READONLY:
                this.booleanResult = buf[0x04] === 2 ? null : !!buf[0x04];
                this.isError = this.booleanResult === null;
                break;
            case FileRequestType.GET_SIZE:
            case FileRequestType.GET_CAPACITY:
            case FileRequestType.GET_FREE_SPACE:
                this.integerResult = buf.readUInt32LE(0x04);
                if (this.integerResult === 0xffffffff)
                    this.integerResult = null;
                this.isError = this.integerResult === null;
                break;
            case FileRequestType.GET_DRIVE:
                const strEnd = buf.indexOf(0, 0x04);
                this.stringResult = strEnd === 0x04 ? null : new TextDecoder("utf8").decode(buf.subarray(0x04, strEnd));
                this.isError = this.stringResult === null;
                break;
            case FileRequestType.LIST:
            case FileRequestType.FIND:
                const count = buf.readUInt32LE(0x04);
                if (count === 0xffffffff) {
                    this.listResult = null;
                    this.isError = true;
                    break;
                }
                this.isError = false;
                let offset = 0x08;
                this.listResult = [];
                const decoder = new TextDecoder("utf8");
                for (let i = 0; i < count; i++) {
                    const end = buf.indexOf(0, offset);
                    this.listResult[i] = decoder.decode(buf.subarray(offset, end));
                    offset = end + 1;
                }
                break;
            case FileRequestType.ATTRIBUTES:
                if (buf[0x1a] === 0) {
                    const size = buf.readUInt32LE(0x04);
                    const created = buf.readBigUint64LE(0x08).toString();
                    const modified = buf.readBigUint64LE(0x10).toString();
                    const isDir = !!buf[0x18];
                    const isReadonly = !!buf[0x19];
                    this.attributes = {
                        size,
                        created,
                        modified,
                        isDir,
                        isReadonly,
                    };
                    this.isError = false;
                }
                else {
                    this.attributes = null;
                    this.isError = buf[0x1a] === 2;
                }
                break;
        }
    }
    static new(data) {
        return newPacket(this, data);
    }
}
exports.CraftPacketFileResponse = CraftPacketFileResponse;
// Server <-> Client
class CraftPacketFileData extends CraftPacket {
    constructor() {
        super(...arguments);
        this.isError = false;
    }
    read(buf) {
        super.read(buf);
        this.isError = !!buf[0x02];
        this.id = buf[0x03];
        const length = buf.readUInt32LE(0x04);
        this.data = buf.subarray(0x08, 0x08 + length);
    }
    write() {
        const buf = super.write();
        buf[0x02] = this.isError ? 1 : 0;
        buf[0x03] = this.id;
        buf.writeUInt32LE(this.data.byteLength);
        this.data.copy(buf, 0x08);
        return buf;
    }
    get length() {
        return 8 + this.data.byteLength;
    }
    static new(data) {
        return newPacket(this, data);
    }
}
exports.CraftPacketFileData = CraftPacketFileData;
// Server --> Client
// TODO
class CraftPacketSpeakerSound extends CraftPacket {
    read(buf) {
        super.read(buf);
    }
    static new(data) {
        return newPacket(this, data);
    }
}
exports.CraftPacketSpeakerSound = CraftPacketSpeakerSound;
const classToType = new Map();
classToType.set(CraftPacketTerminalContents, CraftPacketType.TERMINAL_CONTENTS);
classToType.set(CraftPacketKeyEvent, CraftPacketType.KEY_EVENT);
classToType.set(CraftPacketMouseEvent, CraftPacketType.MOUSE_EVENT);
classToType.set(CraftPacketGenericEvent, CraftPacketType.GENERIC_EVENT);
classToType.set(CraftPacketTerminalChange, CraftPacketType.TERMINAL_CHANGE);
classToType.set(CraftPacketShowMessage, CraftPacketType.SHOW_MESSAGE);
classToType.set(CraftPacketVersionSupport, CraftPacketType.VERSION_SUPPORT);
classToType.set(CraftPacketFileRequest, CraftPacketType.FILE_REQUEST);
classToType.set(CraftPacketFileResponse, CraftPacketType.FILE_RESPONSE);
classToType.set(CraftPacketFileData, CraftPacketType.FILE_DATA);
classToType.set(CraftPacketSpeakerSound, CraftPacketType.SPEAKER_SOUND);
function newPacket(clazz, data) {
    const t = new clazz();
    for (const key in data) {
        t[key] = data[key];
    }
    if (classToType.has(clazz))
        t.type = classToType.get(clazz);
    return t;
}
exports.newPacket = newPacket;


/***/ }),

/***/ "./src/utils.ts":
/*!**********************!*\
  !*** ./src/utils.ts ***!
  \**********************/
/***/ (function(__unused_webpack_module, exports, __webpack_require__) {


var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || function (mod) {
    if (mod && mod.__esModule) return mod;
    var result = {};
    if (mod != null) for (var k in mod) if (k !== "default" && Object.prototype.hasOwnProperty.call(mod, k)) __createBinding(result, mod, k);
    __setModuleDefault(result, mod);
    return result;
};
Object.defineProperty(exports, "__esModule", ({ value: true }));
exports.crc32 = exports.getExecutable = exports.getDataPath = exports.getExtensionSetting = exports.getSetting = void 0;
const vscode = __importStar(__webpack_require__(/*! vscode */ "vscode"));
const os = __importStar(__webpack_require__(/*! os */ "os"));
const fs = __importStar(__webpack_require__(/*! fs */ "fs"));
function getSetting(name) {
    const config = vscode.workspace.getConfiguration(name);
    if (config.get("all") !== null && config.get("all") !== "")
        return config.get("all");
    else if (os.platform() === "win32")
        return config.get("windows").replace(/%([^%]+)%/g, (_, n) => process.env[n] || "%" + n + "%");
    else if (os.platform() === "darwin")
        return config.get("mac")
            .replace(/\$(\w+)/g, (_, n) => process.env[n] || "$" + n)
            .replace(/\${([^}]+)}/g, (_, n) => process.env[n] || "${" + n + "}");
    else if (os.platform() === "linux")
        return config.get("linux")
            .replace(/\$(\w+)/g, (_, n) => process.env[n] || "$" + n)
            .replace(/\${([^}]+)}/g, (_, n) => process.env[n] || "${" + n + "}");
    else
        return null;
}
exports.getSetting = getSetting;
function getExtensionSetting(name) {
    return vscode.workspace.getConfiguration("craftos-pc").get(name);
}
exports.getExtensionSetting = getExtensionSetting;
function getDataPath() {
    const config = vscode.workspace.getConfiguration("craftos-pc");
    if (config.get("dataPath") !== null && config.get("dataPath") !== "")
        return config.get("dataPath");
    else if (os.platform() === "win32")
        return "%appdata%\\CraftOS-PC".replace(/%([^%]+)%/g, (_, n) => process.env[n] || "%" + n + "%");
    else if (os.platform() === "darwin")
        return "$HOME/Library/Application Support/CraftOS-PC"
            .replace(/\$(\w+)/g, (_, n) => process.env[n] || "$" + n)
            .replace(/\${([^}]+)}/g, (_, n) => process.env[n] || "${" + n + "}");
    else if (os.platform() === "linux")
        return "$HOME/.local/craftos-pc"
            .replace(/\$(\w+)/g, (_, n) => process.env[n] || "$" + n)
            .replace(/\${([^}]+)}/g, (_, n) => process.env[n] || "${" + n + "}");
    else
        return null;
}
exports.getDataPath = getDataPath;
function getExecutable() {
    let path = getSetting("craftos-pc.executablePath");
    if (path !== null && fs.existsSync(path))
        return path;
    if (os.platform() === "win32") {
        path = "%localappdata%\\Programs\\CraftOS-PC\\CraftOS-PC_console.exe".replace(/%([^%]+)%/g, (_, n) => process.env[n] || "%" + n + "%");
        if (fs.existsSync(path))
            return path;
    }
    if (path !== null && os.platform() === "win32" && fs.existsSync(path.replace("_console", ""))) {
        vscode.window.showErrorMessage("The CraftOS-PC installation is missing the console version, which is required for this extension to function. Please run the installer again, making sure to check the 'Console build for raw mode' box.");
        return null;
    }
    vscode.window.showErrorMessage("The CraftOS-PC executable could not be found. Check the path in the settings. If you haven't installed CraftOS-PC yet, [download it from the official website.](https://www.craftos-pc.cc)");
    return null;
}
exports.getExecutable = getExecutable;
let crcTable = null;
function makeCRCTable() {
    let c;
    let crcTable = [];
    for (let n = 0; n < 256; n++) {
        c = n;
        for (let k = 0; k < 8; k++)
            c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
        crcTable[n] = c;
    }
    return crcTable;
}
function crc32(str) {
    crcTable = crcTable || makeCRCTable();
    let crc = 0 ^ -1;
    for (let i = 0; i < str.length; i++) {
        crc = (crc >>> 8) ^ crcTable[(crc ^ str.charCodeAt(i)) & 0xff];
    }
    return (crc ^ -1) >>> 0;
}
exports.crc32 = crc32;


/***/ }),

/***/ "./src/view_terminals.ts":
/*!*******************************!*\
  !*** ./src/view_terminals.ts ***!
  \*******************************/
/***/ (function(__unused_webpack_module, exports, __webpack_require__) {


var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", ({ value: true }));
exports.MonitorProvider = exports.ComputerProvider = void 0;
const vscode_1 = __importDefault(__webpack_require__(/*! vscode */ "vscode"));
const globals_1 = __webpack_require__(/*! ./globals */ "./src/globals.ts");
const path_1 = __importDefault(__webpack_require__(/*! path */ "path"));
class ComputerProvider extends vscode_1.default.EventEmitter {
    constructor() {
        super(...arguments);
        this.onDidChangeTreeData = this.event;
    }
    getTreeItem(element) {
        const r = new vscode_1.default.TreeItem(element.title);
        r.iconPath = vscode_1.default.Uri.file(path_1.default.join(globals_1.ext.context.extensionPath, "media/computer.svg"));
        r.command = {
            command: "craftos-pc.open-window",
            title: "CraftOS-PC: Open Window",
            arguments: [element],
        };
        r.tooltip = element.globalID;
        if ((0, globals_1.FindConnection)(element.globalID)?.supportsFilesystem)
            r.contextValue = "data-available";
        return r;
    }
    getChildren(element) {
        if (element)
            return null;
        return [...globals_1.ext.connections.values()]
            .map((connection) => [...connection.windows.values()]
            .filter((window) => !window.isMonitor)
            .map((window) => ({
            title: window.term?.title || "CraftOS-PC Computer",
            globalID: `${window.id}@${connection.id}`,
        })))
            .flat(1);
    }
}
exports.ComputerProvider = ComputerProvider;
class MonitorProvider extends vscode_1.default.EventEmitter {
    constructor() {
        super(...arguments);
        this.onDidChangeTreeData = this.event;
    }
    getTreeItem(element) {
        const r = new vscode_1.default.TreeItem(element.title);
        r.iconPath = vscode_1.default.Uri.file(path_1.default.join(globals_1.ext.context.extensionPath, "media/monitor.svg"));
        r.command = {
            command: "craftos-pc.open-window",
            title: "CraftOS-PC: Open Window",
            arguments: [element],
        };
        r.tooltip = element.globalID;
        return r;
    }
    getChildren(element) {
        if (element)
            return null;
        return [...globals_1.ext.connections.values()]
            .map((connection) => [...connection.windows.values()]
            .filter((window) => window.isMonitor)
            .map((window) => ({
            title: window.term?.title || "CraftOS-PC Computer",
            globalID: `${window.id}@${connection.id}`,
        })))
            .flat(1);
    }
}
exports.MonitorProvider = MonitorProvider;


/***/ }),

/***/ "./src/window.ts":
/*!***********************!*\
  !*** ./src/window.ts ***!
  \***********************/
/***/ (function(__unused_webpack_module, exports, __webpack_require__) {


var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || function (mod) {
    if (mod && mod.__esModule) return mod;
    var result = {};
    if (mod != null) for (var k in mod) if (k !== "default" && Object.prototype.hasOwnProperty.call(mod, k)) __createBinding(result, mod, k);
    __setModuleDefault(result, mod);
    return result;
};
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", ({ value: true }));
exports.CraftWindow = void 0;
const vscode = __importStar(__webpack_require__(/*! vscode */ "vscode"));
const os = __importStar(__webpack_require__(/*! os */ "os"));
const fs = __importStar(__webpack_require__(/*! fs */ "fs"));
const utils_1 = __webpack_require__(/*! ./utils */ "./src/utils.ts");
const path = __importStar(__webpack_require__(/*! path */ "path"));
const packet_1 = __webpack_require__(/*! ./packet */ "./src/packet.ts");
const globals_1 = __webpack_require__(/*! ./globals */ "./src/globals.ts");
const events_1 = __importDefault(__webpack_require__(/*! events */ "events"));
function loadFont() {
    const customFont = vscode.workspace.getConfiguration("craftos-pc.customFont");
    let fontPath = customFont.get("path");
    if (fontPath === "hdfont") {
        const execPath = (0, utils_1.getSetting)("craftos-pc.executablePath");
        if (os.platform() === "win32")
            fontPath = execPath.replace(/[\/\\][^\/\\]+$/, "/") + "hdfont.bmp";
        else if (os.platform() === "darwin" && execPath.indexOf("MacOS/craftos") !== -1)
            fontPath = execPath.replace(/MacOS\/[^\/]+$/, "") + "Resources/hdfont.bmp";
        else if (os.platform() === "darwin" ||
            (os.platform() === "linux" && !fs.existsSync("/usr/share/craftos/hdfont.bmp")))
            fontPath = "/usr/local/share/craftos/hdfont.bmp";
        else if (os.platform() === "linux")
            fontPath = "/usr/share/craftos/hdfont.bmp";
        if (!fs.existsSync(fontPath)) {
            vscode.window.showWarningMessage("The path to the HD font could not be found; the default font will be used instead. Please set the path to the HD font manually.");
            fontPath = null;
        }
    }
    return fontPath;
}
class CraftWindow extends events_1.default {
    constructor(parent, id) {
        super();
        this.parent = parent;
        this.id = id;
        this.isMonitor = false;
    }
    open() {
        if (this.panel) {
            this.panel.reveal();
            return;
        }
        const fontPath = loadFont();
        this.panel = vscode.window.createWebviewPanel("craftos-pc", "CraftOS-PC Terminal", (vscode.window.activeTextEditor && vscode.window.activeTextEditor.viewColumn) || vscode.ViewColumn.One, {
            enableScripts: true,
            retainContextWhenHidden: true,
            localResourceRoots: fontPath !== null && fontPath !== ""
                ? [vscode.Uri.file(fontPath.replace(/[\/\\][^\/\\]*$/, ""))]
                : null,
        });
        globals_1.ext.context.subscriptions.push(this.panel);
        this.panel.iconPath = vscode.Uri.file(path.join(globals_1.ext.context.extensionPath, this.isMonitor ? "media/monitor.svg" : "media/computer.svg"));
        this.panel.webview.html = fs.readFileSync(path.join(globals_1.ext.context.extensionPath, "index.html"), "utf8");
        this.panel.webview.onDidReceiveMessage((message) => {
            if (typeof message !== "object")
                return;
            if (message.getFontPath === true) {
                if (fontPath !== null && fontPath !== "")
                    this.panel.webview.postMessage({
                        fontPath: this.panel.webview.asWebviewUri(vscode.Uri.file(fontPath)).toString(),
                    });
                return;
            }
            this.parent.send(packet_1.CraftPacketRaw.new({
                type: message.type,
                window: this.id,
                data: Buffer.from(message.data, "hex"),
            }));
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
    updateTerm(term) {
        const prevIsMonitor = this.isMonitor;
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
        if (prevIsMonitor !== this.isMonitor) {
            this.emit('type_change', this.isMonitor);
        }
        if (!this.term)
            this.term = {};
        Object.assign(this.term, term);
        if (this.panel) {
            this.panel.webview.postMessage(this.term);
            this.panel.title = this.term.title || "CraftOS-PC Terminal";
        }
    }
}
exports.CraftWindow = CraftWindow;


/***/ }),

/***/ "child_process":
/*!********************************!*\
  !*** external "child_process" ***!
  \********************************/
/***/ ((module) => {

module.exports = require("child_process");

/***/ }),

/***/ "events":
/*!*************************!*\
  !*** external "events" ***!
  \*************************/
/***/ ((module) => {

module.exports = require("events");

/***/ }),

/***/ "fs":
/*!*********************!*\
  !*** external "fs" ***!
  \*********************/
/***/ ((module) => {

module.exports = require("fs");

/***/ }),

/***/ "https":
/*!************************!*\
  !*** external "https" ***!
  \************************/
/***/ ((module) => {

module.exports = require("https");

/***/ }),

/***/ "os":
/*!*********************!*\
  !*** external "os" ***!
  \*********************/
/***/ ((module) => {

module.exports = require("os");

/***/ }),

/***/ "path":
/*!***********************!*\
  !*** external "path" ***!
  \***********************/
/***/ ((module) => {

module.exports = require("path");

/***/ }),

/***/ "vscode":
/*!*************************!*\
  !*** external "vscode" ***!
  \*************************/
/***/ ((module) => {

module.exports = require("vscode");

/***/ }),

/***/ "ws":
/*!*********************!*\
  !*** external "ws" ***!
  \*********************/
/***/ ((module) => {

module.exports = require("ws");

/***/ })

/******/ 	});
/************************************************************************/
/******/ 	// The module cache
/******/ 	var __webpack_module_cache__ = {};
/******/ 	
/******/ 	// The require function
/******/ 	function __webpack_require__(moduleId) {
/******/ 		// Check if module is in cache
/******/ 		var cachedModule = __webpack_module_cache__[moduleId];
/******/ 		if (cachedModule !== undefined) {
/******/ 			return cachedModule.exports;
/******/ 		}
/******/ 		// Create a new module (and put it into the cache)
/******/ 		var module = __webpack_module_cache__[moduleId] = {
/******/ 			// no module.id needed
/******/ 			// no module.loaded needed
/******/ 			exports: {}
/******/ 		};
/******/ 	
/******/ 		// Execute the module function
/******/ 		__webpack_modules__[moduleId].call(module.exports, module, module.exports, __webpack_require__);
/******/ 	
/******/ 		// Return the exports of the module
/******/ 		return module.exports;
/******/ 	}
/******/ 	
/************************************************************************/
/******/ 	
/******/ 	// startup
/******/ 	// Load entry module and return exports
/******/ 	// This entry module is referenced by other modules so it can't be inlined
/******/ 	var __webpack_exports__ = __webpack_require__("./src/index.ts");
/******/ 	module.exports = __webpack_exports__;
/******/ 	
/******/ })()
;
//# sourceMappingURL=extension.js.map