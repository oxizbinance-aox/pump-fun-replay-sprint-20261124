// First-print flipper for the pump.fun bonding-curve replay.
//
// IDEA (mine, written for this entry): buy a curve on its first sign of real
// buying, with a small stake, and flip it fast. Breadth over selection —
// trade many coins, let the few runners pay for the many small losses. One
// buy per coin, one exit: no pyramiding, no trailing stops, no acceleration
// windows. Every decision is a pure function of the recorded tape, so two
// runs agree byte for byte: no clock, no randomness, iteration only over
// insertion-ordered maps fed by the batch stream.
//
// ENTRY (once per mint): the curve is past its first slots (bundled launches
// dump immediately), its tape shows mostly buys from several distinct
// wallets, its price is already up from creation, and its real reserve is
// big enough that the 1%-of-reserve cap allows a buy of at least 0.01 SOL
// (the round-trip minimum). The buy is min(stake, cap).
//
// EXIT (whole position, first trigger wins): take-profit on value vs cost,
// stop-loss on value vs cost, or a hard time limit in slots. A curve that
// completes is closed by the replay itself.
//
// GUARDRAIL: the run needs round trips on at least 20 distinct mints. The
// entry bar is deliberately loose (a handful of trades, a few buyers) so a
// 24h window of ~1,200 curves yields far more than 20 candidates.
import type { Batch, Bot, BotState, OrderInput, Pubkey } from "./vendor/makefun-bot.ts";

export interface Params {
  /** Slots since the CreateEvent before an entry is allowed. */
  minAge: number;
  /** Trades seen on the curve before an entry is allowed. */
  minTrades: number;
  /** Buys / trades, in bps (6000 = 60% of the tape is buys). */
  minBuyShareBps: number;
  /** Distinct buying wallets in the tape. */
  minBuyers: number;
  /** Price now must be at least this far above the creation price, in bps. */
  minRiseBps: number;
  /** Real SOL reserve needed so the 1% cap allows a >= 0.01 SOL buy, lamports. */
  minRealLamports: bigint;
  /** SOL to put into one position, lamports. */
  stakeLamports: bigint;
  /** Smallest buy worth sending, lamports (the round-trip minimum). */
  minBuyLamports: bigint;
  /** Slippage on buys, in bps; sells always go out at 10000. */
  buySlipBps: number;
  /** Sell when value >= cost * (1 + takeProfitBps / 10000). */
  takeProfitBps: number;
  /** Sell when value <= cost * (1 - stopLossBps / 10000). */
  stopLossBps: number;
  /** Slots held before a forced exit. */
  maxHold: number;
  /** Most positions open at once. */
  maxOpen: number;
}

// Settings traded with. Chosen as a flat, robust starting point: a small
// stake (fees are ~3% of a round trip, so the take-profit must clear them
// with room), a 2:1 reward-to-risk exit pair, and a short hold so capital
// turns over across many coins instead of sitting in one dead curve.
export const DEFAULT_PARAMS: Params = {
  minAge: 10,
  minTrades: 6,
  minBuyShareBps: 6000,
  minBuyers: 3,
  minRiseBps: 300,
  minRealLamports: 1_000_000_000n,
  stakeLamports: 50_000_000n,
  minBuyLamports: 10_000_000n,
  buySlipBps: 2000,
  takeProfitBps: 4000,
  stopLossBps: 2000,
  maxHold: 3000,
  maxOpen: 5,
};

/** The recorded tape of one curve: everything the entry decision reads. */
interface Tape {
  createdSlot: number;
  /** Creation price as a ratio virtual_quote / virtual_token. */
  createVq: bigint;
  createVt: bigint;
  trades: number;
  buys: number;
  buyers: Set<string>;
}

interface OpenPosition {
  mint: Pubkey;
  entrySlot: number;
}

export function createStrategy(params: Params): Bot {
  const tape = new Map<Pubkey, Tape>();
  const entered = new Set<Pubkey>();
  const exited = new Set<Pubkey>();
  const open = new Map<Pubkey, OpenPosition>();
  const pendingBuy = new Map<string, Pubkey>();
  const pendingSell = new Map<string, Pubkey>();
  // Same pendings indexed by mint (the maps above are keyed by client_id).
  const pendingBuyMints = new Set<Pubkey>();
  const pendingSellMints = new Set<Pubkey>();
  let counter = 1;

  // Price of a curve now, as the ratio virtual_quote / virtual_token.
  // Compared cross-multiplied so no division (and no float) ever appears.
  function priceUpNow(
    state: BotState,
    mint: Pubkey,
    t: Tape,
    riseBps: number,
  ): boolean {
    const curve = state.curves.get(mint);
    if (curve === undefined) return false;
    const vq = curve.virtual_quote_reserves;
    const vt = curve.virtual_token_reserves;
    if (vt === 0n || t.createVt === 0n) return false;
    // vq/vt >= (vq0/vt0) * (10000 + rise) / 10000
    return vq * t.createVt * 10_000n >= vt * t.createVq * BigInt(10_000 + riseBps);
  }

  // Current SOL value of a holding, in lamports: tokens * vq / vt.
  function holdingValue(state: BotState, mint: Pubkey, tokens: bigint): bigint | null {
    const curve = state.curves.get(mint);
    if (curve === undefined) return null;
    const vt = curve.virtual_token_reserves;
    if (vt === 0n) return null;
    return (tokens * curve.virtual_quote_reserves) / vt;
  }

  return {
    onBatch(state: BotState, batch: Batch): OrderInput[] {
      // 1. Fold this batch's fills into the books: a buy that landed opens a
      // position (entry slot = the fill's slot); a buy rejected or failed
      // frees the mint for another try; a sell that landed closes it.
      for (const fill of batch.fills) {
        const buyMint = pendingBuy.get(fill.client_id);
        if (buyMint !== undefined) {
          pendingBuy.delete(fill.client_id);
          pendingBuyMints.delete(buyMint);
          if (fill.status === "filled") {
            entered.add(buyMint);
            open.set(buyMint, { mint: buyMint, entrySlot: fill.slot });
          }
        }
        const sellMint = pendingSell.get(fill.client_id);
        if (sellMint !== undefined) {
          pendingSell.delete(fill.client_id);
          pendingSellMints.delete(sellMint);
          if (fill.status === "filled") {
            open.delete(sellMint);
            exited.add(sellMint);
          }
        }
      }

      // 2. Fold this batch's events into the tape.
      for (const e of batch.events) {
        if (e.event === "CreateEvent") {
          if (!tape.has(e.mint)) {
            tape.set(e.mint, {
              createdSlot: e.slot,
              createVq: BigInt(e.virtual_quote_reserves),
              createVt: BigInt(e.virtual_token_reserves),
              trades: 0,
              buys: 0,
              buyers: new Set<string>(),
            });
          }
        } else if (e.event === "TradeEvent") {
          const t = tape.get(e.mint);
          if (t === undefined) continue;
          t.trades += 1;
          if (e.is_buy) {
            t.buys += 1;
            if (t.buyers.size < 1000) t.buyers.add(e.user);
          }
        } else {
          // CompleteEvent: the curve is done; drop its tape so it is never
          // considered again.
          tape.delete(e.mint);
        }
      }

      // 3. Drop bookkeeping for positions the replay closed itself
      // (completion / flatten): they are gone from state.positions.
      for (const mint of [...open.keys()]) {
        if (!state.positions.has(mint) && !pendingSellMints.has(mint)) {
          open.delete(mint);
          exited.add(mint);
        }
      }

      const orders: OrderInput[] = [];
      const maxOrders = state.hello.caps.max_orders_per_batch;
      const tx = state.txFeeLamports();

      // 4. Exits first: they free position slots and cash for new entries.
      for (const [mint, pos] of open) {
        if (orders.length >= maxOrders) break;
        if (pendingSellMints.has(mint)) continue;
        const holding = state.positions.get(mint);
        if (holding === undefined) continue;
        const value = holdingValue(state, mint, holding.token_amount);
        if (value === null) continue;
        const cost = holding.cost_lamports;
        const held = state.slot - pos.entrySlot;
        const take = value * 10_000n >= cost * BigInt(10_000 + params.takeProfitBps);
        const stop = value * 10_000n <= cost * BigInt(10_000 - params.stopLossBps);
        if (take || stop || held >= params.maxHold) {
          const id = `s${counter++}`;
          pendingSell.set(id, mint);
          pendingSellMints.add(mint);
          orders.push({
            side: "sell",
            mint,
            token_amount: holding.token_amount,
            max_slippage_bps: 10_000,
            client_id: id,
          });
        }
      }

      // 5. Entries: one buy per mint, cheapest filters first.
      let free = state.freeCashLamports();
      const slots = params.maxOpen - state.committedPositionCount();
      if (slots > 0) {
        for (const [mint, t] of tape) {
          if (orders.length >= maxOrders) break;
          if (entered.has(mint) || exited.has(mint)) continue;
          if (pendingBuyMints.has(mint)) continue;
          const curve = state.curves.get(mint);
          if (curve === undefined || curve.complete) continue;
          if (state.slot - t.createdSlot < params.minAge) continue;
          if (t.trades < params.minTrades) continue;
          if (t.buys * 10_000 < t.trades * params.minBuyShareBps) continue;
          if (t.buyers.size < params.minBuyers) continue;
          if (!priceUpNow(state, mint, t, params.minRiseBps)) continue;
          if (curve.real_quote_reserves < params.minRealLamports) continue;
          const cap = state.maxBuyLamports(mint);
          if (cap < params.minBuyLamports) continue;
          const amount = cap < params.stakeLamports ? cap : params.stakeLamports;
          if (amount < params.minBuyLamports) continue;
          if (free < amount + tx) continue;
          const id = `b${counter++}`;
          pendingBuy.set(id, mint);
          pendingBuyMints.add(mint);
          orders.push({
            side: "buy",
            mint,
            quote_lamports: amount,
            max_slippage_bps: params.buySlipBps,
            client_id: id,
          });
          free -= amount + tx;
        }
      }

      return orders;
    },
  };
}
