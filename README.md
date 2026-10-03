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
- One click requests a **drop set**: N coins from each chute, one coin at a
  time with the selected delay between them. Every round releases one gold
  player coin and one red coin from each enemy chute. The delay is within
  the set, not between clicks. Defaults: one coin per chute, 0.3 s delay.
- The opening pile mixes gold allies, red enemies, and gray duds (40/40/20%
  by default). Duds affect the physics but count for neither side.
- The HUD separates **Ally caught**, **Enemy caught**, and **Duds caught**.
  `Collected` is their sum; losses are counted separately.

Open **Tuning** for enemy chute count (0-4), chute spacing, delay between
coins, and coins per chute per click (1-30). Each click captures its aim and
settings. Pause, reset, or a blocked chute cancels queued coins.
Opening enemy/dud percentages apply with **Reseed pile**; ally is the remainder.

Locked machine defaults: 400 opening coins, drop height 3.0, two enemy
chutes touching the player chute at spacing 0.66. Wider spacing is a tuning
modifier. Chute releases have downward exit velocity to clear fresh coins
at 0.10 s intervals; genuinely occupied slots still cancel a set.

Audio arms on the first gesture. Mute, volume, and reduced motion are
independent; reduced motion suppresses payout particles without changing
physical motion.

## What is measured

`TUNING.md` is the tuning record: protocol, baselines, held-out results, and
the commands that produced them. `DESIGN.md` is the design bible: pillars,
factions, current status, roadmap, and the open combat questions. Headless release trials use the real
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
