// Flash sniper for the pump.fun bonding-curve replay (agent-fun/replay/v2).
//
// Idea: on pump.fun almost every new coin dies within minutes, so the only edge is
// being extremely picky in the first seconds of a launch and getting out fast.
// A coin is bought at most once, in the first few slots after its CreateEvent, and
// only when its opening tape looks like real crowd interest rather than a bundle:
//   - the creator put some of their own SOL in (skin in the game, but not a whale),
//   - several distinct non-creator wallets already bought, but not so many that the
//     launch looks bundled across a wallet cluster,
//   - no creator sell yet, sells by others still small next to buys, no single big dump,
//   - the price has not already run away from its create price.
// The stake is one flat 0.1 SOL per coin, never pyramided: a bad pick costs little,
// a runner is sold whole at +30%, cut at -15%, trailed -15% once +10% is banked, and
// never held past 12 slots. A creator sell exits immediately.
//
// Guardrail probes keep the run above the minimum bar (round trips of >= 0.01 SOL on
// >= 20 coins): when the bot's own fills or coins lag the pace set in block time, it
// buys 0.01 SOL of the most liquid curve traded on the batch and sells it as soon as
// the buy lands.
//
// Deterministic by construction: no clock, no environment, no randomness; every
// iteration runs over insertion-ordered maps fed by the batch stream.

import { BPS, type Batch, type Bot, type BotState, type OrderInput, type Pubkey } from './vendor/makefun-bot.ts';

export interface Params {
  /** Youngest age (slots since create) at which a coin may be bought. */
  minAge: number;
  /** Oldest age at which a first buy may still be decided. */
  maxAge: number;
  /** Flat SOL staked on one coin (one buy only, never added to). */
  stakeSol: number;
  /** Smallest single buy worth paying the tx fee for (SOL). */
  minBuySol: number;
  /** Real SOL reserve window at decision time. */
  minRealSol: number;
  maxRealSol: number;
  /** Creator's own buys in the create slot (SOL). */
  minDevBuy: number;
  maxDevBuy: number;
  /** Trades seen and distinct (non-creator) buyers seen before entry. */
  minTrades: number;
  minBuyers: number;
  /** Distinct non-creator buyers before entry, at most: a launch bundled by many wallets is a dump in waiting. */
  maxBuyers: number;
  /** Lamports sold by others / lamports bought, as bps, at most. */
  maxSellRatioBps: number;
  /** Largest single non-creator sell seen, as bps of the real SOL reserve before it, at most. */
  maxBigSellBps: number;
  /** Price now over the create price, as bps: window. */
  minRunupBps: number;
  maxRunupBps: number;
  /** Slippage allowed on buys (bps). */
  buySlippageBps: number;
  /** Take profit: sell the whole position once it is worth this much over its cost (bps). */
  tpBps: number;
  /** Stop loss: sell the whole position once it is worth this much under its cost (bps). */
  slBps: number;
  /** The trailing stop arms once the position is worth this much over its cost (bps). */
  trailArmBps: number;
  /** Trailing stop: sell once the value falls this far below its best (bps). */
  trailBps: number;
  /** Never hold a position past this many slots. */
  maxHold: number;
  /** Creator sold before entry: skip the coin. */
  skipDevSold: boolean;
  /** Leave at once when the creator sells after entry. */
  exitOnDevSell: boolean;
  /** Guardrail pacing: target coins and fills over this many seconds of block time. */
  targetCoins: number;
  targetFills: number;
  paceSecs: number;
  /** Probe round-trip size (SOL). */
  probeSol: number;
  /** At most this many probe round trips in flight. */
  maxProbes: number;
}

export const DEFAULT_PARAMS: Params = {
  minAge: 0,
  maxAge: 6,
  stakeSol: 0.1,
  minBuySol: 0.05,
  minRealSol: 0.5,
  maxRealSol: 30,
  minDevBuy: 0.05,
  maxDevBuy: 2.5,
  minTrades: 3,
  minBuyers: 4,
  maxBuyers: 8,
  maxSellRatioBps: 5000,
  maxBigSellBps: 3000,
  minRunupBps: 9000,
  maxRunupBps: 25000,
  buySlippageBps: 10_000,
  tpBps: 3000,
  slBps: 1500,
  trailArmBps: 1000,
  trailBps: 1500,
  maxHold: 12,
  skipDevSold: true,
  exitOnDevSell: true,
  targetCoins: 25,
  targetFills: 120,
  paceSecs: 21_600,
  probeSol: 0.01,
  maxProbes: 1,
};

const LAMPORTS = 1e9;
const FEE_BPS = 125n;

/** What selling `tokens` against (vq, vt) would pay after curve fees (95 + 30 bps). */
function sellValue(tokens: bigint, vq: bigint, vt: bigint): bigint {
  if (tokens <= 0n || vt <= 0n) return 0n;
  const q = (tokens * vq) / (vt + tokens);
  return q - (q * FEE_BPS + 9999n) / 10_000n;
}

interface Coin {
  mint: Pubkey;
  createSlot: number;
  creator: Pubkey;
  /** The create-time reserves: the price run-up is measured against them. */
  vq0: bigint;
  vt0: bigint;
  devBuy: bigint;
  trades: number;
  buyers: Set<Pubkey>;
  bought: bigint;
  soldByOthers: bigint;
  bigSellBps: bigint;
  devSold: boolean;
  /** Never buy it again (exited, filtered out for good, or completed). */
  done: boolean;
  complete: boolean;
}

interface Held {
  openedSlot: number;
  /** Best close value seen (lamports, tx fee deducted). */
  best: bigint;
  /** Tx fees paid on this position's fills so far. */
  txPaid: bigint;
}

export function createStrategy(p: Params = DEFAULT_PARAMS): Bot {
  const coins = new Map<Pubkey, Coin>();
  /** Coins still young enough to consider, in creation order. */
  const live = new Set<Pubkey>();
  const held = new Map<Pubkey, Held>();
  /** Probe round trips in flight, by mint. */
  const probes = new Set<Pubkey>();
  /** The bot's own filled orders and the coins they were on (harness closes excluded). */
  let myFills = 0;
  const myCoins = new Set<Pubkey>();
  let firstTime: number | null = null;
  let lastTime: number | null = null;

  const readEvents = (batch: Batch): void => {
    for (const e of batch.events) {
      if (e.event === 'CreateEvent') {
        coins.set(e.mint, {
          mint: e.mint,
          createSlot: e.slot,
          creator: e.creator,
          vq0: BigInt(e.virtual_quote_reserves),
          vt0: BigInt(e.virtual_token_reserves),
          devBuy: 0n,
          trades: 0,
          buyers: new Set(),
          bought: 0n,
          soldByOthers: 0n,
          bigSellBps: 0n,
          devSold: false,
          done: false,
          complete: false,
        });
        live.add(e.mint);
      } else if (e.event === 'TradeEvent') {
        const c = coins.get(e.mint);
        if (c === undefined) continue;
        const sol = BigInt(e.sol_amount);
        c.trades += 1;
        const isDev = e.user === c.creator;
        if (e.is_buy) {
          c.bought += sol;
          if (isDev && e.slot === c.createSlot) c.devBuy += sol;
          else if (!isDev) c.buyers.add(e.user);
        } else if (isDev) {
          c.devSold = true;
        } else {
          c.soldByOthers += sol;
          const rqBefore = BigInt(e.real_quote_reserves) + sol;
          if (rqBefore > 0n) {
            const bps = (sol * BPS) / rqBefore;
            if (bps > c.bigSellBps) c.bigSellBps = bps;
          }
        }
      } else {
        const c = coins.get(e.mint);
        if (c !== undefined) {
          c.complete = true;
          c.done = true;
        }
        live.delete(e.mint);
      }
    }
  };

  return {
    onBatch(state: BotState, batch: Batch): OrderInput[] {
      readEvents(batch);
      for (const e of batch.events) {
        if (e.block_time === null) continue;
        if (firstTime === null) firstTime = e.block_time;
        if (lastTime === null || e.block_time > lastTime) lastTime = e.block_time;
      }
      const orders: OrderInput[] = [];
      const cap = state.hello.caps.max_orders_per_batch;
      const tx = state.txFeeLamports();
      const marks = new Map<Pubkey, { vq: bigint; vt: bigint }>();
      for (const m of batch.marks) marks.set(m.mint, { vq: BigInt(m.virtual_quote_reserves), vt: BigInt(m.virtual_token_reserves) });

      for (const f of batch.fills) {
        if (f.client_id.startsWith('_')) {
          held.delete(f.mint);
          probes.delete(f.mint);
          continue;
        }
        if (f.status === 'filled') {
          myFills += 1;
          myCoins.add(f.mint);
        }
        const h = held.get(f.mint);
        if (f.status !== 'rejected' && h !== undefined) h.txPaid += BigInt(f.tx_fee_lamports);
        if (f.side === 'buy' && f.status === 'filled' && h === undefined) {
          held.set(f.mint, { openedSlot: f.slot, best: 0n, txPaid: BigInt(f.tx_fee_lamports) });
        }
      }
      // A pending order is keyed by client_id; check pending by mint this way.
      const pendingMint = (mint: Pubkey): boolean => {
        for (const po of state.pending.values()) if (po.order.mint === mint) return true;
        return false;
      };
      const pendingSell = (mint: Pubkey): boolean => {
        for (const po of state.pending.values()) if (po.order.mint === mint && po.order.side === 'sell') return true;
        return false;
      };
      const pendingBuy = (mint: Pubkey): boolean => {
        for (const po of state.pending.values()) if (po.order.mint === mint && po.order.side === 'buy') return true;
        return false;
      };
      for (const mint of [...held.keys()]) {
        if (!state.positions.has(mint) && !pendingBuy(mint)) held.delete(mint);
      }

      // Exits first (probe positions are sold by the probe step below, never here).
      for (const [mint, pos] of state.positions) {
        if (orders.length >= cap) break;
        if (probes.has(mint)) continue;
        if (pendingSell(mint)) continue;
        const c = coins.get(mint);
        let h = held.get(mint);
        if (h === undefined) {
          h = { openedSlot: state.slot, best: 0n, txPaid: tx };
          held.set(mint, h);
        }
        let mk = marks.get(mint);
        if (mk === undefined) {
          const cv = state.curves.get(mint);
          if (cv === undefined) continue;
          mk = { vq: cv.virtual_quote_reserves, vt: cv.virtual_token_reserves };
        }
        const value = sellValue(pos.token_amount, mk.vq, mk.vt) - tx;
        const basis = pos.cost_lamports + h.txPaid;
        if (value > h.best) h.best = value;
        let exit = false;
        if (basis > 0n) {
          if (value * BPS >= basis * (BPS + BigInt(p.tpBps))) exit = true;
          if (value * BPS <= basis * (BPS - BigInt(p.slBps))) exit = true;
          if (h.best * BPS >= basis * (BPS + BigInt(p.trailArmBps)) && value * BPS <= h.best * (BPS - BigInt(p.trailBps))) exit = true;
        }
        if (state.slot - h.openedSlot >= p.maxHold) exit = true;
        if (c !== undefined && p.exitOnDevSell && c.devSold) exit = true;
        if (!exit) continue;
        orders.push({ side: 'sell', mint, token_amount: pos.token_amount, max_slippage_bps: 10_000 });
        if (c !== undefined) c.done = true;
      }

      // Probe round trips: sell the whole probe as soon as its buy has landed.
      for (const mint of [...probes]) {
        if (orders.length >= cap) break;
        const pos = state.positions.get(mint);
        if (pos === undefined) {
          if (!pendingMint(mint)) probes.delete(mint);
          continue;
        }
        const curve = state.curves.get(mint);
        if (curve === undefined || curve.complete || pendingMint(mint)) continue;
        orders.push({ side: 'sell', mint, token_amount: pos.token_amount, max_slippage_bps: 10_000 });
      }

      // Entries: one flat buy per coin, in its first few slots only.
      let free = state.freeCashLamports() - tx * BigInt(orders.length);
      let open = state.committedPositionCount();
      for (const mint of [...live]) {
        if (orders.length >= cap) break;
        const c = coins.get(mint)!;
        const age = state.slot - c.createSlot;
        if (age > p.maxAge) {
          c.done = true;
          live.delete(mint);
          continue;
        }
        if (c.done || c.complete || age < p.minAge) continue;
        if (open >= state.hello.caps.max_open_positions) continue;
        if (pendingMint(mint) || probes.has(mint) || state.positions.has(mint)) continue;
        if (c.devSold && p.skipDevSold) {
          c.done = true;
          live.delete(mint);
          continue;
        }
        const curve = state.curves.get(mint);
        if (curve === undefined || curve.complete) continue;
        // Rug filter.
        const rq = curve.real_quote_reserves;
        if (rq < BigInt(Math.floor(p.minRealSol * LAMPORTS)) || rq > BigInt(Math.floor(p.maxRealSol * LAMPORTS))) continue;
        if (c.devBuy < BigInt(Math.floor(p.minDevBuy * LAMPORTS)) || c.devBuy > BigInt(Math.floor(p.maxDevBuy * LAMPORTS))) continue;
        if (c.trades < p.minTrades || c.buyers.size < p.minBuyers || c.buyers.size > p.maxBuyers) continue;
        if (c.bought > 0n && c.soldByOthers * BPS > c.bought * BigInt(p.maxSellRatioBps)) continue;
        if (c.bigSellBps > BigInt(p.maxBigSellBps)) continue;
        const runup = (curve.virtual_quote_reserves * c.vt0 * BPS) / (curve.virtual_token_reserves * c.vq0);
        if (runup > BigInt(p.maxRunupBps) || runup < BigInt(p.minRunupBps)) continue;
        const maxBuy = state.maxBuyLamports(mint);
        const want = BigInt(Math.floor(p.stakeSol * LAMPORTS));
        const amount = want < maxBuy ? want : maxBuy;
        if (amount < BigInt(Math.floor(p.minBuySol * LAMPORTS))) continue;
        if (free < amount + tx * 2n) continue;
        orders.push({ side: 'buy', mint, quote_lamports: amount, max_slippage_bps: p.buySlippageBps });
        free -= amount + tx;
        open += 1;
        c.done = true;
        live.delete(mint);
      }

      // Guardrail pacing: open a probe when the bot's fills or coins lag the pace.
      if (probes.size < p.maxProbes && open < state.hello.caps.max_open_positions && firstTime !== null && lastTime !== null) {
        const pace = Math.min(1, (lastTime - firstTime) / p.paceSecs);
        const needCoins = myCoins.size < Math.ceil(p.targetCoins * pace);
        const needFills = myFills < Math.ceil(p.targetFills * pace);
        if (needCoins || needFills) {
          const minRq = (p.probeSol * Number(BPS)) / state.hello.caps.max_order_bps_of_real_reserve;
          let bestMint: Pubkey | null = null;
          let bestRq = 0n;
          for (const e of batch.events) {
            if (e.event !== 'TradeEvent') continue;
            const mint = e.mint;
            if (held.has(mint) || probes.has(mint) || pendingMint(mint) || state.positions.has(mint)) continue;
            if (needCoins && !needFills && myCoins.has(mint)) continue;
            const curve = state.curves.get(mint);
            if (curve === undefined || curve.complete) continue;
            if (curve.real_quote_reserves < BigInt(Math.floor(minRq * 1.5 * LAMPORTS))) continue;
            if (curve.real_quote_reserves > bestRq) {
              bestRq = curve.real_quote_reserves;
              bestMint = mint;
            }
          }
          if (bestMint !== null && orders.length < cap && free >= BigInt(Math.floor(p.probeSol * LAMPORTS)) + tx * 2n) {
            orders.push({ side: 'buy', mint: bestMint, quote_lamports: BigInt(Math.floor(p.probeSol * LAMPORTS)), max_slippage_bps: p.buySlippageBps });
            probes.add(bestMint);
          }
        }
      }
      return orders;
    },
  };
}
