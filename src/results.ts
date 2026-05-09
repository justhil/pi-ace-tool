const PATH_RE = /(?:^|[\s`'"(\[])([A-Za-z]:[\\/][^\s`'"()\[\]{}<>]+|(?:\.{1,2}[\\/])?[^\s`'"()\[\]{}<>]+\.(?:ts|tsx|js|jsx|mjs|cjs|py|rs|go|java|kt|kts|cs|cpp|c|h|hpp|php|rb|swift|vue|svelte|astro|json|yaml|yml|toml|md|mdx|css|scss|html|sql|sh|ps1))(?:[:#]\d+)?/gim;

function cleanPathCandidate(value: string): string {
	return value
		.replace(/\\/g, "/")
		.replace(/(?::\d+|#L?\d+)$/i, "")
		.replace(/[.,;:!?]+$/g, "")
		.replace(/^['"`]+|['"`)\]]+$/g, "");
}

export function extractResultPaths(text: string, limit = 20): string[] {
	const seen = new Set<string>();
	const paths: string[] = [];
	for (const match of text.matchAll(PATH_RE)) {
		const candidate = cleanPathCandidate(match[1] ?? "");
		if (!candidate || candidate.length < 3) continue;
		if (candidate.includes("//") && !/^[A-Za-z]:\//.test(candidate)) continue;
		if (seen.has(candidate)) continue;
		seen.add(candidate);
		paths.push(candidate);
		if (paths.length >= limit) break;
	}
	return paths;
}

export function buildSearchResultHeader(options: {
	projectRoot: string;
	query: string;
	blobCount: number;
	files?: string[];
}): string {
	const lines = [
		"[ace-tool search_context]",
		`Project: ${options.projectRoot}`,
		`Chunks searched: ${options.blobCount}`,
		`Query: ${options.query}`,
	];
	if (options.files?.length) {
		lines.push(`Likely files: ${options.files.slice(0, 10).join(", ")}`);
	}
	return lines.join("\n");
}
