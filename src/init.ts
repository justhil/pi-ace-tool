import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

const RECOMMENDED_ACEIGNORE_LINES = [
	"# ace-tool recommended ignores",
	"# Keep credentials, local agent config, generated indexes, and heavy artifacts out of remote indexing.",
	".pi/",
	".ace-tool/",
	".env",
	".env.*",
	"*.secret",
	"*.pem",
	"*.key",
	"*.crt",
	"*.p12",
	"*.pfx",
	"coverage/",
	"dist/",
	"build/",
	"target/",
	"node_modules/",
];

const RECOMMENDED_GITIGNORE_LINES = [".pi/", ".ace-tool/"];

export interface AceInitResult {
	projectRoot: string;
	aceignorePath: string;
	gitignorePath: string;
	aceignoreAdded: string[];
	gitignoreAdded: string[];
}

function normalizeLine(line: string): string {
	return line.trim().replace(/\\/g, "/");
}

function hasIgnoreEntry(content: string, entry: string): boolean {
	const normalizedEntry = normalizeLine(entry).replace(/\/+$/, "");
	return content
		.split(/\r?\n/)
		.map((line) => line.split("#")[0] ?? line)
		.map(normalizeLine)
		.filter(Boolean)
		.some((line) => line.replace(/\/+$/, "") === normalizedEntry);
}

async function readTextIfExists(filePath: string): Promise<string> {
	try {
		return await readFile(filePath, "utf8");
	} catch {
		return "";
	}
}

function appendMissingLines(content: string, lines: string[]): { content: string; added: string[] } {
	const added = lines.filter((line) => line.startsWith("#") || !hasIgnoreEntry(content, line));
	if (added.length === 0) return { content, added };
	const prefix = content.length === 0 || content.endsWith("\n") ? content : `${content}\n`;
	return { content: `${prefix}${added.join("\n")}\n`, added };
}

export async function initAceProject(projectRoot: string): Promise<AceInitResult> {
	const root = path.resolve(projectRoot);
	await mkdir(root, { recursive: true });

	const aceignorePath = path.join(root, ".aceignore");
	const gitignorePath = path.join(root, ".gitignore");

	const aceignoreContent = await readTextIfExists(aceignorePath);
	const aceignoreNext = appendMissingLines(aceignoreContent, RECOMMENDED_ACEIGNORE_LINES);
	if (aceignoreNext.added.length > 0) {
		await writeFile(aceignorePath, aceignoreNext.content, "utf8");
	}

	const gitignoreContent = await readTextIfExists(gitignorePath);
	const gitignoreNext = appendMissingLines(gitignoreContent, RECOMMENDED_GITIGNORE_LINES);
	if (gitignoreNext.added.length > 0) {
		await writeFile(gitignorePath, gitignoreNext.content, "utf8");
	}

	return {
		projectRoot: root,
		aceignorePath,
		gitignorePath,
		aceignoreAdded: aceignoreNext.added,
		gitignoreAdded: gitignoreNext.added,
	};
}
