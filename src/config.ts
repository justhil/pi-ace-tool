import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

export type AceToolConfigScope = "project" | "global";

export type AcePromptEnhancerMode = "official" | "pi-model";

export interface StoredAceToolConfig {
	baseUrl?: string;
	token?: string;
	maxLinesPerBlob?: number;
	retrievalTimeoutSecs?: number;
	uploadTimeoutSecs?: number;
	uploadConcurrency?: number;
	maxFileBytes?: number;
	maxBatchBytes?: number;
	indexDirName?: string;
	indexFileName?: string;
	allowHttp?: boolean;
	autoIndexOnSessionStart?: boolean;
	promptEnhancerMode?: AcePromptEnhancerMode;
	promptEnhancerModel?: string;
	promptEnhancerIncludeSearchContext?: boolean;
}

export interface AceToolConfig {
	baseUrl: string;
	token: string;
	maxLinesPerBlob: number;
	retrievalTimeoutMs: number;
	uploadTimeoutMs: number;
	uploadConcurrency?: number;
	maxFileBytes: number;
	maxBatchBytes: number;
	indexDirName: string;
	indexFileName: string;
	autoIndexOnSessionStart: boolean;
	promptEnhancerMode: AcePromptEnhancerMode;
	promptEnhancerModel: string;
	promptEnhancerIncludeSearchContext: boolean;
}

function maybeString(value: unknown): string | undefined {
	return typeof value === "string" && value.trim() !== "" ? value.trim() : undefined;
}

function maybePositiveInt(value: unknown): number | undefined {
	if (typeof value === "number" && Number.isFinite(value) && value > 0) return Math.trunc(value);
	if (typeof value === "string" && value.trim() !== "") {
		const parsed = Number.parseInt(value.trim(), 10);
		if (Number.isFinite(parsed) && parsed > 0) return parsed;
	}
	return undefined;
}

function maybeEnhancerMode(value: unknown): AcePromptEnhancerMode | undefined {
	if (typeof value !== "string") return undefined;
	const lower = value.trim().toLowerCase();
	if (lower === "official" || lower === "augment") return "official";
	if (lower === "pi-model" || lower === "model" || lower === "third-party" || lower === "third_party") return "pi-model";
	return undefined;
}

function maybeBoolean(value: unknown): boolean | undefined {
	if (typeof value === "boolean") return value;
	if (typeof value === "string") {
		const lower = value.trim().toLowerCase();
		if (["1", "true", "yes", "on"].includes(lower)) return true;
		if (["0", "false", "no", "off"].includes(lower)) return false;
	}
	return undefined;
}

function normalizeStoredConfig(raw: unknown): StoredAceToolConfig {
	if (!raw || typeof raw !== "object") return {};
	const value = raw as Record<string, unknown>;
	return cleanStoredConfig({
		baseUrl: maybeString(value.baseUrl) ?? maybeString(value.ACE_TOOL_BASE_URL),
		token: maybeString(value.token) ?? maybeString(value.ACE_TOOL_TOKEN),
		maxLinesPerBlob: maybePositiveInt(value.maxLinesPerBlob) ?? maybePositiveInt(value.ACE_TOOL_MAX_LINES_PER_BLOB),
		retrievalTimeoutSecs: maybePositiveInt(value.retrievalTimeoutSecs) ?? maybePositiveInt(value.ACE_TOOL_RETRIEVAL_TIMEOUT_SECS),
		uploadTimeoutSecs: maybePositiveInt(value.uploadTimeoutSecs) ?? maybePositiveInt(value.ACE_TOOL_UPLOAD_TIMEOUT_SECS),
		uploadConcurrency: maybePositiveInt(value.uploadConcurrency) ?? maybePositiveInt(value.ACE_TOOL_UPLOAD_CONCURRENCY),
		maxFileBytes: maybePositiveInt(value.maxFileBytes) ?? maybePositiveInt(value.ACE_TOOL_MAX_FILE_BYTES),
		maxBatchBytes: maybePositiveInt(value.maxBatchBytes) ?? maybePositiveInt(value.ACE_TOOL_MAX_BATCH_BYTES),
		indexDirName: maybeString(value.indexDirName) ?? maybeString(value.ACE_TOOL_INDEX_DIR),
		indexFileName: maybeString(value.indexFileName) ?? maybeString(value.ACE_TOOL_INDEX_FILE),
		allowHttp: maybeBoolean(value.allowHttp) ?? maybeBoolean(value.ACE_TOOL_ALLOW_HTTP),
		autoIndexOnSessionStart: maybeBoolean(value.autoIndexOnSessionStart) ?? maybeBoolean(value.ACE_TOOL_AUTO_INDEX_ON_SESSION_START),
		promptEnhancerMode: maybeEnhancerMode(value.promptEnhancerMode) ?? maybeEnhancerMode(value.ACE_TOOL_PROMPT_ENHANCER_MODE),
		promptEnhancerModel: maybeString(value.promptEnhancerModel) ?? maybeString(value.ACE_TOOL_PROMPT_ENHANCER_MODEL),
		promptEnhancerIncludeSearchContext: maybeBoolean(value.promptEnhancerIncludeSearchContext) ?? maybeBoolean(value.ACE_TOOL_PROMPT_ENHANCER_INCLUDE_SEARCH_CONTEXT),
	});
}

export function cleanStoredConfig(config: StoredAceToolConfig): StoredAceToolConfig {
	const cleaned: StoredAceToolConfig = {};
	if (config.baseUrl) cleaned.baseUrl = config.baseUrl.trim();
	if (config.token) cleaned.token = config.token.trim();
	if (config.maxLinesPerBlob && config.maxLinesPerBlob > 0) cleaned.maxLinesPerBlob = Math.trunc(config.maxLinesPerBlob);
	if (config.retrievalTimeoutSecs && config.retrievalTimeoutSecs > 0) cleaned.retrievalTimeoutSecs = Math.trunc(config.retrievalTimeoutSecs);
	if (config.uploadTimeoutSecs && config.uploadTimeoutSecs > 0) cleaned.uploadTimeoutSecs = Math.trunc(config.uploadTimeoutSecs);
	if (config.uploadConcurrency && config.uploadConcurrency > 0) cleaned.uploadConcurrency = Math.trunc(config.uploadConcurrency);
	if (config.maxFileBytes && config.maxFileBytes > 0) cleaned.maxFileBytes = Math.trunc(config.maxFileBytes);
	if (config.maxBatchBytes && config.maxBatchBytes > 0) cleaned.maxBatchBytes = Math.trunc(config.maxBatchBytes);
	if (config.indexDirName) cleaned.indexDirName = config.indexDirName.trim();
	if (config.indexFileName) cleaned.indexFileName = config.indexFileName.trim();
	if (typeof config.allowHttp === "boolean") cleaned.allowHttp = config.allowHttp;
	if (typeof config.autoIndexOnSessionStart === "boolean") cleaned.autoIndexOnSessionStart = config.autoIndexOnSessionStart;
	if (config.promptEnhancerMode) cleaned.promptEnhancerMode = config.promptEnhancerMode;
	if (config.promptEnhancerModel) cleaned.promptEnhancerModel = config.promptEnhancerModel.trim();
	if (typeof config.promptEnhancerIncludeSearchContext === "boolean") cleaned.promptEnhancerIncludeSearchContext = config.promptEnhancerIncludeSearchContext;
	return cleaned;
}

export function getGlobalConfigPath(): string {
	return path.join(os.homedir(), ".pi", "agent", "ace-tool.json");
}

export function getProjectConfigPath(cwd: string): string {
	return path.join(path.resolve(cwd), ".pi", "ace-tool.json");
}

export function getConfigFilePath(scope: AceToolConfigScope, cwd: string): string {
	return scope === "global" ? getGlobalConfigPath() : getProjectConfigPath(cwd);
}

export function readStoredConfig(scope: AceToolConfigScope, cwd: string): StoredAceToolConfig {
	const filePath = getConfigFilePath(scope, cwd);
	try {
		return normalizeStoredConfig(JSON.parse(readFileSync(filePath, "utf8")));
	} catch {
		return {};
	}
}

export function readMergedStoredConfig(cwd?: string): StoredAceToolConfig {
	const globalConfig = readStoredConfig("global", cwd ?? process.cwd());
	const projectConfig = cwd ? readStoredConfig("project", cwd) : {};
	return cleanStoredConfig({ ...globalConfig, ...projectConfig });
}

export function writeStoredConfig(scope: AceToolConfigScope, cwd: string, config: StoredAceToolConfig): string {
	const filePath = getConfigFilePath(scope, cwd);
	mkdirSync(path.dirname(filePath), { recursive: true });
	writeFileSync(filePath, `${JSON.stringify(cleanStoredConfig(config), null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
	return filePath;
}

export function deleteStoredConfig(scope: AceToolConfigScope, cwd: string): string {
	const filePath = getConfigFilePath(scope, cwd);
	rmSync(filePath, { force: true });
	return filePath;
}

function readPositiveIntEnv(name: string, fallback: number): number {
	return maybePositiveInt(process.env[name]) ?? fallback;
}

function readOptionalPositiveIntEnv(name: string): number | undefined {
	return maybePositiveInt(process.env[name]);
}

function readStringSetting(envName: string, stored: string | undefined, fallback = ""): string {
	return maybeString(process.env[envName]) ?? stored ?? fallback;
}

function readPositiveIntSetting(envName: string, stored: number | undefined, fallback: number): number {
	return maybePositiveInt(process.env[envName]) ?? stored ?? fallback;
}

function readOptionalPositiveIntSetting(envName: string, stored: number | undefined): number | undefined {
	return maybePositiveInt(process.env[envName]) ?? stored;
}

function readBooleanSetting(envName: string, stored: boolean | undefined, fallback = false): boolean {
	return maybeBoolean(process.env[envName]) ?? stored ?? fallback;
}

export function normalizeBaseUrl(raw: string, allowHttp = process.env.ACE_TOOL_ALLOW_HTTP === "1"): string {
	let value = raw.trim();
	if (!value) return value;

	if (value.startsWith("http://") && !allowHttp) {
		value = `https://${value.slice("http://".length)}`;
	} else if (!value.startsWith("http://") && !value.startsWith("https://")) {
		value = `https://${value}`;
	}

	return value.replace(/\/+$/, "");
}

export function loadConfig(cwd?: string): AceToolConfig {
	const stored = readMergedStoredConfig(cwd);
	const allowHttp = readBooleanSetting("ACE_TOOL_ALLOW_HTTP", stored.allowHttp, false);
	const baseUrl = normalizeBaseUrl(readStringSetting("ACE_TOOL_BASE_URL", stored.baseUrl), allowHttp);
	const token = readStringSetting("ACE_TOOL_TOKEN", stored.token);

	return {
		baseUrl,
		token,
		maxLinesPerBlob: readPositiveIntSetting("ACE_TOOL_MAX_LINES_PER_BLOB", stored.maxLinesPerBlob, 800),
		retrievalTimeoutMs: readPositiveIntSetting("ACE_TOOL_RETRIEVAL_TIMEOUT_SECS", stored.retrievalTimeoutSecs, 60) * 1000,
		uploadTimeoutMs: readPositiveIntSetting("ACE_TOOL_UPLOAD_TIMEOUT_SECS", stored.uploadTimeoutSecs, 30) * 1000,
		uploadConcurrency: readOptionalPositiveIntSetting("ACE_TOOL_UPLOAD_CONCURRENCY", stored.uploadConcurrency),
		maxFileBytes: readPositiveIntSetting("ACE_TOOL_MAX_FILE_BYTES", stored.maxFileBytes, 128 * 1024),
		maxBatchBytes: readPositiveIntSetting("ACE_TOOL_MAX_BATCH_BYTES", stored.maxBatchBytes, 1024 * 1024),
		indexDirName: readStringSetting("ACE_TOOL_INDEX_DIR", stored.indexDirName, ".ace-tool"),
		indexFileName: readStringSetting("ACE_TOOL_INDEX_FILE", stored.indexFileName, "index.json"),
		autoIndexOnSessionStart: readBooleanSetting("ACE_TOOL_AUTO_INDEX_ON_SESSION_START", stored.autoIndexOnSessionStart, false),
		promptEnhancerMode: maybeEnhancerMode(process.env.ACE_TOOL_PROMPT_ENHANCER_MODE) ?? stored.promptEnhancerMode ?? "official",
		promptEnhancerModel: readStringSetting("ACE_TOOL_PROMPT_ENHANCER_MODEL", stored.promptEnhancerModel),
		promptEnhancerIncludeSearchContext: readBooleanSetting("ACE_TOOL_PROMPT_ENHANCER_INCLUDE_SEARCH_CONTEXT", stored.promptEnhancerIncludeSearchContext, false),
	};
}

export function validateConfig(config: AceToolConfig): string[] {
	const issues: string[] = [];
	if (!config.baseUrl) issues.push("ACE_TOOL_BASE_URL/baseUrl is required");
	if (!config.token) issues.push("ACE_TOOL_TOKEN/token is required");
	if (config.maxLinesPerBlob <= 0) issues.push("ACE_TOOL_MAX_LINES_PER_BLOB/maxLinesPerBlob must be positive");
	if (config.retrievalTimeoutMs <= 0) issues.push("ACE_TOOL_RETRIEVAL_TIMEOUT_SECS/retrievalTimeoutSecs must be positive");
	if (config.uploadTimeoutMs <= 0) issues.push("ACE_TOOL_UPLOAD_TIMEOUT_SECS/uploadTimeoutSecs must be positive");
	return issues;
}

export function getUploadStrategy(blobCount: number, config: AceToolConfig): { batchSize: number; concurrency: number; timeoutMs: number; scaleName: string } {
	let strategy: { batchSize: number; concurrency: number; timeoutMs: number; scaleName: string };
	if (blobCount < 100) {
		strategy = { batchSize: 10, concurrency: 1, timeoutMs: 30_000, scaleName: "small" };
	} else if (blobCount < 500) {
		strategy = { batchSize: 30, concurrency: 2, timeoutMs: 45_000, scaleName: "medium" };
	} else if (blobCount < 2000) {
		strategy = { batchSize: 50, concurrency: 3, timeoutMs: 60_000, scaleName: "large" };
	} else {
		strategy = { batchSize: 70, concurrency: 4, timeoutMs: 90_000, scaleName: "extra-large" };
	}

	return {
		...strategy,
		concurrency: config.uploadConcurrency ?? strategy.concurrency,
		timeoutMs: config.uploadTimeoutMs || strategy.timeoutMs,
	};
}
