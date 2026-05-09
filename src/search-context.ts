import { cpus } from "node:os";
import { access, stat } from "node:fs/promises";
import type { AceToolConfig } from "./config.js";
import { getUploadStrategy } from "./config.js";
import { processFileContent, calculateConfigHash, type BlobChunk } from "./chunker.js";
import { collectFileCandidates, type FileCandidate } from "./scanner.js";
import { emptyIndex, getAllBlobHashes, loadIndex, saveIndex, type FileEntry, type IndexData, type IndexStats } from "./cache.js";
import { searchCodebase, uploadBlobs } from "./api.js";
import { buildSearchResultHeader, extractResultPaths } from "./results.js";
import { normalizeProjectPath } from "./path-normalizer.js";

export interface SearchContextParams {
	query: string;
	projectRootPath?: string;
}

export interface SearchContextResult {
	text: string;
	details: {
		projectRoot: string;
		stats: IndexStats;
		blobCount: number;
		partial: boolean;
		files: string[];
	};
}

interface ProcessedResult {
	candidate: FileCandidate;
	entry: FileEntry;
	blobs: BlobChunk[];
	cached: boolean;
}

const MAX_RESULT_BYTES = 50 * 1024;
const MAX_RESULT_LINES = 2000;

function truncateHead(text: string, maxLines = MAX_RESULT_LINES, maxBytes = MAX_RESULT_BYTES): { text: string; truncated: boolean; totalLines: number; totalBytes: number; outputLines: number; outputBytes: number } {
	const lines = text.split(/\r?\n/);
	const totalLines = lines.length;
	const totalBytes = Buffer.byteLength(text, "utf8");
	let outputLines = 0;
	let outputBytes = 0;
	const kept: string[] = [];

	for (const line of lines) {
		const lineBytes = Buffer.byteLength(line, "utf8") + 1;
		if (outputLines >= maxLines || outputBytes + lineBytes > maxBytes) break;
		kept.push(line);
		outputLines += 1;
		outputBytes += lineBytes;
	}

	const truncated = outputLines < totalLines || outputBytes < totalBytes;
	return {
		text: kept.join("\n"),
		truncated,
		totalLines,
		totalBytes,
		outputLines,
		outputBytes,
	};
}

function formatBytes(bytes: number): string {
	if (bytes < 1024) return `${bytes}B`;
	if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
	return `${(bytes / 1024 / 1024).toFixed(1)}MB`;
}

async function assertProjectRoot(projectRoot: string): Promise<void> {
	try {
		await access(projectRoot);
		const metadata = await stat(projectRoot);
		if (!metadata.isDirectory()) throw new Error(`Project path is not a directory: ${projectRoot}`);
	} catch (error) {
		if (error instanceof Error && error.message.startsWith("Project path")) throw error;
		throw new Error(`Project path does not exist or cannot be accessed: ${projectRoot}`);
	}
}

function hasBasicCacheMatch(candidate: FileCandidate, cached: FileEntry | undefined): cached is FileEntry {
	if (!cached) return false;
	if (!Array.isArray(cached.blobHashes) || cached.blobHashes.length === 0) return false;
	return Math.trunc(cached.mtimeMs) === Math.trunc(candidate.mtimeMs) && cached.size === candidate.size;
}

function hasPreciseMtimeMatch(candidate: FileCandidate, cached: FileEntry): boolean {
	return Boolean(candidate.mtimeNs && cached.mtimeNs && candidate.mtimeNs === cached.mtimeNs);
}

async function processCandidate(candidate: FileCandidate, oldIndex: IndexData, config: AceToolConfig): Promise<ProcessedResult | undefined> {
	const cachedEntry = oldIndex.entries[candidate.relativePath];

	if (hasBasicCacheMatch(candidate, cachedEntry) && hasPreciseMtimeMatch(candidate, cachedEntry)) {
		return { candidate, entry: cachedEntry, blobs: [], cached: true };
	}

	try {
		const processed = await processFileContent(
			candidate.absolutePath,
			candidate.relativePath,
			config.maxLinesPerBlob,
			config.maxFileBytes,
		);
		if (!processed) return undefined;

		if (hasBasicCacheMatch(candidate, cachedEntry)) {
			const hashesMatch = processed.blobHashes.length === cachedEntry.blobHashes.length
				&& processed.blobHashes.every((hash, index) => hash === cachedEntry.blobHashes[index]);
			if (hashesMatch) {
				return {
					candidate,
					entry: {
						mtimeMs: candidate.mtimeMs,
						mtimeNs: candidate.mtimeNs,
						size: candidate.size,
						blobHashes: cachedEntry.blobHashes,
					},
					blobs: [],
					cached: true,
				};
			}
		}

		return {
			candidate,
			entry: {
				mtimeMs: candidate.mtimeMs,
				mtimeNs: candidate.mtimeNs,
				size: candidate.size,
				blobHashes: processed.blobHashes,
			},
			blobs: processed.blobs,
			cached: false,
		};
	} catch {
		// If a previously indexed file becomes temporarily unreadable, preserve the old entry.
		if (cachedEntry) {
			return { candidate, entry: cachedEntry, blobs: [], cached: true };
		}
		return undefined;
	}
}

async function processCandidates(candidates: FileCandidate[], oldIndex: IndexData, config: AceToolConfig, concurrency: number, onProgress?: (message: string) => void, signal?: AbortSignal): Promise<ProcessedResult[]> {
	const results: ProcessedResult[] = [];
	let nextIndex = 0;
	let completed = 0;

	async function worker(): Promise<void> {
		while (nextIndex < candidates.length) {
			if (signal?.aborted) throw new Error("Operation aborted");
			const index = nextIndex;
			nextIndex += 1;
			const candidate = candidates[index];
			if (!candidate) continue;

			const processed = await processCandidate(candidate, oldIndex, config);
			if (processed) results.push(processed);

			completed += 1;
			if (completed % 50 === 0 || completed === candidates.length) {
				onProgress?.(`Processed ${completed}/${candidates.length} files`);
			}
		}
	}

	const workerCount = Math.max(1, Math.min(concurrency, candidates.length || 1));
	await Promise.all(Array.from({ length: workerCount }, () => worker()));
	return results.sort((a, b) => a.candidate.relativePath.localeCompare(b.candidate.relativePath));
}

export async function indexProject(projectRoot: string, config: AceToolConfig, onProgress?: (message: string) => void, signal?: AbortSignal): Promise<{ index: IndexData; stats: IndexStats; partial: boolean }> {
	const configHash = calculateConfigHash(config.maxLinesPerBlob);
	onProgress?.("Scanning project files...");
	const candidates = await collectFileCandidates(projectRoot, { maxFileBytes: config.maxFileBytes });

	if (candidates.length === 0) {
		throw new Error("No indexable text files found in project");
	}

	const oldIndex = await loadIndex(projectRoot, configHash, config.indexDirName, config.indexFileName);
	const processConcurrency = Math.max(2, Math.min(16, cpus().length || 4));
	onProgress?.(`Found ${candidates.length} files. Processing changes...`);
	const processed = await processCandidates(candidates, oldIndex, config, processConcurrency, onProgress, signal);

	if (processed.length === 0) {
		throw new Error("No files could be processed");
	}

	const newIndex = emptyIndex(configHash);
	const newBlobs: BlobChunk[] = [];
	let cachedBlobs = 0;

	for (const item of processed) {
		newIndex.entries[item.candidate.relativePath] = item.entry;
		if (item.cached) {
			cachedBlobs += item.entry.blobHashes.length;
		} else {
			newBlobs.push(...item.blobs);
		}
	}

	let failedBatches = 0;
	if (newBlobs.length > 0) {
		const strategy = getUploadStrategy(newBlobs.length, config);
		onProgress?.(`Uploading ${newBlobs.length} new chunks (${strategy.scaleName}, target concurrency ${strategy.concurrency})...`);
		const upload = await uploadBlobs(
			config,
			newBlobs,
			strategy.batchSize,
			strategy.concurrency,
			strategy.timeoutMs,
			onProgress,
			signal,
		);
		failedBatches = upload.failedBatches;
		if (failedBatches > 0) {
			throw new Error(`Index upload partially failed: ${failedBatches} batch(es) failed. The old cache was kept so the next search can retry.`);
		}
	}

	const oldPaths = new Set(Object.keys(oldIndex.entries));
	const newPaths = new Set(Object.keys(newIndex.entries));
	let deletedFiles = 0;
	for (const oldPath of oldPaths) {
		if (!newPaths.has(oldPath)) deletedFiles += 1;
	}

	await saveIndex(projectRoot, newIndex, config.indexDirName, config.indexFileName);
	const stats: IndexStats = {
		totalBlobs: getAllBlobHashes(newIndex).length,
		cachedBlobs,
		newBlobs: newBlobs.length,
		failedBatches,
		files: Object.keys(newIndex.entries).length,
		processedFiles: processed.length,
		skippedFiles: Math.max(0, candidates.length - processed.length),
		deletedFiles,
	};

	return { index: newIndex, stats, partial: failedBatches > 0 };
}

export async function runSearchContext(params: SearchContextParams, config: AceToolConfig, cwd: string, onProgress?: (message: string) => void, signal?: AbortSignal): Promise<SearchContextResult> {
	const query = params.query?.trim();
	if (!query) throw new Error("query is required");

	const projectRoot = normalizeProjectPath(params.projectRootPath, cwd);
	await assertProjectRoot(projectRoot);

	const { index, stats, partial } = await indexProject(projectRoot, config, onProgress, signal);
	const blobNames = getAllBlobHashes(index);
	if (blobNames.length === 0) throw new Error("No blobs found after indexing");

	onProgress?.(`Searching ${blobNames.length} chunks...`);
	const rawText = await searchCodebase(config, query, blobNames, signal);
	const files = extractResultPaths(rawText);
	const header = buildSearchResultHeader({ projectRoot, query, blobCount: blobNames.length, files });
	const enrichedText = `${header}\n\n${rawText}`;
	const truncated = truncateHead(enrichedText);
	let text = truncated.text;
	if (truncated.truncated) {
		text += `\n\n[Output truncated: ${truncated.outputLines} of ${truncated.totalLines} lines (${formatBytes(truncated.outputBytes)} of ${formatBytes(truncated.totalBytes)}).]`;
	}

	return {
		text,
		details: {
			projectRoot,
			stats,
			blobCount: blobNames.length,
			partial,
			files,
		},
	};
}
