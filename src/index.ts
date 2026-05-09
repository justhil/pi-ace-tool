import type { Api, Model } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type, type Static } from "typebox";
import path from "node:path";
import {
	deleteStoredConfig,
	getConfigFilePath,
	loadConfig,
	readStoredConfig,
	type AceToolConfigScope,
	type StoredAceToolConfig,
	validateConfig,
	writeStoredConfig,
} from "./config.js";
import { indexProject, runSearchContext } from "./search-context.js";
import { initAceProject } from "./init.js";
import { enhancePrompt, stripEnhanceMarkers } from "./prompt-enhancer.js";
import { clearIndex, getIndexFilePath, loadIndex } from "./cache.js";
import { calculateConfigHash } from "./chunker.js";

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
		`baseUrl: ${config.baseUrl}`,
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
	"ACE_TOOL_BASE_URL",
	"ACE_TOOL_TOKEN",
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
			kv("baseUrl", config.baseUrl || "not set"),
			kv("token", maskSecret(config.token)),
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
	{ key: "baseUrl", env: "ACE_TOOL_BASE_URL", label: "API 基础地址", kind: "string", required: true, description: "Augment 兼容 API 的基础地址，用于 search_context、索引上传、官方提示词增强，以及代码库上下文注入。" },
	{ key: "token", env: "ACE_TOOL_TOKEN", label: "API Token", kind: "secret", required: true, description: "Augment 兼容 API 的 Bearer Token。配置文件会以 0600 权限写入，但环境变量仍然拥有最高优先级。" },
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
	{ key: "allowHttp", env: "ACE_TOOL_ALLOW_HTTP", label: "允许 HTTP 地址", kind: "boolean", defaultValue: false, description: "是否允许明文 http:// API 地址。默认 false，会为了安全把 http:// 升级为 https://，与 ace-tool-rs 行为一致。" },
	{ key: "autoIndexOnSessionStart", env: "ACE_TOOL_AUTO_INDEX_ON_SESSION_START", label: "会话启动自动索引", kind: "boolean", defaultValue: false, description: "设为 true 时，pi 会话启动后会在后台执行索引/上传。默认 false，用于避免无感远程上传。" },
];

const CONFIG_FIELDS: ConfigField[] = [...BASIC_CONFIG_FIELDS, ...ADVANCED_CONFIG_FIELDS];

function scopeName(scope: AceToolConfigScope): string {
	return scope === "global" ? "全局" : "项目";
}

function updateConfigStatus(ctx: ConfigUiContext): void {
	const config = loadConfig(ctx.cwd);
	ctx.ui.setStatus("ace-tool", validateConfig(config).length > 0 ? "ace: unconfigured" : undefined);
}

function progressStatus(message: string): string {
	const lower = message.toLowerCase();
	if (lower.includes("scanning")) return "ace: scanning";
	if (lower.includes("upload")) return "ace: uploading";
	if (lower.includes("search")) return "ace: searching";
	if (lower.includes("enhanc")) return "ace: enhancing";
	if (lower.includes("process") || lower.includes("found")) return "ace: indexing";
	return "ace: working";
}

function buildAceSystemPrompt(cwd: string): string {
	const config = loadConfig(cwd);
	const issues = validateConfig(config);
	if (issues.length > 0) {
		return "Ace search_context unavailable: do not call it until the user configures ace-tool with /ace-config.";
	}

	return "Ace search_context: use only for semantic codebase discovery when relevant files/flows are unknown; use grep/read/find for exact symbols, all references, or known files. Query with concise natural language plus key terms.";
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
		"",
		`环境变量：${field.env}`,
		`配置文件字段：${String(field.key)}`,
		`当前值：${formatStoredValue(field, config)}`,
		`默认值：${field.defaultValue === undefined ? "无" : field.defaultValue}`,
		`是否必填：${field.required ? "是" : "否"}`,
		"",
		"优先级：环境变量 > 项目配置 > 全局配置 > 默认值。"
	].join("\n");
}

async function confirmConfigFieldEdit(ctx: ConfigUiContext, field: ConfigField, config: StoredAceToolConfig): Promise<boolean> {
	return ctx.ui.confirm(`配置 ${field.env}`, `${configFieldDetails(field, config)}\n\n现在编辑这个设置吗？`);
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

function findFieldFromChoice(choice: string): ConfigField | undefined {
	return CONFIG_FIELDS.find((field) => choice.includes(field.env));
}

async function chooseScope(ctx: ConfigUiContext, args: string): Promise<AceToolConfigScope | undefined> {
	const fromArgs = parseScopeArg(args);
	if (fromArgs) return fromArgs;
	const choice = await ctx.ui.select("ace-tool 配置：选择要编辑的位置", [
		"项目配置 (.pi/ace-tool.json)",
		"全局配置 (~/.pi/agent/ace-tool.json)",
		"清除配置",
		"退出",
	]);
	if (!choice || choice === "退出") return undefined;
	if (choice.startsWith("清除")) {
		await clearConfigFlow(ctx, args);
		return undefined;
	}
	return choice.startsWith("全局") ? "global" : "project";
}

async function clearConfigFlow(ctx: ConfigUiContext, args: string): Promise<void> {
	let scope = parseScopeArg(args);
	if (!scope) {
		const choice = await ctx.ui.select("要清除哪一份 ace-tool 配置？", [
			"项目配置 (.pi/ace-tool.json)",
			"全局配置 (~/.pi/agent/ace-tool.json)",
			"取消",
		]);
		if (!choice || choice === "取消") return;
		scope = choice.startsWith("全局") ? "global" : "project";
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
	const choice = await ctx.ui.select(`设置 ${field.env}（${field.label}）`, [
		"false（推荐）",
		"true",
		"清除 / 使用默认值",
		"取消",
	]);
	if (!choice || choice === "取消") return false;
	if (choice.startsWith("清除")) {
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
	"official：调用 Augment 兼容的 /prompt-enhancer 官方接口。需要配置 ACE_TOOL_BASE_URL 和 ACE_TOOL_TOKEN。",
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
		const choice = await ctx.ui.select(`${scopeName(scope)}提示词增强配置`, [
			`增强模式 = ${mode}`,
			`Pi 模型 = ${model}`,
			`注入代码库上下文 = ${includeContext}`,
			"返回",
		]);
		if (!choice || choice === "返回") return;

		if (choice.startsWith("增强模式")) {
			const ok = await ctx.ui.confirm("提示词增强模式", `${PROMPT_ENHANCER_MODE_DETAILS}\n\n现在修改这个设置吗？`);
			if (!ok) continue;
			const next = await ctx.ui.select("提示词增强模式", [
				"official（Augment /prompt-enhancer）",
				"pi-model（使用已配置的 pi 模型）",
				"清除 / 使用默认值",
				"取消",
			]);
			if (!next || next === "取消") continue;
			const config = { ...stored };
			if (next.startsWith("清除")) delete config.promptEnhancerMode;
			else config.promptEnhancerMode = next.startsWith("pi-model") ? "pi-model" : "official";
			writeStoredConfig(scope, ctx.cwd, config);
			ctx.ui.notify(`已保存提示词增强模式到${scopeName(scope)}配置。`, "info");
			continue;
		}

		if (choice.startsWith("Pi 模型")) {
			const ok = await ctx.ui.confirm("提示词增强 pi 模型", `${PROMPT_ENHANCER_MODEL_DETAILS}\n\n现在修改这个设置吗？`);
			if (!ok) continue;
			const available = ctx.modelRegistry?.getAvailable?.().filter((item) => item.input.includes("text")) ?? [];
			if (available.length === 0) {
				ctx.ui.notify("没有找到已配置的 pi 文本模型。请先在 pi 中配置或登录模型，然后再到这里选择。", "warning");
				continue;
			}
			const selected = await ctx.ui.select("选择提示词增强使用的 pi 模型", [
				...available.slice(0, 80).map((item) => `${modelKey(item)} (${item.name})`),
				"清除 / 使用当前会话模型",
				"取消",
			]);
			if (!selected || selected === "取消") continue;
			const config = { ...stored };
			if (selected.startsWith("清除")) delete config.promptEnhancerModel;
			else config.promptEnhancerModel = selected.split(" ")[0];
			writeStoredConfig(scope, ctx.cwd, config);
			ctx.ui.notify(`已保存提示词增强 pi 模型到${scopeName(scope)}配置。`, "info");
			continue;
		}

		if (choice.startsWith("注入")) {
			const ok = await ctx.ui.confirm("提示词增强代码库上下文注入", `${PROMPT_ENHANCER_CONTEXT_DETAILS}\n\n现在修改这个设置吗？`);
			if (!ok) continue;
			const next = await ctx.ui.select("提示词增强前是否注入 search_context？", [
				"false（推荐）",
				"true",
				"清除 / 使用默认值",
				"取消",
			]);
			if (!next || next === "取消") continue;
			const config = { ...stored };
			if (next.startsWith("清除")) delete config.promptEnhancerIncludeSearchContext;
			else config.promptEnhancerIncludeSearchContext = next === "true";
			writeStoredConfig(scope, ctx.cwd, config);
			ctx.ui.notify(`已保存提示词增强上下文设置到${scopeName(scope)}配置。`, "info");
		}
	}
}

async function editConfigField(ctx: ConfigUiContext, scope: AceToolConfigScope, field: ConfigField, config: StoredAceToolConfig): Promise<void> {
	const shouldEdit = await confirmConfigFieldEdit(ctx, field, config);
	if (!shouldEdit) return;
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
		const choice = await ctx.ui.select(`${scopeName(scope)} ace-tool 高级配置`, [
			...ADVANCED_CONFIG_FIELDS.map((field) => fieldChoice(field, stored)),
			"返回",
		]);
		if (!choice || choice === "返回") return;
		const field = findFieldFromChoice(choice);
		if (field) {
			await editConfigField(ctx, scope, field, { ...stored });
		}
	}
}

async function configureScopeMenu(ctx: ConfigUiContext, scope: AceToolConfigScope): Promise<void> {
	while (true) {
		const stored = readStoredConfig(scope, ctx.cwd);
		const choice = await ctx.ui.select(`${scopeName(scope)} ace-tool 配置`, [
			...BASIC_CONFIG_FIELDS.map((field) => fieldChoice(field, stored)),
			"提示词增强配置",
			"高级设置",
			"清除此配置",
			"返回",
		]);
		if (!choice || choice === "返回") return;
		if (choice === "提示词增强配置") {
			await configurePromptEnhancer(ctx, scope);
			continue;
		}
		if (choice === "高级设置") {
			await configureAdvancedMenu(ctx, scope);
			continue;
		}
		if (choice === "清除此配置") {
			await clearConfigFlow(ctx, scope);
			return;
		}
		const field = findFieldFromChoice(choice);
		if (field) {
			await editConfigField(ctx, scope, field, { ...stored });
		}
	}
}

async function runConfigWizard(args: string, ctx: ConfigUiContext): Promise<void> {
	if (!ctx.hasUI) {
		throw new Error("/ace-config 需要交互式 UI。非交互模式请通过环境变量设置 ACE_TOOL_BASE_URL 和 ACE_TOOL_TOKEN。");
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
		description: `IMPORTANT: This is the primary tool for semantic codebase search through an Augment-compatible remote API.

Use search_context when you do not know which files contain the information you need, when you need high-level codebase context, or when you want to locate implementation flows by natural language.

Do NOT use search_context for exact identifier grep, listing all references of a known symbol, or reading a specific known file. Use built-in grep/read/find tools for those cases.

The tool indexes the current project, uploads new or changed code chunks to the configured Augment API, then asks the codebase retrieval endpoint for relevant context. Output is truncated to 50KB/2000 lines if necessary.

Required environment variables:
- ACE_TOOL_BASE_URL
- ACE_TOOL_TOKEN`,
		promptSnippet: "Semantic codebase search using an Augment-compatible remote code retrieval API",
		promptGuidelines: [
			"Use search_context as the first choice when you are unsure which files contain relevant implementation details.",
			"Use grep/read/find instead of search_context when searching for exact identifiers, all references, or contents of a known file.",
			"Pass a precise natural-language query to search_context, optionally including keywords from the user's request.",
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

			ctx.ui.setStatus("ace-tool", "ace: indexing");
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
						ctx.ui.setStatus("ace-tool", progressStatus(message));
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
				ctx.ui.setStatus("ace-tool", undefined);
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
			const projectRoot = path.resolve(args.trim() || ctx.cwd);
			const configHash = calculateConfigHash(config.maxLinesPerBlob);
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

	pi.registerCommand("ace-clear-index", {
		description: "Clear the local ace-tool index cache for the current project or supplied path",
		handler: async (args, ctx) => {
			const config = loadConfig(ctx.cwd);
			const projectRoot = path.resolve(args.trim() || ctx.cwd);
			await clearIndex(projectRoot, config.indexDirName, config.indexFileName);
			ctx.ui.notify(`Cleared ace-tool index cache for ${projectRoot}. Run /ace-index to rebuild it now, or let the next search_context call rebuild it.`, "info");
		},
	});

	pi.registerCommand("ace-init", {
		description: "Initialize ace-tool project ignores (.aceignore and .gitignore)",
		handler: async (args, ctx) => {
			const projectRoot = path.resolve(args.trim() || ctx.cwd);
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

			const projectRoot = path.resolve(args.trim() || ctx.cwd);
			ctx.ui.setStatus("ace-tool", "ace: indexing");
			try {
				const result = await indexProject(
					projectRoot,
					config,
					(message) => ctx.ui.setStatus("ace-tool", progressStatus(message)),
					ctx.signal,
				);
				ctx.ui.notify(
					`Indexed ${projectRoot}\nfiles: ${result.stats.files}\nblobs: ${result.stats.totalBlobs}\ncached blobs: ${result.stats.cachedBlobs}\nnew blobs: ${result.stats.newBlobs}\nskipped files: ${result.stats.skippedFiles}\ndeleted files: ${result.stats.deletedFiles}`,
					"info",
				);
			} finally {
				ctx.ui.setStatus("ace-tool", undefined);
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

			const projectRoot = path.resolve(parsed.projectRoot || ctx.cwd);
			const includeSearchContext = parsed.includeContextOverride ?? config.promptEnhancerIncludeSearchContext;
			const issues = validateConfig(config);
			if ((config.promptEnhancerMode === "official" || includeSearchContext) && issues.length > 0) {
				ctx.ui.setStatus("ace-tool", "ace: unconfigured");
				ctx.ui.notify(`ace-tool configuration error:\n- ${issues.join("\n- ")}\n\nOfficial enhancement and context injection require /ace-config. Switch prompt enhancer mode to pi-model and disable context injection to enhance without ACE API config.`, "warning");
				return;
			}
			ctx.ui.setStatus("ace-tool", includeSearchContext ? "ace: enhancing+context" : "ace: enhancing");
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
						ctx.ui.setStatus("ace-tool", progressStatus(message));
						renderWaiting();
					},
					signal: ctx.signal,
				});

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
				ctx.ui.setStatus("ace-tool", undefined);
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
			ctx.ui.setStatus("ace-tool", "ace: indexing");
			try {
				const result = await indexProject(
					ctx.cwd,
					config,
					(message) => ctx.ui.setStatus("ace-tool", progressStatus(message)),
					ctx.signal,
				);
				ctx.ui.notify(`ace-tool background index complete: ${result.stats.files} files · ${result.stats.totalBlobs} blobs · ${result.stats.newBlobs} new`, "info");
			} catch (error) {
				ctx.ui.notify(`ace-tool background index failed: ${error instanceof Error ? error.message : String(error)}`, "warning");
			} finally {
				ctx.ui.setStatus("ace-tool", undefined);
			}
		})();
	});

	pi.on("before_agent_start", (event, ctx) => {
		if (!hasSearchContextTool(event)) return;
		return {
			systemPrompt: `${event.systemPrompt}\n\n${buildAceSystemPrompt(ctx.cwd)}`,
		};
	});
}
