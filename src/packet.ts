import { crc32 } from "./utils";

export enum CraftPacketType {
	TERMINAL_CONTENTS = 0, // S
	KEY_EVENT = 1, // C
	MOUSE_EVENT = 2, // C
	GENERIC_EVENT = 3, // C
	TERMINAL_CHANGE = 4, // S/C
	SHOW_MESSAGE = 5, // S
	VERSION_SUPPORT = 6, // S/C
	FILE_REQUEST = 7, // C
	FILE_RESPONSE = 8, // S
	FILE_DATA = 9, // S/C
	SPEAKER_SOUND = 10, // S
}

export class CraftPacket {
	public type: CraftPacketType;
	public window: number = 0;

	public static from(buf: Buffer): CraftPacket {
		let packet: CraftPacket = null;
		switch (<CraftPacketType>buf[0]) {
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

	public read(buf: Buffer) {
		this.type = buf[0];
		this.window = buf[1];
	}

	public write(): Buffer {
		const buf = Buffer.alloc(this.length + 2);
		buf.fill(0);
		buf[0] = this.type;
		buf[1] = this.window;
		return buf;
	}

	public get length() {
		return 2;
	}

	public wrap(options?: { binaryChecksum?: boolean; extended?: boolean }) {
		const data = this.write();
		const b64 = data.toString("base64");
		if (b64.length <= 0xffff) {
			return (
				"!CPC" +
				b64.length.toString(16).padStart(4, "0") +
				b64 +
				crc32(options?.binaryChecksum ? data.toString("binary") : b64)
					.toString(16)
					.padStart(8, "0") +
				"\n"
			);
		} else {
			if (!options?.extended) throw new Error("Packet is too large");
			return (
				"!CPD" +
				b64.length.toString(16).padStart(12, "0") +
				b64 +
				crc32(options?.binaryChecksum ? data.toString("binary") : b64)
					.toString(16)
					.padStart(8, "0") +
				"\n"
			);
		}
	}
}

export class CraftPacketRaw extends CraftPacket {
	public data: Buffer;

	public write() {
		const buf = super.write();
		this.data.copy(buf, 2);
		return buf;
	}

	public get length() {
		return 2 + this.data.byteLength;
	}

	public static new(data: Exclude<Partial<CraftPacketRaw>, "type">) {
		return newPacket(this, data);
	}
}

// Server --> Client
export class CraftPacketTerminalContents extends CraftPacket {
	public mode: number;
	public blink: boolean;
	public width: number;
	public height: number;
	public cursorX: number;
	public cursorY: number;
	public grayscale: boolean;

	public screen: number[][];
	public colors: number[][];
	public pixels: number[][];
	public palette: { r: number; g: number; b: number }[];

	public static from(buf: Buffer): CraftPacketTerminalContents {
		const packet = new CraftPacketTerminalContents();
		packet.read(buf);
		return packet;
	}

	private readRLE(target: number[][], width: number, height: number, buf: Buffer) {
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

	public read(buf: Buffer) {
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
		} else if (this.mode === 1 || this.mode === 2) {
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

	public static new(data: Exclude<Partial<CraftPacketTerminalContents>, "type">) {
		return newPacket(this, data);
	}
}

// Server <-- Client
export class CraftPacketKeyEvent extends CraftPacket {
	public data: number | string = 0;
	public isDown: boolean = false;
	public isHeld: boolean = false;
	public isControl: boolean = false;

	public write(): Buffer {
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

	public get length() {
		return 4;
	}

	public static new(data: Exclude<Partial<CraftPacketKeyEvent>, "type">) {
		return newPacket(this, data);
	}
}

export enum MouseEventType {
	MOUSE_DOWN = 0,
	MOUSE_UP = 1,
	MOUSE_SCROLL = 2,
	MOUSE_DRAG = 3,
}

// Server <-- Client
export class CraftPacketMouseEvent extends CraftPacket {
	public event: MouseEventType;
	public button: 0 | 1 = 0;
	public scroll: "up" | "down";
	public x: number = 0;
	public y: number = 0;

	public write(): Buffer {
		const buf = super.write();
		buf[0x02] = this.event;
		buf[0x03] = this.event === MouseEventType.MOUSE_SCROLL ? (this.scroll === "up" ? 0 : 1) : this.button;
		buf.writeUint32LE(this.x, 0x04);
		buf.writeUint32LE(this.y, 0x08);
		return buf;
	}

	public get length() {
		return 12;
	}

	public static new(data: Exclude<Partial<CraftPacketMouseEvent>, "type">) {
		return newPacket(this, data);
	}
}

// Server <-- Client
// TODO
export class CraftPacketGenericEvent extends CraftPacket {
	public write(): Buffer {
		const buf = super.write();
		return buf;
	}

	public static new(data: Exclude<Partial<CraftPacketGenericEvent>, "type">) {
		return newPacket(this, data);
	}
}

export enum TerminalChangeType {
	UPDATE = 0,
	CLOSE = 1,
	QUIT = 2,
}

// Server <-> Client
export class CraftPacketTerminalChange extends CraftPacket {
	public type2: TerminalChangeType = TerminalChangeType.UPDATE;
	public id: number = 0;
	public width: number = 0;
	public height: number = 0;
	public title: string = "";

	public read(buf: Buffer) {
		super.read(buf);
		this.type2 = buf[0x02];
		this.id = buf[0x03];
		this.width = buf.readUInt16LE(0x04);
		this.height = buf.readUInt16LE(0x06);
		const titleEnd = buf.indexOf(0, 0x08);
		this.title = new TextDecoder("utf8").decode(buf.subarray(0x08, titleEnd));
	}

	public write(): Buffer {
		const buf = super.write();
		buf[0x02] = this.type2;
		buf[0x03] = this.id;
		buf.writeUInt16LE(this.width, 0x04);
		buf.writeUInt16LE(this.height, 0x06);
		return buf;
	}

	public get length() {
		return 9;
	}

	public static new(data: Exclude<Partial<CraftPacketTerminalChange>, "type">) {
		return newPacket(this, data);
	}
}

// Server --> Client
export class CraftPacketShowMessage extends CraftPacket {
	public kind: "unknown" | "info" | "warning" | "error" = "unknown";
	public title: string = "";
	public message: string = "";

	public read(buf: Buffer) {
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

	public static new(data: Exclude<Partial<CraftPacketShowMessage>, "type">) {
		return newPacket(this, data);
	}
}

// Server <-> Client
export class CraftPacketVersionSupport extends CraftPacket {
	public binaryChecksum: boolean = false;
	public supportFilesystem: boolean = false;
	public requestAllWindows: boolean = false;
	public supportSpeaker: boolean = false;

	public read(buf: Buffer) {
		super.read(buf);
		const flags = buf.readUInt16LE(0x02);
		this.binaryChecksum = (flags & 0x01) !== 0;
		this.supportFilesystem = (flags & 0x02) !== 0;
		this.requestAllWindows = (flags & 0x04) !== 0;
		this.supportSpeaker = (flags & 0x08) !== 0;
	}

	public write(): Buffer {
		const buf = super.write();
		buf.writeUInt16LE(
			(this.binaryChecksum ? 1 : 0) |
				(this.supportFilesystem ? 2 : 0) |
				(this.requestAllWindows ? 4 : 0) |
				(this.supportSpeaker ? 8 : 0),
			0x02
		);
		return buf;
	}

	public get length() {
		return 4;
	}

	public static new(data: Exclude<Partial<CraftPacketVersionSupport>, "type">) {
		return newPacket(this, data);
	}
}

export enum FileRequestType {
	EXISTS = 0,
	IS_DIR = 1,
	IS_READONLY = 2,
	GET_SIZE = 3,
	GET_DRIVE = 4,
	GET_CAPACITY = 5,
	GET_FREE_SPACE = 6,
	LIST = 7,
	ATTRIBUTES = 8,
	FIND = 9,
	MAKE_DIR = 10,
	DELETE = 11,
	COPY = 12,
	MOVE = 13,
	OPEN = 16,
}

// Server <-- Client
export class CraftPacketFileRequest extends CraftPacket {
	public type2: FileRequestType;
	public id: number;
	private _path: Uint8Array;
	public set path(val: string) {
		this._path = new TextEncoder().encode(val);
	}
	private _path2: Uint8Array;
	public set path2(val: string) {
		this._path2 = new TextEncoder().encode(val);
	}

	public isWrite: boolean;
	public isAppend: boolean;
	public isBinary: boolean;

	public write(): Buffer {
		const buf = super.write();
		let t = this.type2;
		if (t === FileRequestType.OPEN) {
			t = 16 | (this.isWrite ? 1 : 0) | (this.isAppend ? 2 : 0) | (this.isBinary ? 4 : 0);
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

	public get length() {
		return 6 + (this._path ? this._path.byteLength : 0) + (this._path2 ? this._path2.byteLength : 0);
	}

	public static new(data: Exclude<Partial<CraftPacketFileRequest>, "type">) {
		return newPacket(this, data);
	}
}

// Server --> Client
export class CraftPacketFileResponse extends CraftPacket {
	public type2: FileRequestType;
	public id: number;

	public isError: boolean;

	public success: boolean;
	public error?: string;

	public booleanResult: boolean | null;

	public integerResult: number | null;

	public stringResult: string | null;

	public listResult: string[] | null;

	public attributes: {
		size: number;
		created: number;
		modified: number;
		isDir: boolean;
		isReadonly: boolean;
	} | null;

	public read(buf: Buffer) {
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
				if (!this.success) this.error = new TextDecoder("utf8").decode(buf.subarray(0x04, msgEnd));
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
				if (this.integerResult === 0xffffffff) this.integerResult = null;
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
					const created = Number(buf.readBigUint64LE(0x08));
					const modified = Number(buf.readBigUint64LE(0x10));
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
				} else {
					this.attributes = null;
					this.isError = buf[0x1a] === 2;
				}
				break;
		}
	}

	public static new(data: Exclude<Partial<CraftPacketFileResponse>, "type">) {
		return newPacket(this, data);
	}
}

// Server <-> Client
export class CraftPacketFileData extends CraftPacket {
	public isError: boolean = false;
	public id: number;
	public data: Buffer;

	public read(buf: Buffer) {
		super.read(buf);
		this.isError = !!buf[0x02];
		this.id = buf[0x03];
		const length = buf.readUInt32LE(0x04);
		this.data = buf.subarray(0x08, 0x08 + length);
	}

	public write(): Buffer {
		const buf = super.write();
		buf[0x02] = this.isError ? 1 : 0;
		buf[0x03] = this.id;
		buf.writeUInt32LE(this.data.byteLength, 0x04);
		this.data.copy(buf, 0x08);
		return buf;
	}

	public get length() {
		return 8 + this.data.byteLength;
	}

	public static new(data: Exclude<Partial<CraftPacketFileData>, "type">) {
		return newPacket(this, data);
	}
}

// Server --> Client
// TODO
export class CraftPacketSpeakerSound extends CraftPacket {
	public read(buf: Buffer) {
		super.read(buf);
	}

	public static new(data: Exclude<Partial<CraftPacketSpeakerSound>, "type">) {
		return newPacket(this, data);
	}
}

const classToType = new Map<any, CraftPacketType>();
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

export function newPacket<T extends CraftPacket>(clazz: { new (): T }, data: Exclude<Partial<T>, "type">): T {
	const t = new clazz();
	for (const key in data) {
		t[<any>key] = data[key];
	}
	if (classToType.has(clazz)) t.type = classToType.get(clazz);
	return t;
}
