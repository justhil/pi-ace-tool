export type UploadErrorType = "timeout" | "rate_limit" | "server_error" | "client_error" | "network_error";
export type StrategyAdjustment = "upgrade" | "downgrade" | "no_change";
type LatencyHealth = "healthy" | "normal" | "high";

interface RequestOutcome {
	success: boolean;
	latencyMs: number;
	errorType?: UploadErrorType;
}

const MIN_CONCURRENCY = 1;
const MAX_CONCURRENCY = 8;
const MIN_TIMEOUT_MS = 15_000;
const MAX_TIMEOUT_MS = 180_000;
const MIN_SAMPLES = 20;
const COOLDOWN_REQUESTS = 5;
const DOWNGRADE_SUCCESS_THRESHOLD = 0.70;
const UPGRADE_SUCCESS_THRESHOLD = 0.95;
const WARMUP_REQUESTS = 5;
const WARMUP_SUCCESS_THRESHOLD = 0.90;
const MAX_WARMUP_REQUESTS = 10;
const EWMA_ALPHA = 0.2;
const METRICS_WINDOW_SIZE = 20;

class RuntimeMetrics {
	private ewmaLatencyMs: number;
	private readonly baselineLatencyMs: number;
	private readonly outcomes: RequestOutcome[] = [];
	private requestsSinceAdjustmentValue = 0;
	private rateLimitCount = 0;
	private initialized = false;

	constructor(baselineTimeoutMs: number) {
		this.baselineLatencyMs = Math.max(baselineTimeoutMs * 0.3, 1);
		this.ewmaLatencyMs = this.baselineLatencyMs;
	}

	record(outcome: RequestOutcome): void {
		// Align with ace-tool-rs: exclude 5xx from strategy metrics because server errors are not client-side congestion signals.
		if (outcome.errorType === "server_error") return;

		if (outcome.success || outcome.errorType) {
			this.updateEwma(outcome.latencyMs);
		}

		if (outcome.errorType === "rate_limit") this.rateLimitCount += 1;

		if (this.outcomes.length >= METRICS_WINDOW_SIZE) {
			const removed = this.outcomes.shift();
			if (removed?.errorType === "rate_limit") {
				this.rateLimitCount = Math.max(0, this.rateLimitCount - 1);
			}
		}

		this.outcomes.push(outcome);
		this.requestsSinceAdjustmentValue += 1;
	}

	private updateEwma(latencyMs: number): void {
		if (!this.initialized) {
			this.ewmaLatencyMs = latencyMs;
			this.initialized = true;
			return;
		}
		this.ewmaLatencyMs = EWMA_ALPHA * latencyMs + (1 - EWMA_ALPHA) * this.ewmaLatencyMs;
	}

	successRate(): number {
		if (this.outcomes.length === 0) return 1;
		return this.outcomes.filter((outcome) => outcome.success).length / this.outcomes.length;
	}

	sampleCount(): number {
		return this.outcomes.length;
	}

	hasMinimumSamples(): boolean {
		return this.outcomes.length >= MIN_SAMPLES;
	}

	requestsSinceAdjustment(): number {
		return this.requestsSinceAdjustmentValue;
	}

	resetAdjustmentCounter(): void {
		this.requestsSinceAdjustmentValue = 0;
	}

	hasRateLimitErrors(): boolean {
		return this.rateLimitCount > 0;
	}

	latencyHealth(): LatencyHealth {
		const ratio = this.ewmaLatencyMs / this.baselineLatencyMs;
		if (ratio <= 0.8) return "healthy";
		if (ratio <= 1.5) return "normal";
		return "high";
	}

	ewma(): number {
		return this.ewmaLatencyMs;
	}
}

export class AdaptiveUploadStrategy {
	private currentConcurrency: number;
	private currentTimeoutMs: number;
	private readonly targetConcurrency: number;
	private readonly targetTimeoutMs: number;
	private readonly metrics: RuntimeMetrics;
	private warmupActive: boolean;
	private warmupRequestCount = 0;

	constructor(targetConcurrency: number, targetTimeoutMs: number) {
		this.targetConcurrency = Math.max(MIN_CONCURRENCY, Math.min(MAX_CONCURRENCY, targetConcurrency));
		this.targetTimeoutMs = Math.max(MIN_TIMEOUT_MS, Math.min(MAX_TIMEOUT_MS, targetTimeoutMs));
		this.currentConcurrency = this.targetConcurrency > MIN_CONCURRENCY ? MIN_CONCURRENCY : this.targetConcurrency;
		this.currentTimeoutMs = this.targetTimeoutMs;
		this.metrics = new RuntimeMetrics(this.targetTimeoutMs);
		this.warmupActive = this.targetConcurrency > MIN_CONCURRENCY;
	}

	concurrency(): number {
		return this.currentConcurrency;
	}

	timeoutMs(): number {
		return this.currentTimeoutMs;
	}

	recordOutcome(success: boolean, latencyMs: number, errorType?: UploadErrorType): { adjustment: StrategyAdjustment; message?: string } {
		this.metrics.record({ success, latencyMs, errorType });

		if (this.warmupActive) {
			this.warmupRequestCount += 1;
			return this.checkWarmupExit();
		}

		return this.evaluateAdjustment();
	}

	private checkWarmupExit(): { adjustment: StrategyAdjustment; message?: string } {
		if (this.warmupRequestCount < WARMUP_REQUESTS) return { adjustment: "no_change" };

		const successRate = this.metrics.successRate();
		if (this.warmupRequestCount >= MAX_WARMUP_REQUESTS) {
			this.warmupActive = false;
			return { adjustment: "no_change", message: `Adaptive warmup completed: success=${Math.round(successRate * 100)}%, concurrency=${this.currentConcurrency}` };
		}

		if (this.metrics.sampleCount() === 0) return { adjustment: "no_change" };

		if (successRate >= WARMUP_SUCCESS_THRESHOLD && this.metrics.latencyHealth() !== "high") {
			const old = this.currentConcurrency;
			this.currentConcurrency = this.targetConcurrency;
			this.warmupActive = false;
			this.metrics.resetAdjustmentCounter();
			return {
				adjustment: old === this.currentConcurrency ? "no_change" : "upgrade",
				message: `Adaptive warmup success: concurrency ${old}→${this.currentConcurrency}, success=${Math.round(successRate * 100)}%`,
			};
		}

		if (successRate < DOWNGRADE_SUCCESS_THRESHOLD) {
			this.warmupActive = false;
			return { adjustment: "no_change", message: `Adaptive warmup cautious: keeping concurrency=${this.currentConcurrency}, success=${Math.round(successRate * 100)}%` };
		}

		return { adjustment: "no_change" };
	}

	private evaluateAdjustment(): { adjustment: StrategyAdjustment; message?: string } {
		if (!this.metrics.hasMinimumSamples()) return { adjustment: "no_change" };
		if (this.metrics.requestsSinceAdjustment() < COOLDOWN_REQUESTS) return { adjustment: "no_change" };

		const successRate = this.metrics.successRate();
		const latencyHealth = this.metrics.latencyHealth();
		const hasRateLimit = this.metrics.hasRateLimitErrors();

		if (successRate < DOWNGRADE_SUCCESS_THRESHOLD || hasRateLimit || latencyHealth === "high") {
			return this.applyDowngrade(successRate, hasRateLimit, latencyHealth);
		}

		if (successRate > UPGRADE_SUCCESS_THRESHOLD && latencyHealth === "healthy") {
			return this.applyUpgrade(successRate);
		}

		return { adjustment: "no_change" };
	}

	private applyDowngrade(successRate: number, hasRateLimit: boolean, latencyHealth: LatencyHealth): { adjustment: StrategyAdjustment; message?: string } {
		const oldConcurrency = this.currentConcurrency;
		const oldTimeout = this.currentTimeoutMs;
		this.currentConcurrency = Math.max(MIN_CONCURRENCY, Math.floor(this.currentConcurrency / 2));
		this.currentTimeoutMs = Math.min(MAX_TIMEOUT_MS, Math.floor(this.currentTimeoutMs * 1.5));
		this.metrics.resetAdjustmentCounter();

		const reason = hasRateLimit ? "rate_limited" : latencyHealth === "high" ? "high_latency" : "low_success_rate";
		return {
			adjustment: "downgrade",
			message: `Adaptive downgrade (${reason}): concurrency ${oldConcurrency}→${this.currentConcurrency}, timeout ${Math.round(oldTimeout / 1000)}s→${Math.round(this.currentTimeoutMs / 1000)}s, success=${Math.round(successRate * 100)}%, ewma=${Math.round(this.metrics.ewma())}ms`,
		};
	}

	private applyUpgrade(successRate: number): { adjustment: StrategyAdjustment; message?: string } {
		const oldConcurrency = this.currentConcurrency;
		const oldTimeout = this.currentTimeoutMs;
		const atMaxConcurrency = this.currentConcurrency >= MAX_CONCURRENCY || this.currentConcurrency >= this.targetConcurrency;
		const atMinTimeout = this.currentTimeoutMs <= MIN_TIMEOUT_MS || this.currentTimeoutMs <= this.targetTimeoutMs;

		if (!atMaxConcurrency) {
			this.currentConcurrency = Math.min(MAX_CONCURRENCY, this.currentConcurrency + 1);
		}
		if (!atMinTimeout) {
			this.currentTimeoutMs = Math.max(MIN_TIMEOUT_MS, Math.floor(this.currentTimeoutMs * 0.8));
		}

		if (oldConcurrency === this.currentConcurrency && oldTimeout === this.currentTimeoutMs) {
			return { adjustment: "no_change" };
		}

		this.metrics.resetAdjustmentCounter();
		return {
			adjustment: "upgrade",
			message: `Adaptive upgrade: concurrency ${oldConcurrency}→${this.currentConcurrency}, timeout ${Math.round(oldTimeout / 1000)}s→${Math.round(this.currentTimeoutMs / 1000)}s, success=${Math.round(successRate * 100)}%, ewma=${Math.round(this.metrics.ewma())}ms`,
		};
	}
}
