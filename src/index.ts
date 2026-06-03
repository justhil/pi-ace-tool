import type { Api, Model } from "@earendil-works/pi-ai";
import type { BuildSystemPromptOptions, ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { SelectList, Text, truncateToWidth, type Component, type SelectItem, type SelectListTheme, type TUI } from "@earendil-works/pi-tui";
import { Type, type Static } from "typebox";
import {
	deleteStoredConfig,
	getConfigFilePath,
	loadConfig,
	readStoredConfig,
	type AceToolConfigScope,
	type StoredAceToolConfig,
	validateConfig,
	writeStoredConfig,
	type AceApiMode,
} from "./config.js";
import {
	completeAugmentOAuthFlow,
	createAugmentOAuthFlow,
	getDefaultAugmentSessionPath,
	openBrowser,
	readAugmentSessionSource,
	removeAugmentSession,
} from "./augment-auth.js";
import { indexProject, runSearchContext } from "./search-context.js";
import { initAceProject } from "./init.js";
import { enhancePrompt, stripEnhanceMarkers } from "./prompt-enhancer.js";
import { clearIndex, getIndexFilePath, loadIndex } from "./cache.js";
import { calculateConfigHash } from "./chunker.js";
import { getAceApiIdentity } from "./api.js";
import { normalizeProjectPath } from "./path-normalizer.js";

const SEARCH_CONTEXT_PARAMS = Type.Object({
	query: Type.String({
		description: `Natural language description of the code you are looking for.

Recommended format: natural language description + optional keywords.

Examples:
- "Where is the function that handles user authentication?"
- "What tests are there for the login functionality?"
- "How is the database connected to the application?"
- "Find the initialization flow of message queue consumers. Keywords: mq consumer init, subscribe"`,
	}),
	project_root_path: Type.Optional(
		Type.String({
			description: "Absolute path to the project root directory. If omitted, pi's current working directory is used.",
		}),
	),
});

type SearchContextParams = Static<typeof SEARCH_CONTEXT_PARAMS>;

type SearchContextDetails = {
	projectRoot?: string;
	query?: string;
	stats?: {
		totalBlobs: number;
		cachedBlobs: number;
		newBlobs: number;
		failedBatches: number;
		files: number;
		processedFiles?: number;
		skippedFiles?: number;
		deletedFiles?: number;
	};
	blobCount?: number;
	partial?: boolean;
	files?: string[];
	status?: string;
	stage?: string;
	frame?: number;
	startedAt?: number;
};

function configSummary(cwd: string): string {
	const config = loadConfig(cwd);
	const issues = validateConfig(config);
	if (issues.length > 0) {
		return `ace-tool 尚未配置：\n- ${issues.join("\n- ")}\n\n请运行 /ace-config 进行配置。环境变量仍然会覆盖已保存的配置。`;
	}
	return [
		"ace-tool configured",
		`apiMode: ${config.apiMode}`,
		`baseUrl: ${config.baseUrl || "not set"}`,
		`token: ${maskSecret(config.token)}`,
		`maxLinesPerBlob: ${config.maxLinesPerBlob}`,
		`retrievalTimeout: ${config.retrievalTimeoutMs / 1000}s`,
		`uploadTimeout: ${config.uploadTimeoutMs / 1000}s`,
		`uploadConcurrency: ${config.uploadConcurrency ?? "auto"}`,
		`autoIndex: ${config.autoIndexOnSessionStart ? "on" : "off"}`,
		`promptEnhancer: ${config.promptEnhancerMode}${config.promptEnhancerMode === "pi-model" ? ` (${config.promptEnhancerModel || "current model"})` : ""}`,
		`promptEnhancerContext: ${config.promptEnhancerIncludeSearchContext ? "on" : "off"}`,
		`index: ${config.indexDirName}/${config.indexFileName}`,
	].join("\n");
}

function configScopeSummary(cwd: string): string {
	const project = readStoredConfig("project", cwd);
	const global = readStoredConfig("global", cwd);
	const projectKeys = Object.keys(project).length;
	const globalKeys = Object.keys(global).length;
	return `project config: ${projectKeys ? `${projectKeys} setting(s)` : "not set"}\nglobal config: ${globalKeys ? `${globalKeys} setting(s)` : "not set"}`;
}

const CONFIG_ENV_NAMES = [
	"ACE_TOOL_API_MODE",
	"ACE_TOOL_BASE_URL",
	"ACE_TOOL_TOKEN",
	"ACE_TOOL_AUGMENT_SESSION_PATH",
	"ACE_TOOL_AUGMENT_AUTH_URL",
	"ACE_TOOL_MAX_LINES_PER_BLOB",
	"ACE_TOOL_RETRIEVAL_TIMEOUT_SECS",
	"ACE_TOOL_UPLOAD_TIMEOUT_SECS",
	"ACE_TOOL_UPLOAD_CONCURRENCY",
	"ACE_TOOL_MAX_FILE_BYTES",
	"ACE_TOOL_MAX_BATCH_BYTES",
	"ACE_TOOL_INDEX_DIR",
	"ACE_TOOL_INDEX_FILE",
	"ACE_TOOL_ALLOW_HTTP",
	"ACE_TOOL_AUTO_INDEX_ON_SESSION_START",
	"ACE_TOOL_PROMPT_ENHANCER_MODE",
	"ACE_TOOL_PROMPT_ENHANCER_MODEL",
	"ACE_TOOL_PROMPT_ENHANCER_INCLUDE_SEARCH_CONTEXT",
];

function envOverrideSummary(): string {
	const count = CONFIG_ENV_NAMES.filter((name) => process.env[name]?.trim()).length;
	return count > 0 ? `${count} override(s)` : "none";
}

function padLabel(label: string, width = 13): string {
	return label.padEnd(width, " ");
}

function kv(label: string, value: string | number | boolean | undefined): string {
	return `${padLabel(label)} ${value === undefined || value === "" ? "-" : value}`;
}

function section(title: string, rows: string[]): string {
	return [`─ ${title}`, ...rows.map((row) => `  ${row}`)].join("\n");
}

function nextActionText(configIssues: string[], fileCount: number): string {
	if (configIssues.length > 0) return "run /ace-config";
	if (fileCount === 0) return "run /ace-init then /ace-index";
	return "ready; use search_context when semantic discovery is useful";
}

function messageContentToText(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.map((part) => {
			if (part && typeof part === "object" && (part as { type?: string }).type === "text") return (part as { text?: string }).text ?? "";
			return "";
		})
		.filter(Boolean)
		.join("\n");
}

function buildRecentConversationHistory(ctx: { sessionManager?: { getBranch?: () => unknown[] } }, maxMessages = 10): string {
	const branch = ctx.sessionManager?.getBranch?.() ?? [];
	const lines: string[] = [];
	for (const entry of branch.slice().reverse()) {
		const message = (entry as { message?: { role?: string; content?: unknown } }).message;
		if (!message || (message.role !== "user" && message.role !== "assistant")) continue;
		const text = messageContentToText(message.content).trim();
		if (!text) continue;
		lines.push(`${message.role === "user" ? "User" : "Assistant"}: ${firstLine(text, 4000)}`);
		if (lines.length >= maxMessages) break;
	}
	return lines.reverse().join("\n");
}

function resolvePromptEnhancerModel(ctx: { model?: Model<Api>; modelRegistry?: ConfigUiContext["modelRegistry"] }, config: ReturnType<typeof loadConfig>): Model<Api> | undefined {
	if (config.promptEnhancerModel) {
		const parsed = parseModelKey(config.promptEnhancerModel);
		if (parsed) return ctx.modelRegistry?.find(parsed.provider, parsed.modelId);
	}
	return ctx.model;
}

function parseEnhanceArgs(args: string): { prompt: string; send: boolean; projectRoot?: string; includeContextOverride?: boolean } {
	const parts = args.trim().split(/\s+/).filter(Boolean);
	let send = false;
	let projectRoot: string | undefined;
	let includeContextOverride: boolean | undefined;
	const rest: string[] = [];
	for (let index = 0; index < parts.length; index += 1) {
		const part = parts[index];
		if (part === "--send") {
			send = true;
			continue;
		}
		if (part === "--context") {
			includeContextOverride = true;
			continue;
		}
		if (part === "--no-context") {
			includeContextOverride = false;
			continue;
		}
		if (part === "--project" && parts[index + 1]) {
			projectRoot = parts[index + 1];
			index += 1;
			continue;
		}
		rest.push(part);
	}
	return { prompt: stripEnhanceMarkers(rest.join(" ")).trim(), send, projectRoot, includeContextOverride };
}

function buildStatusPanel(options: {
	cwd: string;
	projectRoot: string;
	indexPath: string;
	fileCount: number;
	blobCount: number;
	configHash: string;
}): { text: string; level: "info" | "warning" } {
	const config = loadConfig(options.cwd);
	const issues = validateConfig(config);
	const projectConfig = readStoredConfig("project", options.cwd);
	const globalConfig = readStoredConfig("global", options.cwd);
	const projectKeys = Object.keys(projectConfig).length;
	const globalKeys = Object.keys(globalConfig).length;
	const configured = issues.length === 0;
	const indexed = options.fileCount > 0 && options.blobCount > 0;
	const augmentSession = readAugmentSessionSource(config.augmentSessionPath);

	const text = [
		"ace-tool status",
		"",
		section("health", [
			kv("config", configured ? "configured" : "missing"),
			kv("index", indexed ? "ready" : "empty"),
			kv("next", nextActionText(issues, options.fileCount)),
		]),
		"",
		section("config", [
			kv("apiMode", config.apiMode),
			kv("baseUrl", config.baseUrl || "not set"),
			kv("token", maskSecret(config.token)),
			kv("augment", augmentSession.session ? `logged in (${augmentSession.source})` : "not logged in"),
			kv("tenant", augmentSession.session?.tenantURL || "not set"),
			kv("project", projectKeys ? `${projectKeys} setting(s)` : "not set"),
			kv("global", globalKeys ? `${globalKeys} setting(s)` : "not set"),
			kv("env", envOverrideSummary()),
			kv("autoIndex", config.autoIndexOnSessionStart ? "on" : "off"),
			kv("enhancer", config.promptEnhancerMode),
			kv("enhModel", config.promptEnhancerModel || "current"),
			kv("enhContext", config.promptEnhancerIncludeSearchContext ? "on" : "off"),
		]),
		"",
		section("index", [
			kv("files", options.fileCount),
			kv("blobs", options.blobCount),
			kv("chunkLines", config.maxLinesPerBlob),
			kv("upload", `${config.uploadConcurrency ?? "auto"} concurrency · ${Math.round(config.uploadTimeoutMs / 1000)}s timeout`),
			kv("retrieval", `${Math.round(config.retrievalTimeoutMs / 1000)}s timeout`),
			kv("apiIdentity", compactPath(getAceApiIdentity(config), 72)),
			kv("hash", options.configHash),
		]),
		"",
		section("paths", [
			kv("project", compactPath(options.projectRoot, 72)),
			kv("indexFile", compactPath(options.indexPath, 72)),
		]),
		...(issues.length > 0 ? ["", section("issues", issues.map((issue) => `! ${issue}`))] : []),
	].join("\n");

	return { text, level: configured ? "info" : "warning" };
}

function maskSecret(value: string | undefined): string {
	if (!value) return "not set";
	if (value.length <= 8) return "********";
	return `${value.slice(0, 4)}...${value.slice(-4)}`;
}

function compactPath(value: string | undefined, maxLength = 56): string {
	if (!value) return "current project";
	const normalized = value.replace(/\\/g, "/");
	if (normalized.length <= maxLength) return normalized;
	const tail = normalized.slice(-(maxLength - 1));
	return `…${tail}`;
}

function firstLine(value: unknown, maxLength = 72): string {
	const text = typeof value === "string" ? value.trim().split(/\r?\n/)[0] ?? "" : "";
	if (!text) return "semantic code search";
	return text.length <= maxLength ? text : `${text.slice(0, maxLength - 1)}…`;
}

function statChip(label: string, value: string | number | undefined): string {
	if (value === undefined) return "";
	return `${label} ${value}`;
}

const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

function spinnerFrame(frame: number | undefined): string {
	return SPINNER_FRAMES[(frame ?? 0) % SPINNER_FRAMES.length] ?? "·";
}

function progressStage(message: string): string {
	const lower = message.toLowerCase();
	if (lower.includes("scanning")) return "scanning";
	if (lower.includes("upload")) return "uploading";
	if (lower.includes("search")) return "searching";
	if (lower.includes("adaptive")) return "tuning";
	if (lower.includes("process") || lower.includes("found")) return "indexing";
	return "working";
}

function formatElapsed(startedAt: number | undefined): string {
	if (!startedAt) return "";
	const seconds = Math.max(0, Math.round((Date.now() - startedAt) / 1000));
	return seconds < 60 ? `${seconds}s` : `${Math.floor(seconds / 60)}m${String(seconds % 60).padStart(2, "0")}s`;
}

function progressStageZh(message: string): string {
	const lower = message.toLowerCase();
	if (lower.includes("scanning")) return "扫描文件";
	if (lower.includes("upload")) return "上传索引";
	if (lower.includes("search")) return "检索上下文";
	if (lower.includes("enhanc")) return "等待模型增强";
	if (lower.includes("process") || lower.includes("found")) return "处理索引";
	return "处理中";
}

function enhanceWaitingLines(options: {
	frame: number;
	startedAt: number;
	mode: string;
	model?: string;
	includeContext: boolean;
	status: string;
	prompt: string;
}): string[] {
	const stage = progressStageZh(options.status);
	return [
		`${spinnerFrame(options.frame)} ace-enhance · ${stage} · ${formatElapsed(options.startedAt)}`,
		`模式：${options.mode}${options.model ? ` · 模型：${options.model}` : ""}`,
		`代码库上下文：${options.includeContext ? "开启" : "关闭"}`,
		`状态：${options.status}`,
		`提示词：${firstLine(options.prompt, 96)}`,
	];
}

function renderSearchPreview(content: unknown, maxLines = 8): string[] {
	if (!Array.isArray(content)) return [];
	const textContent = content.find((item) => item?.type === "text") as { text?: string } | undefined;
	if (!textContent?.text) return [];
	return textContent.text
		.split(/\r?\n/)
		.map((line) => line.trimEnd())
		.filter(Boolean)
		.slice(0, maxLines)
		.map((line) => line.length > 110 ? `${line.slice(0, 109)}…` : line);
}

function parseScopeArg(args: string): AceToolConfigScope | undefined {
	const normalized = args.trim().toLowerCase();
	if (normalized.includes("global")) return "global";
	if (normalized.includes("project") || normalized.includes("local")) return "project";
	return undefined;
}

type ConfigTheme = {
	fg: (color: "accent" | "muted" | "dim" | "warning", text: string) => string;
	bold: (text: string) => string;
};

type ConfigUiContext = {
	cwd: string;
	hasUI: boolean;
	modelRegistry?: {
		getAvailable: () => Model<Api>[];
		find: (provider: string, modelId: string) => Model<Api> | undefined;
		getApiKeyAndHeaders: (model: Model<Api>) => Promise<{ ok: true; apiKey?: string; headers?: Record<string, string> } | { ok: false; error: string }>;
	};
	ui: {
		select: (title: string, items: string[]) => Promise<string | undefined>;
		input: (title: string, placeholder?: string) => Promise<string | undefined>;
		confirm: (title: string, message: string) => Promise<boolean>;
		notify: (message: string, level?: "info" | "warning" | "error") => void;
		setStatus: (key: string, value: string | undefined) => void;
		custom?: <T>(
			factory: (tui: TUI, theme: ConfigTheme, keybindings: unknown, done: (result: T) => void) => Component | Promise<Component>,
			options?: { overlay?: boolean },
		) => Promise<T>;
	};
};

type ConfigFieldKind = "string" | "secret" | "number" | "boolean";

type ConfigField = {
	key: keyof StoredAceToolConfig;
	env: string;
	label: string;
	kind: ConfigFieldKind;
	description: string;
	defaultValue?: string | number | boolean;
	required?: boolean;
};

const BASIC_CONFIG_FIELDS: ConfigField[] = [
	{ key: "baseUrl", env: "ACE_TOOL_BASE_URL", label: "兼容 API 基础地址", kind: "string", description: "compat 或 auto 回退模式下使用的 Augment 兼容 API 基础地址。official-oauth 模式会改用 Augment OAuth session 中的 tenantURL。" },
	{ key: "token", env: "ACE_TOOL_TOKEN", label: "兼容 API Token", kind: "secret", description: "compat 或 auto 回退模式下使用的 Bearer Token。official-oauth 模式不使用该字段。配置文件会以 0600 权限写入，但环境变量仍然拥有最高优先级。" },
];

const ADVANCED_CONFIG_FIELDS: ConfigField[] = [
	{ key: "maxLinesPerBlob", env: "ACE_TOOL_MAX_LINES_PER_BLOB", label: "每个 blob 最大行数", kind: "number", defaultValue: 800, description: "每个索引代码块的最大源码行数。数值越小，检索粒度越细但上传块更多；数值越大，块数量更少但检索上下文更粗。" },
	{ key: "retrievalTimeoutSecs", env: "ACE_TOOL_RETRIEVAL_TIMEOUT_SECS", label: "检索超时秒数", kind: "number", defaultValue: 60, description: "远程语义检索和官方提示词增强请求的超时时间。只有在 API 较慢或项目很大时才建议调高。" },
	{ key: "uploadTimeoutSecs", env: "ACE_TOOL_UPLOAD_TIMEOUT_SECS", label: "上传超时秒数", kind: "number", defaultValue: 30, description: "上传批次的基础超时时间。自适应上传器可能会按运行情况调整；该值作为初始值或覆盖值。" },
	{ key: "uploadConcurrency", env: "ACE_TOOL_UPLOAD_CONCURRENCY", label: "上传并发度", kind: "number", defaultValue: "auto", description: "手动覆盖上传并发度。建议保持未设置以使用自适应策略；过高可能导致限流或超时。" },
	{ key: "maxFileBytes", env: "ACE_TOOL_MAX_FILE_BYTES", label: "单文件最大字节数", kind: "number", defaultValue: 128 * 1024, description: "允许索引的单文件最大大小。超过该大小的文件会被跳过，避免上传生成物或大型数据文件。" },
	{ key: "maxBatchBytes", env: "ACE_TOOL_MAX_BATCH_BYTES", label: "单批上传最大字节数", kind: "number", defaultValue: 1024 * 1024, description: "每个上传批次的 JSON 载荷最大大小。如果网关拒绝较大的请求，可以调低该值。" },
	{ key: "indexDirName", env: "ACE_TOOL_INDEX_DIR", label: "索引目录", kind: "string", defaultValue: ".ace-tool", description: "本地 ace-tool 缓存目录。扩展会尽力把该目录加入 .gitignore。" },
	{ key: "indexFileName", env: "ACE_TOOL_INDEX_FILE", label: "索引文件名", kind: "string", defaultValue: "index.json", description: "索引目录内的本地索引缓存文件名。只有需要多个独立缓存时才建议修改。" },
	{ key: "augmentSessionPath", env: "ACE_TOOL_AUGMENT_SESSION_PATH", label: "Augment Session 路径", kind: "string", defaultValue: getDefaultAugmentSessionPath(), description: "official-oauth / auto 模式读取和 /ace-login 写入的 Augment OAuth session 文件。默认复用 auggie 的 ~/.augment/session.json。" },
	{ key: "augmentAuthUrl", env: "ACE_TOOL_AUGMENT_AUTH_URL", label: "Augment OAuth 地址", kind: "string", defaultValue: "https://auth.augmentcode.com", description: "Augment OAuth 登录入口。通常保持官方默认值即可。" },
	{ key: "allowHttp", env: "ACE_TOOL_ALLOW_HTTP", label: "允许 HTTP 地址", kind: "boolean", defaultValue: false, description: "是否允许明文 http:// API 地址。默认 false，会为了安全把 http:// 升级为 https://，与 ace-tool-rs 行为一致。" },
	{ key: "autoIndexOnSessionStart", env: "ACE_TOOL_AUTO_INDEX_ON_SESSION_START", label: "会话启动自动索引", kind: "boolean", defaultValue: false, description: "设为 true 时，pi 会话启动后会在后台执行索引/上传。默认 false，用于避免无感远程上传。" },
];

function scopeName(scope: AceToolConfigScope): string {
	return scope === "global" ? "全局" : "项目";
}

function updateConfigStatus(ctx: ConfigUiContext): void {
	const config = loadConfig(ctx.cwd);
	ctx.ui.setStatus("ace-tool", validateConfig(config).length > 0 ? "ace: unconfigured" : undefined);
}

function apiModeLabel(mode: AceApiMode | undefined): string {
	return mode ?? "compat";
}

const API_MODE_DETAILS = [
	"选择 search_context / /ace-index / official /ace-enhance 使用哪条 API 链路。",
	"",
	"compat：继续使用 ACE_TOOL_BASE_URL + ACE_TOOL_TOKEN 指向的 Augment 兼容中转。",
	"official-oauth：读取 Augment OAuth session，直连 session.tenantURL；需要先 /ace-login 或设置 AUGMENT_SESSION_AUTH。",
	"auto：优先 official-oauth；没有 session 时回退 compat。",
	"",
	"环境变量：ACE_TOOL_API_MODE",
	"配置文件字段：apiMode",
	"默认值：compat",
].join("\n");

async function configureApiMode(ctx: ConfigUiContext, scope: AceToolConfigScope): Promise<void> {
	const stored = readStoredConfig(scope, ctx.cwd);
	const choice = await selectConfigItem(ctx, "选择 ace-tool API 模式", [
		{
			value: "compat",
			label: "compat（兼容中转）",
			description: "使用 ACE_TOOL_BASE_URL + ACE_TOOL_TOKEN。",
			details: "保持当前行为：search_context、索引上传和 official prompt enhancer 都走已配置的 Augment 兼容 API 中转。适合已有中转可用、或需要回退兼容时使用。",
		},
		{
			value: "official-oauth",
			label: "official-oauth（官方直连）",
			description: "使用 Augment OAuth session 直连官方 tenant API。",
			details: "优先推荐的新模式。需要先运行 /ace-login，或由 auggie login 生成 ~/.augment/session.json，也可设置 AUGMENT_SESSION_AUTH。不会使用 ACE_TOOL_BASE_URL / ACE_TOOL_TOKEN。",
		},
		{
			value: "auto",
			label: "auto（官方优先，兼容回退）",
			description: "有官方 session 就直连官方；否则回退中转。",
			details: "适合过渡期使用。存在 AUGMENT_SESSION_AUTH 或 session 文件时走 official-oauth；没有 session 时走 compat。",
		},
		{ value: "clear", label: "清除 / 使用默认值", description: "删除 apiMode 字段，回到默认 compat。", details: "清除 apiMode 字段；默认值为 compat。" },
	]);
	if (!choice) return;
	const config = { ...stored };
	if (choice === "clear") delete config.apiMode;
	else config.apiMode = choice as AceApiMode;
	writeStoredConfig(scope, ctx.cwd, config);
	updateConfigStatus(ctx);
	ctx.ui.notify(`已保存 API 模式到${scopeName(scope)}配置：${choice === "clear" ? "compat(default)" : choice}`, "info");
}

function progressStatus(message: string): string {
	const lower = message.toLowerCase();
	const processed = message.match(/Processed\s+(\d+)\/(\d+)\s+files/i);
	if (processed) return `ace: indexing ${processed[1]}/${processed[2]}`;
	const found = message.match(/Found\s+(\d+)\s+files/i);
	if (found) return `ace: indexing 0/${found[1]}`;
	const uploadStart = message.match(/Uploading\s+(\d+)\s+new chunks/i);
	if (uploadStart) return `ace: uploading ${uploadStart[1]} chunks`;
	const uploadBatches = message.match(/Uploaded\s+(\d+)\/(\d+)\s+batches/i) ?? message.match(/started:\s+(\d+)\s+batches/i);
	if (uploadBatches) return uploadBatches[2] ? `ace: uploading ${uploadBatches[1]}/${uploadBatches[2]}` : `ace: uploading 0/${uploadBatches[1]}`;
	const searching = message.match(/Searching\s+(\d+)\s+chunks/i);
	if (searching) return `ace: searching ${searching[1]} chunks`;
	if (lower.includes("scanning")) return "ace: scanning";
	if (lower.includes("upload")) return "ace: uploading";
	if (lower.includes("search")) return "ace: searching";
	if (lower.includes("enhanc")) return "ace: enhancing";
	if (lower.includes("process") || lower.includes("found")) return "ace: indexing";
	return "ace: working";
}

type AceStatusContext = { ui: { setStatus: (key: string, value: string | undefined) => void } };
let aceStatusSeq = 0;
let activeAceStatusOwner = 0;

function beginAceStatus(ctx: AceStatusContext, initial: string): { update: (value: string) => void; progress: (message: string) => void; finish: (value: string, clearAfterMs?: number) => void; clear: () => void } {
	const owner = ++aceStatusSeq;
	activeAceStatusOwner = owner;
	ctx.ui.setStatus("ace-tool", initial);
	const clearIfOwner = () => {
		if (activeAceStatusOwner === owner) {
			ctx.ui.setStatus("ace-tool", undefined);
			activeAceStatusOwner = 0;
		}
	};
	return {
		update(value: string) {
			if (activeAceStatusOwner === owner) ctx.ui.setStatus("ace-tool", value);
		},
		progress(message: string) {
			if (activeAceStatusOwner === owner) ctx.ui.setStatus("ace-tool", progressStatus(message));
		},
		finish(value: string, clearAfterMs = 1600) {
			if (activeAceStatusOwner !== owner) return;
			ctx.ui.setStatus("ace-tool", value);
			setTimeout(clearIfOwner, clearAfterMs);
		},
		clear: clearIfOwner,
	};
}

function buildAceSystemPrompt(cwd: string, options: Pick<BuildSystemPromptOptions, "selectedTools">): string {
	const config = loadConfig(cwd);
	const issues = validateConfig(config);
	if (issues.length > 0) {
		return "Ace search_context unavailable: do not call it until the user configures ace-tool with /ace-config or logs in with /ace-login.";
	}

	const selectedTools = new Set(options.selectedTools ?? []);
	const hasSelection = Boolean(options.selectedTools);
	const hasTool = (name: string) => !hasSelection || selectedTools.has(name);
	const companionTools = [
		hasTool("read") ? "- Use read after search_context identifies candidate files, and whenever the file path is already known." : "",
		hasTool("bash") ? "- Use bash with rg/grep/find/ls for exact identifiers, literal text, directory listing, and exhaustive reference searches." : "",
		hasTool("edit") ? "- Use edit for precise changes after the target file and exact old text are known." : "",
		hasTool("write") ? "- Use write for new files or intentional full rewrites; do not use search_context for file modification." : "",
	].filter(Boolean);

	return [
		"## Ace search_context routing",
		"search_context is the primary tool for semantic codebase discovery. Use it more often when the task depends on project implementation details that are not already located.",
		"",
		"Call search_context early when:",
		"- relevant files, components, implementation flows, architecture, behavior, or tests are unknown;",
		"- the user gives a natural-language coding task and you need project-specific context before planning or editing;",
		"- grep/find would be too broad, or you do not know reliable exact keywords yet.",
		"",
		"Do not call search_context when:",
		"- exact file paths or exact symbols are already known and a direct read or literal search is enough;",
		"- you need exhaustive references, directory listing, file contents, or file modifications;",
		"- search_context already returned candidate files and the next step is verification or editing.",
		...(companionTools.length > 0 ? ["", "Keep using other tools:", ...companionTools] : []),
		"",
		"Search query format: concise natural language plus optional exact keywords from the user's request. Set project_root_path only when searching outside the current project.",
	].join("\n");
}

function hasSearchContextTool(event: { systemPromptOptions?: { selectedTools?: unknown } }): boolean {
	const selectedTools = event.systemPromptOptions?.selectedTools;
	if (!Array.isArray(selectedTools)) return true;
	return selectedTools.some((tool) => {
		if (typeof tool === "string") return tool === "search_context";
		if (tool && typeof tool === "object" && "name" in tool) {
			return (tool as { name?: unknown }).name === "search_context";
		}
		return false;
	});
}

function configFieldDetails(field: ConfigField, config: StoredAceToolConfig): string {
	return [
		field.description,
		`环境变量：${field.env}`,
		`配置字段：${String(field.key)}`,
		`当前值：${formatStoredValue(field, config)} · 默认：${field.defaultValue === undefined ? "无" : field.defaultValue}`,
		`必填：${field.required ? "是" : "否"} · 优先级：环境变量 > 项目 > 全局 > 默认`,
	].join("\n");
}

function formatStoredValue(field: ConfigField, config: StoredAceToolConfig): string {
	const value = config[field.key];
	if (value === undefined || value === "") {
		return field.defaultValue === undefined ? "未设置" : `默认值：${field.defaultValue}`;
	}
	if (field.kind === "secret") return maskSecret(String(value));
	return String(value);
}

function fieldChoice(field: ConfigField, config: StoredAceToolConfig): string {
	const mark = field.required ? "*" : " ";
	return `${mark} ${field.env} (${field.label}) = ${formatStoredValue(field, config)}`;
}

type ConfigSelectItem = {
	value: string;
	label: string;
	description?: string;
	details?: string;
};

function selectTheme(theme: ConfigTheme): SelectListTheme {
	return {
		selectedPrefix: (text) => theme.fg("accent", text),
		selectedText: (text) => theme.fg("accent", text),
		description: (text) => theme.fg("muted", text),
		scrollInfo: (text) => theme.fg("dim", text),
		noMatch: (text) => theme.fg("warning", text),
	};
}

const CONFIG_DETAIL_PREVIEW_LINES = 5;

function fixedDetailLines(value: string, width: number, lineCount = CONFIG_DETAIL_PREVIEW_LINES): string[] {
	const maxWidth = Math.max(20, width - 4);
	const source = value
		.split(/\r?\n/)
		.map((line) => line.replace(/\s+/g, " ").trim())
		.filter(Boolean);
	const lines = source.slice(0, lineCount).map((line) => truncateToWidth(line, maxWidth, "…"));
	while (lines.length < lineCount) lines.push("");
	return lines;
}

async function selectConfigItem(ctx: ConfigUiContext, title: string, items: ConfigSelectItem[], maxVisible = 8): Promise<string | undefined> {
	if (!ctx.ui.custom) {
		const labels = items.map((item) => item.label);
		const choice = await ctx.ui.select(title, labels);
		return items.find((item) => item.label === choice)?.value;
	}

	return ctx.ui.custom<string | undefined>((tui, theme, _keybindings, done) => {
		const selectListItems: SelectItem[] = items.map((item) => ({ value: item.value, label: item.label, description: item.description }));
		const selectList = new SelectList(selectListItems, Math.min(maxVisible, Math.max(1, selectListItems.length)), selectTheme(theme), {
			minPrimaryColumnWidth: 28,
			maxPrimaryColumnWidth: 72,
		});
		const detailByValue = new Map(items.map((item) => [item.value, item.details || item.description || ""]));
		selectList.onSelect = (item) => done(item.value);
		selectList.onCancel = () => done(undefined);
		return {
			render(width: number): string[] {
				const selected = selectList.getSelectedItem();
				const details = selected ? detailByValue.get(selected.value) ?? "" : "";
				const detailLines = fixedDetailLines(details, width)
					.map((line) => `  ${line ? theme.fg("muted", line) : ""}`);
				return [
					theme.fg("accent", theme.bold(title)),
					"",
					...detailLines,
					"",
					...selectList.render(width),
					"",
					theme.fg("dim", "↑↓ 切换 · Enter 选择/编辑 · Esc 返回"),
				];
			},
			invalidate() {
				selectList.invalidate();
			},
			handleInput(data: string) {
				selectList.handleInput(data);
				tui.requestRender();
			},
		};
	});
}

async function chooseScope(ctx: ConfigUiContext, args: string): Promise<AceToolConfigScope | undefined> {
	const fromArgs = parseScopeArg(args);
	if (fromArgs) return fromArgs;
	const choice = await selectConfigItem(ctx, "ace-tool 配置：选择要编辑的位置", [
		{
			value: "global",
			label: "全局配置 (~/.pi/agent/ace-tool.json)",
			description: "默认作用于所有项目；可被项目配置和环境变量覆盖。",
			details: [
				"编辑全局配置：~/.pi/agent/ace-tool.json",
				"适合保存通用 API 地址、Token、提示词增强偏好等跨项目配置。",
				"优先级：环境变量 > 项目配置 > 全局配置 > 默认值。",
			].join("\n"),
		},
		{
			value: "project",
			label: "项目配置 (.pi/ace-tool.json)",
			description: "只作用于当前项目；优先级高于全局配置。",
			details: [
				"编辑项目配置：.pi/ace-tool.json",
				"适合保存当前仓库专用设置，例如独立 API 地址、索引参数或增强策略。",
				"注意：.pi/ 默认会被忽略，避免把 Token 提交到仓库。",
			].join("\n"),
		},
		{
			value: "clear",
			label: "清除配置",
			description: "删除项目或全局配置文件。",
			details: "选择后会再询问要清除项目配置还是全局配置，并在删除前二次确认。",
		},
		{
			value: "exit",
			label: "退出",
			description: "不修改任何配置。",
			details: "关闭配置向导。",
		},
	]);
	if (!choice || choice === "exit") return undefined;
	if (choice === "clear") {
		await clearConfigFlow(ctx, args);
		return undefined;
	}
	return choice === "global" ? "global" : "project";
}

async function clearConfigFlow(ctx: ConfigUiContext, args: string): Promise<void> {
	let scope = parseScopeArg(args);
	if (!scope) {
		const choice = await selectConfigItem(ctx, "要清除哪一份 ace-tool 配置？", [
			{
				value: "global",
				label: "全局配置 (~/.pi/agent/ace-tool.json)",
				description: "删除全局配置文件。",
				details: `将删除：${getConfigFilePath("global", ctx.cwd)}\n删除后会退回到项目配置、环境变量或默认值。`,
			},
			{
				value: "project",
				label: "项目配置 (.pi/ace-tool.json)",
				description: "删除当前项目配置文件。",
				details: `将删除：${getConfigFilePath("project", ctx.cwd)}\n删除后当前项目会使用全局配置、环境变量或默认值。`,
			},
			{ value: "cancel", label: "取消", description: "不删除任何配置。", details: "返回上一级菜单。" },
		]);
		if (!choice || choice === "cancel") return;
		scope = choice === "global" ? "global" : "project";
	}
	const ok = await ctx.ui.confirm("清除 ace-tool 配置？", `删除 ${getConfigFilePath(scope, ctx.cwd)}？`);
	if (!ok) return;
	const filePath = deleteStoredConfig(scope, ctx.cwd);
	updateConfigStatus(ctx);
	ctx.ui.notify(`已删除 ${scopeName(scope)} ace-tool 配置：\n${filePath}`, "info");
}

async function editStringField(ctx: ConfigUiContext, scope: AceToolConfigScope, field: ConfigField, config: StoredAceToolConfig): Promise<boolean> {
	const current = formatStoredValue(field, config);
	const title = `设置 ${field.env}（${field.label}）`;
	const placeholder = field.kind === "secret"
		? `当前值：${current}。注意：输入内容会明文显示。留空 = 保持不变，输入 '-' = 清除。`
		: `当前值：${current}。留空 = 保持不变，输入 '-' = 清除。`;
	const value = await ctx.ui.input(title, placeholder);
	if (value === undefined) return false;
	const trimmed = value.trim();
	if (!trimmed) return false;
	if (trimmed === "-") {
		delete config[field.key];
	} else {
		(config as Record<string, unknown>)[field.key] = trimmed;
	}
	writeStoredConfig(scope, ctx.cwd, config);
	updateConfigStatus(ctx);
	return true;
}

async function editNumberField(ctx: ConfigUiContext, scope: AceToolConfigScope, field: ConfigField, config: StoredAceToolConfig): Promise<boolean> {
	const value = await ctx.ui.input(
		`设置 ${field.env}（${field.label}）`,
		`当前值：${formatStoredValue(field, config)}。请输入正整数；留空 = 保持不变，输入 '-' = 清除。`,
	);
	if (value === undefined) return false;
	const trimmed = value.trim();
	if (!trimmed) return false;
	if (trimmed === "-") {
		delete config[field.key];
		writeStoredConfig(scope, ctx.cwd, config);
		updateConfigStatus(ctx);
		return true;
	}
	const parsed = Number.parseInt(trimmed, 10);
	if (!Number.isFinite(parsed) || parsed <= 0) {
		ctx.ui.notify(`${field.env} 必须是正整数。`, "warning");
		return false;
	}
	(config as Record<string, unknown>)[field.key] = parsed;
	writeStoredConfig(scope, ctx.cwd, config);
	updateConfigStatus(ctx);
	return true;
}

async function editBooleanField(ctx: ConfigUiContext, scope: AceToolConfigScope, field: ConfigField, config: StoredAceToolConfig): Promise<boolean> {
	const choice = await selectConfigItem(ctx, `设置 ${field.env}（${field.label}）`, [
		{ value: "false", label: "false（推荐）", description: "关闭此开关。", details: `${field.description}\n\n将 ${field.env} 保存为 false。` },
		{ value: "true", label: "true", description: "开启此开关。", details: `${field.description}\n\n将 ${field.env} 保存为 true。` },
		{ value: "clear", label: "清除 / 使用默认值", description: "删除配置文件字段。", details: `删除 ${String(field.key)} 字段；之后使用环境变量、上级配置或默认值。` },
		{ value: "cancel", label: "取消", description: "不修改此设置。", details: "返回上一级菜单。" },
	]);
	if (!choice || choice === "cancel") return false;
	if (choice === "clear") {
		delete config[field.key];
	} else {
		(config as Record<string, unknown>)[field.key] = choice === "true";
	}
	writeStoredConfig(scope, ctx.cwd, config);
	updateConfigStatus(ctx);
	return true;
}

function modelKey(model: Model<Api>): string {
	return `${model.provider}/${model.id}`;
}

function parseModelKey(value: string): { provider: string; modelId: string } | undefined {
	const [provider, ...modelParts] = value.split("/");
	const modelId = modelParts.join("/");
	if (!provider || !modelId) return undefined;
	return { provider, modelId };
}

const PROMPT_ENHANCER_MODE_DETAILS = [
	"选择 /ace-enhance 使用哪种方式改写提示词。",
	"",
	"official：调用当前 API 模式解析出的 Augment /prompt-enhancer。compat 用 ACE_TOOL_BASE_URL + ACE_TOOL_TOKEN；official-oauth 用 Augment OAuth session。",
	"pi-model：调用 pi 中已经配置好的文本模型。会复用 pi 的鉴权、请求头、Provider、代理和自定义模型。",
	"",
	"环境变量：ACE_TOOL_PROMPT_ENHANCER_MODE",
	"配置文件字段：promptEnhancerMode",
	"可选值：official、pi-model",
	"默认值：official",
].join("\n");

const PROMPT_ENHANCER_MODEL_DETAILS = [
	"选择 pi-model 模式下 /ace-enhance 使用哪个已配置的 pi 文本模型。",
	"",
	"这里只会列出已经配置鉴权、并且支持文本输入的模型。清除此设置后，会使用当前会话模型。",
	"",
	"环境变量：ACE_TOOL_PROMPT_ENHANCER_MODEL",
	"配置文件字段：promptEnhancerModel",
	"格式：provider/modelId，例如 anthropic/claude-sonnet-4-5",
	"默认值：当前会话模型",
].join("\n");

const PROMPT_ENHANCER_CONTEXT_DETAILS = [
	"是否在提示词增强前先执行 search_context，并把相关代码库上下文注入到增强提示词中。",
	"",
	"这可以改善大型重构、需求澄清、方案设计类提示词，但也可能触发扫描、索引、上传变更代码块，以及一次远程检索。",
	"默认关闭，用于避免额外延迟和无感远程上传。单次执行时也可以用 /ace-enhance --context 或 --no-context 临时覆盖。",
	"",
	"环境变量：ACE_TOOL_PROMPT_ENHANCER_INCLUDE_SEARCH_CONTEXT",
	"配置文件字段：promptEnhancerIncludeSearchContext",
	"默认值：false",
].join("\n");

async function configurePromptEnhancer(ctx: ConfigUiContext, scope: AceToolConfigScope): Promise<void> {
	while (true) {
		const stored = readStoredConfig(scope, ctx.cwd);
		const mode = stored.promptEnhancerMode ?? "official";
		const model = stored.promptEnhancerModel || "not set";
		const includeContext = stored.promptEnhancerIncludeSearchContext ?? false;
		const choice = await selectConfigItem(ctx, `${scopeName(scope)}提示词增强配置`, [
			{
				value: "mode",
				label: `增强模式 = ${mode}`,
				description: "选择 /ace-enhance 使用官方接口还是 pi 模型。",
				details: PROMPT_ENHANCER_MODE_DETAILS,
			},
			{
				value: "model",
				label: `Pi 模型 = ${model}`,
				description: "pi-model 模式下使用的模型；未设置时使用当前会话模型。",
				details: PROMPT_ENHANCER_MODEL_DETAILS,
			},
			{
				value: "context",
				label: `注入代码库上下文 = ${includeContext}`,
				description: "增强前是否先检索并注入 search_context。",
				details: PROMPT_ENHANCER_CONTEXT_DETAILS,
			},
			{ value: "back", label: "返回", description: "回到上一级配置菜单。", details: "返回上一级菜单。" },
		]);
		if (!choice || choice === "back") return;

		if (choice === "mode") {
			const next = await selectConfigItem(ctx, "提示词增强模式", [
				{
					value: "official",
					label: "official（Augment /prompt-enhancer）",
					description: "使用当前 API 模式对应的 Augment 增强接口。",
					details: "调用当前 API 模式解析出的 /prompt-enhancer。compat 使用 ACE_TOOL_BASE_URL + ACE_TOOL_TOKEN；official-oauth 使用 /ace-login 或 AUGMENT_SESSION_AUTH 的官方 tenant API。",
				},
				{
					value: "pi-model",
					label: "pi-model（使用已配置的 pi 模型）",
					description: "复用 pi 中已配置的模型和鉴权。",
					details: "调用 pi 原生模型注册表中的文本模型，不在 ace-tool 扩展里单独维护第三方 API Key。",
				},
				{ value: "clear", label: "清除 / 使用默认值", description: "删除配置文件字段，回到默认 official。", details: "清除 promptEnhancerMode 字段；默认值是 official。" },
				{ value: "cancel", label: "取消", description: "不修改增强模式。", details: "返回提示词增强配置菜单。" },
			]);
			if (!next || next === "cancel") continue;
			const config = { ...stored };
			if (next === "clear") delete config.promptEnhancerMode;
			else config.promptEnhancerMode = next === "pi-model" ? "pi-model" : "official";
			writeStoredConfig(scope, ctx.cwd, config);
			ctx.ui.notify(`已保存提示词增强模式到${scopeName(scope)}配置。`, "info");
			continue;
		}

		if (choice === "model") {
			const available = ctx.modelRegistry?.getAvailable?.().filter((item) => item.input.includes("text")) ?? [];
			if (available.length === 0) {
				ctx.ui.notify("没有找到已配置的 pi 文本模型。请先在 pi 中配置或登录模型，然后再到这里选择。", "warning");
				continue;
			}
			const selected = await selectConfigItem(ctx, "选择提示词增强使用的 pi 模型", [
				...available.slice(0, 80).map((item) => ({
					value: modelKey(item),
					label: `${modelKey(item)} (${item.name})`,
					description: item.provider,
					details: `模型：${modelKey(item)}\n名称：${item.name}\nProvider：${item.provider}\n输入能力：${item.input.join(", ")}`,
				})),
				{ value: "clear", label: "清除 / 使用当前会话模型", description: "删除模型配置。", details: "清除 promptEnhancerModel 字段；pi-model 模式会使用当前会话模型。" },
				{ value: "cancel", label: "取消", description: "不修改模型。", details: "返回提示词增强配置菜单。" },
			]);
			if (!selected || selected === "cancel") continue;
			const config = { ...stored };
			if (selected === "clear") delete config.promptEnhancerModel;
			else config.promptEnhancerModel = selected;
			writeStoredConfig(scope, ctx.cwd, config);
			ctx.ui.notify(`已保存提示词增强 pi 模型到${scopeName(scope)}配置。`, "info");
			continue;
		}

		if (choice === "context") {
			const next = await selectConfigItem(ctx, "提示词增强前是否注入 search_context？", [
				{
					value: "false",
					label: "false（推荐）",
					description: "默认不额外检索代码库上下文。",
					details: "推荐默认关闭，避免 /ace-enhance 触发额外扫描、索引、上传和远程检索。需要时可用 /ace-enhance --context 单次开启。",
				},
				{
					value: "true",
					label: "true",
					description: "增强前自动注入 search_context。",
					details: "适合大型重构、需求澄清、方案设计等需要代码库语义背景的提示词；可能增加延迟并触发远程上传变更块。",
				},
				{ value: "clear", label: "清除 / 使用默认值", description: "删除配置文件字段，回到默认 false。", details: "清除 promptEnhancerIncludeSearchContext 字段；默认值是 false。" },
				{ value: "cancel", label: "取消", description: "不修改上下文注入设置。", details: "返回提示词增强配置菜单。" },
			]);
			if (!next || next === "cancel") continue;
			const config = { ...stored };
			if (next === "clear") delete config.promptEnhancerIncludeSearchContext;
			else config.promptEnhancerIncludeSearchContext = next === "true";
			writeStoredConfig(scope, ctx.cwd, config);
			ctx.ui.notify(`已保存提示词增强上下文设置到${scopeName(scope)}配置。`, "info");
		}
	}
}

async function editConfigField(ctx: ConfigUiContext, scope: AceToolConfigScope, field: ConfigField, config: StoredAceToolConfig): Promise<void> {
	const changed = field.kind === "number"
		? await editNumberField(ctx, scope, field, config)
		: field.kind === "boolean"
			? await editBooleanField(ctx, scope, field, config)
			: await editStringField(ctx, scope, field, config);
	if (changed) {
		ctx.ui.notify(`已保存 ${field.env} 到${scopeName(scope)}配置。`, "info");
	}
}

async function configureAdvancedMenu(ctx: ConfigUiContext, scope: AceToolConfigScope): Promise<void> {
	while (true) {
		const stored = readStoredConfig(scope, ctx.cwd);
		const choice = await selectConfigItem(ctx, `${scopeName(scope)} ace-tool 高级配置`, [
			...ADVANCED_CONFIG_FIELDS.map((field) => ({
				value: String(field.key),
				label: fieldChoice(field, stored),
				description: field.description,
				details: configFieldDetails(field, stored),
			})),
			{ value: "back", label: "返回", description: "回到上一级配置菜单。", details: "返回上一级菜单，不修改高级设置。" },
		]);
		if (!choice || choice === "back") return;
		const field = ADVANCED_CONFIG_FIELDS.find((item) => item.key === choice);
		if (field) {
			await editConfigField(ctx, scope, field, { ...stored });
		}
	}
}

async function configureScopeMenu(ctx: ConfigUiContext, scope: AceToolConfigScope): Promise<void> {
	while (true) {
		const stored = readStoredConfig(scope, ctx.cwd);
		const choice = await selectConfigItem(ctx, `${scopeName(scope)} ace-tool 配置`, [
			{
				value: "api-mode",
				label: `API 模式 = ${apiModeLabel(stored.apiMode)}`,
				description: "选择兼容中转、官方 OAuth 直连或自动回退。",
				details: API_MODE_DETAILS,
			},
			...BASIC_CONFIG_FIELDS.map((field) => ({
				value: String(field.key),
				label: fieldChoice(field, stored),
				description: field.description,
				details: configFieldDetails(field, stored),
			})),
			{
				value: "prompt-enhancer",
				label: "提示词增强配置",
				description: "配置 /ace-enhance 的增强模式、pi 模型和上下文注入。",
				details: "配置 /ace-enhance：选择 official 或 pi-model，指定 pi 模型，并决定是否在增强前注入 search_context 代码库上下文。",
			},
			{
				value: "advanced",
				label: "高级设置",
				description: "索引粒度、超时、并发、缓存目录等高级参数。",
				details: "高级设置包含索引分块、文件大小限制、上传批次、并发、HTTP 安全策略和会话启动自动索引。通常保持默认即可。",
			},
			{ value: "back", label: "返回", description: "回到配置位置选择。", details: "返回上一级菜单。" },
		]);
		if (!choice || choice === "back") return;
		if (choice === "api-mode") {
			await configureApiMode(ctx, scope);
			continue;
		}
		if (choice === "prompt-enhancer") {
			await configurePromptEnhancer(ctx, scope);
			continue;
		}
		if (choice === "advanced") {
			await configureAdvancedMenu(ctx, scope);
			continue;
		}
		const field = BASIC_CONFIG_FIELDS.find((item) => item.key === choice);
		if (field) {
			await editConfigField(ctx, scope, field, { ...stored });
		}
	}
}

async function runConfigWizard(args: string, ctx: ConfigUiContext): Promise<void> {
	if (!ctx.hasUI) {
		throw new Error("/ace-config 需要交互式 UI。非交互模式请通过环境变量设置 ACE_TOOL_API_MODE、ACE_TOOL_BASE_URL / ACE_TOOL_TOKEN，或运行 /ace-login 生成 Augment session。");
	}

	const normalizedArgs = args.trim().toLowerCase();
	if (normalizedArgs.includes("clear") || normalizedArgs.includes("delete") || normalizedArgs.includes("reset")) {
		await clearConfigFlow(ctx, args);
		return;
	}

	const directScope = parseScopeArg(args);
	if (directScope) {
		await configureScopeMenu(ctx, directScope);
		return;
	}

	const scope = await chooseScope(ctx, args);
	if (scope) await configureScopeMenu(ctx, scope);
}

export default function piAceToolExtension(pi: ExtensionAPI) {
	pi.registerTool({
		name: "search_context",
		label: "Search Context",
		description: `IMPORTANT: search_context is the primary semantic codebase discovery tool through an Augment-compatible remote API.

Use search_context early when relevant files, components, implementation flows, architecture, behavior, or tests are unknown, especially before non-trivial code changes driven by natural-language requirements.

Do NOT use search_context for exact identifier grep, exhaustive reference lists, literal text search, directory listing, reading a known file, or modifying files. Use bash/rg/grep/find/ls, read, edit, and write for those jobs when available.

The tool indexes the current project, uploads new or changed code chunks to the configured Augment API, then asks the codebase retrieval endpoint for relevant context. Treat results as navigation and project context; read returned files before making precise changes. Output is truncated to 50KB/2000 lines if necessary.

Configuration:
- compat mode requires ACE_TOOL_BASE_URL and ACE_TOOL_TOKEN.
- official-oauth mode requires /ace-login, ~/.augment/session.json, or AUGMENT_SESSION_AUTH.
- auto mode prefers official-oauth and falls back to compat.`,
		promptSnippet: "Semantic codebase discovery for unknown files, flows, architecture, tests, and project-specific implementation context",
		promptGuidelines: [
			"Use search_context early when the task requires project-specific context and relevant files, flows, architecture, behavior, or tests are unknown.",
			"Do not use search_context for exact identifiers, literal text search, directory listings, known file reads, or edits; use bash/rg/grep/find/ls/read/edit/write for those when available.",
			"After search_context returns likely files, read those files and continue with precise normal tools for verification and changes.",
		],
		parameters: SEARCH_CONTEXT_PARAMS,
		prepareArguments(args): SearchContextParams {
			if (!args || typeof args !== "object") return args as SearchContextParams;
			const input = args as Record<string, unknown>;
			if (typeof input.projectRootPath === "string" && input.project_root_path === undefined) {
				return { ...input, project_root_path: input.projectRootPath } as SearchContextParams;
			}
			return args as SearchContextParams;
		},
		async execute(_toolCallId, params: SearchContextParams, signal, onUpdate, ctx) {
			const config = loadConfig(ctx.cwd);
			const issues = validateConfig(config);
			if (issues.length > 0) {
				ctx.ui.setStatus("ace-tool", "ace: unconfigured");
				throw new Error(`ace-tool configuration error:\n- ${issues.join("\n- ")}`);
			}

			const aceStatus = beginAceStatus(ctx, "ace: indexing");
			const startedAt = Date.now();
			let frame = 0;
			try {
				const result = await runSearchContext(
					{
						query: params.query,
						projectRootPath: params.project_root_path,
					},
					config,
					ctx.cwd,
					(message) => {
						aceStatus.progress(message);
						onUpdate?.({
							content: [{ type: "text", text: message }],
							details: {
								status: message,
								stage: progressStage(message),
								frame: frame++,
								startedAt,
								query: params.query,
							},
						});
					},
					signal,
				);

				return {
					content: [{ type: "text", text: result.text }],
					details: { ...result.details, query: params.query, startedAt },
				};
			} finally {
				aceStatus.clear();
			}
		},

		renderCall(args, theme) {
			let text = theme.fg("toolTitle", theme.bold("search_context"));
			text += " " + theme.fg("accent", `\"${firstLine(args.query)}\"`);
			if (args.project_root_path) {
				text += " " + theme.fg("dim", compactPath(args.project_root_path, 42));
			}
			return new Text(text, 0, 0);
		},

		renderResult(result, { expanded, isPartial }, theme) {
			const details = result.details as SearchContextDetails | undefined;

			if (isPartial) {
				const stage = details?.stage ?? "working";
				const status = details?.status ?? "Working...";
				const elapsed = formatElapsed(details?.startedAt);
				let text = theme.fg("accent", spinnerFrame(details?.frame));
				text += " " + theme.fg("toolTitle", stage);
				if (elapsed) text += " " + theme.fg("dim", elapsed);
				text += "\n" + theme.fg("muted", status);
				if (details?.query) text += "\n" + theme.fg("dim", `\"${firstLine(details.query, 96)}\"`);
				return new Text(text, 0, 0);
			}

			if (!details?.stats) {
				const text = result.content[0];
				return new Text(text?.type === "text" ? theme.fg("dim", firstLine(text.text, 120)) : theme.fg("dim", "No search result"), 0, 0);
			}

			const stats = details.stats;
			const chips = [
				statChip("files", stats.files),
				statChip("blobs", details.blobCount ?? stats.totalBlobs),
				statChip("new", stats.newBlobs),
				statChip("cached", stats.cachedBlobs),
				stats.skippedFiles ? statChip("skipped", stats.skippedFiles) : "",
				stats.deletedFiles ? statChip("deleted", stats.deletedFiles) : "",
			].filter(Boolean);

			const elapsed = formatElapsed(details.startedAt);
			let text = theme.fg("success", "✓ context ready");
			if (elapsed) text += " " + theme.fg("dim", elapsed);
			if (details.partial) text += " " + theme.fg("warning", "partial");
			text += " " + theme.fg("muted", chips.join(" · "));

			if (details.projectRoot) {
				text += "\n" + theme.fg("dim", compactPath(details.projectRoot));
			}

			if (expanded) {
				if (details.files?.length) {
					text += "\n" + theme.fg("muted", "files") + "\n" + details.files.slice(0, 8).map((file) => theme.fg("dim", compactPath(file, 88))).join("\n");
				}
				const preview = renderSearchPreview(result.content);
				if (preview.length > 0) {
					text += "\n" + theme.fg("muted", "preview") + "\n" + preview.map((line) => theme.fg("dim", line)).join("\n");
				}
			}

			return new Text(text, 0, 0);
		},
	});

	pi.registerCommand("ace-status", {
		description: "Show pi-ace-tool configuration and local index status",
		handler: async (args, ctx) => {
			const config = loadConfig(ctx.cwd);
			const projectRoot = normalizeProjectPath(args.trim(), ctx.cwd);
			const configHash = calculateConfigHash(config.maxLinesPerBlob, getAceApiIdentity(config));
			const index = await loadIndex(projectRoot, configHash, config.indexDirName, config.indexFileName);
			const fileCount = Object.keys(index.entries).length;
			const blobCount = Object.values(index.entries).reduce((sum, entry) => sum + entry.blobHashes.length, 0);
			const indexPath = getIndexFilePath(projectRoot, config.indexDirName, config.indexFileName);
			const panel = buildStatusPanel({
				cwd: ctx.cwd,
				projectRoot,
				indexPath,
				fileCount,
				blobCount,
				configHash,
			});
			ctx.ui.notify(panel.text, panel.level);
		},
	});

	pi.registerCommand("ace-login", {
		description: "Authenticate with Augment OAuth and save ~/.augment/session.json for official-oauth mode",
		handler: async (_args, ctx) => {
			const config = loadConfig(ctx.cwd);
			const existing = readAugmentSessionSource(config.augmentSessionPath);
			if (existing.session) {
				const ok = await ctx.ui.confirm(
					"重新登录 Augment？",
					`当前已有 Augment session（${existing.source}）：\n${existing.session.tenantURL}\n\n继续会用新 session 覆盖文件登录状态。`,
				);
				if (!ok) return;
			}

			const flow = createAugmentOAuthFlow(config.augmentAuthUrl);
			const opened = await openBrowser(flow.authorizeUrl);
			ctx.ui.notify(
				[
					"Augment OAuth 登录已开始。",
					opened ? "已尝试打开浏览器。" : "浏览器未能自动打开，请手动访问下面的 URL。",
					"",
					flow.authorizeUrl,
					"",
					"浏览器登录后会显示一段 JSON。复制完整 JSON，然后粘贴到下一步输入框。",
				].join("\n"),
				"info",
			);

			const pasted = await ctx.ui.input("粘贴 Augment OAuth JSON", "粘贴浏览器返回的完整 JSON，例如 {\"code\":...,\"state\":...,\"tenant_url\":...}");
			if (!pasted?.trim()) {
				ctx.ui.notify("Augment OAuth 登录已取消。", "info");
				return;
			}

			const session = await completeAugmentOAuthFlow(flow, pasted, config.augmentSessionPath, ctx.signal);
			ctx.ui.notify(
				[
					"Augment OAuth 登录成功。",
					`tenant: ${session.tenantURL}`,
					`session: ${config.augmentSessionPath || getDefaultAugmentSessionPath()}`,
					"",
					"可在 /ace-config → API 模式 切换到 official-oauth 或 auto。",
				].join("\n"),
				"info",
			);
			updateConfigStatus(ctx);
		},
	});

	pi.registerCommand("ace-logout", {
		description: "Remove local Augment OAuth session used by official-oauth mode",
		handler: async (_args, ctx) => {
			const config = loadConfig(ctx.cwd);
			const source = readAugmentSessionSource(config.augmentSessionPath);
			if (!source.session) {
				ctx.ui.notify("当前没有可用的 Augment OAuth session。", "info");
				return;
			}
			const ok = await ctx.ui.confirm("退出 Augment OAuth？", `清除当前 Augment session？\nsource: ${source.source}\nfile: ${source.path}\n\ntenant: ${source.session.tenantURL}`);
			if (!ok) return;
			if (source.source === "env") delete process.env.AUGMENT_SESSION_AUTH;
			const removed = removeAugmentSession(config.augmentSessionPath);
			ctx.ui.notify(
				[
					"已清除当前进程的 Augment session。",
					`已删除本地 session 文件：${removed}`,
					source.source === "env" ? "注意：无法修改父进程 shell 里的 AUGMENT_SESSION_AUTH；下次启动前请在 shell 中 unset。" : "",
				].filter(Boolean).join("\n"),
				"info",
			);
			updateConfigStatus(ctx);
		},
	});

	pi.registerCommand("ace-clear-index", {
		description: "Clear the local ace-tool index cache for the current project or supplied path",
		handler: async (args, ctx) => {
			const config = loadConfig(ctx.cwd);
			const projectRoot = normalizeProjectPath(args.trim(), ctx.cwd);
			await clearIndex(projectRoot, config.indexDirName, config.indexFileName);
			ctx.ui.notify(`Cleared ace-tool index cache for ${projectRoot}. Run /ace-index to rebuild it now, or let the next search_context call rebuild it.`, "info");
		},
	});

	pi.registerCommand("ace-init", {
		description: "Initialize ace-tool project ignores (.aceignore and .gitignore)",
		handler: async (args, ctx) => {
			const projectRoot = normalizeProjectPath(args.trim(), ctx.cwd);
			const ok = await ctx.ui.confirm(
				"Initialize ace-tool ignores?",
				`This will update .aceignore and .gitignore for:\n${projectRoot}\n\nRecommended ignores protect .pi/, .ace-tool/, env files, keys, certificates, and common build artifacts.`,
			);
			if (!ok) return;
			const result = await initAceProject(projectRoot);
			ctx.ui.notify(
				[
					"ace-tool initialized",
					`projectRoot: ${result.projectRoot}`,
					`aceignore: ${result.aceignorePath}`,
					`gitignore: ${result.gitignorePath}`,
					`aceignore added: ${result.aceignoreAdded.length || 0}`,
					`gitignore added: ${result.gitignoreAdded.length || 0}`,
					"",
					"Tip: run /ace-config next, then /ace-index to pre-index explicitly.",
				].join("\n"),
				"info",
			);
		},
	});

	pi.registerCommand("ace-index", {
		description: "Pre-index the current project or supplied path without running a search",
		handler: async (args, ctx) => {
			const config = loadConfig(ctx.cwd);
			const issues = validateConfig(config);
			if (issues.length > 0) {
				ctx.ui.setStatus("ace-tool", "ace: unconfigured");
				ctx.ui.notify(`ace-tool configuration error:\n- ${issues.join("\n- ")}\n\nRun /ace-config first.`, "warning");
				return;
			}

			const projectRoot = normalizeProjectPath(args.trim(), ctx.cwd);
			const aceStatus = beginAceStatus(ctx, "ace: indexing");
			let statusFinished = false;
			try {
				const result = await indexProject(
					projectRoot,
					config,
					(message) => aceStatus.progress(message),
					ctx.signal,
				);
				ctx.ui.notify(
					`Indexed ${projectRoot}\nfiles: ${result.stats.files}\nblobs: ${result.stats.totalBlobs}\ncached blobs: ${result.stats.cachedBlobs}\nnew blobs: ${result.stats.newBlobs}\nskipped files: ${result.stats.skippedFiles}\ndeleted files: ${result.stats.deletedFiles}`,
					"info",
				);
				aceStatus.finish(`ace: indexed ${result.stats.files} files`);
				statusFinished = true;
			} finally {
				if (!statusFinished) aceStatus.clear();
			}
		},
	});

	pi.registerCommand("ace-enhance", {
		description: "Enhance a prompt. Uses configured official Augment endpoint or selected pi model. Usage: /ace-enhance [--context|--no-context] [--send] [--project <path>] <prompt>",
		handler: async (args, ctx) => {
			const config = loadConfig(ctx.cwd);
			const parsed = parseEnhanceArgs(args);
			const editorText = ctx.ui.getEditorText?.()?.trim() ?? "";
			const prompt = parsed.prompt || stripEnhanceMarkers(editorText);
			if (!prompt) {
				ctx.ui.notify("Usage: /ace-enhance [--context|--no-context] [--send] [--project <path>] <prompt>\n\nTip: you can also type a prompt in the editor first, then run /ace-enhance with no args.", "warning");
				return;
			}

			const model = config.promptEnhancerMode === "pi-model" ? resolvePromptEnhancerModel(ctx, config) : undefined;
			if (config.promptEnhancerMode === "pi-model" && !model) {
				ctx.ui.notify("提示词增强模式是 pi-model，但没有找到可用的 pi 模型。请在 /ace-config → 提示词增强配置 中选择模型，或切换为 official 模式。", "warning");
				return;
			}

			const auth = model ? await ctx.modelRegistry.getApiKeyAndHeaders(model) : undefined;
			if (auth && !auth.ok) {
				ctx.ui.notify(`提示词增强模型鉴权不可用：${auth.error}`, "warning");
				return;
			}

			const projectRoot = normalizeProjectPath(parsed.projectRoot, ctx.cwd);
			const includeSearchContext = parsed.includeContextOverride ?? config.promptEnhancerIncludeSearchContext;
			const issues = validateConfig(config);
			if ((config.promptEnhancerMode === "official" || includeSearchContext) && issues.length > 0) {
				ctx.ui.setStatus("ace-tool", "ace: unconfigured");
				ctx.ui.notify(`ace-tool configuration error:\n- ${issues.join("\n- ")}\n\nOfficial enhancement and context injection require /ace-login or /ace-config. Switch prompt enhancer mode to pi-model and disable context injection to enhance without ACE API config.`, "warning");
				return;
			}
			const aceStatus = beginAceStatus(ctx, includeSearchContext ? "ace: enhancing+context" : "ace: enhancing");
			const startedAt = Date.now();
			let frame = 0;
			let latestStatus = includeSearchContext ? "准备检索代码库上下文..." : "正在等待提示词增强结果...";
			const modelLabel = model ? modelKey(model) : undefined;
			const renderWaiting = () => {
				ctx.ui.setWidget("ace-enhance", enhanceWaitingLines({
					frame: frame++,
					startedAt,
					mode: config.promptEnhancerMode,
					model: modelLabel,
					includeContext: includeSearchContext,
					status: latestStatus,
					prompt,
				}));
			};
			renderWaiting();
			const waitingTimer = setInterval(renderWaiting, 800);
			try {
				const result = await enhancePrompt(config, {
					mode: config.promptEnhancerMode,
					projectRoot,
					prompt,
					conversationHistory: buildRecentConversationHistory(ctx),
					includeSearchContext,
					model,
					auth: auth && auth.ok ? { apiKey: auth.apiKey, headers: auth.headers } : undefined,
					onProgress: (message) => {
						latestStatus = message;
						aceStatus.progress(message);
						renderWaiting();
					},
					signal: ctx.signal,
				});

				clearInterval(waitingTimer);
				ctx.ui.setWidget("ace-enhance", undefined);
				aceStatus.update("ace: reviewing");
				const reviewed = await ctx.ui.editor("Review enhanced prompt", result.text);
				const finalPrompt = (reviewed ?? "").trim();
				if (!finalPrompt) {
					ctx.ui.notify("Prompt enhancement cancelled.", "info");
					return;
				}

				if (parsed.send) {
					pi.sendUserMessage(finalPrompt);
				} else {
					ctx.ui.setEditorText(finalPrompt);
					ctx.ui.notify(
						[
							"Enhanced prompt placed in editor.",
							`mode: ${result.details.mode}`,
							result.details.model ? `model: ${result.details.model}` : "",
							`input: ${result.details.inputChars} chars`,
							`output: ${result.details.outputChars} chars`,
							result.details.includeSearchContext ? `context: ${result.details.contextChars} chars` : "context: off",
						].filter(Boolean).join("\n"),
						"info",
					);
				}
			} finally {
				clearInterval(waitingTimer);
				ctx.ui.setWidget("ace-enhance", undefined);
				aceStatus.clear();
			}
		},
	});

	pi.registerCommand("ace-config", {
		description: "Configure pi-ace-tool interactively. Usage: /ace-config [project|global|clear]",
		handler: async (args, ctx) => {
			await runConfigWizard(args, ctx);
		},
	});

	pi.on("session_start", (_event, ctx) => {
		const config = loadConfig(ctx.cwd);
		const issues = validateConfig(config);
		ctx.ui.setStatus("ace-tool", issues.length > 0 ? "ace: unconfigured" : undefined);
		if (issues.length > 0 || !config.autoIndexOnSessionStart) return;

		void (async () => {
			const aceStatus = beginAceStatus(ctx, "ace: indexing");
			let statusFinished = false;
			try {
				const result = await indexProject(
					ctx.cwd,
					config,
					(message) => aceStatus.progress(message),
					ctx.signal,
				);
				ctx.ui.notify(`ace-tool background index complete: ${result.stats.files} files · ${result.stats.totalBlobs} blobs · ${result.stats.newBlobs} new`, "info");
				aceStatus.finish(`ace: indexed ${result.stats.files} files`);
				statusFinished = true;
			} catch (error) {
				ctx.ui.notify(`ace-tool background index failed: ${error instanceof Error ? error.message : String(error)}`, "warning");
			} finally {
				if (!statusFinished) aceStatus.clear();
			}
		})();
	});

	pi.on("before_agent_start", (event, ctx) => {
		if (!hasSearchContextTool(event)) return;
		return {
			systemPrompt: `${event.systemPrompt}\n\n${buildAceSystemPrompt(ctx.cwd, event.systemPromptOptions)}`,
		};
	});
}
