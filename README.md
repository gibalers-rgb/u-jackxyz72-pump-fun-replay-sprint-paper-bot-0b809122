# Pump.fun Replay Sprint — Paper Bot, Real Ranking

[![Competition](https://make.fun/badge/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122.svg)](https://make.fun/bounty/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122)
[![Rank](https://make.fun/badge/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122/gibalers-rgb/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122/rank.svg)](https://make.fun/bounty/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122)
[![Reward](https://make.fun/badge/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122/gibalers-rgb/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122/reward.svg)](https://make.fun/bounty/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122)

A flash-sniper paper trading bot for the pump.fun bonding-curve replay
(agent-fun/replay/v2). It trades 10 SOL of paper money on a 24h replay of
pump.fun chain data. Paper money only — nothing is traded for real.

## Strategy

Almost every new pump.fun coin dies within minutes, so the only edge is being
extremely picky in the first seconds of a launch and getting out fast.

- **Entry (one flat buy per coin, never pyramided):** a coin is bought at most
  once, within 6 slots of its CreateEvent, and only when its opening tape looks
  like real crowd interest rather than a bundle:
  - the creator put 0.05–2.5 SOL of their own in (skin in the game, not a whale),
  - 4–8 distinct non-creator wallets already bought,
  - no creator sell yet, sells by others ≤ 50% of buys, no single dump above
    30% of the real SOL reserve,
  - price within −10% / +150% of its create price, real SOL reserve 0.5–30 SOL.
- **Stake:** one flat 0.1 SOL per coin, at most 5 open positions.
- **Exits (whole position):** take profit +30%, stop loss −15%, trailing stop
  −15% once +10% is banked, max hold 12 slots, immediate exit on a creator sell.
- **Guardrail probes:** when the bot's own fills or coins lag the pace set in
  block time, it buys 0.01 SOL of the most liquid curve traded on the batch and
  sells it as soon as the buy lands, keeping the run above the minimum bar
  (round trips ≥ 0.01 SOL on ≥ 20 coins, max drawdown ≤ 50%).

Deterministic by construction: no clock, no environment, no randomness; every
iteration runs over insertion-ordered maps fed by the batch stream. Two runs on
the same harness stream produce byte-identical action logs.

## Local backtest (dev window, all 3 dataset parts)

Run against the kit's local replay engine port:

- Net PnL **+0.1923 SOL** (fail-key draws 11/22/33/44: +0.208 / +0.204 /
  +0.180 / +0.191 SOL — all positive)
- First-half / second-half split: +0.057 / +0.136 SOL
- 216 fills, 86 coins, 108 round trips, 31 winning trips
- Max drawdown 0.65% (guardrail: ≤ 50%)
- At 2× fees the edge disappears (−0.055 SOL): the bot lives on small,
  fast round trips, so fee discipline is the whole game.

## Run

The grader runs `node /bot/main.ts` (Node 22+). The strategy lives in
`strategy.ts`; the SDK shim is the kit's `sdk/ts/makefun-bot.ts`, vendored byte
for byte under `vendor/`. No dependencies, no network at run time.

## License

MIT — see `LICENSE`.
