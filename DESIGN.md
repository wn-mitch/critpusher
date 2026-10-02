# Critpusher design bible

Living design context for the game. Measurements live in `TUNING.md`; run
instructions live in `README.md`. Public repository:
https://github.com/wn-mitch/critpusher

## Status

| Stage   | Scope                                                                                                         | State       |
| ------- | ------------------------------------------------------------------------------------------------------------- | ----------- |
| MVP 1   | Physical machine: dense pile, pusher, collection edge, opening rain, live tuning, measurement harness         | Shipped     |
| MVP 1.5 | Playable chutes: synchronized player/enemy stacks, faction colors and catch counters, release timing controls | Shipped     |
| MVP 2   | Combat: what a caught coin does to you or to the enemy                                                        | Design open |
| MVP 3   | Progression: waves, escalating pressure, persistence                                                          | Not started |

## The physical contract

Coins are real Rapier cylinders. Nothing is animated to imitate a pile.

- One player chute releases at z = -3.15 over the rear of the upper pusher;
  pointer and slider control x only. A fixed camera frames the whole machine.
- The pusher sweeps with cosine motion, stroke 2, period 2.4 s. Coins ride
  the pusher, jam, and avalanche; a coin past the collection edge (z = 4)
  and below y = -0.45 is caught exactly once.
- Active coins are never deleted to hold density. Out-of-bounds exits are
  losses, never payouts, and are counted separately from catches.
- One release drops every chute at once as a vertical stack, preflighted
  against real cylinder shapes. Refusal is honest and visible: nothing
  spawns, the cooldown is not consumed, and a scheduled sequence stops
  rather than retrying with a smaller budget.

## The loop

1. Choose an aim and a chute configuration.
2. Release a stack from every chute simultaneously.
3. Watch the pile absorb it and either avalanche or refuse to.
4. Read the split: ally catches, enemy catches, losses.

Placement is the player's main decision. The pile is deliberately slow to
settle, so the consequence of a release arrives over the next cycle instead
of instantly.

## Factions

- **Ally** (gold): the opening pile and player-fed coins.
- **Enemy** (red): every enemy chute release, red from the moment it spawns
  and after it lands.

Faction is carried on the body itself, so it survives contacts, and catches
are counted by faction at resolution time. Enemy coins are legitimately
catchable; catching them is currently neutral, which is the gap MVP 2 fills.

Carried over from the earlier design conversation: real partial wins,
actionable near misses, a shuffled queue, placement as the main choice,
legible enemy chutes, and a shared adversarial pile.

## Controls and tuning surface

- Aim by pointer, arrow keys, or the chute-position slider; drop by button,
  Space, tap, or hold.
- Live, no reseed: coin weight, friction, stroke, period, drop height, drop
  rate, enemy chute count (0-4), chute spacing, player stack (1-3), delay
  between drops (0.1-5 s), drops per click (1-30).
- Reseed-required: seed, density, coin radius, coin thickness, collection
  edge depth.
- Chute spacing bounds keep every chute plus a coin radius inside the
  cabinet, and spacing also narrows the aiming range rather than clamping
  flank chutes together.
- A scheduled sequence fires on fixed simulation ticks. Pause, reseed, a
  hidden page, or a refused admission stops the remainder; frames never
  catch up in a burst.

## Measured behaviour

- 30 synchronized actions (seed 1337, 600 opening coins, two enemy chutes at
  spacing 1.5, three coins per chute): 381 ally catches, 57 enemy catches,
  28 of 30 actions paid within one pusher cycle. Ally catches were 361
  starting-pile coins and 20 player-fed coins.
- In the browser, four enemy chutes at spacing 2.2 produced exactly 13
  bodies at the requested offsets, 12 enemy and 1 ally, and an immediate
  second click was refused by the shared cooldown.
- Five consecutive default-pile three-chute releases were admitted with no
  refusals.
- A three-batch timed sequence at 0.5 s intervals produced 27 bodies; pause
  cancelled the two queued batches.
- Portrait 390x844 lays out with no horizontal overflow.

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
