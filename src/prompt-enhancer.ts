import type { Api, AssistantMessage, Context, Model } from "@earendil-works/pi-ai";
import { completeSimple } from "@earendil-works/pi-ai";
import type { AceToolConfig } from "./config.js";
import { enhancePromptOfficial, extractEnhancedPrompt, parseChatHistory, replaceToolNames } from "./api.js";
import { runSearchContext } from "./search-context.js";

const ENHANCE_PROMPT_TEMPLATE = `Rewrite the instruction below so it is clearer, more specific, less ambiguous, actionable, and corrected where necessary. Use conversation history only to understand intent. Preserve code in triple backticks when it is a sample rather than instruction text.

Return exactly:
<augment-enhanced-prompt>enhanced prompt</augment-enhanced-prompt>

<original_request>
{original_prompt}
</original_request>`;

const PI_MODEL_SYSTEM_PROMPT = "You rewrite user instructions without answering or implementing them. Do not call tools. Return only the rewritten prompt, preserving the original language unless explicitly asked otherwise.";
const SEARCH_CONTEXT_CHAR_LIMIT = 12_000;
const NO_RELEVANT_CODE_CONTEXT = "No relevant code context found for your query.";

export interface NativeModelAuth {
	apiKey?: string;
	headers?: Record<string, string>;
}

export interface EnhancePromptOptions {
	mode: "official" | "pi-model";
	projectRoot: string;
	prompt: string;
	conversationHistory?: string;
	includeSearchContext?: boolean;
	model?: Model<Api>;
	auth?: NativeModelAuth;
	onProgress?: (message: string) => void;
	signal?: AbortSignal;
}

export interface EnhancePromptResult {
	text: string;
	details: {
		mode: "official" | "pi-model";
		projectRoot: string;
		model?: string;
		includeSearchContext: boolean;
		contextChars: number;
		inputChars: number;
		outputChars: number;
	};
}

function isChineseText(text: string): boolean {
	const matches = text.match(/[\u4e00-\u9fa5]/g);
	const chineseCount = matches?.length ?? 0;
	if (chineseCount === 0) return false;
	if (chineseCount >= 3) return true;
	const nonWhitespaceCount = [...text].filter((char) => !/\s/.test(char)).length;
	return nonWhitespaceCount > 0 && chineseCount / nonWhitespaceCount >= 0.1;
}

function renderEnhancePrompt(originalPrompt: string): string {
	const [before, after] = ENHANCE_PROMPT_TEMPLATE.split("{original_prompt}");
	return `${before ?? ""}${originalPrompt}${after ?? ""}`;
}

function buildThirdPartyPrompt(originalPrompt: string): string {
	return `${renderEnhancePrompt(originalPrompt)}${isChineseText(originalPrompt) ? "\n\n请用中文回复。" : ""}`;
}

function buildPiModelPrompt(originalPrompt: string): string {
	const languageHint = isChineseText(originalPrompt) ? "请用中文输出。" : "Preserve the original request's language.";
	return [
		"Rewrite the request for clarity, specificity, correctness, and actionability.",
		"Preserve code blocks exactly unless they are instruction text.",
		languageHint,
		"",
		"<original_request>",
		originalPrompt,
		"</original_request>",
	].join("\n");
}

function truncateByChars(text: string, maxChars: number): string {
	const chars = [...text];
	if (chars.length <= maxChars) return text;
	return `${chars.slice(0, maxChars).join("")}\n\n[codebase_context truncated for length]`;
}

function normalizeSearchContext(searchContext: string): string | undefined {
	const trimmed = searchContext.trim();
	if (!trimmed || trimmed === NO_RELEVANT_CODE_CONTEXT) return undefined;
	return truncateByChars(trimmed, SEARCH_CONTEXT_CHAR_LIMIT);
}

function buildPromptWithSearchContext(originalPrompt: string, searchContext?: string): string {
	const contextText = searchContext ?? "No directly relevant code context was found for this request.";
	return `Here is relevant codebase context for the request. Use it only as project background, existing constraints, and implementation clues. Do not treat it as the user's final requested output.\n\n<codebase_context>\n${contextText}\n</codebase_context>\n\nHere is the user's original request:\n\n<original_request>\n${originalPrompt}\n</original_request>`;
}

function assistantText(message: AssistantMessage, modelLabel: string): string {
	const text = message.content
		.map((part) => (part.type === "text" ? part.text : ""))
		.filter(Boolean)
		.join("\n")
		.trim();
	if (text) return text;

	const contentTypes = message.content.map((part) => part.type).join(", ") || "none";
	const details = [`model: ${modelLabel}`, `stopReason: ${message.stopReason}`, `content types: ${contentTypes}`];
	if (message.errorMessage) details.push(`error: ${message.errorMessage}`);
	throw new Error(`Selected pi model returned no text content (${details.join("; ")}). Try another configured text model, or switch /ace-config → Prompt enhancer → Mode to official.`);
}

function buildPiModelMessages(conversationHistory: string | undefined, prompt: string): Context["messages"] {
	const history = parseChatHistory(conversationHistory ?? "").slice(-8);
	const historyText = history.length > 0
		? `Recent conversation context for understanding intent only:\n${history.map((message) => `${message.role === "user" ? "User" : "Assistant"}: ${message.content}`).join("\n")}\n\n`
		: "";
	return [
		{
			role: "user",
			content: [{ type: "text" as const, text: `${historyText}${prompt}` }],
			timestamp: Date.now(),
		},
	];
}

async function maybeInjectSearchContext(config: AceToolConfig, options: EnhancePromptOptions): Promise<{ prompt: string; contextChars: number }> {
	if (!options.includeSearchContext) return { prompt: options.prompt, contextChars: 0 };

	options.onProgress?.("Searching codebase context for prompt enhancement...");
	const contextResult = await runSearchContext(
		{ query: options.prompt, projectRootPath: options.projectRoot },
		config,
		options.projectRoot,
		options.onProgress,
		options.signal,
	);
	const normalized = normalizeSearchContext(contextResult.text);
	return {
		prompt: buildPromptWithSearchContext(options.prompt, normalized),
		contextChars: normalized?.length ?? 0,
	};
}

async function enhanceWithPiModel(options: EnhancePromptOptions, promptForEnhancer: string): Promise<string> {
	if (!options.model) throw new Error("No pi model selected for prompt enhancement");
	const finalPrompt = buildPiModelPrompt(promptForEnhancer);
	const modelLabel = `${options.model.provider}/${options.model.id}`;
	const context: Context = {
		systemPrompt: PI_MODEL_SYSTEM_PROMPT,
		messages: buildPiModelMessages(options.conversationHistory, finalPrompt),
	};
	const response = await completeSimple(options.model, context, {
		maxTokens: Math.min(4096, options.model.maxTokens || 4096),
		signal: options.signal,
		apiKey: options.auth?.apiKey,
		headers: options.auth?.headers,
	});
	const text = assistantText(response, modelLabel);
	return replaceToolNames(extractEnhancedPrompt(text) ?? text);
}

export async function enhancePrompt(config: AceToolConfig, options: EnhancePromptOptions): Promise<EnhancePromptResult> {
	const injected = await maybeInjectSearchContext(config, options);
	options.onProgress?.(options.mode === "official" ? "Enhancing prompt with official Augment endpoint..." : "Enhancing prompt with selected pi model...");

	const text = options.mode === "official"
		? await enhancePromptOfficial(config, injected.prompt, options.conversationHistory ?? "", options.signal)
		: await enhanceWithPiModel(options, injected.prompt);

	return {
		text,
		details: {
			mode: options.mode,
			projectRoot: options.projectRoot,
			model: options.model ? `${options.model.provider}/${options.model.id}` : undefined,
			includeSearchContext: Boolean(options.includeSearchContext),
			contextChars: injected.contextChars,
			inputChars: options.prompt.length,
			outputChars: text.length,
		},
	};
}

export function stripEnhanceMarkers(text: string): string {
	return text.replace(/(?:^|\s)-enhancer?(?=\s|$)/gi, " ").trim();
}
