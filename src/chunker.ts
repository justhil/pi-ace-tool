import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { TextDecoder } from "node:util";

export interface BlobChunk {
	path: string;
	content: string;
}

export interface ProcessedFileContent {
	blobs: BlobChunk[];
	blobHashes: string[];
	contentBytes: number;
}

const DECODER_LABELS = ["utf-8", "gbk", "gb18030", "windows-1252"];

export function calculateBlobName(path: string, content: string): string {
	const hash = createHash("sha256");
	hash.update(path);
	hash.update(content);
	return hash.digest("hex");
}

export function calculateConfigHash(maxLinesPerBlob: number): string {
	const hash = createHash("sha256");
	hash.update("v1:");
	const buffer = Buffer.allocUnsafe(8);
	buffer.writeBigUInt64LE(BigInt(maxLinesPerBlob));
	hash.update(buffer);
	return hash.digest("hex").slice(0, 16);
}

function replacementThreshold(length: number): number {
	return length < 100 ? 5 : Math.floor(length * 0.05);
}

function countReplacementChars(text: string): number {
	let count = 0;
	for (const char of text) {
		if (char === "\uFFFD") count += 1;
	}
	return count;
}

export function decodeBuffer(buffer: Buffer): string {
	for (const label of DECODER_LABELS) {
		try {
			const decoder = new TextDecoder(label, { fatal: false });
			const text = decoder.decode(buffer);
			if (countReplacementChars(text) <= replacementThreshold(text.length)) {
				return text;
			}
		} catch {
			// Encoding label is not supported in this Node runtime; try the next one.
		}
	}

	return buffer.toString("utf8");
}

export function sanitizeContent(content: string): string {
	let result = "";
	for (const char of content) {
		const code = char.codePointAt(0) ?? 0;
		const isBadControl =
			(code >= 0x00 && code <= 0x08) ||
			code === 0x0b ||
			code === 0x0c ||
			(code >= 0x0e && code <= 0x1f) ||
			code === 0x7f;
		if (!isBadControl) result += char;
	}
	return result;
}

export function isBinaryContent(content: string): boolean {
	const chars = Array.from(content);
	if (chars.length === 0) return false;
	let nonPrintable = 0;
	for (const char of chars) {
		const code = char.codePointAt(0) ?? 0;
		if ((code >= 0x00 && code <= 0x08) || (code >= 0x0e && code <= 0x1f) || code === 0x7f) {
			nonPrintable += 1;
		}
	}
	return nonPrintable > chars.length / 10;
}

function splitLinesLikeRust(content: string): string[] {
	if (content.length === 0) return [];
	const lines = content.split(/\r\n|\n|\r/);
	if (/\r\n$|\n$|\r$/.test(content)) lines.pop();
	return lines;
}

export function splitFileContent(filePath: string, content: string, maxLinesPerBlob: number): BlobChunk[] {
	const maxLines = maxLinesPerBlob > 0 ? maxLinesPerBlob : 800;
	const lines = splitLinesLikeRust(content);
	const totalLines = lines.length;

	if (totalLines <= maxLines) {
		return [{ path: filePath, content }];
	}

	const numChunks = Math.ceil(totalLines / maxLines);
	const blobs: BlobChunk[] = [];
	for (let chunkIndex = 0; chunkIndex < numChunks; chunkIndex += 1) {
		const startLine = chunkIndex * maxLines;
		const endLine = Math.min(startLine + maxLines, totalLines);
		const chunkContent = lines.slice(startLine, endLine).join("\n");
		blobs.push({
			path: `${filePath}#chunk${chunkIndex + 1}of${numChunks}`,
			content: chunkContent,
		});
	}
	return blobs;
}

export async function processFileContent(filePath: string, relativePath: string, maxLinesPerBlob: number, maxFileBytes: number): Promise<ProcessedFileContent | undefined> {
	const buffer = await readFile(filePath);
	const decoded = decodeBuffer(buffer);
	if (isBinaryContent(decoded)) return undefined;

	const content = sanitizeContent(decoded);
	if (Buffer.byteLength(content, "utf8") > maxFileBytes) return undefined;

	const blobs = splitFileContent(relativePath, content, maxLinesPerBlob);
	return {
		blobs,
		blobHashes: blobs.map((blob) => calculateBlobName(blob.path, blob.content)),
		contentBytes: Buffer.byteLength(content, "utf8"),
	};
}
