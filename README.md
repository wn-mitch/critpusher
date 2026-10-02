# Critpusher

A physical coin-pusher toy in the browser. Real cylinders, real contacts,
real avalanches: coins are Rapier bodies that ride a moving pusher and fall
off the collection edge. Rendering is Three.js.

This is a playable physics prototype, not a finished game. The open question
was whether the machine produces a satisfying rhythm of dropping, watching,
anticipating, and collecting; combat comes after that.

## Run it

Node 24 or newer.

```sh
npm install
just dev      # or: npm run dev
just build    # typecheck + production bundle
just test     # physics regressions
```

For a phone on the same network, bind explicitly:
`npm run dev -- --host 0.0.0.0` and open the LAN address.

## Play

- Move the pointer over the machine or use the **Chute position** slider to aim.
- Click, tap, or hold **Drop coin**; Space also drops. Arrow keys aim,
  P pauses, R resets when focus is outside a form control.
- **Drop coin** releases every chute at once: your gold stack plus three red
  coins from each enemy chute. Enemy coins stay red in the pile.
- The HUD splits **Ally caught** from **Enemy caught**. Losses are reported
  separately and never counted as catches.

Open **Tuning** for the live release controls: enemy chute count (0-4),
chute spacing, player stack (1-3), delay between drops, and number of drops
per click. Chute and timing changes apply without reseeding.

Audio arms on the first gesture. Mute, volume, and reduced motion are
independent; reduced motion suppresses payout particles without changing
physical motion.

## What is measured

`TUNING.md` is the tuning record: protocol, baselines, held-out results, and
the commands that produced them. Headless release trials use the real
simulation, one pusher cycle per release, an identical no-input world as a
control, and payout provenance separated into starting pile, player-fed, and
enemy-fed coins.

```sh
just solve --patterns flanks --coins 3 --enemy-coins 3 --spacings 1.5 \
  --densities 600 --seeds 42 --releases 30
```

The optional adaptive placement policy calls an external model and reads
`TYPESAFE_API_KEY` from the environment in Node only; the browser never
receives that key.

## Scope

Implemented: the physical machine, opening rain, live tuning, atomic
synchronized stack releases, per-faction colors and catch counters, audio
feedback, and the measurement harness.

Not implemented: combat, damage, special coins, progression. Human feel,
long-session stability, and combat balance are not verified.

## License

MIT.
