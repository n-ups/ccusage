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
import { loadMonthlyUsageData } from '../data-loader.ts';
import { detectMismatches, printMismatchReport } from '../debug.ts';
import { log, logger } from '../logger.ts';

export const monthlyCommand = define({
	name: 'monthly',
	description: 'Show usage report grouped by month',
	...sharedCommandConfig,
	async run(ctx) {
		// Load configuration and merge with CLI arguments
		const config = loadConfig(ctx.values.config, ctx.values.debug);
		const mergedOptions = mergeConfigWithArgs(ctx, config, ctx.values.debug);

		// --jq implies --json
		const useJson = Boolean(mergedOptions.json) || mergedOptions.jq != null;
		if (useJson) {
			logger.level = 0;
		}

		const monthlyData = await loadMonthlyUsageData(mergedOptions);

		if (monthlyData.length === 0) {
			if (useJson) {
				const emptyOutput = {
					monthly: [],
					totals: {
						inputTokens: 0,
						outputTokens: 0,
						cacheCreationTokens: 0,
						cacheReadTokens: 0,
						totalTokens: 0,
						totalCost: 0,
					},
				};
				log(JSON.stringify(emptyOutput, null, 2));
			} else {
				logger.warn('No Claude usage data found.');
			}
			process.exit(0);
		}

		// Calculate totals
		const totals = calculateTotals(monthlyData);

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
		if (mergedOptions.debug && !useJson) {
			const mismatchStats = await detectMismatches(undefined);
			printMismatchReport(mismatchStats, mergedOptions.debugSamples as number | undefined);
		}

		if (useJson) {
			// Output JSON format
			const jsonOutput = {
				monthly: monthlyData.map((data) => ({
					month: data.month,
					inputTokens: data.inputTokens,
					outputTokens: data.outputTokens,
					cacheCreationTokens: data.cacheCreationTokens,
					cacheReadTokens: data.cacheReadTokens,
					totalTokens: getTotalTokens(data),
					totalCost: data.totalCost,
					modelsUsed: data.modelsUsed,
					modelBreakdowns: data.modelBreakdowns,
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
			if (mergedOptions.jq != null) {
				const jqResult = await processWithJq(jsonOutput, mergedOptions.jq);
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
			logger.box('Claude Code Token Usage Report - Monthly');

			// Create table with compact mode support
			const tableConfig: UsageReportConfig = {
				firstColumnName: 'Month',
				dateFormatter: (dateStr: string) =>
					formatDateCompact(
						dateStr,
						mergedOptions.timezone,
						mergedOptions.locale ?? DEFAULT_LOCALE,
					),
				forceCompact: ctx.values.compact,
			};
			const table = createUsageReportTable(tableConfig);

			// Add monthly data
			for (const data of monthlyData) {
				// Main row
				const row = formatUsageDataRow(data.month, {
					inputTokens: data.inputTokens,
					outputTokens: data.outputTokens,
					cacheCreationTokens: data.cacheCreationTokens,
					cacheReadTokens: data.cacheReadTokens,
					totalCost: data.totalCost,
					modelsUsed: data.modelsUsed,
				});
				table.push(row);

				// Add model breakdown rows if flag is set
				if (mergedOptions.breakdown) {
					pushBreakdownRows(table, data.modelBreakdowns);
				}
			}

			// Add empty row for visual separation before totals
			addEmptySeparatorRow(table, 8);

			// Add totals
			const totalsRow = formatTotalsRow({
				inputTokens: totals.inputTokens,
				outputTokens: totals.outputTokens,
				cacheCreationTokens: totals.cacheCreationTokens,
				cacheReadTokens: totals.cacheReadTokens,
				totalCost: totals.totalCost,
			});
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
