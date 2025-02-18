const child_process = require('child_process');
const { SIGINT } = require('constants');
const fs = require('fs');
const https = require('https');
const os = require('os');
const path = require('path');
const process = require('process');
const semver = require('semver');
const URL = require('url').URL;
const vscode = require('vscode');
const vsls = require('vsls');
const WebSocket = require('ws');

var windows = {};
var crcTable = null;
var extcontext = null;
/** @type vscode.OutputChannel */
var log = {appendLine: () => {}};

function makeCRCTable() {
    let c;
    let crcTable = [];
    for (let n = 0; n < 256; n++) {
        c = n;
        for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1;
        crcTable[n] = c;
    }
    return crcTable;
}

function crc32(str) {
    crcTable = crcTable || makeCRCTable();
    let crc = 0 ^ (-1);
    for (let i = 0; i < str.length; i++) {
        crc = (crc >>> 8) ^ crcTable[(crc ^ str.charCodeAt(i)) & 0xFF];
    }
    return (crc ^ (-1)) >>> 0;
};

function bufferstream(str) {
    let retval = {}
    retval.pos = 0
    retval.str = str
    retval.readUInt64 = function() {
        let r = Number(this.str.readBigUInt64LE(this.pos));
        this.pos += 8;
        return r;
    }
    retval.readUInt32 = function() {
        let r = this.str.readUInt32LE(this.pos);
        this.pos += 4;
        return r;
    }
    retval.readUInt16 = function() {
        let r = this.str.readUInt16LE(this.pos);
        this.pos += 2;
        return r;
    }
    retval.get = function() {
        return this.str.readUInt8(this.pos++);
    };
    retval.putback = function() {this.pos--;}
    return retval;
}

function validateURL(str) {
    try {
        let url = new URL(str);
        return url.protocol.toLowerCase() == "ws:" || url.protocol.toLowerCase() == "wss:";
    } catch (e) {return false;}
}

const connections = new Map();

const computer_provider = {
    getChildren: element => {
        if ((element === undefined || element === null)) {
            let arr = [];
            for (let w in windows) if (!windows[w].isMonitor) arr.push({title: windows[w].term.title, id: w});
            return arr;
        } else return null;
    },
    getTreeItem: element => {
        let r = new vscode.TreeItem(element.title);
        r.iconPath = vscode.Uri.file(path.join(extcontext.extensionPath, 'media/computer.svg'));
        r.command = {command: "craftos-pc.open-window", title: "CraftOS-PC: Open Window", arguments: [element]};
        const connection = connections.get(parseInt(element.id));
        if (connection && connection.supportsFilesystem) r.contextValue = "data-available";
        return r;
    },
    _onDidChangeTreeData: new vscode.EventEmitter(),
};
computer_provider.onDidChangeTreeData = computer_provider._onDidChangeTreeData.event;

const monitor_provider = {
    getChildren: element => {
        if ((element === undefined || element === null)) {
            let arr = [];
            for (let w in windows) if (windows[w].isMonitor) arr.push({title: windows[w].term.title, id: w});
            return arr;
        }
        else return null;
    },
    getTreeItem: element => {
        let r = new vscode.TreeItem(element.title);
        r.iconPath = vscode.Uri.file(path.join(extcontext.extensionPath, 'media/monitor.svg'));
        r.command = {command: "craftos-pc.open-window", title: "CraftOS-PC: Open Window", arguments: [element]};
        return r;
    },
    _onDidChangeTreeData: new vscode.EventEmitter(),
}
monitor_provider.onDidChangeTreeData = monitor_provider._onDidChangeTreeData.event;

class Dependency extends vscode.TreeItem {
    constructor(
      label,
      version,
      collapsibleState
    ) {
        super(label, collapsibleState);
        this.label = label;
        this.version = version;
        this.collapsibleState = collapsibleState;
        this.tooltip = `${this.label}-${this.version}`;
        this.description = this.version;

        this.iconPath = vscode.ThemeIcon.File;
        this.resourceUri = vscode.Uri.parse('craftos-pc://0/myfile.lua');
        this.id = 'ok_' + Math.random();
    }
  }
  

const files_provider = {
    getChildren: element => {
        if (!element) {

        } else {

        }
        return [
            new Dependency('Hello', 'Chiblee', vscode.TreeItemCollapsibleState.None),
            new Dependency('Recurse', ':)', vscode.TreeItemCollapsibleState.Collapsed)
        ];
    },
    getTreeItem: element => element,
    _onDidChangeTreeData: new vscode.EventEmitter(),
    dragMimeTypes: ['text/uri-list'],
    dropMimeTypes: ['files', 'text/uri-list', 'application/vnd.code.tree.craftos-files'],
    handleDrag: (...args) => {console.log('drag', ...args)},
    handleDrop: async (target, dataTransfer, cancellationToken) => {
        console.log("drop");
        for (const [mimeType, dataTransferItem] of dataTransfer) {
            console.log("dt:", mimeType, dataTransferItem);
            const file = dataTransferItem.asFile();
            if (file) {
                console.log(file, (await file.data()).length);
            }
        }
    }
}
files_provider.onDidChangeTreeData = files_provider._onDidChangeTreeData.event;

// TODO: Rework the whole thing to support multiple windows per connection

var /*TODO*/ process_connection = null;
var /*TODO*/ data_continuation = null;
var /*TODO*/ nextDataRequestID = 0;
var /*TODO*/ dataRequestCallbacks = {};
var /*TODO*/ isVersion11 = false;
var /*TODO*/ useBinaryChecksum = false;
var /*TODO*/ supportsFilesystem = false;
var /*TODO*/ gotMessage = false;
var didShowBetaMessage = false;
var processFeatures = {};
/** @type vsls.LiveShare|null */
var liveshare = null;
/** @type vsls.SharedServiceProxy|null */
var vslsClient = null;
/** @type vsls.SharedService|null */
var vslsServer = null;

function getSetting(name) {
    const config = vscode.workspace.getConfiguration(name);
    if (config.get("all") !== null && config.get("all") !== "") return config.get("all");
    else if (os.platform() === "win32") return config.get("windows").replace(/%([^%]+)%/g, (_, n) => process.env[n] || ('%' + n + '%'));
    else if (os.platform() === "darwin") return config.get("mac").replace(/\$(\w+)/g, (_, n) => process.env[n] || ('$' + n)).replace(/\${([^}]+)}/g, (_, n) => process.env[n] || ('${' + n + '}'));
    else if (os.platform() === "linux") return config.get("linux").replace(/\$(\w+)/g, (_, n) => process.env[n] || ('$' + n)).replace(/\${([^}]+)}/g, (_, n) => process.env[n] || ('${' + n + '}'));
    else return null;
}

function getDataPath() {
    const config = vscode.workspace.getConfiguration("craftos-pc");
    if (config.get("dataPath") !== null && config.get("dataPath") !== "") return config.get("dataPath");
    else if (os.platform() === "win32") return "%appdata%\\CraftOS-PC".replace(/%([^%]+)%/g, (_, n) => process.env[n] || ('%' + n + '%'));
    else if (os.platform() === "darwin") return "$HOME/Library/Application Support/CraftOS-PC".replace(/\$(\w+)/g, (_, n) => process.env[n] || ('$' + n)).replace(/\${([^}]+)}/g, (_, n) => process.env[n] || ('${' + n + '}'))
    else if (os.platform() === "linux") return "$HOME/.local/craftos-pc".replace(/\$(\w+)/g, (_, n) => process.env[n] || ('$' + n)).replace(/\${([^}]+)}/g, (_, n) => process.env[n] || ('${' + n + '}'))
    else return null;
}

function getExecutable() {
    let path = getSetting("craftos-pc.executablePath");
    if (path !== null && fs.existsSync(path)) return path;
    if (os.platform() === "win32") {
        path = "%localappdata%\\Programs\\CraftOS-PC\\CraftOS-PC_console.exe".replace(/%([^%]+)%/g, (_, n) => process.env[n] || ('%' + n + '%'));
        if (fs.existsSync(path)) return path;
    }
    if (path !== null && os.platform() === "win32" && fs.existsSync(path.replace("_console", ""))) {
        vscode.window.showErrorMessage("The CraftOS-PC installation is missing the console version, which is required for this extension to function. Please run the installer again, making sure to check the 'Console build for raw mode' box.");
        return null;
    }
    vscode.window.showErrorMessage("The CraftOS-PC executable could not be found. Check the path in the settings. If you haven't installed CraftOS-PC yet, [download it from the official website.](https://www.craftos-pc.cc)");
    return null;
}

function closeWindow(id) {
    if (id in windows) {
        if (windows[id].panel !== undefined) windows[id].panel.dispose();
        delete windows[id];
        computer_provider._onDidChangeTreeData.fire(null);
        monitor_provider._onDidChangeTreeData.fire(null);
        if (vslsServer !== null) vslsServer.notify("windows", windows);
    }
}

function closeAllWindows() {
    for (let k in windows) if (windows[k].panel !== undefined) windows[k].panel.dispose();
    windows = {};
    computer_provider._onDidChangeTreeData.fire(null);
    monitor_provider._onDidChangeTreeData.fire(null);
    if (vslsServer !== null) vslsServer.notify("windows", {});
}

class Connection {
    constructor(id) {
        this.id = id;
        this.process_connection = /*any*/ null;
        this.data_continuation = null;
        this.nextDataRequestID = 0;
        this.dataRequestCallbacks = {};
        this.isVersion11 = false;
        this.useBinaryChecksum = false;
        this.supportsFilesystem = false;
        this.gotMessage = false;
        this.isRemote = false;
    }

    connectToProcess(extra_args) {
        this.isRemote = false;
        if (this.process_connection !== null) return true;
        const exe_path = getExecutable();
        if (exe_path === null) {
            return false;
        }
        const dir = vscode.workspace.getConfiguration("craftos-pc").get("dataPath");
        let process_options = {
            windowsHide: true
        };
        let args = vscode.workspace.getConfiguration("craftos-pc").get("additionalArguments");
        if (args !== null) {args = args.split(' '); args.push("--raw");}
        else args = ["--raw"];
        if (dir !== null) args.splice(-1, 0, "-d", dir);
        if (extra_args !== null) args = args.concat(extra_args);
        log.appendLine("Running: " + exe_path + " " + args.join(" "));
        try {
            const process_connection = child_process.spawn(exe_path, args, process_options);
            this.process_connection = process_connection;
            process_connection.on("error", () => {
                vscode.window.showErrorMessage("The CraftOS-PC worker process could not be launched. Check the path to the executable in the settings.");
                this.process_connection = null;
                closeWindow(this.id);
            });
            process_connection.on("exit", code => {
                vscode.window.showInformationMessage(`The CraftOS-PC worker process exited with code ${code}.`)
                this.process_connection = null;
                closeWindow(this.id);
            });
            process_connection.on("disconnect", () => {
                vscode.window.showErrorMessage(`The CraftOS-PC worker process was disconnected from the window.`)
                this.process_connection = null;
                closeWindow(this.id);
            });
            process_connection.on("close", () => {
                //vscode.window.showInformationMessage(`The CraftOS-PC worker process closed all IO streams with code ${code}.`)
                this.process_connection = null;
                closeWindow(this.id);
            });
            process_connection.stdout.on("data", data => this.processDataChunk(data));
            process_connection.stderr.on("data", data => {
                log.appendLine(data.toString());
            });
        } catch (e) {
            vscode.window.showErrorMessage("The CraftOS-PC worker process could not be launched. Check the path to the executable in the settings.");
            log.appendLine(e);
            return;
        }
        this.sendRaw("!CPC0008BgADAA==498C93D2\n"); // 0x0003
        vscode.window.showInformationMessage("A new CraftOS-PC worker process has been started.");
        openPanel(this.id, true);
        this.gotMessage = false;
        this.data_continuation = null;
        this.nextDataRequestID = 0;
        this.dataRequestCallbacks = {};
        this.isVersion11 = false;
        this.useBinaryChecksum = false;
        this.supportsFilesystem = false;
    }
    
    connectToWebSocket(url) {
        this.isRemote = true;
        if (this.process_connection !== null || url === undefined) return true;
        const socket = new WebSocket(url);
        // We insert a small shim here so we don't have to rewrite the other code.
        const process_connection = {
            connected: socket.readyState == WebSocket.OPEN,
            disconnect: () => socket.close(),
            kill: () => socket.close(),
            stdin: {write: data => {for (let i = 0; i < data.length; i += 65530) socket.send(data.substring(i, Math.min(i + 65530, data.length)))}}
        };
        this.process_connection = process_connection;
        socket.on("open", () => {
            //socket.send("!CPC0008BgACAA==FBAC4FC2\n"); // 0x0002
            //socket.send("!CPC0008BgADAA==498C93D2\n"); // 0x0003
            //socket.send("!CPC0008BgAGAA==0E2CE902\n"); // 0x0006
            socket.send("!CPC0008BgAHAA==8C7C7ED3\n"); // 0x0007
            vscode.window.showInformationMessage("Successfully connected to the WebSocket server.");
            process_connection.connected = true;
            openPanel(this.id, true);
        });
        socket.on("error", e => {
            if (e.message.match("certificate has expired"))
                vscode.window.showErrorMessage("A bug in VS Code is causing the connection to fail. Please go to https://www.craftos-pc.cc/docs/remote#certificate-has-expired-error to fix it.", "Open Page", "OK").then(res => {
                    if (res === "OK") return;
                    vscode.env.openExternal(vscode.Uri.parse("https://www.craftos-pc.cc/docs/remote#certificate-has-expired-error"));
                });
            else vscode.window.showErrorMessage("An error occurred while connecting to the server: " + e.message);
            this.process_connection = null;
            closeWindow(this.id);
        });
        socket.on("close", () => {
            vscode.window.showInformationMessage("Disconnected from the WebSocket server.");
            this.process_connection = null;
            closeWindow(this.id);
        });
        socket.on("message", data => this.processDataChunk(data));
        this.gotMessage = false;
        this.data_continuation = null;
        this.nextDataRequestID = 0;
        this.dataRequestCallbacks = {};
        this.isVersion11 = false;
        this.useBinaryChecksum = false;
        this.supportsFilesystem = false;
    }
    
    queueDataRequest(type, path, path2) {
        if (this.process_connection === null) return new Promise((resolve, reject) => reject(new Error("Path does not exist")));
        let filedata = undefined;
        if ((type & 0xF1) === 0x11) {
            filedata = path2;
            path2 = undefined;
        }
        const pathbuf = Buffer.from(path, "latin1");
        const path2buf = (typeof path2 === "string" ? Buffer.from(path2, "latin1") : null);
        const data = Buffer.alloc(5 + pathbuf.length + (typeof path2 === "string" ? path2buf.length + 1 : 0));
        data[0] = 7;
        data[1] = 0;
        data[2] = type;
        data[3] = this.nextDataRequestID;
        this.nextDataRequestID = (this.nextDataRequestID + 1) & 0xFF;
        pathbuf.copy(data, 4);
        if (typeof path2 === "string") path2buf.copy(data, 5 + pathbuf.length);
        const b64 = data.toString('base64');
        const packet = "!CPC" + ("000" + b64.length.toString(16)).slice(-4) + b64 + ("0000000" + crc32(this.useBinaryChecksum ? data.toString("binary") : b64).toString(16)).slice(-8) + "\n";
        this.sendRaw(packet, 'utf8');
        if (typeof filedata !== "undefined") {
            const data2 = Buffer.alloc(8 + filedata.length);
            data2[0] = 9;
            data2[1] = 0;
            data2[2] = 0;
            data2[3] = data[3];
            data2.writeInt32LE(filedata.length, 4);
            filedata.copy(data2, 8);
            const b642 = data2.toString('base64');
            const packet2 = (b642.length > 65535 ? "!CPD" + ("00000000000" + b642.length.toString(16)).slice(-12) : "!CPC" + ("000" + b642.length.toString(16)).slice(-4)) + b642 + ("0000000" + crc32(this.useBinaryChecksum ? data2.toString("binary") : b642).toString(16)).slice(-8) + "\n";
            this.sendRaw(packet2, 'utf8');
        }
        return new Promise((resolve, reject) => {
            let tid = setTimeout(() => {
                delete this.dataRequestCallbacks[data[3]];
                log.appendLine("Could not get info for " + path + " (request " + data[3] + ")");
                reject(new Error("Timeout"));
            }, 3000);
            this.dataRequestCallbacks[data[3]] = (data, err) => {
                clearTimeout(tid);
                if (!err) resolve(data);
                else reject(err);
            }
        });
    }

    /**
     * @param {Buffer} chunk data
     */
    processDataChunk(chunk) {
        if (typeof chunk === "string") chunk = new Buffer(chunk, "utf8");
        if (this.data_continuation !== null) {
            chunk = Buffer.concat([this.data_continuation, chunk]);
            this.data_continuation = null;
        }
        while (chunk.length > 0) {
            let off;
            if (chunk.subarray(0, 4).toString() === "!CPC") off = 8;
            else if (chunk.subarray(0, 4).toString() === "!CPD" && this.isVersion11) off = 16;
            else {
                log.appendLine("Invalid message");
                return;
            }
            const size = parseInt(chunk.subarray(4, off).toString(), 16);
            if (size > chunk.length + 9) {
                this.data_continuation = chunk;
                return;
            }
            const data = Buffer.from(chunk.subarray(off, size + off).toString(), 'base64');
            const good_checksum = parseInt(chunk.subarray(size + off, size + off + 8).toString(), 16);
            const data_checksum = crc32(this.useBinaryChecksum ? data.toString("binary") : chunk.subarray(off, size + off).toString());
            if (good_checksum !== data_checksum) {
                log.appendLine("Bad checksum: expected " + good_checksum.toString(16) + ", got " + data_checksum.toString(16));
                chunk = chunk.subarray(size + 16);
                while (String.fromCharCode(chunk[0]).match(/\s/)) chunk = chunk.subarray(1);
                continue;
            }
            let term = {}
            const stream = bufferstream(data);
            const type = stream.get();
            const _id = stream.get();
            const id = this.id;
            if (!this.gotMessage && type == 4) this.sendRaw("!CPC0008BgADAA==498C93D2\n"); // 0x0003
            this.gotMessage = true;
            let winid = null;
            if (type === 0) {
                term.mode = stream.get();
                term.blink = stream.get() === 1;
                term.width = stream.readUInt16();
                term.height = stream.readUInt16();
                term.cursorX = stream.readUInt16();
                term.cursorY = stream.readUInt16();
                stream.readUInt32();
                term.screen = {}
                term.colors = {}
                term.pixels = {}
                if (term.mode === 0) {
                    let c = stream.get();
                    let n = stream.get();
                    for (let y = 0; y < term.height; y++) {
                        term.screen[y] = {}
                        for (let x = 0; x < term.width; x++) {
                            term.screen[y][x] = c;
                            n--;
                            if (n === 0) {
                                c = stream.get();
                                n = stream.get();
                            }
                        }
                    }
                    for (let y = 0; y < term.height; y++) {
                        term.colors[y] = {}
                        for (let x = 0; x < term.width; x++) {
                            term.colors[y][x] = c;
                            n--;
                            if (n === 0) {
                                c = stream.get();
                                n = stream.get();
                            }
                        }
                    }
                    stream.putback();
                    stream.putback();
                } else if (term.mode === 1 || term.mode === 2) {
                    let c = stream.get();
                    let n = stream.get();
                    for (let y = 0; y < term.height * 9; y++) {
                        term.pixels[y] = {}
                        for (let x = 0; x < term.width * 6; x++) {
                            term.pixels[y][x] = c;
                            n--;
                            if (n === 0) {
                                c = stream.get();
                                n = stream.get();
                            }
                        }
                    }
                    stream.putback();
                    stream.putback();
                }
                term.palette = {}
                if (term.mode === 0 || term.mode === 1) {
                    for (let i = 0; i < 16; i++) {
                        term.palette[i] = {}
                        term.palette[i].r = stream.get();
                        term.palette[i].g = stream.get();
                        term.palette[i].b = stream.get();
                    }
                } else if (term.mode === 2) {
                    for (let i = 0; i < 256; i++) {
                        term.palette[i] = {}
                        term.palette[i].r = stream.get();
                        term.palette[i].g = stream.get();
                        term.palette[i].b = stream.get();
                    }
                }
            } else if (type === 4) {
                const type2 = stream.get();
                if (type2 === 2) {
                    if (this.process_connection.connected) {
                        this.sendRaw("\n", "utf8");
                        this.process_connection.disconnect();
                    } else {
                        this.process_connection.kill(SIGINT);
                        //vscode.window.showWarningMessage("The CraftOS-PC worker process did not close correctly. Some changes may not have been saved.")
                    }
                    closeWindow(this.id);
                    return;
                } else if (type2 === 1) {
                    if (windows[id].panel !== undefined) windows[id].panel.dispose();
                    delete windows[id];
                    computer_provider._onDidChangeTreeData.fire(null);
                    monitor_provider._onDidChangeTreeData.fire(null);
                    if (vslsServer !== null) vslsServer.notify("windows", windows);
                    chunk = chunk.subarray(size + 16);
                    while (String.fromCharCode(chunk[0]).match(/\s/)) chunk = chunk.subarray(1);
                    continue;
                } else if (type2 === 0) {
                    winid = stream.get();
                    term.width = stream.readUInt16();
                    term.height = stream.readUInt16();
                    term.title = "";
                    for (let c = stream.get(); c !== 0; c = stream.get()) term.title += String.fromCharCode(c);
                    if (windows[id] !== undefined) {
                        windows[id].isMonitor = typeof term.title === "string" && term.title.indexOf("Monitor") !== -1;
                        if (winid > 0) {
                            windows[id].computerID = winid - 1;
                            windows[id].isMonitor = false;
                        } else if (typeof term.title === "string" && term.title.match(/Computer \d+$/)) {
                            windows[id].computerID = parseInt(term.title.match(/Computer (\d+)$/)[1]);
                        }
                    }
                }
            } else if (type === 5) {
                const flags = stream.readUInt32();
                let title = "";
                for (let c = stream.get(); c !== 0; c = stream.get()) title += String.fromCharCode(c);
                let message = "";
                for (let c = stream.get(); c !== 0; c = stream.get()) message += String.fromCharCode(c);
                switch (flags) {
                    case 0x10: vscode.window.showErrorMessage("CraftOS-PC: " + title + ": " + message); break;
                    case 0x20: vscode.window.showWarningMessage("CraftOS-PC: " + title + ": " + message); break;
                    case 0x40: vscode.window.showInformationMessage("CraftOS-PC: " + title + ": " + message); break;
                }
            } else if (type === 6) {
                const flags = stream.readUInt16();
                this.isVersion11 = true;
                this.useBinaryChecksum = (flags & 1) === 1;
                this.supportsFilesystem = (flags & 2) === 2;
                computer_provider._onDidChangeTreeData.fire(null);
                if (vslsServer !== null) vslsServer.notify("flags", {isVersion11: this.isVersion11, useBinaryChecksum: this.useBinaryChecksum, supportsFilesystem: false});
            } else if (type === 8) {
                const reqtype = stream.get();
                const reqid = stream.get();
                if (!this.dataRequestCallbacks[reqid]) {
                    log.appendLine("Got stray response for request ID " + reqid + ", ignoring.");
                    chunk = chunk.subarray(size + 16);
                    while (String.fromCharCode(chunk[0]).match(/\s/)) chunk = chunk.subarray(1);
                    continue;
                }
                switch (reqtype) {
                    case 0: case 1: case 2: {
                        const ok = stream.get();
                        if (ok === 0) this.dataRequestCallbacks[reqid](false);
                        else if (ok === 1) this.dataRequestCallbacks[reqid](true);
                        else this.dataRequestCallbacks[reqid](null, new Error("Operation failed"));
                        break;
                    } case 3: case 5: case 6: {
                        const size = stream.readUInt32();
                        if (size === 0xFFFFFFFF) this.dataRequestCallbacks[reqid](null, new Error("Operation failed"));
                        else this.dataRequestCallbacks[reqid](size);
                        break;
                    } case 4: {
                        let str = "";
                        for (let c = stream.get(); c !== 0; c = stream.get()) str += String.fromCharCode(c);
                        if (str !== "") this.dataRequestCallbacks[reqid](str);
                        else this.dataRequestCallbacks[reqid](null, new Error("Operation failed"));
                        break;
                    } case 7: case 9: {
                        const size = stream.readUInt32();
                        if (size === 0xFFFFFFFF) this.dataRequestCallbacks[reqid](null, new Error("Operation failed"));
                        else {
                            let arr = [];
                            for (let i = 0; i < size; i++) {
                                arr[i] = "";
                                for (let c = stream.get(); c !== 0; c = stream.get()) arr[i] += String.fromCharCode(c);
                            }
                            this.dataRequestCallbacks[reqid](arr);
                        }
                        break;
                    } case 8: {
                        let attr = {};
                        attr.size = stream.readUInt32();
                        attr.created = new Date(stream.readUInt64());
                        attr.modified = new Date(stream.readUInt64());
                        attr.isDir = stream.get() !== 0;
                        attr.isReadOnly = stream.get() !== 0;
                        const ok = stream.get();
                        if (ok === 0) this.dataRequestCallbacks[reqid](attr);
                        else if (ok === 1) this.dataRequestCallbacks[reqid](null);
                        else this.dataRequestCallbacks[reqid](null, new Error("Operation failed"));
                        break;
                    } case 10: case 11: case 12: case 13:
                    case 16: case 17: case 18: case 19:
                    case 20: case 21: case 22: case 23: {
                        let str = "";
                        for (let c = stream.get(); c !== 0; c = stream.get()) str += String.fromCharCode(c);
                        if (str === "") this.dataRequestCallbacks[reqid]();
                        else this.dataRequestCallbacks[reqid](null, new Error(str));
                        break;
                    }
                }
                delete this.dataRequestCallbacks[reqid];
            } else if (type === 9) {
                const fail = stream.get();
                const reqid = stream.get();
                const size = stream.readUInt32();
                if (!this.dataRequestCallbacks[reqid]) {
                    log.appendLine("Got stray data response for request ID " + reqid + ", ignoring.");
                    chunk = chunk.subarray(size + 16);
                    while (String.fromCharCode(chunk[0]).match(/\s/)) chunk = chunk.subarray(1);
                    continue;
                }
                const data = Buffer.alloc(size);
                stream.str.copy(data, 0, stream.pos);
                if (fail) this.dataRequestCallbacks[reqid](null, new Error(data.toString()));
                else this.dataRequestCallbacks[reqid](data);
                delete this.dataRequestCallbacks[reqid];
            }
            let newWindow = false;
            if (windows[id] === undefined) {windows[id] = {}; newWindow = true;}
            if (windows[id].term === undefined) windows[id].term = {};
            for (let k in term) windows[id].term[k] = term[k];
            if (windows[id].isMonitor === undefined) {
                windows[id].isMonitor = typeof windows[id].term.title === "string" && windows[id].term.title.indexOf("Monitor") !== -1;
                if (winid !== null && winid > 0) {
                    windows[id].computerID = winid - 1;
                    windows[id].isMonitor = false;
                } else if (typeof windows[id].term.title === "string" && windows[id].term.title.match(/Computer \d+$/)) {
                    windows[id].computerID = parseInt(windows[id].term.title.match(/Computer (\d+)$/)[1]);
                }
            }
            if (windows[id].panel !== undefined) {
                windows[id].panel.webview.postMessage(windows[id].term);
                windows[id].panel.title = windows[id].term.title || "CraftOS-PC Terminal";
            }
            if (vslsServer !== null) {
                if (newWindow) vslsServer.notify("windows", windows);
                else vslsServer.notify("term", {id: id, term: windows[id].term, refresh: type === 4});
            }
            if (type === 4) {
                computer_provider._onDidChangeTreeData.fire(null);
                monitor_provider._onDidChangeTreeData.fire(null);
            }
            chunk = chunk.subarray(size + off + 8);
            while (String.fromCharCode(chunk[0]).match(/\s/)) chunk = chunk.subarray(1);
        }
    }

    sendRaw(packet) {
        this.process_connection.stdin.write(packet, 'utf8');
    }
}

function checkVersion(silent) {
    const exe_path = getSetting("craftos-pc.executablePath");
    if (exe_path === null) return;
    child_process.execFile(exe_path, ["--version"], {windowsHide: true}, (err, stdout, stderr) => {
        if (err) {
            if (!silent) vscode.window.showErrorMessage("Failed to detect CraftOS-PC version (error: " + err.message + "). Please check that the path is correct and working properly.");
            return;
        }
        let version = (stdout.match(/CraftOS-PC v([\d\.]+)/) || [])[1];
        if (version === undefined || version === null) {
            if (!silent) vscode.window.showErrorMessage("Failed to detect CraftOS-PC version (error: no version number detected)." + (os.platform === "win32" ? "Make sure the path is pointing to CraftOS-PC_console.exe, and not CraftOS-PC.exe." : ""));
            return;
        }
        log.appendLine("Detected CraftOS-PC " + version);
        version = semver.coerce(version);
        processFeatures.debugger = semver.gt(version, "2.6.6");
        processFeatures.filesystem = semver.gte(version, "2.6.0");
        if (!silent) {
            if (version == "2.5.4" || version == "2.5.5") vscode.window.showWarningMessage("This version of CraftOS-PC crashes when using multiple windows. Update to a newer version to fix this.");
            else if (version == "2.5.1") vscode.window.showWarningMessage("This version of CraftOS-PC often crashes when using the extension. Update to a newer version to fix this.");
            else if (semver.lt(version, "2.4.0")) vscode.window.showWarningMessage("This version of CraftOS-PC does not support using multiple windows properly. Update to a newer version to fix this.");
        }
    });
}

/**
 * @implements {vscode.FileSystemProvider}
 */
class RawFileSystemProvider {
    constructor() {
        this._onDidChangeFile = new vscode.EventEmitter()
        this.onDidChangeFile = this._onDidChangeFile.event
    }

    getConnection(authority) {
        const id = parseInt(authority)
        if (!connections.has(id)) throw vscode.FileSystemError.Unavailable("Computer connection not open yet");
        const connection = connections.get(id);
        if (!connection.supportsFilesystem) throw vscode.FileSystemError.Unavailable("Connected computer doesn't support filesystems");
        return connection;
    }

    /**
     * @param {vscode.Uri} source
     * @param {vscode.Uri} destination
     * @param {{overwrite: boolean}} options
     */
    copy(source, destination, options) {
        if (source.authority !== destination.authority) throw vscode.FileSystemError.Unavailable("Cannot move across computers");
        const connection = this.getConnection(source.authority);
        return connection.queueDataRequest(12, source.path, destination.path);
    }
    /**
     * @param {vscode.Uri} uri 
     */
    createDirectory(uri) {
        const connection = this.getConnection(uri.authority);
        return connection.queueDataRequest(10, uri.path);
    }
    /**
     * @param {vscode.Uri} uri 
     * @param {{recursive: boolean}} options
     */
    delete(uri, options) {
        // Warning: ignores options.recursive (always true)
        const connection = this.getConnection(uri.authority);
        return connection.queueDataRequest(11, uri.path);
    }
    /**
     * @param {vscode.Uri} uri 
     */
    readDirectory(uri) {
        const connection = this.getConnection(uri.authority);
        return new Promise(resolve => {
            connection.queueDataRequest(7, uri.path).then(files => {
                let arr = [];
                let promises = [];
                for (let f of files) {
                    promises.push(new Promise(resolve => connection.queueDataRequest(1, path.join(uri.path, f)).then(isDir => {
                        arr.push([f, isDir ? vscode.FileType.Directory : vscode.FileType.File]);
                        resolve();
                    }).catch(() => {
                        arr.push([f, vscode.FileType.Unknown]);
                        resolve();
                    })));
                }
                return Promise.all(promises).then(() => {
                    arr.sort((a, b) => {
                        if (a[1] == vscode.FileType.File && b[1] == vscode.FileType.Directory) return 1;
                        else if (b[1] == vscode.FileType.File && a[1] == vscode.FileType.Directory) return -1;
                        else return a[0].localeCompare(b[0]);
                    });
                    resolve(arr);
                });
            });
        });
    }
    /**
     * @param {vscode.Uri} uri 
     */
    readFile(uri) {
        const connection = this.getConnection(uri.authority);
        return connection.queueDataRequest(20, uri.path).then(data => Uint8Array.from(data));
    }
    /**
     * @param {vscode.Uri} oldUri 
     * @param {vscode.Uri} newUri 
     * @param {{overwrite: boolean}} options 
     */
    rename(oldUri, newUri, options) {
        // Warning: ignores overwrite (always false)
        if (oldUri.authority !== newUri.authority) throw vscode.FileSystemError.Unavailable("Cannot move across computers");
        const connection = this.getConnection(oldUri.authority);
        return connection.queueDataRequest(13, oldUri.path, newUri.path);
    }
    /**
     * @param {vscode.Uri} uri 
     */
    stat(uri) {
        const connection = this.getConnection(uri.authority);
        return connection.queueDataRequest(8, uri.path).then(attributes => {
            if (attributes === null) throw vscode.FileSystemError.FileNotFound(uri);
            return {
                ctime: attributes.created.getTime(),
                mtime: attributes.modified.getTime(),
                size: attributes.size,
                type: attributes.isDir ? vscode.FileType.Directory : vscode.FileType.File
            }
        });
    }
    /**
     * @param {vscode.Uri} uri 
     * @param {{excludes: string[], recursive: boolean}} options
     */
    watch(uri, options) {
        // unimplemented
        const connection = this.getConnection(uri.authority);
        return null;
    }
    /**
     * @param {vscode.Uri} uri 
     * @param {Uint8Array} content
     * @param {{create: boolean, overwrite: boolean}} options
     */
    writeFile(uri, content, options) {
        const connection = this.getConnection(uri.authority);
        return connection.queueDataRequest(21, uri.path, content);
    }
}

const debugAdapterFactory = {
    /**
     * @param {vscode.DebugSession} session
     */
    createDebugAdapterDescriptor: (session, executable) => {
        if (session.configuration.request === "launch") {
            if (!processFeatures.debugger) {
                vscode.window.showErrorMessage("This version of CraftOS-PC does not support debugging. Please update to the latest version.");
                return null;
            }
            const exe_path = getSetting("craftos-pc.executablePath");
            if (exe_path === null) {
                vscode.window.showErrorMessage("Please set the path to the CraftOS-PC executable in the settings.");
                return null;
            }
            if (!fs.existsSync(exe_path)) {
                vscode.window.showErrorMessage("The CraftOS-PC executable could not be found. Check the path in the settings." + (os.platform() === "win32" ? " If you installed CraftOS-PC without administrator privileges, you will need to set the path manually. Also make sure CraftOS-PC_console.exe exists in the install directory - if not, reinstall CraftOS-PC with the Console build component enabled." : ""));
                return null;
            }
            const dir = vscode.workspace.getConfiguration("craftos-pc").get("dataPath");
            let args = vscode.workspace.getConfiguration("craftos-pc").get("additionalArguments");
            if (args !== null) {args = args.split(' '); args.push("--exec"); args.push("periphemu.create(0,'debug_adapter')")}
            else args = ["--exec", "periphemu.create(0,'debug_adapter')"];
            if (dir !== null) args.splice(0, 0, "-d", dir);
            return new vscode.DebugAdapterExecutable(exe_path, args);
        } else if (session.configuration.request === "attach") {
            return new vscode.DebugAdapterServer(session.configuration.port || 12100, session.configuration.host);
        } else return undefined;
    }
}

let nextConnection = 0;
function connectToProcess(extra_args) {
    const id = nextConnection++;
    let minId = 0;
    for (const connection of connections.values()) {
        if (!connection.isRemote && windows[connection.id]) {
            minId = Math.max(minId, (windows[connection.id].computerID || 0) + 1);
        }
    }
    const connection = new Connection(id);
    connections.set(id, connection);
    if (minId > 0) {
        extra_args = extra_args || [];
        extra_args.push('--id');
        extra_args.push(minId);
    }
    connection.connectToProcess(extra_args);
    vscode.commands.executeCommand('setContext', 'craftos.computerCount', id + 1);
    return connection;
}

function connectToWebSocket(url) {
    const id = nextConnection++;
    const connection = new Connection(id);
    connections.set(id, connection);
    connection.connectToWebSocket(url);
    vscode.commands.executeCommand('setContext', 'craftos.computerCount', id + 1);
    return connection;
}

function openPanel(id, force) {
    if (!force && (extcontext === null || windows[id] === undefined)) return;
    if (windows[id] !== undefined && windows[id].panel !== undefined) {
        windows[id].panel.reveal();
        return;
    }
    const customFont = vscode.workspace.getConfiguration("craftos-pc.customFont");
    let fontPath = customFont.get("path");
    if (fontPath === "hdfont") {
        const execPath = getSetting("craftos-pc.executablePath");
        if (os.platform() === "win32") fontPath = execPath.replace(/[\/\\][^\/\\]+$/, "/") + "hdfont.bmp";
        else if (os.platform() === "darwin" && execPath.indexOf("MacOS/craftos") !== -1) fontPath = execPath.replace(/MacOS\/[^\/]+$/, "") + "Resources/hdfont.bmp";
        else if (os.platform() === "darwin" || (os.platform() === "linux" && !fs.existsSync("/usr/share/craftos/hdfont.bmp"))) fontPath = "/usr/local/share/craftos/hdfont.bmp";
        else if (os.platform() === "linux") fontPath = "/usr/share/craftos/hdfont.bmp";
        if (!fs.existsSync(fontPath)) {
            vscode.window.showWarningMessage("The path to the HD font could not be found; the default font will be used instead. Please set the path to the HD font manually.");
            fontPath = null;
        }
    }
    const panel = vscode.window.createWebviewPanel(
        'craftos-pc',
        'CraftOS-PC Terminal',
        vscode.window.activeTextEditor && vscode.window.activeTextEditor.viewColumn || vscode.ViewColumn.One,
        {
            enableScripts: true,
            retainContextWhenHidden: true,
            localResourceRoots: (fontPath !== null && fontPath !== "") ? [vscode.Uri.file(fontPath.replace(/[\/\\][^\/\\]*$/, ""))] : null
        }
    );
    extcontext.subscriptions.push(panel);
    // Get path to resource on disk
    const onDiskPath = vscode.Uri.file(path.join(extcontext.extensionPath, 'index.html'));
    panel.iconPath = windows[id] && windows[id].isMonitor ? vscode.Uri.file(path.join(extcontext.extensionPath, 'media/monitor.svg')) : vscode.Uri.file(path.join(extcontext.extensionPath, 'media/computer.svg'));
    panel.webview.html = fs.readFileSync(onDiskPath.fsPath, 'utf8');
    panel.webview.onDidReceiveMessage(message => {
        if (typeof message !== "object") return;
        const connection = connections.get(id);
        if (!connection || !connection.process_connection) return;
        if (message.getFontPath === true) {
            if (fontPath !== null && fontPath !== "") panel.webview.postMessage({fontPath: panel.webview.asWebviewUri(vscode.Uri.file(fontPath)).toString()});
            return;
        }
        const data = Buffer.alloc(message.data.length / 2 + 2);
        data[0] = message.type;
        data[1] = 0;
        Buffer.from(message.data, 'hex').copy(data, 2)
        const b64 = data.toString('base64');
        const packet = "!CPC" + ("000" + b64.length.toString(16)).slice(-4) + b64 + ("0000000" + crc32(connection.useBinaryChecksum ? data.toString("binary") : b64).toString(16)).slice(-8) + "\n";
        connection.sendRaw(packet, 'utf8');
    });
    panel.onDidChangeViewState(e => {
        if (e.webviewPanel.active && windows[id].term !== undefined) {
            e.webviewPanel.webview.postMessage(windows[id].term);
            e.webviewPanel.title = windows[id].term.title || "CraftOS-PC Terminal";
        }
    });
    panel.onDidDispose(() => {if (windows[id].panel !== undefined) delete windows[id].panel;});
    let newWindow = false;
    if (windows[id] === undefined) {windows[id] = {}; newWindow = true;}
    windows[id].panel = panel;
    if (windows[id].term !== undefined) {
        windows[id].panel.webview.postMessage(windows[id].term);
        windows[id].panel.title = windows[id].term.title || "CraftOS-PC Terminal";
    }
    if (newWindow && vslsServer !== null) vslsServer.notify("windows", windows);
}

/**
 * @param {vscode.ExtensionContext} context
 */
function activate(context) {

    log.appendLine("The CraftOS-PC extension is now active.");

    extcontext = context;

    context.subscriptions.push(vscode.commands.registerCommand('craftos-pc.open', () => {
        return connectToProcess();
    }));

    context.subscriptions.push(vscode.commands.registerCommand('craftos-pc.open-websocket', obj => {
        if (typeof obj === "string") return connectToWebSocket(obj);
        let wsHistory = context.globalState.get("JackMacWindows.craftos-pc/websocket-history", [""]);
        let quickPick = vscode.window.createQuickPick();
        quickPick.items = wsHistory.map(val => {return {label: val}});
        quickPick.title = "Enter the WebSocket URL:";
        quickPick.placeholder = "wss://";
        quickPick.canSelectMany = false;
        quickPick.onDidChangeValue(() => {
            wsHistory[0] = quickPick.value;
            quickPick.items = wsHistory.map(val => {return {label: val}});
        });
        quickPick.onDidAccept(() => {
            let str = quickPick.selectedItems[0].label;
            if (!validateURL(str)) vscode.window.showErrorMessage("The URL you entered is not valid.");
            else {
                wsHistory[0] = str;
                if (wsHistory.slice(1).includes(str))
                    wsHistory.splice(wsHistory.slice(1).indexOf(str)+1, 1);
                wsHistory.unshift("");
                context.globalState.update("JackMacWindows.craftos-pc/websocket-history", wsHistory);
                connectToWebSocket(str);
            }
        });
        quickPick.show();
    }));

    context.subscriptions.push(vscode.commands.registerCommand('craftos-pc.clear-history', () => {
        context.globalState.update("JackMacWindows.craftos-pc/websocket-history", [""]);
    }));

    context.subscriptions.push(vscode.commands.registerCommand('craftos-pc.open-new-remote', () => {
        if (!didShowBetaMessage) {
            vscode.window.showWarningMessage("remote.craftos-pc.cc is currently in beta. Be aware that things may not work as expected. If you run into issues, please report them [on GitHub](https://github.com/MCJack123/remote.craftos-pc.cc/issues). If things break, use Shift+Ctrl+P (Shift+Cmd+P on Mac), then type 'reload window' and press Enter.");
            didShowBetaMessage = true;
        }
        https.get("https://remote.craftos-pc.cc/new", res => {
            if (Math.floor(res.statusCode / 100) !== 2) {
                vscode.window.showErrorMessage("Could not connect to remote.craftos-pc.cc: HTTP " + res.statusCode);
                res.resume();
                return;
            }
            res.setEncoding('utf8');
            let id = "";
            res.on('data', chunk => id += chunk);
            res.on('end', () => {
                vscode.env.clipboard.writeText("wget run https://remote.craftos-pc.cc/server.lua " + id);
                vscode.window.showInformationMessage("A command has been copied to the clipboard. Paste that into the ComputerCraft computer to establish the connection.");
                connectToWebSocket("wss://remote.craftos-pc.cc/" + id);
            });
        }).on('error', e => {
            if (e.message.match("certificate has expired"))
                vscode.window.showErrorMessage("A bug in VS Code is causing the connection to fail. Please go to https://www.craftos-pc.cc/docs/remote#certificate-has-expired-error to fix it.", "Open Page", "OK").then(res => {
                    if (res === "OK") return;
                    vscode.env.openExternal(vscode.Uri.parse("https://www.craftos-pc.cc/docs/remote#certificate-has-expired-error"));
                });
            else vscode.window.showErrorMessage("Could not connect to remote.craftos-pc.cc: " + e.message);
        });
    }));

    context.subscriptions.push(vscode.commands.registerCommand('craftos-pc.open-window', obj => {
        if (typeof obj === "object") openPanel(parseInt(obj.id));
        else vscode.window.showInputBox({prompt: "Enter the window ID:", validateInput: str => isNaN(parseInt(str)) ? "Invalid number" : null}).then(id => openPanel(parseInt(id)));
    }));

    context.subscriptions.push(vscode.commands.registerCommand('craftos-pc.open-config', () => {
        if (getDataPath() === null) {
            vscode.window.showErrorMessage("Please set the path to the CraftOS-PC data directory manually.");
            return;
        }
        vscode.commands.executeCommand("vscode.open", vscode.Uri.file(getDataPath() + "/config/global.json"));
    }));

    context.subscriptions.push(vscode.commands.registerCommand('craftos-pc.open-computer-data', obj => {
        if (getDataPath() === null) {
            vscode.window.showErrorMessage("Please set the path to the CraftOS-PC data directory manually.");
            return;
        }
        if (typeof obj === "object") {
            vscode.commands.executeCommand("vscode.openFolder", vscode.Uri.file(getDataPath() + "/computer/" + windows[parseInt(obj.id)].computerID), {forceNewWindow: true});
        } else {
            vscode.window.showInputBox({prompt: "Enter the computer ID:", validateInput: str => isNaN(parseInt(str)) ? "Invalid number" : null}).then(value => {
                if (!fs.existsSync(getDataPath() + "/computer/" + value)) vscode.window.showErrorMessage("The computer ID provided does not exist.");
                else vscode.commands.executeCommand("vscode.openFolder", vscode.Uri.file(getDataPath() + "/computer/" + value));
            });
        }
    }));

    context.subscriptions.push(vscode.commands.registerCommand('craftos-pc.open-remote-data', async obj => {
        if (typeof obj !== "object") {
            const value = parseInt(await vscode.window.showInputBox({prompt: "Enter the window ID:", validateInput: str => isNaN(parseInt(str)) ? "Invalid number" : null}));
            if (typeof windows[value] !== "object") {
                vscode.window.showErrorMessage("The window ID provided does not exist.");
                return;
            }
            obj = windows[value];
        }
        const connection = connections.get(parseInt(obj.id));
        if (!connection || !connection.process_connection) {
            vscode.window.showErrorMessage("Please open CraftOS-PC before using this command.");
            return;
        }
        if (!connection.supportsFilesystem) {
            vscode.window.showErrorMessage("This connection does not support file system access.");
            return;
        }
        if (!vscode.workspace.workspaceFile) {
            const opt = await vscode.window.showWarningMessage(
                "Due to technical limitations, opening the computer data will cause the connection to close. Please restart the connection after running this. Are you sure you want to continue?",
                "No", "Yes"
            );
            if (opt === "No") return;
            closeAllWindows();
        }
        vscode.workspace.updateWorkspaceFolders(vscode.workspace.workspaceFolders ? vscode.workspace.workspaceFolders.length : 0, null, {name: obj.title.replace(/^.*: */, ""), uri: vscode.Uri.parse(`craftos-pc://${obj.id}/`)});
        vscode.window.showInformationMessage("Added remote folder to workspace.");
    }));

    context.subscriptions.push(vscode.commands.registerCommand('craftos-pc.close', () => {
        for (const connection of connections.values()) {
            if (connection.process_connection) {
                connection.sendRaw(connection.useBinaryChecksum ? "!CPC000CBAACAAAAAAAA2C7A548B\n" : "!CPC000CBAACAAAAAAAA3AB9B910\n", "utf8");
            }
        }
    }));

    context.subscriptions.push(vscode.commands.registerCommand("craftos-pc.close-window", async obj => {
        const id = parseInt(
            typeof obj === "object"
            ? obj.id
            : await vscode.window.showInputBox({prompt: "Enter the window ID:", validateInput: str => isNaN(parseInt(str)) ? "Invalid number" : null})
        );
        const connection = connections.get(id);
        if (!connection) {
            vscode.window.showErrorMessage("Please open CraftOS-PC before using this command.");
            return;
        }
        const data = Buffer.alloc(9);
        data.fill(0);
        data[0] = 4;
        data[1] = 0;
        data[2] = 1;
        const b64 = data.toString("base64");
        connection.sendRaw("!CPC000C" + b64 + ("0000000" + crc32(connection.useBinaryChecksum ? data.toString("binary") : b64).toString(16)).slice(-8) + "\n\n", "utf8");
    }));

    context.subscriptions.push(vscode.commands.registerCommand("craftos-pc.kill", async obj => {
        const id = parseInt(
            typeof obj === "object"
            ? obj.id
            : await vscode.window.showInputBox({prompt: "Enter the window ID:", validateInput: str => isNaN(parseInt(str)) ? "Invalid number" : null})
        );
        const connection = connections.get(id);
        if (!connection) {
            vscode.window.showErrorMessage("Please open CraftOS-PC before using this command.");
            return;
        }
        if (connection.process_connection && connection.process_connection.kill) {
            connection.sendRaw(connection.useBinaryChecksum ? "!CPC000CBAACAAAAAAAA2C7A548B\n" : "!CPC000CBAACAAAAAAAA3AB9B910\n", "utf8");
            connection.process_connection.kill(SIGINT);
            connections.delete(id);
        }
    }));

    context.subscriptions.push(vscode.commands.registerCommand("craftos-pc.run-file", path => {
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
    }));

    context.subscriptions.push(vscode.workspace.registerFileSystemProvider("craftos-pc", new RawFileSystemProvider()));
    context.subscriptions.push(vscode.window.registerUriHandler({handleUri: uri => {
        vscode.commands.executeCommand("craftos-pc.open-websocket", uri.path.replace(/^\//, ""));
    }}));

    context.subscriptions.push(vscode.debug.registerDebugAdapterDescriptorFactory("craftos-pc", debugAdapterFactory));
    
    log = vscode.window.createOutputChannel("CraftOS-PC");

    let change_timer = null;
    vscode.workspace.onDidChangeConfiguration(event => {
        if (event.affectsConfiguration("craftos-pc.executablePath")) {
            // Use a timer to debounce quick autosaves
            if (change_timer !== null) clearTimeout(change_timer);
            change_timer = setTimeout(() => {change_timer = null; checkVersion(false);}, 3000);
        }
    });

    vscode.window.createTreeView("craftos-computers", {"treeDataProvider": computer_provider});
    vscode.window.createTreeView("craftos-monitors", {"treeDataProvider": monitor_provider});
    vscode.window.createTreeView("craftos-files", {"treeDataProvider": files_provider, dragAndDropController: files_provider, canSelectMany: true, showCollapseAll: true});

    vsls.getApi(context.extension.id).then(api => {
        if (api === null) return;
        liveshare = api;
        const updateSession = () => {
            if (liveshare.session.role === vsls.Role.Host && vslsServer === null) {
                if (vslsClient !== null && /*TODO*/ process_connection === null) {
                    windows = {};
                    computer_provider._onDidChangeTreeData.fire(null);
                    monitor_provider._onDidChangeTreeData.fire(null);
                    vslsClient = null;
                }
                liveshare.shareService("terminal").then(svc => {
                    vslsServer = svc;
                    vslsServer.onNotify("packet", data => {
                        // TODO: Add actual access control (MicrosoftDocs/live-share#1716)
                        const peer = liveshare.peers.find(a => a.peerNumber == data.peer);
                        if (/*TODO*/ process_connection !== null && (peer.access === vsls.Access.ReadWrite || peer.access === vsls.Access.Owner)) /*TODO*/ process_connection.stdin.write(data.data, "utf8");
                    });
                    vslsServer.onNotify("get-windows", () => {
                        vslsServer.notify("windows", windows);
                        vslsServer.notify("flags", {/*TODO*/ isVersion11: /*TODO*/ isVersion11, /*TODO*/ useBinaryChecksum: /*TODO*/ useBinaryChecksum, /*TODO*/ supportsFilesystem: false});
                    });
                }).catch(err => vscode.window.showErrorMessage("Could not create Live Share service: " + err));
            } else if (liveshare.session.role === vsls.Role.Guest && vslsClient === null) {
                vslsServer = null;
                liveshare.getSharedService("terminal").then(svc => {
                    vslsClient = svc;
                    vslsClient.onNotify("windows", param => {
                        let newwindows = {};
                        for (let id in param) newwindows[id] = {term: param[id].term, isMonitor: param[id].isMonitor, panel: windows[id] ? windows[id].panel : undefined};
                        for (let id in windows) if (!newwindows[id] && windows[id].panel) windows[id].panel.dispose();
                        windows = newwindows;
                        computer_provider._onDidChangeTreeData.fire(null);
                        monitor_provider._onDidChangeTreeData.fire(null);
                    });
                    vslsClient.onNotify("term", param => {
                        windows[param.id].term = param.term
                        if (windows[param.id].panel) {
                            windows[param.id].panel.webview.postMessage(param.term);
                            windows[param.id].panel.title = param.term.title || "CraftOS-PC Terminal";
                        }
                        if (param.refresh) {
                            computer_provider._onDidChangeTreeData.fire(null);
                            monitor_provider._onDidChangeTreeData.fire(null);
                        }
                    });
                    vslsClient.onNotify("flags", param => {
                        /*TODO*/ isVersion11 = param./*TODO*/ isVersion11;
                        /*TODO*/ useBinaryChecksum = param./*TODO*/ useBinaryChecksum;
                        /*TODO*/ supportsFilesystem = param./*TODO*/ supportsFilesystem;
                    });
                    /*TODO*/ process_connection = {
                        connected: true,
                        disconnect: () => {},
                        kill: () => {},
                        stdin: {write: data => {
                            if (liveshare.session.access === vsls.Access.ReadWrite || liveshare.session.access === vsls.Access.Owner) vslsClient.notify("packet", {data: data, peer: liveshare.session.peerNumber});
                        }}
                    };
                    vslsClient.notify("get-windows", {});
                }).catch(err => vscode.window.showErrorMessage("Could not connect to Live Share service: " + err));
            } else if (liveshare.session.role === vsls.Role.None) {
                if (vslsClient !== null && /*TODO*/ process_connection !== null && /*TODO*/ process_connection.isLiveShare) {
                    windows = {};
                    computer_provider._onDidChangeTreeData.fire(null);
                    monitor_provider._onDidChangeTreeData.fire(null);
                    vslsClient = null;
                    /*TODO*/ process_connection = null;
                }
                vslsServer = null;
            }
        };
        liveshare.onDidChangeSession(updateSession);
        liveshare.onDidChangePeers(() => {
            if (vslsServer !== null) vslsServer.notify("windows", windows);
        });
        if (liveshare.session.role !== vsls.Role.None) updateSession();
    });

    checkVersion(true);
}
exports.activate = activate;

// this method is called when your extension is deactivated
function deactivate() {
    for (const connection of connections.values()) {
        if (connection.process_connection) {
            if (connection.isRemote) {
                connection.sendRaw(connection.useBinaryChecksum ? "!CPC000CBAACAAAAAAAA2C7A548B\n" : "!CPC000CBAACAAAAAAAA3AB9B910\n", "utf8");
                connection.process_connection.disconnect();
            } else {
                connection.process_connection.kill(SIGINT);
            }
        }
    }
    closeAllWindows();
}

module.exports = {
    activate,
    deactivate
}
