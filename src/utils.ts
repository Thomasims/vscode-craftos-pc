import * as vscode from "vscode";
import * as os from "os";
import * as fs from "fs";

export function getSetting(name: string): string | null {
	const config = vscode.workspace.getConfiguration(name);
	if (config.get("all") !== null && config.get("all") !== "") return config.get("all");
	else if (os.platform() === "win32")
		return (<string>config.get("windows")).replace(/%([^%]+)%/g, (_, n) => process.env[n] || "%" + n + "%");
	else if (os.platform() === "darwin")
		return (<string>config.get("mac"))
			.replace(/\$(\w+)/g, (_, n) => process.env[n] || "$" + n)
			.replace(/\${([^}]+)}/g, (_, n) => process.env[n] || "${" + n + "}");
	else if (os.platform() === "linux")
		return (<string>config.get("linux"))
			.replace(/\$(\w+)/g, (_, n) => process.env[n] || "$" + n)
			.replace(/\${([^}]+)}/g, (_, n) => process.env[n] || "${" + n + "}");
	else return null;
}

export function getExtensionSetting(name: string): string | null {
	return vscode.workspace.getConfiguration("craftos-pc").get(name);
}

export function getDataPath() {
	const config = vscode.workspace.getConfiguration("craftos-pc");
	if (config.get("dataPath") !== null && config.get("dataPath") !== "") return config.get("dataPath");
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
	else return null;
}

export function getExecutable() {
	let path = getSetting("craftos-pc.executablePath");
	if (path !== null && fs.existsSync(path)) return path;
	if (os.platform() === "win32") {
		path = "%localappdata%\\Programs\\CraftOS-PC\\CraftOS-PC_console.exe".replace(
			/%([^%]+)%/g,
			(_, n) => process.env[n] || "%" + n + "%"
		);
		if (fs.existsSync(path)) return path;
	}
	if (path !== null && os.platform() === "win32" && fs.existsSync(path.replace("_console", ""))) {
		vscode.window.showErrorMessage(
			"The CraftOS-PC installation is missing the console version, which is required for this extension to function. Please run the installer again, making sure to check the 'Console build for raw mode' box."
		);
		return null;
	}
	vscode.window.showErrorMessage(
		"The CraftOS-PC executable could not be found. Check the path in the settings. If you haven't installed CraftOS-PC yet, [download it from the official website.](https://www.craftos-pc.cc)"
	);
	return null;
}

let crcTable = null;

function makeCRCTable() {
	let c;
	let crcTable = [];
	for (let n = 0; n < 256; n++) {
		c = n;
		for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
		crcTable[n] = c;
	}
	return crcTable;
}

export function crc32(str) {
	crcTable = crcTable || makeCRCTable();
	let crc = 0 ^ -1;
	for (let i = 0; i < str.length; i++) {
		crc = (crc >>> 8) ^ crcTable[(crc ^ str.charCodeAt(i)) & 0xff];
	}
	return (crc ^ -1) >>> 0;
}
