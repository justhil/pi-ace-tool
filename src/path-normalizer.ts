import { readFileSync } from "node:fs";
import path from "node:path";

export type RuntimeEnv = "windows" | "wsl" | "unix";

export interface NormalizedPath {
	canonical: string;
	local: string;
}

let detectedRuntimeEnv: RuntimeEnv | undefined;

export function detectRuntimeEnv(): RuntimeEnv {
	if (detectedRuntimeEnv) return detectedRuntimeEnv;
	if (process.platform === "win32") {
		detectedRuntimeEnv = "windows";
		return detectedRuntimeEnv;
	}

	if (process.platform === "linux") {
		const envLooksWsl = Boolean(process.env.WSL_INTEROP || process.env.WSL_DISTRO_NAME);
		const procLooksWsl = ["/proc/version", "/proc/sys/kernel/osrelease"].some((filePath) => {
			try {
				const text = readFileSync(filePath, "utf8").toLowerCase();
				return text.includes("microsoft") || text.includes("wsl");
			} catch {
				return false;
			}
		});
		if (envLooksWsl || procLooksWsl) {
			detectedRuntimeEnv = "wsl";
			return detectedRuntimeEnv;
		}
	}

	detectedRuntimeEnv = "unix";
	return detectedRuntimeEnv;
}

export function isWindowsDrivePath(value: string): boolean {
	return /^[a-zA-Z]:[\\/]/.test(value.trim());
}

export function winToWsl(value: string): string | undefined {
	const normalized = value.trim().replace(/\\/g, "/");
	if (!/^[a-zA-Z]:\//.test(normalized)) return undefined;
	const drive = normalized[0]?.toLowerCase();
	const rest = normalized.slice(2);
	return `/mnt/${drive}${rest}`;
}

export function isWslMntPath(value: string): boolean {
	return /^\/mnt\/[a-zA-Z](?:\/|$)/.test(value.trim().replace(/\\/g, "/"));
}

export function wslToWin(value: string): string | undefined {
	const normalized = value.trim().replace(/\\/g, "/");
	const match = normalized.match(/^\/mnt\/([a-zA-Z])(?:\/(.*))?$/);
	if (!match) return undefined;
	const drive = match[1]?.toUpperCase();
	const rest = match[2] ? `\\${match[2].replace(/\//g, "\\")}` : "\\";
	return `${drive}:${rest}`;
}

export interface WslUncPath {
	distro: string;
	innerPath: string;
}

export function parseWslUncPath(value: string): WslUncPath | undefined {
	const normalized = value.trim().replace(/\//g, "\\");
	const lower = normalized.toLowerCase();
	const prefixes = ["\\\\wsl$\\", "\\\\wsl.localhost\\"];
	for (const prefix of prefixes) {
		if (!lower.startsWith(prefix)) continue;
		const rest = normalized.slice(prefix.length);
		if (!rest) return undefined;
		const slashIndex = rest.indexOf("\\");
		if (slashIndex === -1) return { distro: rest, innerPath: "/" };
		if (slashIndex === 0) return undefined;
		return {
			distro: rest.slice(0, slashIndex),
			innerPath: rest.slice(slashIndex).replace(/\\/g, "/"),
		};
	}
	return undefined;
}

export function isWslUncPath(value: string): boolean {
	return Boolean(parseWslUncPath(value));
}

function resolveLocalPath(value: string, cwd: string, runtimeEnv: RuntimeEnv): string {
	if (runtimeEnv === "windows") {
		return path.win32.isAbsolute(value) ? path.win32.normalize(value) : path.win32.resolve(cwd, value);
	}
	const posixValue = value.replace(/\\/g, "/");
	const posixCwd = cwd.replace(/\\/g, "/");
	return path.posix.isAbsolute(posixValue) ? path.posix.normalize(posixValue) : path.posix.resolve(posixCwd, posixValue);
}

export function normalizePathForRuntime(input: string, cwd = process.cwd(), runtimeEnv = detectRuntimeEnv()): NormalizedPath {
	const raw = (input || cwd).trim() || cwd;
	const baseCwd = runtimeEnv === "windows" ? path.win32.resolve(cwd) : path.posix.resolve(cwd.replace(/\\/g, "/"));

	if (runtimeEnv === "windows") {
		const unc = parseWslUncPath(raw);
		if (unc) {
			return { canonical: unc.innerPath, local: raw.replace(/\//g, "\\") };
		}
		const winFromWsl = isWslMntPath(raw) ? wslToWin(raw) : undefined;
		const local = resolveLocalPath(winFromWsl ?? raw, baseCwd, runtimeEnv);
		return { canonical: local.replace(/\\/g, "/"), local };
	}

	if (runtimeEnv === "wsl") {
		const unc = parseWslUncPath(raw);
		if (unc) {
			const local = resolveLocalPath(unc.innerPath, baseCwd, runtimeEnv);
			return { canonical: local.replace(/\\/g, "/"), local };
		}
		const wslFromWin = isWindowsDrivePath(raw) ? winToWsl(raw) : undefined;
		const local = resolveLocalPath(wslFromWin ?? raw, baseCwd, runtimeEnv);
		return { canonical: local.replace(/\\/g, "/"), local };
	}

	const local = resolveLocalPath(raw, baseCwd, runtimeEnv);
	return { canonical: local.replace(/\\/g, "/"), local };
}

export function normalizeProjectPath(input: string | undefined, cwd: string): string {
	return normalizePathForRuntime(input?.trim() || cwd, cwd).local;
}

export function toPosixPath(value: string): string {
	return value.replace(/\\/g, "/");
}
