# Pump.fun Replay Sprint — Paper Bot, Real Ranking

[![make.fun · u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122](https://make.fun/badge/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122.svg)](https://make.fun/bounty/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122)
[![make.fun · rank](https://make.fun/badge/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122/oxizbinance-aox/pump-fun-replay-sprint-20261124/rank.svg)](https://make.fun/bounty/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122)
[![make.fun · reward](https://make.fun/badge/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122/oxizbinance-aox/pump-fun-replay-sprint-20261124/reward.svg)](https://make.fun/bounty/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122)

A paper trading bot for the 24h pump.fun replay: 10 SOL of paper money, best net PnL wins, and a place needs net PnL above 0 after every fee.

## Strategy: first-print flipper

Breadth over selection. The bot buys a curve on its first sign of real buying, with a small stake, and flips it fast. One buy per coin, one exit — no pyramiding, no trailing stops, no acceleration windows.

**Entry (once per mint):** the curve is past its first slots (bundled launches dump immediately); its tape shows mostly buys (≥60%) from at least 3 distinct wallets; its price is already ≥3% above creation; its real reserve is ≥1 SOL so the 1%-of-reserve cap allows a buy of at least 0.01 SOL (the round-trip minimum). The buy is min(0.05 SOL stake, cap).

**Exit (whole position, first trigger wins):** take-profit at +40% of cost, stop-loss at −20% of cost, or a hard 3,000-slot hold cap. A curve that completes is closed by the replay itself.

**Why these numbers:** a round trip costs ~3% of stake (1.25% curve fees each way + 105k lamports tx fees per order + a 2% failed-tx draw), so the +40%/−20% exit pair needs only a ~29% win rate to break even before fees are counted twice — and the 3,000-slot cap keeps capital turning over across many coins instead of sitting in one dead curve. The entry bar is deliberately loose so a 24h window of ~1,200 curves yields far more than the 20-coin guardrail minimum.

**Determinism:** every decision is a pure function of the recorded tape — no clock, no randomness, iteration only over insertion-ordered maps. Two runs agree byte for byte, as the harness requires.

## Files

- `main.ts` — entrypoint: runs the bot with the traded settings.
- `strategy.ts` — the strategy (entry/exit rules, tape tracking, order bookkeeping).
- `vendor/makefun-bot.ts` — the kit's SDK shim, vendored byte for byte exactly as the kit documents (sha256 `4e243d4a0adce99b66b6124dd5a9c06867a92f7a0dd03dc6d65195f2f9ebbf08`).

## Backtest — NOT YET RUN IN THE BUILD SESSION

⚠️ The backtest was **not** run while building: the session hit an execution-risk flag on the vendored SDK copy, so no local run was executed here. **Run it before bundling/submitting** — do not submit blind:

```sh
KIT=~/workspace/makefun/oneline-kits/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122-kit
# backtest this strategy on the dev window (pilot sim + this repo's strategy):
node $KIT/baselines/pilot/momentum/tools/backtest.ts $KIT  # (expects ../strategy.ts — see note)
# or grade as the server will (needs the transcripts bundle first):
node $KIT/cli/makefun.mjs grade-local --kit $KIT --bot <repo-dir> --driver docker --bundle <transcripts.tar.gz>
node $KIT/cli/makefun.mjs grade-local --kit $KIT --bot <repo-dir> --driver docker --bundle <transcripts.tar.gz> --stress 20
```

Note: the pilot `backtest.ts` imports `../strategy.ts` (its own pilot strategy). To test THIS strategy with it, point a copy of the driver at this repo's `strategy.ts`, or use `grade-local --stress` (the authoritative check — it also prints how much of the net PnL came from the 3 best coins).

**Submit only if:** dev net PnL > 0, fills ≥ 200 over ≥ 20 coins, max drawdown ≤ 50%, and the ex-best-coins net is still positive (a win that leans on one lucky coin will not survive the final window). If the dev PnL is negative, tune `takeProfitBps` / `stopLossBps` / `minRiseBps` / `stakeLamports` on a small grid and prefer a flat region over the single best cell.

Bounty: https://make.fun/bounty/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122

## License

MIT — see [LICENSE](LICENSE).
