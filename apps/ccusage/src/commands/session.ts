import type { UsageReportConfig } from '@ccusage/terminal/table';
import type { HeadroomBalance } from '../_headroom-parser.ts';
import process from 'node:process';
import {
	addEmptySeparatorRow,
	createUsageReportTable,
	formatCurrency,
	formatTotalsRow,
	formatUsageDataRow,
	pushBreakdownRows,
} from '@ccusage/terminal/table';
import { Result } from '@praha/byethrow';
import { define } from 'gunshi';
import pc from 'picocolors';
import { loadConfig, mergeConfigWithArgs } from '../_config-loader-tokens.ts';
import { DEFAULT_LOCALE } from '../_consts.ts';
import { formatDateCompact } from '../_date-utils.ts';
import { calculateHeadroomBalance, getHeadroomStats } from '../_headroom-parser.ts';
import { processWithJq } from '../_jq-processor.ts';
import { sharedCommandConfig } from '../_shared-args.ts';
import { calculateTotals, createTotalsObject, getTotalTokens } from '../calculate-cost.ts';
import { loadSessionData } from '../data-loader.ts';
import { detectMismatches, printMismatchReport } from '../debug.ts';
import { log, logger } from '../logger.ts';
import { handleSessionIdLookup } from './_session_id.ts';

// eslint-disable-next-line ts/no-unused-vars
const { order: _, ...sharedArgs } = sharedCommandConfig.args;

export const sessionCommand = define({
	name: 'session',
	description: 'Show usage report grouped by conversation session',
	...sharedCommandConfig,
	args: {
		...sharedArgs,
		id: {
			type: 'string',
			short: 'i',
			description: 'Load usage data for a specific session ID',
		},
	},
	toKebab: true,
	async run(ctx): Promise<void> {
		// Load configuration and merge with CLI arguments
		const config = loadConfig(ctx.values.config, ctx.values.debug);
		const mergedOptions: typeof ctx.values = mergeConfigWithArgs(ctx, config, ctx.values.debug);

		// --jq implies --json
		const useJson = mergedOptions.json || mergedOptions.jq != null;
		if (useJson) {
			logger.level = 0;
		}

		// Handle specific session ID lookup
		if (mergedOptions.id != null) {
			return handleSessionIdLookup(
				{
					values: {
						id: mergedOptions.id,
						mode: mergedOptions.mode,
						offline: mergedOptions.offline,
						jq: mergedOptions.jq,
						timezone: mergedOptions.timezone,
						locale: mergedOptions.locale ?? DEFAULT_LOCALE,
						headroom: mergedOptions.headroom,
					},
				},
				useJson,
			);
		}

		// Original session listing logic
		const sessionData = await loadSessionData({
			since: ctx.values.since,
			until: ctx.values.until,
			mode: ctx.values.mode,
			offline: ctx.values.offline,
			timezone: ctx.values.timezone,
			locale: ctx.values.locale,
		});

		if (sessionData.length === 0) {
			if (useJson) {
				log(JSON.stringify([]));
			} else {
				logger.warn('No Claude usage data found.');
			}
			process.exit(0);
		}

		// Calculate totals
		const totals = calculateTotals(sessionData);

		let headroomBalance: HeadroomBalance | undefined;
		if (mergedOptions.headroom === true) {
			const headroomResult = await getHeadroomStats();
			if (Result.isSuccess(headroomResult)) {
				headroomBalance = calculateHeadroomBalance(headroomResult.value);
			} else if (headroomResult.error.message !== 'HEADROOM_NOT_FOUND') {
				logger.warn(`Failed to fetch headroom stats: ${headroomResult.error.message}`);
			}
		}

		// Show debug information if requested
		if (ctx.values.debug && !useJson) {
			const mismatchStats = await detectMismatches(undefined);
			printMismatchReport(mismatchStats, ctx.values.debugSamples);
		}

		if (useJson) {
			// Output JSON format
			const jsonOutput = {
				sessions: sessionData.map((data) => ({
					sessionId: data.sessionId,
					inputTokens: data.inputTokens,
					outputTokens: data.outputTokens,
					cacheCreationTokens: data.cacheCreationTokens,
					cacheReadTokens: data.cacheReadTokens,
					totalTokens: getTotalTokens(data),
					totalCost: data.totalCost,
					lastActivity: data.lastActivity,
					modelsUsed: data.modelsUsed,
					modelBreakdowns: data.modelBreakdowns,
					projectPath: data.projectPath,
				})),
				totals: createTotalsObject(totals),
				...(headroomBalance != null ? { headroom: headroomBalance } : {}),
			};

			if (headroomBalance != null) {
				Object.assign(jsonOutput, {
					grandTotalPaid: totals.totalCost + headroomBalance.totalPaid,
				});
			}

			// Process with jq if specified
			if (ctx.values.jq != null) {
				const jqResult = await processWithJq(jsonOutput, ctx.values.jq);
				if (Result.isFailure(jqResult)) {
					logger.error(jqResult.error.message);
					process.exit(1);
				}
				log(jqResult.value);
			} else {
				log(JSON.stringify(jsonOutput, null, 2));
			}
		} else {
			// Print header
			logger.box('Claude Code Token Usage Report - By Session');

			// Create table with compact mode support
			const tableConfig: UsageReportConfig = {
				firstColumnName: 'Session',
				includeLastActivity: true,
				dateFormatter: (dateStr: string) =>
					formatDateCompact(dateStr, ctx.values.timezone, ctx.values.locale),
				forceCompact: ctx.values.compact,
			};
			const table = createUsageReportTable(tableConfig);

			// Add session data
			let maxSessionLength = 0;
			for (const data of sessionData) {
				const sessionDisplay = data.sessionId.split('-').slice(-2).join('-'); // Display last two parts of session ID

				maxSessionLength = Math.max(maxSessionLength, sessionDisplay.length);

				// Main row
				const row = formatUsageDataRow(
					sessionDisplay,
					{
						inputTokens: data.inputTokens,
						outputTokens: data.outputTokens,
						cacheCreationTokens: data.cacheCreationTokens,
						cacheReadTokens: data.cacheReadTokens,
						totalCost: data.totalCost,
						modelsUsed: data.modelsUsed,
					},
					data.lastActivity,
				);
				table.push(row);

				// Add model breakdown rows if flag is set
				if (ctx.values.breakdown) {
					// Session has 1 extra column before data and 1 trailing column
					pushBreakdownRows(table, data.modelBreakdowns, 1, 1);
				}
			}

			// Add empty row for visual separation before totals
			addEmptySeparatorRow(table, 9);

			// Add totals
			const totalsRow = formatTotalsRow(
				{
					inputTokens: totals.inputTokens,
					outputTokens: totals.outputTokens,
					cacheCreationTokens: totals.cacheCreationTokens,
					cacheReadTokens: totals.cacheReadTokens,
					totalCost: totals.totalCost,
				},
				true,
			); // Include Last Activity column
			table.push(totalsRow);

			log(table.toString());

			if (headroomBalance != null) {
				const pctSaved =
					headroomBalance.usageCost > 0
						? (headroomBalance.savings / headroomBalance.usageCost) * 100
						: 0;

				log(`\n${pc.cyan('--- Headroom Proxy Impact ---')}`);
				log(`Headroom Usage:   ${pc.red(`+${formatCurrency(headroomBalance.usageCost)}`)}`);
				log(
					`Headroom Savings: ${pc.green(`-${formatCurrency(headroomBalance.savings)}`)} (${pctSaved.toFixed(1)}%)`,
				);
				log(`Headroom Paid:    ${pc.yellow(`+${formatCurrency(headroomBalance.totalPaid)}`)}`);

				log(`\n${pc.cyan('--- Combined Total ---')}`);
				log(`Claude Code Paid: ${formatCurrency(totals.totalCost)}`);
				log(`Headroom Paid:    ${pc.yellow(`+${formatCurrency(headroomBalance.totalPaid)}`)}`);
				log(`--------------------------------`);
				log(
					`Grand Total Paid: ${pc.yellow(formatCurrency(totals.totalCost + headroomBalance.totalPaid))}`,
				);
			}

			// Show guidance message if in compact mode
			if (table.isCompactMode()) {
				logger.info('\nRunning in Compact Mode');
				logger.info('Expand terminal width to see cache metrics and total tokens');
			}
		}
	},
});

// Note: Tests for --id functionality are covered by the existing loadSessionUsageById tests
// in data-loader.ts, since this command directly uses that function.
