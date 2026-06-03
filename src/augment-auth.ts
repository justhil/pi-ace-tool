import { createHash, randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { exec } from "node:child_process";

export interface AugmentSession {
	accessToken: string;
	tenantURL: string;
	scopes: string[];
}

export interface AugmentOAuthFlow {
	authorizeUrl: string;
	codeVerifier: string;
	state: string;
}

export interface AugmentSessionSource {
	session?: AugmentSession;
	source: "env" | "file" | "none";
	path: string;
}

const DEFAULT_AUTH_URL = "https://auth.augmentcode.com";
const DEFAULT_CLIENT_ID = "v";
const ALLOWED_TENANT_SUFFIXES = [".augmentcode.com", ".augm.io", ".hjkl.ai"];
const ALLOWED_TENANT_HOSTS = ["augmentcode.com", "www.augmentcode.com", "augm.io", "www.augm.io", "hjkl.ai", "www.hjkl.ai"];

export function getDefaultAugmentSessionPath(): string {
	return path.join(os.homedir(), ".augment", "session.json");
}

function normalizeSessionPath(sessionPath?: string): string {
	return sessionPath?.trim() || getDefaultAugmentSessionPath();
}

function normalizeUrl(raw: string): string {
	let value = raw.trim();
	if (!value) return value;
	if (!value.startsWith("http://") && !value.startsWith("https://")) value = `https://${value}`;
	return value.replace(/\/+$/, "");
}

function parseSession(raw: string): AugmentSession | undefined {
	try {
		const value = JSON.parse(raw) as Partial<AugmentSession>;
		if (!value || typeof value !== "object") return undefined;
		if (typeof value.accessToken !== "string" || !value.accessToken.trim()) return undefined;
		if (typeof value.tenantURL !== "string" || !value.tenantURL.trim()) return undefined;
		return {
			accessToken: value.accessToken.trim(),
			tenantURL: assertAllowedTenantUrl(value.tenantURL),
			scopes: Array.isArray(value.scopes) ? value.scopes.filter((scope): scope is string => typeof scope === "string") : [],
		};
	} catch {
		return undefined;
	}
}

export function readAugmentSessionSource(sessionPath?: string): AugmentSessionSource {
	const resolvedPath = normalizeSessionPath(sessionPath);
	const envSession = process.env.AUGMENT_SESSION_AUTH?.trim();
	if (envSession) {
		const session = parseSession(envSession);
		if (session) return { session, source: "env", path: resolvedPath };
	}

	try {
		if (!existsSync(resolvedPath)) return { source: "none", path: resolvedPath };
		const session = parseSession(readFileSync(resolvedPath, "utf8"));
		return session ? { session, source: "file", path: resolvedPath } : { source: "none", path: resolvedPath };
	} catch {
		return { source: "none", path: resolvedPath };
	}
}

export function getAugmentSession(sessionPath?: string): AugmentSession | undefined {
	return readAugmentSessionSource(sessionPath).session;
}

function base64Url(buffer: Buffer): string {
	return buffer.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=/g, "");
}

function assertAllowedTenantUrl(rawUrl: string): string {
	const normalized = normalizeUrl(rawUrl);
	const url = new URL(normalized);
	if (url.protocol !== "https:") throw new Error(`Invalid Augment tenant URL protocol: ${rawUrl}`);
	const hostname = url.hostname.toLowerCase();
	const allowed = ALLOWED_TENANT_HOSTS.includes(hostname)
		|| ALLOWED_TENANT_SUFFIXES.some((suffix) => hostname.endsWith(suffix) && hostname.length > suffix.length);
	if (!allowed) throw new Error(`Invalid Augment tenant URL: ${rawUrl}`);
	return url.origin;
}

export function createAugmentOAuthFlow(authUrl?: string): AugmentOAuthFlow {
	const codeVerifier = base64Url(randomBytes(32));
	const codeChallenge = base64Url(createHash("sha256").update(Buffer.from(codeVerifier)).digest());
	const state = base64Url(randomBytes(8));
	const params = new URLSearchParams({
		response_type: "code",
		code_challenge: codeChallenge,
		code_challenge_method: "S256",
		client_id: DEFAULT_CLIENT_ID,
		state,
		prompt: "login",
	});
	return {
		authorizeUrl: new URL(`/authorize?${params.toString()}`, normalizeUrl(authUrl || DEFAULT_AUTH_URL)).toString(),
		codeVerifier,
		state,
	};
}

export async function openBrowser(url: string): Promise<boolean> {
	const command = process.platform === "darwin"
		? `open "${url}"`
		: process.platform === "win32"
			? `start "" "${url}"`
			: `xdg-open "${url}"`;
	return new Promise((resolve) => {
		const child = exec(command, (error) => resolve(!error));
		const timer = setTimeout(() => {
			child.kill();
			resolve(false);
		}, 5000);
		child.once("exit", () => clearTimeout(timer));
	});
}

export async function completeAugmentOAuthFlow(flow: AugmentOAuthFlow, pastedJson: string, sessionPath?: string, signal?: AbortSignal): Promise<AugmentSession> {
	let authResponse: { code?: unknown; state?: unknown; tenant_url?: unknown; error?: unknown; error_description?: unknown };
	try {
		authResponse = JSON.parse(pastedJson.trim()) as typeof authResponse;
	} catch {
		throw new Error("Invalid OAuth response JSON. Paste the complete JSON response from the browser.");
	}

	if (authResponse.state !== flow.state) throw new Error("OAuth state mismatch. Restart /ace-login and try again.");
	if (typeof authResponse.error === "string" && authResponse.error) {
		const details = typeof authResponse.error_description === "string" ? `: ${authResponse.error_description}` : "";
		throw new Error(`OAuth request failed (${authResponse.error})${details}`);
	}
	if (typeof authResponse.code !== "string" || !authResponse.code.trim()) throw new Error("OAuth response is missing code.");
	if (typeof authResponse.tenant_url !== "string" || !authResponse.tenant_url.trim()) throw new Error("OAuth response is missing tenant_url.");

	const tenantURL = assertAllowedTenantUrl(authResponse.tenant_url);
	const timeout = AbortSignal.timeout(60_000);
	const response = await fetch(new URL("token", `${tenantURL}/`).toString(), {
		method: "POST",
		headers: {
			"Content-Type": "application/json",
			"User-Agent": "augment.cli/0.17.0",
		},
		body: JSON.stringify({
			grant_type: "authorization_code",
			client_id: DEFAULT_CLIENT_ID,
			code_verifier: flow.codeVerifier,
			redirect_uri: "",
			code: authResponse.code,
		}),
		signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
	});
	const text = await response.text();
	if (!response.ok) throw new Error(`Token exchange failed: HTTP ${response.status}${text ? ` - ${text}` : ""}`);

	let tokenResponse: { access_token?: unknown };
	try {
		tokenResponse = JSON.parse(text) as typeof tokenResponse;
	} catch {
		throw new Error("Token exchange returned invalid JSON.");
	}
	if (typeof tokenResponse.access_token !== "string" || !tokenResponse.access_token.trim()) {
		throw new Error("Token exchange response is missing access_token.");
	}

	const session = {
		accessToken: tokenResponse.access_token.trim(),
		tenantURL,
		scopes: ["read", "write"],
	};
	writeAugmentSession(session, sessionPath);
	process.env.AUGMENT_SESSION_AUTH = JSON.stringify(session);
	return session;
}

export function writeAugmentSession(session: AugmentSession, sessionPath?: string): string {
	const resolvedPath = normalizeSessionPath(sessionPath);
	mkdirSync(path.dirname(resolvedPath), { recursive: true });
	writeFileSync(resolvedPath, `${JSON.stringify(session, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
	return resolvedPath;
}

export function removeAugmentSession(sessionPath?: string): string {
	const resolvedPath = normalizeSessionPath(sessionPath);
	rmSync(resolvedPath, { force: true });
	return resolvedPath;
}
