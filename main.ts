// Pump.fun Replay Sprint — paper bot, real ranking.
//
// The grader runs `node /bot/main.ts` with this directory mounted at /bot.
// The bot is a "first-print flipper": it buys a curve on its first sign of
// real buying, with a small stake, and flips it fast on a fixed take-profit,
// stop-loss, or time limit. Breadth over selection — many small coins, the
// few runners pay for the many small losses. One buy per coin, one exit.
//
// The replay protocol (agent-fun/replay/v2) is spoken through the kit's SDK
// shim, vendored byte for byte in vendor/makefun-bot.ts, exactly as the kit
// documents. The strategy itself — what to buy, when to sell — lives in
// strategy.ts and is written for this entry.
//
// Settings below are the starting point traded with: a 0.05 SOL stake, a
// 2:1 reward-to-risk exit pair (+40% take-profit, -20% stop-loss), and a
// 3,000-slot hold cap so capital turns over across many coins. They were
// picked to clear the round-trip fee (~3% of stake) with room, and to keep
// the run above the 20-coin guardrail on a 24h window of ~1,200 curves.
import { runBot } from "./vendor/makefun-bot.ts";
import { createStrategy, DEFAULT_PARAMS, type Params } from "./strategy.ts";

// Settings traded with: the strategy defaults, with the stake and exits
// spelled out here so the traded numbers are visible at the entrypoint.
// A round trip costs ~3% of stake (1.25% curve fees each way + tx fees +
// a 2% failed-tx draw), so the take-profit must clear that with room, and
// the 3,000-slot cap keeps capital turning over across many coins.
const PARAMS: Params = {
  ...DEFAULT_PARAMS,
  stakeLamports: 50_000_000n,
  takeProfitBps: 4000,
  stopLossBps: 2000,
  maxHold: 3000,
};

// Fail fast on a misconfiguration instead of trading a broken setup for 24h:
// the stake must clear the round-trip minimum, the take-profit must clear
// the round-trip fee, and open positions must fit the harness cap.
if (PARAMS.stakeLamports < PARAMS.minBuyLamports) {
  throw new Error("stake is below the round-trip minimum");
}
if (PARAMS.takeProfitBps <= 300) {
  throw new Error("take-profit does not clear the round-trip fee");
}
if (PARAMS.maxOpen > 5) {
  throw new Error("open positions exceed the harness cap of 5");
}

await runBot(createStrategy(PARAMS));
