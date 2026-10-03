# Critpusher design bible

Living design context for the game. Measurements live in `TUNING.md`; run
instructions live in `README.md`. Public repository:
https://github.com/wn-mitch/critpusher

## Status

| Stage   | Scope                                                                                                 | State       |
| ------- | ----------------------------------------------------------------------------------------------------- | ----------- |
| MVP 1   | Physical machine: dense pile, pusher, collection edge, opening rain, live tuning, measurement harness | Shipped     |
| MVP 1.5 | Coin-by-coin drop sets, mixed ally/enemy/dud opening pile, distinct colors and catch counters         | Shipped     |
| MVP 2   | Combat: what a caught coin does to you or to the enemy                                                | Design open |
| MVP 3   | Progression: waves, escalating pressure, persistence                                                  | Not started |

## The physical contract

Coins are real Rapier cylinders. Nothing is animated to imitate a pile.

- One player chute releases at z = -3.15 over the rear of the upper pusher;
  pointer and slider control x only. A fixed camera frames the whole machine.
- The pusher sweeps with cosine motion, stroke 2, period 2.4 s. Coins ride
  the pusher, jam, and avalanche; a coin past the collection edge (z = 4)
  and below y = -0.45 is caught exactly once.
- Active coins are never deleted to hold density. Out-of-bounds exits are
  losses, never payouts, and are counted separately from catches.
- A **drop set** is the coins requested by one click. Each timed round
  releases one coin from every chute simultaneously. **Coins per chute per
  click** sets the number of rounds; **Delay between coins (s)** spaces
  coins within that set, not separate sets. The first round is immediate.
- Admission checks real cylinder shapes, including coins inserted before
  the next physics step. A blocked round spawns nothing and stops the set
  rather than retrying with fewer coins.
- Synchronized chute releases start with downward velocity sized to clear a
  flat coin thickness plus gap within 0.10 s. Opening rain remains gravity-only.
  A tilted coin or a crowded pile can still physically block the slot.

## The loop

1. Choose an aim and a chute configuration.
2. Release a drop set: N single coins from each chute, spaced by the chosen delay.
3. Watch the pile absorb it and either avalanche or refuse to.
4. Read ally catches, enemy catches, dud catches, and losses separately.

Placement is the player's main decision. The pile is deliberately slow to
settle, so the consequence of a release arrives over the next cycle instead
of instantly.

## Factions

- **Ally** (gold): the ally share of the opening pile and player-chute coins.
- **Enemy** (red): the enemy share of the opening pile and enemy-chute coins.
- **Dud** (gray): neutral opening-pile coins. They occupy space and transmit
  force normally, but count for neither side when caught.

The opening mix defaults to 40% ally, 40% enemy, 20% dud. Enemy and dud
percentages are adjustable; ally is the remainder. Percentages apply on
reseed. Integer quotas are rounded, bounded to the planned pile size, and
shuffled deterministically from the seed without changing physical geometry.
Chute releases remain gold or red according to the chute.
`Collected = Ally caught + Enemy caught + Duds caught`; losses count in none.

Faction is carried on the body itself, so it survives contacts, and catches
are counted by faction at resolution time. Enemy coins are legitimately
catchable; catching them is currently neutral, which is the gap MVP 2 fills.

Carried over from the earlier design conversation: real partial wins,
actionable near misses, a shuffled queue, placement as the main choice,
legible enemy chutes, and a shared adversarial pile.

## Controls and tuning surface

- Aim by pointer, arrow keys, or the chute-position slider; drop by button,
  Space, tap, or hold.
- Live physical tuning: coin weight, friction, stroke, period, drop height.
- Next-click release settings: enemy chute count (0-4), chute spacing,
  delay between coins (0.10-0.50 s in 0.01 s steps), coins per chute per click (1-30).
  Defaults: two enemy chutes, touching spacing 0.66, one coin per chute,
  delay 0.3 s, 400 opening coins, drop height 3.0. Wider spacing is an explicit
  tuning modifier; a larger coin radius raises the minimum safe spacing.
  Aim, layout, count, and delay are captured at the click; edits cannot
  change the size or placement of a set already running.
  Physical release times round up to the next 60 Hz simulation tick (about 17 ms).
- Reseed-required: seed, density, coin radius, coin thickness, collection
  edge depth, opening enemy percentage, opening dud percentage.
- Chute spacing bounds keep every chute plus a coin radius inside the
  cabinet, and spacing also narrows the aiming range rather than clamping
  flank chutes together.
- A set fires on fixed simulation ticks. Pause, reseed, a hidden page, or a
  refused admission stops its remaining coins; frames never catch up in a
  burst. Its delay does not impose a wait before the next set.

## Measured behaviour

- Browser click scheduler: three coins per chute with two enemy chutes and
  0.5 s delay spawned three bodies at each of simulation times 0, 0.5, 1.0 s:
  nine bodies total (three ally, six enemy), not nine bodies per round.
  Mid-set control edits left that set unchanged; a new set began at 1.383 s.
- Locked-default browser checks: opening pile spawned 400 coins (160 ally,
  160 enemy, 80 dud). One click emitted exactly three coins at x=-0.66/0/0.66
  and y=3.0. Six-coin-per-chute sets completed at both 0.10 and 0.15 s delays
  with 18 emitted coins and zero losses each.
- A dense 20-coins-per-chute stress set at 0.10 s jammed after 16 rounds.
  A tilted enemy coin occupied the next slot; the refused round spawned nothing.
- Browser opening mix: 100 coins at 30% enemy, 10% dud produced 60 ally,
  30 enemy, 10 dud. Values stayed pending until **Reseed pile**.
- Moving one coin of each faction through the physical collection boundary
  increased total catches by three and each faction counter by one.
- Desktop rendering shows gold, red, and gray coins in the opening pile.
  Portrait 390x844 has no horizontal overflow with all five HUD counters.
- Production build and 111 regression tests pass.

Historical simultaneous-stack trials used an all-ally opening pile:
seed 42, 600 opening coins, two enemy chutes at spacing 1.5, three coins per
chute caught 381 ally coins (361 starting-pile, 20 player-fed) and 57 enemy
coins. 28 of 30 release windows paid within one cycle. These trials used
gravity-only releases and are not measurements of the locked defaults,
mixed opening pile, or downward-fed timed drop sets.

Read these as provenance, not causation: the automated trial cannot prove a
single action caused a specific payout, and most opening-pile movement is
not caused by the action that happened to precede it.

## Open questions for MVP 2

1. **What does a caught enemy coin do?** Three candidates:
   - HP duel: enemy catches damage the player, ally catches damage the
     enemy. Placement decides which faction spills, so the existing skill
     becomes the fight.
   - Single reward meter: enemy catches are lost rewards and block progress;
     ally catches bank toward a payout threshold.
   - Lane objectives: marked shelf lanes convert coins into block or strike
     effects. Most placement pressure, most new UI.
2. **What is enemy pressure?** Enemy coins currently stay in the machine
   instead of resolving as threats. Is the enemy chute a drip the player
   must outpace, or a bank that releases a wave when it fills?
3. **Does catching an enemy coin feel like a win or a loss?** The pile is
   shared, so the same avalanche can feed both sides.
4. **How does the player read the fight without looking away from the
   pile?** Counters, pile colour, or audio first?
5. **What makes a near miss actionable?** The next release is already a
   deliberate cost; the queue decides what arrives.

## What is not verified

Human feel, long-session stability, real-phone behaviour, and combat balance
are unmeasured. Frame-rate evidence is from a headless desktop Chromium
build, not a phone.
