import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { Result } from '@praha/byethrow';

const execFileAsync = promisify(execFile);

export type HeadroomModelStats = {
	savedPct: number; // e.g. 0.15 for 15%
	savedUsd: number; // e.g. 11.72
};

export type HeadroomStats = {
	totalTokensSaved: number;
	models: Record<string, HeadroomModelStats>; // key is model name
};

export async function getHeadroomStats(): Result.ResultAsync<HeadroomStats, Error> {
	const resultFn = Result.try({
		try: async () => {
			const { stdout } = await execFileAsync('headroom', ['perf']);
			return parseHeadroomOutput(stdout);
		},
		catch: (error: unknown) => {
			const msg = error instanceof Error ? error.message : String(error);
			if (msg.includes('ENOENT') || msg.includes('not found')) {
				return new Error('HEADROOM_NOT_FOUND');
			}
			return new Error(msg);
		},
	});
	return resultFn();
}

export function parseHeadroomOutput(output: string): HeadroomStats {
	const stats: HeadroomStats = {
		totalTokensSaved: 0,
		models: {},
	};

	// Parse total tokens saved
	const totalSavedMatch = /Total saved:\s+([\d,]+)\s+tokens/.exec(output);
	if (totalSavedMatch != null && totalSavedMatch[1] != null) {
		stats.totalTokensSaved = Number.parseInt(totalSavedMatch[1].replace(/,/g, ''), 10);
	}

	// Parse per-model usage
	// Example: claude-sonnet-4-6: 544 reqs, 3,905,672 tokens saved (15%), list price $3.00/MTok  ~$11.72 at list price
	const modelRegex =
		/\s+([a-zA-Z0-9\-.]+):\s+\d+ reqs,\s+[\d,]+\s+tokens saved \((\d+)%\).*?~\$([\d.]+)\s+at list price/g;
	let match = modelRegex.exec(output);
	while (match !== null) {
		const modelName = match[1];
		const savedPct = Number.parseInt(match[2] ?? '0', 10) / 100;
		const savedUsd = Number.parseFloat(match[3] ?? '0');

		if (modelName != null) {
			stats.models[modelName] = {
				savedPct,
				savedUsd,
			};
		}
		match = modelRegex.exec(output);
	}

	return stats;
}

export type HeadroomBalance = {
	usageCost: number; // The gross cost of usage BEFORE savings was stripped
	savings: number; // The amount saved by optimization
	totalPaid: number; // The net paid specifically tracked by headroom (usage - savings)
};

export function calculateHeadroomBalance(stats: HeadroomStats): HeadroomBalance {
	let savings = 0;
	let usageCost = 0;

	for (const modelStats of Object.values(stats.models)) {
		if (modelStats.savedPct > 0) {
			const modelUsageCost = modelStats.savedUsd / modelStats.savedPct;
			usageCost += modelUsageCost;
			savings += modelStats.savedUsd;
		}
	}

	return {
		usageCost,
		savings,
		totalPaid: usageCost - savings,
	};
}

if (import.meta.vitest != null) {
	describe('headroom parser', () => {
		it('should parse valid headroom output', () => {
			const mockOutput = `
Headroom Performance Report
============================================================

Requests:     666
Tokens:       27,447,343 -> 23,399,280 (14.8% reduction)
Total saved:  4,074,560 tokens

Per-Model Breakdown
----------------------------------------
  claude-haiku-4-5-20251001: 122 reqs, 168,888 tokens saved (14%), list price $1.00/MTok  ~$0.17 at list price
  claude-sonnet-4-20250514: 544 reqs, 3,905,672 tokens saved (15%), list price $3.00/MTok  ~$11.72 at list price
  * Actual bill savings depend on provider caching behavior
			`;

			const stats = parseHeadroomOutput(mockOutput);
			expect(stats.totalTokensSaved).toBe(4074560);
			expect(stats.models['claude-haiku-4-5-20251001']).toBeDefined();
			expect(stats.models['claude-haiku-4-5-20251001']?.savedPct).toBe(0.14);
			expect(stats.models['claude-haiku-4-5-20251001']?.savedUsd).toBe(0.17);

			expect(stats.models['claude-sonnet-4-20250514']).toBeDefined();
			expect(stats.models['claude-sonnet-4-20250514']?.savedPct).toBe(0.15);
			expect(stats.models['claude-sonnet-4-20250514']?.savedUsd).toBe(11.72);
		});
	});
}
