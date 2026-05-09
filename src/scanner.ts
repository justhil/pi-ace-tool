import { opendir, readFile, stat } from "node:fs/promises";
import path from "node:path";

export interface IgnoreRule {
	pattern: string;
	negated: boolean;
	directoryOnly: boolean;
	anchored: boolean;
	hasSlash: boolean;
	regex: RegExp;
}

export interface ScanOptions {
	maxFileBytes: number;
}

export interface FileCandidate {
	absolutePath: string;
	relativePath: string;
	size: number;
	mtimeMs: number;
	mtimeNs?: string;
}

const DEFAULT_EXCLUDE_PATTERNS = [
	".venv",
	"venv",
	".env",
	"env",
	"node_modules",
	"vendor",
	".pnpm",
	".yarn",
	"bower_components",
	".git",
	".pi",
	".svn",
	".hg",
	".gitmodules",
	"__pycache__",
	".pytest_cache",
	".mypy_cache",
	".tox",
	".eggs",
	"*.egg-info",
	".ruff_cache",
	"dist",
	"build",
	"target",
	"out",
	"bin",
	"obj",
	".next",
	".nuxt",
	".output",
	".vercel",
	".netlify",
	".turbo",
	".parcel-cache",
	".cache",
	".temp",
	".tmp",
	".tmp-build",
	"coverage",
	".nyc_output",
	"htmlcov",
	".idea",
	".vscode",
	".vs",
	"*.swp",
	"*.swo",
	".DS_Store",
	"Thumbs.db",
	"desktop.ini",
	"*.pyc",
	"*.pyo",
	"*.pyd",
	"*.so",
	"*.dll",
	"*.dylib",
	"*.exe",
	"*.o",
	"*.obj",
	"*.class",
	"*.jar",
	"*.war",
	"*.min.js",
	"*.min.css",
	"*.bundle.js",
	"*.chunk.js",
	"*.map",
	"*.gz",
	"*.zip",
	"*.tar",
	"*.rar",
	"package-lock.json",
	"yarn.lock",
	"pnpm-lock.yaml",
	"Gemfile.lock",
	"poetry.lock",
	"Cargo.lock",
	"composer.lock",
	"*.log",
	"logs",
	"tmp",
	"temp",
	"*.png",
	"*.jpg",
	"*.jpeg",
	"*.gif",
	"*.ico",
	"*.svg",
	"*.mp3",
	"*.mp4",
	"*.wav",
	"*.avi",
	"*.mov",
	"*.pdf",
	"*.doc",
	"*.docx",
	"*.xls",
	"*.xlsx",
	"*.woff",
	"*.woff2",
	"*.ttf",
	"*.eot",
	"*.otf",
	"*.db",
	"*.sqlite",
	"*.sqlite3",
	".ace-tool",
];

const TEXT_EXTENSIONS = new Set([
	".py",
	".js",
	".ts",
	".jsx",
	".tsx",
	".mjs",
	".cjs",
	".java",
	".go",
	".rs",
	".cpp",
	".c",
	".cc",
	".h",
	".hpp",
	".hxx",
	".cs",
	".rb",
	".php",
	".swift",
	".kt",
	".kts",
	".scala",
	".clj",
	".cljs",
	".lua",
	".dart",
	".m",
	".mm",
	".pl",
	".pm",
	".r",
	".jl",
	".ex",
	".exs",
	".erl",
	".hs",
	".zig",
	".v",
	".nim",
	".f90",
	".f95",
	".groovy",
	".gradle",
	".sol",
	".move",
	".md",
	".mdx",
	".txt",
	".json",
	".jsonc",
	".json5",
	".yaml",
	".yml",
	".toml",
	".xml",
	".ini",
	".conf",
	".cfg",
	".properties",
	".editorconfig",
	".html",
	".htm",
	".css",
	".scss",
	".sass",
	".less",
	".styl",
	".vue",
	".svelte",
	".astro",
	".ejs",
	".hbs",
	".pug",
	".jade",
	".jinja",
	".jinja2",
	".erb",
	".liquid",
	".twig",
	".mustache",
	".njk",
	".sql",
	".sh",
	".bash",
	".zsh",
	".fish",
	".ps1",
	".psm1",
	".bat",
	".cmd",
	".makefile",
	".mk",
	".cmake",
	".graphql",
	".gql",
	".proto",
	".prisma",
	".csv",
	".tsv",
	".rst",
	".adoc",
	".tex",
	".org",
	".dockerfile",
	".containerfile",
	".vim",
	".el",
	".rkt",
]);

const TEXT_FILENAMES = new Set([
	"Makefile",
	"makefile",
	"GNUmakefile",
	"Dockerfile",
	"Containerfile",
	"Jenkinsfile",
	"Vagrantfile",
	"Procfile",
	".gitignore",
	".aceignore",
	".gitattributes",
	".gitmodules",
	".dockerignore",
	".npmignore",
	".eslintignore",
	".prettierignore",
	".stylelintignore",
	".editorconfig",
	".browserslistrc",
	".npmrc",
	".yarnrc",
	".nvmrc",
	".node-version",
	".ruby-version",
	".python-version",
	".env.example",
	".env.sample",
	".env.template",
	".eslintrc",
	".prettierrc",
	".stylelintrc",
	".babelrc",
	".postcssrc",
	".huskyrc",
	".lintstagedrc",
	".commitlintrc",
	"Gemfile",
	"Rakefile",
	"Brewfile",
	"Pipfile",
	"MANIFEST.in",
	"setup.py",
	"requirements.txt",
	"constraints.txt",
	"README",
	"CHANGELOG",
	"LICENSE",
	"LICENCE",
	"AUTHORS",
	"CONTRIBUTORS",
	"HISTORY",
	"TODO",
	"ROADMAP",
	"COPYING",
]);

function toPosix(value: string): string {
	return value.replace(/\\/g, "/");
}

export function toRelativePosix(root: string, target: string): string {
	return toPosix(path.relative(root, target));
}

function stripIgnoreComment(line: string): string {
	let escaped = false;
	for (let i = 0; i < line.length; i += 1) {
		const char = line[i];
		if (char === "\\" && !escaped) {
			escaped = true;
			continue;
		}
		if (char === "#" && !escaped) return line.slice(0, i);
		escaped = false;
	}
	return line;
}

function escapeRegexChar(char: string): string {
	return /[|\\{}()[\]^$+?.]/.test(char) ? `\\${char}` : char;
}

function globToRegex(pattern: string, anchored: boolean, hasSlash: boolean): RegExp {
	let body = "";
	for (let i = 0; i < pattern.length; i += 1) {
		const char = pattern[i];
		if (char === "*") {
			if (pattern[i + 1] === "*") {
				body += ".*";
				i += 1;
			} else {
				body += "[^/]*";
			}
		} else if (char === "?") {
			body += "[^/]";
		} else {
			body += escapeRegexChar(char);
		}
	}

	if (anchored || hasSlash) {
		return new RegExp(`^${body}(?:/.*)?$`);
	}

	return new RegExp(`(^|/)${body}(?:/.*)?$`);
}

function parseIgnoreLine(rawLine: string): IgnoreRule | undefined {
	let line = stripIgnoreComment(rawLine).trim();
	if (!line) return undefined;
	if (line.startsWith("#")) return undefined;

	let negated = false;
	if (line.startsWith("!")) {
		negated = true;
		line = line.slice(1);
	}

	line = line.trim();
	if (!line) return undefined;

	let anchored = line.startsWith("/");
	if (anchored) line = line.slice(1);

	const directoryOnly = line.endsWith("/");
	if (directoryOnly) line = line.replace(/\/+$/, "");

	line = toPosix(line);
	const hasSlash = line.includes("/");

	return {
		pattern: line,
		negated,
		directoryOnly,
		anchored,
		hasSlash,
		regex: globToRegex(line, anchored, hasSlash),
	};
}

async function readIgnoreFile(filePath: string): Promise<string[]> {
	try {
		const content = await readFile(filePath, "utf8");
		return content.split(/\r?\n/);
	} catch {
		return [];
	}
}

export async function loadIgnoreRules(projectRoot: string): Promise<IgnoreRule[]> {
	const lines = [
		...DEFAULT_EXCLUDE_PATTERNS,
		...(await readIgnoreFile(path.join(projectRoot, ".gitignore"))),
		...(await readIgnoreFile(path.join(projectRoot, ".aceignore"))),
	];

	return lines.map(parseIgnoreLine).filter((rule): rule is IgnoreRule => Boolean(rule));
}

export function isIgnored(relativePath: string, isDirectory: boolean, rules: IgnoreRule[]): boolean {
	const normalized = toPosix(relativePath).replace(/^\.\//, "");
	if (!normalized) return false;

	let ignored = false;
	for (const rule of rules) {
		if (rule.directoryOnly && !isDirectory) continue;
		if (rule.regex.test(normalized)) {
			ignored = !rule.negated;
		}
	}
	return ignored;
}

export function isTextFile(filePath: string): boolean {
	const filename = path.basename(filePath);
	if (TEXT_FILENAMES.has(filename)) return true;

	const lower = filename.toLowerCase();
	if (lower === "dockerfile" || lower.endsWith(".dockerfile")) return true;
	if (lower === "containerfile" || lower.endsWith(".containerfile")) return true;

	const ext = path.extname(filename).toLowerCase();
	return TEXT_EXTENSIONS.has(ext);
}

export async function collectFileCandidates(projectRoot: string, options: ScanOptions): Promise<FileCandidate[]> {
	const root = path.resolve(projectRoot);
	const rules = await loadIgnoreRules(root);
	const files: FileCandidate[] = [];

	async function walk(directory: string): Promise<void> {
		let dir;
		try {
			dir = await opendir(directory);
		} catch {
			return;
		}

		for await (const entry of dir) {
			const absolutePath = path.join(directory, entry.name);
			const relativePath = toRelativePosix(root, absolutePath);

			if (entry.isSymbolicLink()) continue;

			if (entry.isDirectory()) {
				if (!isIgnored(relativePath, true, rules)) {
					await walk(absolutePath);
				}
				continue;
			}

			if (!entry.isFile()) continue;
			if (isIgnored(relativePath, false, rules)) continue;
			if (!isTextFile(absolutePath)) continue;

			try {
				const metadata = await stat(absolutePath, { bigint: true });
				const size = Number(metadata.size);
				if (size > options.maxFileBytes) continue;
				files.push({
					absolutePath,
					relativePath,
					size,
					mtimeMs: Number(metadata.mtimeMs),
					mtimeNs: metadata.mtimeNs.toString(),
				});
			} catch {
				// File disappeared or cannot be stat'ed; skip it.
			}
		}
	}

	await walk(root);
	files.sort((a, b) => a.relativePath.localeCompare(b.relativePath));
	return files;
}
