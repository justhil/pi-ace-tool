import { mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";

export interface FileEntry {
	mtimeMs: number;
	mtimeNs?: string;
	size: number;
	blobHashes: string[];
}

export interface IndexData {
	version: number;
	configHash: string;
	entries: Record<string, FileEntry>;
}

export interface IndexStats {
	totalBlobs: number;
	cachedBlobs: number;
	newBlobs: number;
	failedBatches: number;
	files: number;
	processedFiles: number;
	skippedFiles: number;
	deletedFiles: number;
}

export const CURRENT_INDEX_VERSION = 1;
const MAX_INDEX_BYTES = 256 * 1024 * 1024;

function isPlainObject(value: unknown): value is Record<string, unknown> {
	return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function normalizeFileEntry(value: unknown): FileEntry | undefined {
	if (!isPlainObject(value)) return undefined;
	if (typeof value.mtimeMs !== "number" || !Number.isFinite(value.mtimeMs)) return undefined;
	if (typeof value.size !== "number" || !Number.isFinite(value.size) || value.size < 0) return undefined;
	if (value.mtimeNs !== undefined && typeof value.mtimeNs !== "string") return undefined;
	if (!Array.isArray(value.blobHashes) || value.blobHashes.some((hash) => typeof hash !== "string" || !hash)) return undefined;
	return {
		mtimeMs: value.mtimeMs,
		mtimeNs: value.mtimeNs,
		size: value.size,
		blobHashes: value.blobHashes,
	};
}

function normalizeIndexData(value: unknown, configHash: string): IndexData | undefined {
	if (!isPlainObject(value)) return undefined;
	if (value.version !== CURRENT_INDEX_VERSION) return undefined;
	if (value.configHash !== configHash) return undefined;
	if (!isPlainObject(value.entries)) return undefined;

	const entries: Record<string, FileEntry> = {};
	for (const [relativePath, entryValue] of Object.entries(value.entries)) {
		if (!relativePath || path.isAbsolute(relativePath) || relativePath.includes("\\") || relativePath.split("/").includes("..")) return undefined;
		const entry = normalizeFileEntry(entryValue);
		if (!entry) return undefined;
		entries[relativePath] = entry;
	}

	return { version: CURRENT_INDEX_VERSION, configHash, entries };
}

export function emptyIndex(configHash: string): IndexData {
	return {
		version: CURRENT_INDEX_VERSION,
		configHash,
		entries: {},
	};
}

export function getAceDir(projectRoot: string, dirName = ".ace-tool"): string {
	return path.join(projectRoot, dirName);
}

export function getIndexFilePath(projectRoot: string, dirName = ".ace-tool", fileName = "index.json"): string {
	return path.join(getAceDir(projectRoot, dirName), fileName);
}

async function ensureGitignoreContainsAceDir(projectRoot: string, dirName: string): Promise<void> {
	if (!dirName || path.basename(dirName) !== dirName) return;
	const gitignorePath = path.join(projectRoot, ".gitignore");
	let content = "";
	try {
		content = await readFile(gitignorePath, "utf8");
	} catch {
		content = "";
	}

	const expectedA = dirName;
	const expectedB = `${dirName}/`;
	const hasEntry = content
		.split(/\r?\n/)
		.map((line) => line.trim())
		.filter((line) => line && !line.startsWith("#"))
		.map((line) => line.split("#")[0]?.trim() ?? line)
		.some((line) => line === expectedA || line === expectedB);

	if (hasEntry) return;

	const prefix = content.length === 0 || content.endsWith("\n") ? content : `${content}\n`;
	try {
		await writeFile(gitignorePath, `${prefix}${dirName}/\n`, "utf8");
	} catch {
		// Best effort only.
	}
}

export async function ensureIndexDir(projectRoot: string, dirName = ".ace-tool"): Promise<string> {
	const aceDir = getAceDir(projectRoot, dirName);
	await mkdir(aceDir, { recursive: true });
	await ensureGitignoreContainsAceDir(projectRoot, dirName);
	return aceDir;
}

export async function loadIndex(projectRoot: string, configHash: string, dirName = ".ace-tool", fileName = "index.json"): Promise<IndexData> {
	const indexPath = getIndexFilePath(projectRoot, dirName, fileName);
	try {
		const metadata = await stat(indexPath);
		if (metadata.size > MAX_INDEX_BYTES) return emptyIndex(configHash);
		const raw = await readFile(indexPath, "utf8");
		const parsed = normalizeIndexData(JSON.parse(raw), configHash);
		return parsed ?? emptyIndex(configHash);
	} catch {
		return emptyIndex(configHash);
	}
}

export async function saveIndex(projectRoot: string, data: IndexData, dirName = ".ace-tool", fileName = "index.json"): Promise<void> {
	await ensureIndexDir(projectRoot, dirName);
	const indexPath = getIndexFilePath(projectRoot, dirName, fileName);
	const tempPath = `${indexPath}.tmp-${process.pid}-${Date.now()}`;
	await writeFile(tempPath, JSON.stringify(data), "utf8");
	try {
		await rename(tempPath, indexPath);
	} catch (error) {
		// Windows cannot always rename over an existing file.
		await rm(indexPath, { force: true }).catch(() => undefined);
		await rename(tempPath, indexPath);
	}
}

export function getAllBlobHashes(data: IndexData): string[] {
	return Object.values(data.entries).flatMap((entry) => entry.blobHashes);
}

export async function clearIndex(projectRoot: string, dirName = ".ace-tool", fileName = "index.json"): Promise<void> {
	const indexPath = getIndexFilePath(projectRoot, dirName, fileName);
	await rm(indexPath, { force: true });
}
