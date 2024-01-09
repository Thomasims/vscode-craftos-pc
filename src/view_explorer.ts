import {
	TreeItem,
	TreeItemCollapsibleState,
	ThemeIcon,
	Uri,
	EventEmitter,
	TreeDataProvider,
	CancellationToken,
	ProviderResult,
	TreeDragAndDropController,
	DataTransfer,
	DataTransferItem,
	FileSystemProvider,
	workspace,
	FileType,
	Disposable,
	FileChangeEvent,
	FileStat,
	FileSystemError,
} from "vscode";
import { ext } from "./globals";
import { CraftPacketFileRequest, FileRequestType } from "./packet";
import { join, dirname, basename } from "path";
import { CraftConnection } from "./connection";

export class CraftFileSystemProvider extends EventEmitter<FileChangeEvent[]> implements FileSystemProvider {
	onDidChangeFile = this.event;

	private getConnection(uri: Uri) {
		const connection = ext.uidConnections.get(parseInt(uri.authority));
		if (!connection) throw FileSystemError.Unavailable("Computer connection not open yet");
		return connection;
	}

	async stat(uri: Uri): Promise<FileStat> {
		const connection = this.getConnection(uri);
		const res = await connection.queueFileRequest(
			CraftPacketFileRequest.new({
				type2: FileRequestType.ATTRIBUTES,
				path: uri.path,
			})
		).catch(_ => Promise.reject(FileSystemError.FileNotFound(uri)));
		return {
			ctime: new Date(res.attributes.created).getTime(),
			mtime: new Date(res.attributes.modified).getTime(),
			size: res.attributes.size,
			type: res.attributes.isDir ? FileType.Directory : FileType.File,
		};
	}

	async readDirectory(uri: Uri): Promise<[string, FileType][]> {
		const connection = this.getConnection(uri);
		const res = await connection
			.queueFileRequest(
				CraftPacketFileRequest.new({
					type2: FileRequestType.LIST,
					path: uri.path,
				})
			)
			.catch((_) => Promise.reject(FileSystemError.FileNotFound(uri)));
		return await Promise.all(
			res.listResult.map(async (name) => {
				try {
					const subres = await connection.queueFileRequest(
						CraftPacketFileRequest.new({
							type2: FileRequestType.IS_DIR,
							path: join(uri.path, name),
						})
					);
					return [name, subres.booleanResult ? FileType.Directory : FileType.File];
				} catch (_) {}
				return [name, FileType.Unknown];
			})
		);
	}

	async createDirectory(uri: Uri): Promise<void> {
		const connection = this.getConnection(uri);
		await connection
			.queueFileRequest(
				CraftPacketFileRequest.new({
					type2: FileRequestType.MAKE_DIR,
					path: uri.path,
				})
			)
			.catch((e) => Promise.reject(FileSystemError.Unavailable(e)));
	}

	async readFile(uri: Uri): Promise<Uint8Array> {
		const connection = this.getConnection(uri);
		const res = await connection
			.queueFileRead(uri.path)
			.catch((e) => Promise.reject(FileSystemError.FileNotFound(uri)));
		return new Uint8Array(res.data);
	}

	async writeFile(
		uri: Uri,
		content: Uint8Array,
		options: { readonly create: boolean; readonly overwrite: boolean }
	): Promise<void> {
		const connection = this.getConnection(uri);
		if (options.create === false || options.overwrite === false) {
			const res = await connection
				.queueFileRequest(CraftPacketFileRequest.new({ type2: FileRequestType.EXISTS, path: uri.path }))
				.catch(() => ({ booleanResult: false }));
			if (res.booleanResult ? !options.create : !options.overwrite) return;
		}
		await connection
			.queueFileWrite(uri.path, Buffer.from(content), true)
			.catch((e) => Promise.reject(FileSystemError.Unavailable(e)));
	}

	async delete(uri: Uri, options: { readonly recursive: boolean }): Promise<void> {
		const connection = this.getConnection(uri);
		await connection
			.queueFileRequest(CraftPacketFileRequest.new({ type2: FileRequestType.DELETE, path: uri.path }))
			.catch((e) => Promise.reject(FileSystemError.Unavailable(e)));
	}

	async rename(oldUri: Uri, newUri: Uri, options: { readonly overwrite: boolean }): Promise<void> {
		if (oldUri.authority !== newUri.authority) throw FileSystemError.Unavailable("Cannot move across computers");
		const connection = this.getConnection(oldUri);
		await connection
			.queueFileRequest(
				CraftPacketFileRequest.new({
					type2: FileRequestType.MOVE,
					path: oldUri.path,
					path2: newUri.path,
				})
			)
			.catch((e) => Promise.reject(FileSystemError.Unavailable(e)));
	}

	async copy(source: Uri, destination: Uri, options: { readonly overwrite: boolean }): Promise<void> {
		if (source.authority !== destination.authority)
			throw FileSystemError.Unavailable("Cannot copy across computers");
		const connection = this.getConnection(source);
		await connection
			.queueFileRequest(
				CraftPacketFileRequest.new({
					type2: FileRequestType.COPY,
					path: source.path,
					path2: destination.path,
				})
			)
			.catch((e) => Promise.reject(FileSystemError.Unavailable(e)));
	}

	watch(uri: Uri, options: { readonly recursive: boolean; readonly excludes: readonly string[] }): Disposable {
		throw new Error("Method not implemented.");
	}
}

export class CraftFile extends TreeItem {
	constructor(
		public readonly connection: string,
		public label: string,
		public path: string,
		public isFolder: boolean
	) {
		const uri = Uri.from({
			scheme: "craftos-pc",
			authority: ext.connections.get(connection).uid.toFixed(0),
			path,
		});
		super(uri, isFolder ? TreeItemCollapsibleState.Collapsed : TreeItemCollapsibleState.None);
		this.tooltip = `${connection}:${path}`;

		this.resourceUri = uri
		this.id = `${connection}:${path}`;

		if (path === "/") {
			this.iconPath = Uri.file(join(ext.context.extensionPath, "media/computer.svg"));
			this.contextValue = "is-computer";
		} else {
			this.iconPath = isFolder ? ThemeIcon.Folder : ThemeIcon.File;
			this.contextValue = isFolder ? "is-folder" : "is-file";
			if (!isFolder) this.command = { command: "vscode.open", title: "Open", arguments: [this.resourceUri] };
		}
	}

	getChildren(): Thenable<CraftFile[]> {
		if (!this.isFolder) return;
		return workspace.fs.readDirectory(this.resourceUri).then((entries) =>
			entries
				.map(
					([name, type]) =>
						new CraftFile(this.connection, name, join(this.path, name), type == FileType.Directory)
				)
				.sort((a, b) => {
					if (a.isFolder !== b.isFolder) return a.isFolder ? -1 : 1;
					return a.label < b.label ? -1 : 1;
				})
		);
	}
}

interface FileData {
	name: string;
	contents: Buffer | FileData[];
}

async function addFileData(target: FileData[], uri: Uri, token: CancellationToken, fileType?: FileType) {
	if (!fileType) fileType = (await workspace.fs.stat(uri)).type;
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
			await connection.queueFileWrite(join(path, name), contents, true);
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
		try {
			return [...ext.connections!.values()]
				.filter((connection) => connection.supportsFilesystem)
				.map(
					(connection) =>
						new CraftFile(connection.id, connection.windows.get(0)?.title || connection.id, "/", true)
				);
		} catch (e) {
			console.log(e);
			return [];
		}
	}
	getParent(element: CraftFile): ProviderResult<CraftFile> {
		if (element.path === "/") return;
		const d = dirname(element.path);
		return new CraftFile(element.connection, basename(d), d, true);
	}

	dragMimeTypes = ["text/uri-list", "application/vnd.code.tree.craftos-files"];
	handleDrag(source: readonly CraftFile[], dataTransfer: DataTransfer, token: CancellationToken): void {
		dataTransfer.set(
			"application/vnd.code.tree.craftos-files",
			new DataTransferItem(
				source.map((file) => ({ connectionID: file.connection, path: file.path, uri: file.resourceUri }))
			)
		);
		dataTransfer.set(
			"text/uri-list",
			new DataTransferItem(source.map((file) => file.resourceUri.toString()).join("\r\n"))
		);
	}

	dropMimeTypes = ["text/uri-list", "application/vnd.code.tree.craftos-files"];
	async handleDrop(target: CraftFile, dataTransfer: DataTransfer, token: CancellationToken): Promise<void> {
		try {
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
							const uri = Uri.parse(uriStr.trim());
							if (uri.scheme !== "craftos-pc") await addFileData(files, uri, token);
							if (token.isCancellationRequested) return;
						}
						break;
					case "application/vnd.code.tree.craftos-files":
						for (const fileInfo of item.value) {
							const { connectionID, path, uri } = fileInfo;
							if (connectionID !== target.connection) {
								const connection2 = ext.connections.get(connectionID);
								if (connection2) await addFileData(files, uri, token);
							} else {
								try {
									await connection.queueFileRequest(
										CraftPacketFileRequest.new({
											type2: FileRequestType.MOVE,
											path: path,
											path2: join(target.path, basename(path)),
										})
									);
								} catch (_) {}
							}
							if (token.isCancellationRequested) return;
						}
						break;
				}
			}
			if (token.isCancellationRequested) return;
			await sendFiles(files, connection, target.path, token);
		} catch (e) {
			console.log(e);
		}
		this.fire(null);
	}
}
