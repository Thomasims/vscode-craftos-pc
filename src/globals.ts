import * as vscode from "vscode";
import { CraftConnection } from "./connection";

export const ext: {
	log?: vscode.OutputChannel;
	context?: vscode.ExtensionContext;
	connections?: Map<string, CraftConnection>;
} = {};

export function FindConnection(globalID: string) {
	const sep = globalID.indexOf("@");
	if (sep !== -1) globalID = globalID.substring(sep + 1);
	return ext.connections.get(globalID);
}

export function FindWindow(globalID: string) {
	const sep = globalID.indexOf("@");
	if (sep === -1) return;
	return ext.connections.get(globalID.substring(sep + 1))?.windows.get(parseInt(globalID.substring(0, sep)));
}
