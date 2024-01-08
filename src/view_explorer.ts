import {
	TreeItem,
	TreeItemCollapsibleState,
	ThemeIcon,
	Uri,
	EventEmitter,
	TreeDataProvider,
	CancellationToken,
	Event,
	ProviderResult,
	TreeDragAndDropController,
	DataTransfer,
	workspace,
	FileType,
} from "vscode";
import { ext } from "./globals";
import { CraftPacketFileRequest, CraftPacketFileResponse, FileRequestType } from "./packet";
import { join, dirname, basename } from "path";
import { CraftConnection } from "./connection";

interface FileRef {
	connection: string;
	path: string;

	title: string;
}

class CraftFile extends TreeItem {
	constructor(
		public readonly connection: string,
		public label: string,
		public path: string,
		public isFolder: boolean
	) {
		super(label, isFolder ? TreeItemCollapsibleState.Collapsed : TreeItemCollapsibleState.None);
		this.tooltip = `${connection}:${path}`;

		if (path === "/") {
			this.iconPath = Uri.file(join(ext.context.extensionPath, "media/computer.svg"));
			this.contextValue = "computer";
		} else {
			this.iconPath = isFolder ? ThemeIcon.Folder : ThemeIcon.File;
			this.contextValue = isFolder ? "folder" : "file";
		}
		this.resourceUri = Uri.parse("craftos-pc://remote" + path);
		this.id = `${connection}:${path}`;
	}

	async getChildren(): Promise<CraftFile[]> {
		const connection = ext.connections?.get(this.connection);
		if (!this.isFolder || !connection) return [];
		const listPacket = await connection.queueDataRequest(
			CraftPacketFileRequest.new({
				type2: FileRequestType.LIST,
				path: this.path,
			})
		);
		if (!(listPacket instanceof CraftPacketFileResponse)) return [];
		if (listPacket.isError) {
			return [];
		}
		return Promise.all(
			listPacket.listResult!.map(async (name) => {
				const filePath = join(this.path, name);
				const boolPacket = await connection.queueDataRequest(
					CraftPacketFileRequest.new({
						type2: FileRequestType.IS_DIR,
						path: filePath,
					})
				);
				if (!(boolPacket instanceof CraftPacketFileResponse) || boolPacket.isError) return;
				return new CraftFile(this.connection, name, filePath, boolPacket.booleanResult!);
			})
		).then((list) =>
			list
				.filter((file) => file)
				.sort((a, b) => {
					if (a.isFolder !== b.isFolder) return a.isFolder ? -1 : 1;
					return a.label < b.label ? -1 : 1;
				})
		) as Promise<CraftFile[]>;
	}
}

interface FileData {
	name: string;
	contents: Buffer | FileData[];
}

async function addFileData(target: FileData[], uri: Uri, token: CancellationToken, fileType?: FileType) {
	if (!fileType) {
		const stat = await workspace.fs.stat(uri);
		fileType = stat.type;
	}
	let contents: Buffer | FileData[];
	switch (fileType) {
		case FileType.Directory:
			contents = [];
			for (const [name, type] of await workspace.fs.readDirectory(uri)) {
				await addFileData(contents, Uri.joinPath(uri, name), token, type);
				if (token.isCancellationRequested) return;
			}
			break;
		case FileType.File:
			contents = Buffer.from(await workspace.fs.readFile(uri));
			break;
		default:
			return;
	}
	target.push({
		name: basename(uri.path),
		contents,
	});
}

async function sendFiles(source: FileData[], connection: CraftConnection, path: string, token: CancellationToken) {
	for (const { name, contents } of source) {
		if (Array.isArray(contents)) {
			await sendFiles(contents, connection, join(path, name), token);
		} else {
			await connection.queueDataRequest(
				CraftPacketFileRequest.new({
					type2: FileRequestType.OPEN,
					isBinary: true,
					isWrite: true,
					path: join(path, name),
				}),
				contents
			);
		}
		if (token.isCancellationRequested) return;
	}
}

export class FileProvider
	extends EventEmitter<null>
	implements TreeDataProvider<CraftFile>, TreeDragAndDropController<CraftFile>
{
	onDidChangeTreeData = this.event;

	getTreeItem(element: CraftFile): TreeItem | Thenable<TreeItem> {
		return element;
	}
	getChildren(element?: CraftFile | undefined): ProviderResult<CraftFile[]> {
		if (element) return element.getChildren();
		return [...ext.connections!.values()].map(
			(connection) => new CraftFile(connection.id, connection.id, "/", true)
		);
	}
	getParent(element: CraftFile): ProviderResult<CraftFile> {
		if (element.path === "/") return;
		const d = dirname(element.path);
		return new CraftFile(element.connection, basename(d), d, true);
	}

	dragMimeTypes = ["application/vnd.code.tree.craftos-files"];

	dropMimeTypes = ["text/uri-list", "application/vnd.code.tree.craftos-files"];
	async handleDrop(target: CraftFile, dataTransfer: DataTransfer, token: CancellationToken): Promise<void> {
		if (!target) return;
		if (!target.isFolder) target = await this.getParent(target);
		const connection = ext.connections.get(target.connection);
		if (!connection) return;
		let entries = [...dataTransfer];
		const files: FileData[] = [];
		for (const [mimeType, item] of entries) {
			switch (mimeType) {
				case "text/uri-list":
					for (const uriStr of (await item.asString()).split(/\r?\n/)) {
						await addFileData(files, Uri.parse(uriStr.trim()), token);
						if (token.isCancellationRequested) return;
					}
					break;
				case "application/vnd.code.tree.craftos-files":
					console.log("craftos file", item.value);
					break;
			}
		}
		if (token.isCancellationRequested) return;
		await sendFiles(files, connection, target.path, token);
		this.fire(null);
	}
}
