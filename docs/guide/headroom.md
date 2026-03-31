# Headroom Integration

ccusage now supports additive cost tracking for [Headroom](https://github.com/n-ups/headroom), a context-optimization proxy for Claude Code.

## Overview

When you use Headroom as a proxy for Claude Code, it optimizes your prompts by stripping redundant context, which saves money. However, since these optimizations happen at the proxy level, the standard Claude Code logs (`~/.config/claude/projects/*.jsonl`) only reflect the _reduced_ token counts that were actually sent to Anthropic.

The Headroom integration in ccusage allows you to see the "True Total Paid" by combining:

1. **Claude Code Cost**: The amount billed by Anthropic (captured in local logs).
2. **Headroom Proxy Cost**: The amount spent on Headroom's internal processing (calculated from Headroom's performance metrics).

## How it Works

ccusage automatically detects if `headroom` is installed on your system. If found, it runs `headroom perf` in the background to fetch model-specific savings percentages and USD amounts.

### The Balance Sheet Logic

The integration presents a "Balance Sheet" at the bottom of your reports:

```text
--- Headroom Proxy Impact ---
Headroom Usage:   +$79.41
Headroom Savings: -$11.90 (15.0%)
Headroom Paid:    +$67.51

--- Combined Total ---
Claude Code Paid: $469.87
Headroom Paid:    +$67.51
--------------------------------
Grand Total Paid: $537.38
```

### Mathematical Attribution

The proxy cost is extrapolated using the following logic per model:

1. **Gross Usage Cost** = `Savings Amount / Savings Percentage`
   - If you saved $11.73 at a 15% reduction rate, your gross usage was $78.20.
2. **Headroom Paid (Net)** = `Gross Usage Cost - Savings Amount`
   - In this example: $78.20 - $11.73 = $66.47.
3. **Grand Total** = `Claude Code Paid + Headroom Paid`

## Configuration

The feature is enabled by default if `headroom` is detected.

### Disabling Headroom Tracking

If you want to hide the Headroom balance sheet, use the `--no-headroom` flag:

```bash
ccusage daily --no-headroom
```

### JSON Output

When using `--json`, a `headroom` object is injected into the root of the response:

```json
{
	"totals": { "totalCost": 469.87 },
	"headroom": {
		"usageCost": 79.41,
		"savings": 11.9,
		"totalPaid": 67.51
	},
	"grandTotalPaid": 537.38
}
```

## Troubleshooting

- **Headroom not found**: ccusage silently skips the calculation if the `headroom` binary is not in your `PATH`.
- **Permission issues**: Ensure the user running `ccusage` has permission to execute `headroom`.
