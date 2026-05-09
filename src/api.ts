import { randomUUID } from "node:crypto";
import type { AceToolConfig } from "./config.js";
import type { BlobChunk } from "./chunker.js";
import { AdaptiveUploadStrategy, type UploadErrorType } from "./adaptive.js";

export const USER_AGENT = "augment.cli/0.17.0";

const SESSION_ID = randomUUID();

interface BatchUploadResponse {
	blob_names?: string[];
}

interface SearchResponse {
	formatted_retrieval?: string | null;
}

interface ChatMessage {
	role: "user" | "assistant";
	content: string;
}

interface PromptEnhancerResponse {
	text?: string | null;
}

interface UploadBatchResult {
	success: boolean;
	blobNames: string[];
	latencyMs: number;
	status?: number;
	error?: string;
	errorType?: UploadErrorType;
}

export interface UploadResult {
	uploadedBlobNames: string[];
	failedBatches: number;
	finalConcurrency: number;
	finalTimeoutMs: number;
}

function delay(ms: number, signal?: AbortSignal): Promise<void> {
	if (ms <= 0) return Promise.resolve();
	return new Promise((resolve, reject) => {
		const timeout = setTimeout(resolve, ms);
		const onAbort = () => {
			clearTimeout(timeout);
			reject(new Error("Operation aborted"));
		};
		if (signal) {
			if (signal.aborted) {
				clearTimeout(timeout);
				reject(new Error("Operation aborted"));
				return;
			}
			signal.addEventListener("abort", onAbort, { once: true });
		}
	});
}

function makeTimeoutSignal(timeoutMs: number, parent?: AbortSignal): { signal: AbortSignal; cleanup: () => void } {
	const controller = new AbortController();
	let timeout: NodeJS.Timeout | undefined;

	const abort = () => controller.abort();
	if (parent) {
		if (parent.aborted) controller.abort();
		else parent.addEventListener("abort", abort, { once: true });
	}

	if (timeoutMs > 0) {
		timeout = setTimeout(() => controller.abort(), timeoutMs);
	}

	return {
		signal: controller.signal,
		cleanup: () => {
			if (timeout) clearTimeout(timeout);
			if (parent) parent.removeEventListener("abort", abort);
		},
	};
}

function headers(config: AceToolConfig, requestId: string): Record<string, string> {
	return {
		"Content-Type": "application/json",
		"User-Agent": USER_AGENT,
		"x-request-id": requestId,
		"x-request-session-id": SESSION_ID,
		Authorization: `Bearer ${config.token}`,
	};
}

function parseRetryAfter(value: string | null): number {
	if (!value) return 1000;
	const seconds = Number.parseInt(value, 10);
	if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1000;
	const dateMs = Date.parse(value);
	if (Number.isFinite(dateMs)) return Math.max(0, dateMs - Date.now());
	return 1000;
}

function classifyStatus(status: number): UploadErrorType {
	if (status === 429) return "rate_limit";
	if (status >= 500) return "server_error";
	return "client_error";
}

export function parseChatHistory(conversationHistory: string): ChatMessage[] {
	const chatHistory: ChatMessage[] = [];
	let currentRole: ChatMessage["role"] | undefined;
	let currentLines: string[] = [];
	const flush = () => {
		if (currentRole) chatHistory.push({ role: currentRole, content: currentLines.join("\n") });
		currentRole = undefined;
		currentLines = [];
	};

	for (const line of conversationHistory.split(/\r?\n/)) {
		const trimmed = line.trim();
		const userPrefix = ["User:", "用户:"].find((prefix) => trimmed.startsWith(prefix));
		const assistantPrefix = ["AI:", "Assistant:", "助手:"].find((prefix) => trimmed.startsWith(prefix));
		if (userPrefix) {
			flush();
			currentRole = "user";
			currentLines.push(trimmed.slice(userPrefix.length).trim());
		} else if (assistantPrefix) {
			flush();
			currentRole = "assistant";
			currentLines.push(trimmed.slice(assistantPrefix.length).trim());
		} else if (currentRole) {
			currentLines.push(line);
		}
	}
	flush();
	return chatHistory.filter((message) => message.content.trim());
}

export function extractEnhancedPrompt(text: string): string | undefined {
	const match = text.match(/<augment-enhanced-prompt(?:\s+[^>]*)?>\s*([\s\S]*?)\s*<\/augment-enhanced-prompt\s*>/i);
	const value = match?.[1]?.trim();
	return value || undefined;
}

export function replaceToolNames(text: string): string {
	return text.replaceAll("codebase-retrieval", "search_context").replaceAll("codebase_retrieval", "search_context");
}

async function uploadBatch(config: AceToolConfig, blobs: BlobChunk[], timeoutMs: number, signal?: AbortSignal): Promise<UploadBatchResult> {
	const url = `${config.baseUrl}/batch-upload`;
	const body = JSON.stringify({ blobs });
	const maxRetries = 3;
	let lastError = "Unknown error";
	let lastStatus: number | undefined;
	let lastErrorType: UploadErrorType | undefined;
	let totalLatencyMs = 0;

	for (let attempt = 0; attempt < maxRetries; attempt += 1) {
		const requestId = randomUUID();
		const timeout = makeTimeoutSignal(timeoutMs, signal);
		const started = Date.now();
		try {
			const response = await fetch(url, {
				method: "POST",
				headers: headers(config, requestId),
				body,
				signal: timeout.signal,
			});
			totalLatencyMs += Date.now() - started;

			lastStatus = response.status;
			lastErrorType = classifyStatus(response.status);

			if (response.status === 401 || response.status === 403) {
				return { success: false, blobNames: [], latencyMs: totalLatencyMs, status: response.status, error: "Authentication failed", errorType: "client_error" };
			}

			if (response.status === 400) {
				const text = await response.text().catch(() => "");
				return { success: false, blobNames: [], latencyMs: totalLatencyMs, status: response.status, error: text || "Bad request", errorType: "client_error" };
			}

			if (response.ok) {
				const text = await response.text();
				const parsed = JSON.parse(text) as BatchUploadResponse;
				return { success: true, blobNames: parsed.blob_names ?? [], latencyMs: totalLatencyMs };
			}

			if (response.status === 429 && attempt < maxRetries - 1) {
				lastError = `Rate limited (${response.status})`;
				await delay(parseRetryAfter(response.headers.get("Retry-After")), signal);
				continue;
			}

			if (response.status >= 500 && attempt < maxRetries - 1) {
				lastError = `Server error (${response.status})`;
				await delay(1000 * 2 ** attempt, signal);
				continue;
			}

			const text = await response.text().catch(() => "");
			return {
				success: false,
				blobNames: [],
				latencyMs: totalLatencyMs,
				status: response.status,
				error: text || `HTTP ${response.status}`,
				errorType: classifyStatus(response.status),
			};
		} catch (error) {
			totalLatencyMs += Date.now() - started;
			lastError = error instanceof Error ? error.message : String(error);
			lastErrorType = lastError.toLowerCase().includes("abort") || lastError.toLowerCase().includes("timeout") ? "timeout" : "network_error";
			if (signal?.aborted) throw new Error("Operation aborted");
			if (attempt < maxRetries - 1) {
				await delay(1000 * 2 ** attempt, signal);
			}
		} finally {
			timeout.cleanup();
		}
	}

	return { success: false, blobNames: [], latencyMs: totalLatencyMs, status: lastStatus, error: lastError, errorType: lastErrorType };
}

export function buildBatches(blobs: BlobChunk[], maxBlobsPerBatch: number, maxBatchBytes: number): BlobChunk[][] {
	const batches: BlobChunk[][] = [];
	let current: BlobChunk[] = [];
	let currentSize = 0;
	const batchLimit = Math.max(1, maxBlobsPerBatch);

	for (const blob of blobs) {
		const blobSize = Buffer.byteLength(blob.content, "utf8") + Buffer.byteLength(blob.path, "utf8");
		const wouldExceedSize = currentSize + blobSize > maxBatchBytes;
		const wouldExceedCount = current.length >= batchLimit;
		if (current.length > 0 && (wouldExceedSize || wouldExceedCount)) {
			batches.push(current);
			current = [];
			currentSize = 0;
		}
		current.push(blob);
		currentSize += blobSize;
	}

	if (current.length > 0) batches.push(current);
	return batches;
}

export async function uploadBlobs(config: AceToolConfig, blobs: BlobChunk[], batchSize: number, concurrency: number, timeoutMs: number, onProgress?: (message: string) => void, signal?: AbortSignal): Promise<UploadResult> {
	const batches = buildBatches(blobs, batchSize, config.maxBatchBytes);
	const uploadedBlobNames: string[] = [];
	let failedBatches = 0;
	let nextIndex = 0;
	let completed = 0;
	const strategy = new AdaptiveUploadStrategy(concurrency, timeoutMs);

	onProgress?.(`Adaptive upload started: ${batches.length} batches, initial concurrency ${strategy.concurrency()}, timeout ${Math.round(strategy.timeoutMs() / 1000)}s`);

	async function runWave(): Promise<void> {
		const waveSize = Math.max(1, Math.min(strategy.concurrency(), batches.length - nextIndex));
		const indices = Array.from({ length: waveSize }, () => nextIndex++);
		const results = await Promise.all(indices.map(async (index) => {
			if (signal?.aborted) throw new Error("Operation aborted");
			const batch = batches[index] ?? [];
			return uploadBatch(config, batch, strategy.timeoutMs(), signal);
		}));

		for (const result of results) {
			completed += 1;
			if (result.success) {
				uploadedBlobNames.push(...result.blobNames);
			} else {
				failedBatches += 1;
			}

			const adjustment = strategy.recordOutcome(result.success, result.latencyMs, result.errorType);
			if (adjustment.message) onProgress?.(adjustment.message);
		}

		onProgress?.(`Uploaded ${completed}/${batches.length} batches${failedBatches ? ` (${failedBatches} failed)` : ""}; concurrency ${strategy.concurrency()}, timeout ${Math.round(strategy.timeoutMs() / 1000)}s`);
	}

	while (nextIndex < batches.length) {
		if (signal?.aborted) throw new Error("Operation aborted");
		await runWave();
	}

	return {
		uploadedBlobNames,
		failedBatches,
		finalConcurrency: strategy.concurrency(),
		finalTimeoutMs: strategy.timeoutMs(),
	};
}

export async function enhancePromptOfficial(config: AceToolConfig, prompt: string, conversationHistory = "", signal?: AbortSignal): Promise<string> {
	const url = `${config.baseUrl}/prompt-enhancer`;
	const requestId = randomUUID();
	const body = JSON.stringify({
		nodes: [
			{
				id: 0,
				type: 0,
				text_node: { content: prompt },
			},
		],
		chat_history: parseChatHistory(conversationHistory),
		conversation_id: null,
		model: "claude-sonnet-4-5",
		mode: "CHAT",
	});

	const timeout = makeTimeoutSignal(config.retrievalTimeoutMs, signal);
	try {
		const response = await fetch(url, {
			method: "POST",
			headers: headers(config, requestId),
			body,
			signal: timeout.signal,
		});
		const text = await response.text().catch(() => "");
		if (response.status === 401) throw new Error("Prompt enhancer token invalid or expired");
		if (response.status === 403) throw new Error("Prompt enhancer access denied, token may be disabled");
		if (!response.ok) throw new Error(`Prompt enhancer failed: HTTP ${response.status}${text ? ` - ${text}` : ""}`);

		const parsed = JSON.parse(text) as PromptEnhancerResponse;
		const enhanced = parsed.text?.trim();
		if (!enhanced) throw new Error("Prompt enhancer API returned empty result");
		return replaceToolNames(extractEnhancedPrompt(enhanced) ?? enhanced);
	} finally {
		timeout.cleanup();
	}
}

export async function searchCodebase(config: AceToolConfig, query: string, blobNames: string[], signal?: AbortSignal): Promise<string> {
	const url = `${config.baseUrl}/agents/codebase-retrieval`;
	const requestId = randomUUID();
	const body = JSON.stringify({
		information_request: query,
		blobs: {
			checkpoint_id: null,
			added_blobs: blobNames,
			deleted_blobs: [],
		},
		dialog: [],
		max_output_length: 0,
		disable_codebase_retrieval: false,
		enable_commit_retrieval: false,
	});

	const timeout = makeTimeoutSignal(config.retrievalTimeoutMs, signal);
	try {
		const response = await fetch(url, {
			method: "POST",
			headers: headers(config, requestId),
			body,
			signal: timeout.signal,
		});

		const text = await response.text().catch(() => "");
		if (!response.ok) {
			throw new Error(`Search failed: HTTP ${response.status}${text ? ` - ${text}` : ""}`);
		}

		const parsed = JSON.parse(text) as SearchResponse;
		const result = parsed.formatted_retrieval?.trim();
		return result || "No relevant code context found for your query.";
	} finally {
		timeout.cleanup();
	}
}
