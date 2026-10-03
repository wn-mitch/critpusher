# Critpusher tuning, run-study, and fight-study record

## Run and controls

Use Node 24 or newer. `npm install`, then `just dev` (or `npm run dev`).
`just build` creates `dist/`; `just test` runs the physics regressions.
For a phone on the same network, explicitly bind Vite with
`npm run dev -- --host 0.0.0.0` and open the computer's LAN address.

Move the pointer over the machine or use the chute-position slider. Click,
touch, or hold **Drop coin**; Space also repeats. Arrow keys aim, P pauses,
and R resets when focus is outside form controls. The camera is fixed.
Sound arms on the first gesture. Mute and volume are independent of reduced
motion, which suppresses payout particles without changing physical motion.

Tuning separates live coin weight, friction, stroke, period, and drop height
from seed, density, radius, thickness, collection-edge depth, opening type
weights, HP, effect amounts, and bomb parameters, which apply at **Apply
tuning & new run**. Pending reset values survive live-setting edits. Restart
preserves tuning.
Live sliders apply immediately; exact numeric entries apply on change (blur)
so partial decimal input is not rewritten by range clamping.
The hidden-page handler freezes simulation time, cancels held input, and
stops any queued release sequence; returning does not simulate the hidden
interval or override a manual pause.

## Readable combat policy projection

Combat policies share `three-cap-rays-v3`, a CPU-only projection using the
presentation's fixed desktop camera, cylinders, cabinet, and native feed poses.
A coin type is exposed only when a camera-facing cap has at least three
clear, in-frame rays among its center and four half-radius cardinal samples.
Sidewalls, buried caps, and off-screen caps do not reveal a type. Exposed
positions are rounded to 0.01 machine units. Lane counts, heights, and speeds
use the same readable mask; body IDs and hidden feed state are not policy inputs.
Unreadable feed slots remain `null` in order, including a hidden replenishment.

The center and seeded-random baselines release immediately. The rule baseline
combines visible occupancy with configured sword, skull, and healing values,
currency, and armed-bomb penalties; ties prefer center, inner left/right, then
outer left/right. It suggests the closest retracted quarter-cycle phase.
Fixed-timing trials preserve that suggestion but execute zero wait. Jev uses
the same projection and 20 validated placement/timing alternatives, with no
retry, fallback, or hidden rollout.

## Whole-run study (`mvp3-run-v1`)

The run owner is the measured three-encounter game, not the historical
physical solver or first-fight diagnostic. `run-study` records starter choice,
loading/event/combat batches, admission fragments, waves, shops, recovery,
rewards, build identity, physical accounting, final pile digest, and outcome.
Policies are `center`, `random`, and `rule`; no model/provider access is used.

The fixed screen cohort is 5 purchase profiles × 12 screen seeds × 3 policies,
plus three no-purchase controls (one for each starter) × 12 seeds × `rule`.
The purchase profiles and ordered capped priorities are:

| Profile | Starter | Ordered shop priorities |
| --- | --- | --- |
| `collector` | Collector | one Potion pack; up to two Restorative brew; Extra player chute; up to two Tempered swords |
| `swarm` | Pocket army | Gold pack; Diamond mint; Potion pack; up to two Tempered swords; Extra player chute |
| `volley` | Volley | Potion pack; up to two Tempered swords; Extra player chute; Gold pack |
| `tempo` | Collector | Combo bell; up to two Tempered swords; Potion pack; Magazine-dump |
| `recovery` | Collector | two Potion packs; up to two Restorative brew; Extra player chute; one Tempered sword |

`no-purchases-collector`, `no-purchases-swarm`, and `no-purchases-volley`
skip both shops. Each shop follows the first affordable legal item in profile
order, targets the first player chute unless cloning, and stops after eight
attempts. Composition replacement order is bomb, gold, diamond, sword, potion;
the run still applies real prices and limits.

Screen seeds are
`7,42,1337,19,71,113,211,307,401,503,601,709`. Evaluation is frozen to the
same five profiles and controls, `rule`, and the disjoint held-out seeds
`1009,1013,1019,1021,1031,1033,1039,1049,1051,1061,1063,1069,1087,1091,1093,1097,1103,1109,1117,1123,1129,1151,1153,1163`.
Only smoke accepts explicit seed/build overrides. Screen/evaluate require the
complete preregistered cohorts and 60 actions per encounter.

Each encounter permits at most 60 actions and 300 admitted rounds, with
1,440-tick loading and mechanical-stall caps. A dump action costs five rounds.
Rows classified `won`, `lost`, `unfinished`, or `invalid` are all retained in
the planned denominator. Budget exhaustion is unfinished; mechanical stalls,
loader errors, bad decisions, and accounting divergence are invalid. Replay
requires a nonempty manifest and exactly one row per planned trial, with no
missing, duplicate, or unplanned rows.

```sh
just run-study --phase smoke --seeds 7,42,1337 \
  --builds collector,swarm,volley,tempo,recovery --policies rule \
  --actions 60 --workers 3 \
  --output ../critpusher-mvp3-evidence/run-smoke.json
just run-study --phase screen --policies center,random,rule --actions 60 \
  --workers 4 --output ../critpusher-mvp3-evidence/run-screen.json \
  --selection ../critpusher-mvp3-evidence/run-selection.json
just run-study --phase evaluate --policies rule --actions 60 --workers 4 \
  --selection ../critpusher-mvp3-evidence/run-selection.json \
  --output ../critpusher-mvp3-evidence/run-evaluation.json
just run-study --phase replay \
  --replay ../critpusher-mvp3-evidence/run-smoke.json \
  --output ../critpusher-mvp3-evidence/run-replay.json
```

Selection freezes the screen protocol/configuration digest before evaluation;
evaluation cannot tune on held-out outcomes. If a screen gate fails, the
approved adjustment order is affordability, offending-encounter potion
weights, bounded enemy-HP reduction, miniature population, then recovery
pressure. No adjustment weakens bomb mechanics or removes invalid rows.
Workers spill complete raw trace rows to temporary files. The parent keeps
compact summaries and full-row digests, streams reports in manifest order,
and reads replay rows incrementally. Failed cohorts preserve all rows and
cannot freeze a selection; smoke/replay success alone is not balance proof.

Build strength and tradeoff compare `rule` medians across advertised profiles:
enemy HP removed per admitted round, final player HP, and total earned currency.
A strength exceeds another profile's median; a tradeoff trails another's.
Zero-admission runs have no admitted-round efficiency. Matched no-purchase
control deltas remain separate evidence, not the strength/tradeoff comparator.

Recovery reduction is Collector net attrition minus Recovery net attrition,
matched by valid `rule` seed and post-shop encounter. The pooled median must
be positive; pre-shop encounter one cannot measure purchased recovery.
Distributions use nearest-rank percentiles, including the lower middle value
for an even-sized median. No-purchase controls separately establish whether
later attrition exceeds fixed inter-encounter healing.

### Current run progress

The latest recorded full screen is candidate 6, before the ownership/shop UI
refinements, with protocol digest
`ccf9e1b86d7dcc9dfcb5288a23473f21faf87ba3cb0677dbe0ed44a26cef654b`.
All 216 planned rows are retained: 192 won, 22 lost, 2 unfinished, and 0 invalid.
Nine of ten gates passed. Matched post-shop recovery reduction has 24 observations,
median 0, p10 −4, p90 +6, and worst −20; the strictly positive recovery gate fails.
This is a rejected candidate, not a frozen selection. Held-out seeds are untouched.

The current later opening mixes retain skull/potion weights 27/16 in encounter
two and 32/14 in encounter three. The functional UI pass changes no gameplay
numbers. Human feedback approves the functional run and ownership/shop refinements
but identifies excessive ease. The next balancing pass must address that
observation; automated win counts alone do not establish appropriate difficulty.
Detailed kit/purchase/mascot/pressure acceptance remains pending.

## Authored cabinet commands

`just cabinet-assets` generates `assets/cabinet.blend` and
`src/assets/cabinet.glb` with Blender discovered from `BLENDER_BIN`, PATH, or
the confirmed application path. `just cabinet-check` checks the actual
exported vertices/transforms and required named modules, contact faces, gate
poses, finite/unit transforms, triangle budget, and GLB-size budget. Runtime
GLB loading is asynchronous and fatal on failure; there is no primitive
cabinet fallback.

## Historical first-fight diagnostic study (separate from run balance)

`just fight-study` runs the separate diagnostic encounter on real Rapier bodies.
The fixed study uses 400 opening coins, HP 100/120, sword damage 3, skull
damage 2, potion healing 4, and bomb damage 5 to each combatant. Its player
feed is a shuffled four-sword/one-bomb bag; its one-wave guard feed contains
four skulls and one gold. Only the opening mixture and registered bomb
threshold/minimum closing-speed preset vary.

| Mixture | Gold | Diamond | Sword | Skull | Potion | Bomb |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| balanced | 25 | 1 | 35 | 25 | 10 | 4 |
| recovery | 23 | 1 | 30 | 26 | 16 | 4 |
| pressure | 21 | 1 | 35 | 33 | 6 | 4 |

Bomb presets are sensitive (2 hits, speed 0.50), standard (3 hits, speed
0.75), and resistant (5 hits, speed 1.00). All use radius 1.75 and blast
delta speed 3. Qualifying new coin contacts count; resting contacts and
machine contacts do not. Blast-associated secondary detonations require
actual subsequent coin impacts, not a radius trigger.

The retained screen and diagnostic holdout below used the flat-feed
`three-cap-rays-v1` projection. Current studies use the native gravity-feed v3
projection, with the same three-of-five visibility rule. Registered bomb
presets remain explicit at radius 1.75 and delta speed 3, independently of
the playable blast. Historical outcomes do not validate the current geometry
or the stronger playable blast.

The screen uses all nine mixture/preset combinations, four policies,
60-action budgets, and seeds
`7,42,1337,19,71,113,211,307,401,503,601,709`.
Evaluation uses both adaptive and fixed timing on the frozen profiles and
disjoint seeds
`1009,1013,1019,1021,1031,1033,1039,1049,1051,1061,1063,1069,1087,1091,1093,1097,1103,1109,1117,1123,1129,1151,1153,1163`.
One action requests one simultaneous three-coin round. Its 144-tick release
window begins at physical admission, not when the request is accepted.
Adaptive policy waits are 0/36/72/108 ticks; fixed timing records the suggestion
but executes zero policy wait. Mechanical settling waits separately for up to
1440 ticks; a persistent stall is retained as an invalid trial, not a shorter
window or a smaller action cohort. The browser imposes no mechanical-wait limit.
A final 144-tick observation follows the last admitted action.
Both kinds of waiting count toward combat and rolling bursts, but not
release-window catches, damage, or dry-stretch scores.

Selection requires zero invalid trials, at most 20% unfinished trials,
at most 10% terminal fights ending before five actions, median terminal
actions in [10,45], and at most 10% of valid trials reaching a rolling
144-tick burst of at least 50% of starting player HP. The separate
reporting flag for a severe burst starts at 25% HP. Ranking prefers Jev
victory rates in [30%,80%], then early-finish rate, severe-tail rate,
worst-policy simultaneous-defeat rate, Jev HP, Jev currency, and registered
profile order. Evaluation cannot change that selection or relax its gates.

### Recorded screening and diagnostic holdout

The live five-action Jev smoke failed with HTTP 402 before a drop.
Its observation, failed request, and invalid row are retained. Screening
and evaluation deliberately unset `TYPESAFE_API_KEY` afterward: they
complete the baseline cohorts without making further provider requests,
and retain missing-credential Jev rows rather than substituting a policy.

| Cohort | Planned rows | Valid baseline rows | Invalid Jev rows |
| --- | ---: | ---: | ---: |
| Nine-profile screen | 432 | 324 | 108 |
| Two-profile diagnostic holdout | 384 | 288 | 96 |

Every profile fails the zero-invalid gate. The frozen selection therefore
records `no-qualified-mixture`, with balanced-standard and
balanced-resistant as the highest-ranked diagnostic profiles. The browser
retains provisional balanced-standard; the holdout does not select a winner.

All 288 valid holdout rows are victories, with no defeat, simultaneous
defeat, or budget exhaustion. Each table row has 24 valid seeds per timing
mode; adaptive and fixed cohort summaries are identical.

| Profile | Policy | Median finish actions | Median player HP | Median currency | Worst dry stretch | Worst no-enemy-damage stretch | Largest incoming burst / starting HP |
| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: |
| balanced-standard | center | 14 | 46 | 28 | 3 | 3 | 0.36 |
| balanced-standard | random | 15 | 42 | 26 | 5 | 6 | 0.33 |
| balanced-standard | rule | 13 | 45 | 25 | 4 | 4 | 0.35 |
| balanced-resistant | center | 17 | 55 | 32 | 4 | 4 | 0.30 |
| balanced-resistant | random | 17 | 57 | 33 | 4 | 5 | 0.27 |
| balanced-resistant | rule | 18 | 60 | 30 | 3 | 3 | 0.27 |

Matched-seed comparisons use 2,000 deterministic bootstrap resamples and
95% percentile intervals, separately by timing. Baseline pairs contain
24 valid pairs and zero omissions; Jev pairs contain zero valid pairs
and 24 omissions, with null differences and intervals. For
balanced-standard, center minus rule remaining HP is 2.54
[-3.63,7.75]; currency is 1.96 [-0.92,4.67]. Both intervals include zero.
Victory saturation and unavailable Jev comparisons do not establish
deliberate-placement superiority or enjoyable combat balance.

Reports use the `first-fight-v2` schema. Replays of `first-fight-v1` are rejected
with `Unsupported replay version: first-fight-v1; use its recorded engine revision`.

Raw reports live outside tracked source in
`../critpusher-first-fight-evidence/`. They retain planned manifests,
per-seed rows, setup/type accounting, admitted actions, event/effect ledgers,
decision traces, initial/simulation digests, code/dependency/platform
identity, and median/p10/p90/worst summaries for every recorded metric.
Invalid rows remain in denominators. Replay requires a nonempty planned
manifest and exactly one corresponding row per planned trial; missing,
duplicate, or unexpected rows are failures, not a smaller successful cohort.

Commands used for the recorded cohorts:

```sh
just fight-study --phase smoke --policies center,random,rule --seeds 42 \
  --actions 12 --workers 3 \
  --output ../critpusher-first-fight-evidence/fight-smoke-final.json
just fight-study --phase smoke --policies jev --seeds 42 --actions 5 \
  --max-jev-requests 5 --workers 1 \
  --output ../critpusher-first-fight-evidence/fight-jev-smoke.json
env -u TYPESAFE_API_KEY just fight-study --phase screen \
  --policies center,random,rule,jev --actions 60 --max-jev-requests 10000 \
  --workers 4 --output ../critpusher-first-fight-evidence/fight-screen.json \
  --selection ../critpusher-first-fight-evidence/fight-selection.json
env -u TYPESAFE_API_KEY just fight-study --phase evaluate \
  --selection ../critpusher-first-fight-evidence/fight-selection.json \
  --policies center,random,rule,jev --actions 60 --max-jev-requests 10000 \
  --workers 4 --output ../critpusher-first-fight-evidence/fight-evaluation.json
just fight-study --phase replay --max-jev-requests 0 \
  --replay ../critpusher-first-fight-evidence/fight-smoke-final.json \
  --output ../critpusher-first-fight-evidence/fight-replay-final.json
```

Screening and evaluation exit nonzero because invalid Jev evidence exists.
Valid live Jev evaluation requires working provider access and remains
an acceptance gate, not a mocked or inferred result.

Recorded verification: `just test` passes all 207 tests in 25 files, and
`just build` passes TypeScript and production bundling. Vite reports a large
JavaScript chunk warning. API-free replay matches initial digests, canonical
ledgers, simulation digests, and outcomes for all three baseline smoke rows
and four held-out rule traces (seed 1009, both diagnostic profiles and
both timing modes). Replay also reproduces the one captured HTTP 402 failure;
a matching failed trace is not a successful live Jev trial.

The held-out replay source is a four-row subset with a corresponding
four-trial planned manifest, stored as `fight-evaluation-replay-source.json`.
Its replay and the recorded failed-request replay use:

```sh
just fight-study --phase replay --max-jev-requests 0 \
  --replay ../critpusher-first-fight-evidence/fight-evaluation-replay-source.json \
  --output ../critpusher-first-fight-evidence/fight-evaluation-replay.json
just fight-study --phase replay --max-jev-requests 0 \
  --replay ../critpusher-first-fight-evidence/fight-jev-smoke.json \
  --output ../critpusher-first-fight-evidence/fight-jev-replay.json
```

### Historical browser fixture evidence

This subsection records the earlier first-fight diagnostic surface, not the
current run UI. Its automated muted-browser proof covered desktop 1280×800,
portrait 390×844, and landscape 844×390; the then-existing Start/drop/Restart
controls, keyboard and trusted touch events, cap glyphs, five-token trays,
real-impact bomb pips, terminal outcomes, frozen ready/end states, and
normal/reduced-motion equality of physical state and combat totals.
That fixture cleared transient particles, blast rings, world labels, and
textual combat cues on Restart. The recorded production fixture reached
victory after 16 drop clicks with player HP 55, enemy HP 0, and currency 40.
These are historical diagnostic observations and do not describe the current
starter/shop run flow or establish human acceptance.

These historical first-fight-specific human checks were not recorded:
identification of upcoming tokens and helpful/harmful exposed coins, intentional
sword/healing pursuit or skull/armed-bomb avoidance, explanation of mixed-avalanche
HP/currency changes, bomb state and safe collection versus detonation, and
finish/restart behavior. Current run feedback and its remaining acceptance checks
are recorded in **Current run progress** above. Automation cannot establish feel.


## Historical combat-study release controls (not the run UI)

The machine has one player chute and, by default, two skull-feeding enemy chutes.
One click requests a **drop set**: the selected number of single coins from
each chute. Every round releases one coin from each chute simultaneously.
**Delay between coins (s)** is the minimum interval within this set,
not a delay between sets. The first round is immediate only when all slots
are ready. Defaults: one coin per chute (three coins per click),
minimum spacing 0.66, minimum delay 0.3 s.

**Release chutes** settings apply to the next click without reseeding:

- Chute ownership comes from the encounter roster, not release settings.
- **Chute spacing** keeps every chute plus a coin radius inside the cabinet.
  It also narrows aim so flank chutes are not clamped together.
- **Delay between coins (s)** 0.10-0.50 in 0.01 s steps. Minimum intervals
  round up to the next 60 Hz simulation tick (about 17 ms); stock settling
  and physical escapement clearance can lengthen an interval.
- **Coins per chute per click** 1-30. With E enemy chutes and N selected
  coins, a complete set releases N × (E + 1) bodies.

Aim, layout, number, and minimum interval are captured per click. A new click
during a set is refused. Fixed simulation ticks prevent catch-up bursts.
Pause, reset, or hiding the page stops remaining rounds. Occupied or unsettled
slots wait without consuming stock; all lanes must pass the physical preflight
before any gate opens. There is no extra delay between completed sets.

Stock rides native, unmotorized prismatic rails on the 40° incline.
The escapement floor, the front-floor segment below the outlet, and the low lip
retract together while a lane's gate is open, matching the rendered hardware.
A passive upper holdback retains the next coin until the admitted body clears;
the admitted body keeps its native body, collider, pose, and velocity. Closure
waits until admitted bodies no longer overlap hardware being re-enabled.
Already-enabled support remains under resting bodies, including in disabled
lanes. Gravity and native contacts move the higher coins; replacement stock
starts behind the rear cover. Clearance checks include admitted colliders and
gizmos created since the last physics step. Rear insertion also checks current
stock directly, so same-tick cancellation cannot install overlapping refills.
The separate historical physical-release API retains its direct-drop behavior;
playable encounters and combat studies use the mechanical magazines.

The provisional opening mix is gold/diamond/sword/skull/potion/bomb
25/1/35/25/10/4. The six explicit nonnegative weights normalize to percentages
and require positive total weight. Largest-remainder quotas use canonical type
order for ties; a separate seeded shuffle preserves rain geometry.

The player queue uses shuffled bags of four swords and one bomb. Magazines load
after the opening board settles and hold five native face-up coins per tray.
Bases, lips, cylinders, rims, and glyphs share the incline; camera bounds include
the raised stock. A replacement can be temporarily unreadable behind the cover.
Stock has no gameplay ID, bomb arming, or spawn count until physical admission.
Admission advances the bag only after a complete atomic round; waiting,
canceled rounds, and aim changes consume nothing.
Setup catches grant no effects. A ready or finished encounter freezes physical
time, and both combatants reaching zero is a defeat.

The following command is the historical simultaneous-stack trial. Its
all-ally opening pile yielded 381 ally catches (361 starting-pile, 20
player-fed), 57 enemy catches, and 28 paying windows out of 30 actions.
It is not a timed-set or mixed-pile playtest.

```sh
just solve --policies center --patterns flanks --coins 3 --enemy-coins 3 \
  --spacings 1.5 --densities 600 --seeds 42 --releases 30 --workers 1 \
  --output /tmp/critpusher-playable-factions.json
```

## Historical physical/combat-study defaults

400 starting coins, seed 1337, provisional six-type mix 25/1/35/25/10/4,
radius 0.32, thickness 0.13, friction 0.58, pusher stroke 2, collection edge z=4,
period 2.4 seconds, drop height 3.0. Rapier steps at 60 Hz. Browser cadence
comes from delay between coins; headless stack trials retain their own
drop-rate limit (six releases per second by default). Coin faces are flat
cylinders; embossed rendering adds only 0.008 total thickness.

Historical three-faction browser smoke: all 400 opening coins spawned with
exact 160/160/80 quotas and zero losses. A default click spawned one coin at each of
x=-0.66/0/0.66, y=3.0, z=-3.15. Six-round sets at 0.10 s and 0.15 s intervals
both emitted 18 bodies without losing coins. A 20-round dense set at 0.10 s
jammed at round 17 when a tilted enemy coin occupied the slot; no partial
round spawned. Historical stack trials below used gravity-only releases,
so their payout results are not measurements of the locked defaults.

Historical six-type browser smoke at seed 1337 spawned all 400 coins, settled
for 720 ticks, and reached ready with 379 active bodies and 21 setup catches
(2 gold, 9 swords, 7 skulls, 3 potions), zero losses, and zero detonations.
HP stayed 100/120 and currency stayed zero.

**Coin weight (×)** is a live mass multiplier from 0.1 to 10, default 1.
It scales cylinder material density, so mass still depends on coin size.
Existing coins, pending opening rain, and future player drops use the current
weight. Live edits recompute mass and rotational inertia without resizing
coins, resetting the pile, or changing velocities. Reset preserves the setting.
Gravity and the pusher's prescribed motion are unchanged: uniformly heavier
coins do not fall faster or automatically produce stronger pushes. With the
same multiplier on every coin, changes in pile motion may be subtle.

The playable bomb defaults are radius 2.25 and peak delta speed 6, with
three qualifying impacts at minimum closing speed 0.75 and damage 5 to each
combatant. A speed-6 Rapier probe measured delta speed 3.333 at distance 1
and 0.667 at distance 2. Both bodies moved outward on the next physics step.

Blast impulse is `mass × delta speed × radial falloff`. A probe doubled
thickness and quadrupled density, producing 8× mass but the same measured
delta speed 1.500. Weight 1 and thickness 0.13 remain the physical defaults;
changing thickness also changes packing, collisions, and chute clearance.
Detonation effects use pooled bright cores, shockwaves, and deterministic
sparks. Reduced motion keeps those elements stationary; restart clears them.

Combat-message and status regions reserve fixed line space; queued-drop
messages do not resize the machine. Controls retain enough height for their
messages, and portrait physical counters sit below the feeds.

Retained speed-7 correction verification: all 211 tests across 26 files passed, including
feed-cap visibility at tuning boundaries and real-Rapier blast comparisons.
The API-free center/random/rule smoke and replay matched initial state,
event/effect ledger, physical digest, and outcome for all three rows.
During a 30-round browser release, damage, healing, currency, and bomb
messages caused zero measured scene movement at 1280×800, 390×844, and
844×390. The encounter ended in victory with player HP 42, enemy HP 0,
currency 36, and 12 detonations. A captured real detonation also verified
normal effect motion, stationary reduced-motion effects, reset cleanup,
and complete effect-object disposal. Raw correction evidence is outside
the repository in `../critpusher-first-fight-evidence/playtest-corrections-*`.

The player chute releases at z=-3.15 over the rear of the upper pusher;
pointer and slider movement control x only. Rendering and physics share
that depth. Drops land on the moving upper shelf at all four tested phases.

Opening rain allocates 30% of its source coins to the upper pusher and 70%
to the lower shelf. Seeded positions, heights, yaw, tilt, and staged timing
produce irregular piles. Admission checks empty space around existing
coins; blocked rain entries wait rather than being discarded. Player drop
cadence is independent of rain admission.

The original stroke-1.4 baseline, with 300 coins and seed 1337, had this
fixed-step distribution at 12 seconds without input:

| Section              | Coins |
| -------------------- | ----: |
| Upper pusher, left   |    29 |
| Upper pusher, center |    22 |
| Upper pusher, right  |    23 |
| Lower rear           |    31 |
| Lower middle         |   111 |
| Lower front          |    82 |
| Collected            |     2 |

All 300 source coins had spawned by six seconds; none were lost. Upper
counts use coin centers above y=0.5 and behind the current pusher front,
including one coin-radius margin. Lower depth bands are z<0, 0..2, and >=2;
upper lateral bands split at x=-1.5 and x=1.5. Coins above y=1.5 are excluded
as unsettled for this probe; no such coins remained at twelve seconds.

The pusher's long rear extension overlaps the enclosing walls throughout its
stroke. There is no closing pocket behind or beside the moving slab. Side
and rear walls rise to 4.5; the front is open. Coins beyond the configured
collection edge and below y=-0.45 collect once and leave the physics world.
Other out-of-bounds exits are losses, never payouts. Active coins are not
deleted to maintain density.

## Original stroke-1.4 desktop baseline

Baseline: Apple M4 Max, 14 logical CPUs, 36 GiB memory, macOS arm64;
headless Chromium 153.0.8010.12 using ANGLE Metal on the Apple GPU.
Viewport 1440 × 1000, device-pixel ratio 1. Each fixed-seed preset received
eight seconds of warm-up followed by ten seconds of animation-frame
sampling, without player drops. Timings include the development build.

| Seeded coins | Mean active during sample |   FPS | Physics mean / p95 ms | Render CPU mean ms | Frame CPU p95 ms | Collected by end |
| ------------ | ------------------------: | ----: | --------------------: | -----------------: | ---------------: | ---------------: |
| 150          |                       148 | 60.08 |           0.74 / 0.90 |               0.14 |             1.00 |                2 |
| 300          |                       298 | 60.03 |           1.64 / 2.00 |               0.18 |             2.20 |                5 |
| 500          |                       477 | 60.03 |           2.81 / 3.50 |               0.21 |             3.70 |               41 |
| 1,000        |                       790 | 60.06 |           5.19 / 6.70 |               0.26 |             7.00 |              316 |

All four presets finished with zero pending rain, zero losses, and zero
dropped simulation steps during sampling. The stress preset shed coins
normally; this is not a claim of 1,000 bodies sustained throughout the
sample. Rendering measures CPU submission, not GPU execution. Timer
precision limits small timings.

A separate twenty-second held-Space browser session began after the
300-coin rain settled. It admitted 119 rear-fed coins and collected 24,
with zero losses. The final reading was about 60 FPS; two fixed steps
were dropped during the session.

A five-minute accelerated fixed-step run began with 300 coins and fed one
coin every ten steps while sweeping the chute. All 1,800 scheduled drops
were admitted: 2,100 spawned, 1,602 collected, 498 still active, zero lost,
and zero duplicate events. Peak active count was 552. Conservation held
throughout. This bounds the observed run, not unlimited-session memory
or performance.

Software-rendered SwiftShader ran the initial browser smoke near 8 FPS.
Hardware acceleration matters. No real-phone, Safari, or universal 60 FPS
claim is made. The bundled Three.js/Rapier application is approximately
1.82 MB gzip; Vite reports its large-chunk warning. Cold-start shader work
can register dropped-step diagnostics before the pile settles.

## Interaction and feedback checks

- Automated tests cover real collection/loss cleanup, repeated
  resolution, conservation, seeding, reset, dense finite state, containment,
  exact tick-boundary drop cadence, upper-pusher landing, irregular rain,
  non-overlapping admission, and settled section coverage.
- Desktop pointer/keyboard input, held dropping, paused reset, fifteen rapid
  restarts, tuning drafts, and reduced-motion controls were exercised.
- Chromium touch emulation produced trusted touch pointer events. Holding
  the drop control added seven coins; touch cancellation stopped repeats.
  Portrait 390 × 844 and landscape 844 × 390 fit their viewports with the
  drop control visible and no horizontal overflow. These are emulated
  layouts/input, not measurements on physical mobile hardware.
- Simulated visibility-change events froze physics, avoided catch-up, and
  preserved a manual pause. Native OS background lifecycle was not measured.
- Real WebAudio created no context before arming, synthesized motor/release/
  aggregated payout voices after a gesture, suspended on pause/hidden, and
  closed without live voices on disposal. Verification output was muted;
  audible mix quality still needs a listening playtest.

## Tuning observations and next judgment

The 150-coin preset is sparse, with two opening payouts in the measured
window. At 300, both levels hold coins and rear feeding creates pressure
through the upper pile. At 500, forty-one opening coins paid out; this is
the useful comparison for a more immediate rhythm. The 1,000 preset is a
stress experiment with substantial automatic opening collection.

The fixed elevated view exposes the upper pusher and lower collection edge.
Coins visibly stack, tilt, ride the pusher, and fall into the collection
path. Swept placement moves the feed across different parts of that pile;
a large cluster can yield several collections within one second. Motor
phase, release clinks, aggregated dings, counts, and bounded particles
provide distinct feedback paths without needing camera movement.

The measured default is 300 coins, stroke 2, and collection edge z=4.
Opening positions do not repeat in vertical columns. Natural contact stacks
still form, but the opening pile is not a lattice. The compact landscape
view makes fine placement less legible than portrait or desktop.

A human must judge the desire to keep dropping, preferred cadence, sound
mix, and whether waiting on the pusher feels anticipatory rather than flat.
Automation does not establish satisfaction. In this historical MVP1.5 record,
combat, special-coin supply, hold, encounters, and the shop were future
gates; the current run is documented at the start of this file.

## MVP 1.5 controlled physical trials

The experiment runner uses real Rapier bodies without rendering. Every trial
pins physical inputs, warms up for 12 simulated seconds, then admits 30
drops at 72-tick intervals (1.2 seconds), followed by a 4.8-second idle tail.
Warmup collections are recorded separately. Totals below include the idle
tail; dry stretches count only feeding windows. A no-input control runs for
the same duration because warmup does not stop the pile from moving.

The throughput sweep crosses starting counts 200/300/400, seeds 7/42/1337,
four geometries, and center/no-input policies: 72 trials. The configurations
change only stroke (1.4 or 2) and collection-edge depth (4 or 3). Moving the
edge also changes the physical shelf, rain bounds, and visible cabinet.

### Throughput

At 300 starting coins, means across three seeds:

| Geometry                          | Collections with 30 drops | No-input collections | Added over idle | Median longest dry stretch |
| --------------------------------- | ------------------------: | -------------------: | --------------: | -------------------------: |
| Original: stroke 1.4, edge 4      |                       6.0 |                  1.3 |             4.7 |                   26 drops |
| Longer stroke: 2, edge 4          |                      49.7 |                 12.7 |            37.0 |                    5 drops |
| Shorter shelf: stroke 1.4, edge 3 |                      25.3 |                  2.3 |            23.0 |                   11 drops |
| Combined: stroke 2, edge 3        |                      82.0 |                 33.0 |            49.0 |                    3 drops |

For the longer stroke alone:

| Starting coins | Collections with 30 drops | No-input collections | Median longest dry stretch |
| -------------- | ------------------------: | -------------------: | -------------------------: |
| 200            |                      20.0 |                  0.3 |                    9 drops |
| 300            |                      49.7 |                 12.7 |                    5 drops |
| 400            |                      94.3 |                 36.3 |                    5 drops |

At 300, the longer-stroke trials averaged 8.7 small bursts of 1–3 coins,
with a largest observed burst of 12. Collections occurred in 11 of the 30
feeding windows on average. These are physical spills, not random rewards
or evidence that each spill was caused by the immediately preceding drop.

A separate 24-trial timing sweep starts feeding at four quarter-cycle
offsets, with matched no-input controls. Mean player-fed collections range
from 41.7 to 49.7; median longest dry stretches range from 5 to 6 drops.
This does not establish an optimal release phase or human timing skill.

### Placement, randomness, and back-row isolation

Three near-edge coins in the left or right lane are selected from the same
initial snapshot. Policies feed the target lane, opposite lane, center,
alternating left/center/right, seeded random positions, or nothing.
Each input policy receives the same 30-drop budget and timing. No policy
can inspect future physics. Sides are balanced across the same seeded
piles, not geometrically mirrored copies.

Both promising geometries received 72 trials each at 300 coins. The
full-length shelf with stroke 2 then received another 72 trials using
previously unused seeds 101/202/303. Each geometry includes normal chute
feeding and direct back-row placement. Direct placement bypasses travel
across the upper pusher; it is an experiment API, not a player control.

Target efficiency is the mean release time of the three selected coins,
measured in drop windows. Unreleased targets and targets collected only
during the idle tail cost the full 30-window budget. This avoids excluding
unsuccessful targets from an apparently fast average. Positive advantage
means deliberate placement released targets sooner.

Full-length shelf, stroke 2, all six seeds and both sides:

| Feed     | Against     | Mean advantage in drop windows | Faster / within one / slower |
| -------- | ----------- | -----------------------------: | ---------------------------: |
| Chute    | Opposite    |                           7.48 |                    9 / 2 / 1 |
| Chute    | Center      |                           2.86 |                    7 / 2 / 3 |
| Chute    | Alternating |                           1.72 |                    8 / 3 / 1 |
| Chute    | Random      |                           3.54 |                    7 / 3 / 2 |
| Back-row | Opposite    |                           7.60 |                   10 / 1 / 1 |
| Back-row | Center      |                           4.26 |                    8 / 3 / 1 |
| Back-row | Alternating |                           4.10 |                   10 / 2 / 0 |
| Back-row | Random      |                           4.84 |                    9 / 2 / 1 |

“Faster” and “slower” require at least one full drop-window difference.
There are 12 paired side comparisons per row, but only six independent
seeded piles. The holdout chute-vs-random comparison alone was 5 / 1 / 0,
with a mean advantage of 4.27 windows. No confidence interval or universal
skill claim follows from this small sample.

The shorter-shelf combination had only a 1.15-window mean chute advantage
over random placement on the original seeds, versus 2.80 for the full
shelf. Its higher automatic collection also makes immediate causality
harder to interpret. The shipped default therefore keeps edge depth 4.

**Unproven hypothesis:** visible local progress within the next few pushes.
Across all six seeds, deliberate chute feeding moved the target cluster
only 0.008 world units farther forward than no input after three pusher
cycles, on average; direct back-row feeding added 0.036. A coin diameter is
0.64. Eventual targeting efficiency improved, but a readily visible,
immediate placement consequence is not established.

### Playable probes and honest avalanche feedback

Under **Tuning → Placement probe**, **Mark edge targets** marks up to three
eligible coins per lane. Cyan/ivory/magenta rims and one/two/three face bars
identify lanes without changing coin mass, colliders, or payouts. The probe
reports remaining, collected, and lost targets separately. Reset clears it.
Marking while paused updates the picture; resizing the paused cabinet
redraws the scene without advancing physics.

The displayed burst count accumulates across simulation steps. A 0.65-second
quiet interval closes a burst; a 3-second cap separates continuous output.
Pause freezes burst time and reset clears it. Coins still resolve once
individually. Sound escalates at totals 1/2/4/8/16 with a 140 ms payout
cooldown and bounded voices; it does not replay every coin at full volume.
A browser fixture with seven real falling bodies displayed 1 through 7
across separate frames, ending with seven collections and no active bodies.

### Stability and verification

The six suites comprise 318 fixed-step trials with zero losses and zero
rejected scheduled drops. The runner checks lifecycle conservation and
duplicate resolution on every step and samples finite body poses.
All target-policy trials had three available targets.

Six sustained-feed trials cover three seeds and both feed modes, each
starting with 300 coins and admitting 900 drops at six per second.
All 5,400 drops were admitted. Peak active count was 385; final active
counts were 314–346. No loss, duplicate resolution, conservation failure,
or nonfinite-pose failure occurred. This bounds 150 seconds of feeding per
trial, not unlimited play or arbitrary tuning.

The production build and 48 tests pass. Desktop and emulated portrait and
landscape surfaces were inspected. Trusted touch holding admitted four
coins and releasing stopped repeats. The viewport widths remained
390 and 844 pixels with the drop button visible. Real-device performance
and audible mix quality remain unverified.

### Reproduction

```sh
just experiment --suite throughput --output /tmp/critpusher-throughput.json
just experiment --suite skill --front 4 --stroke 2 --output /tmp/critpusher-skill-long.json
just experiment --suite skill --front 3 --stroke 2 --output /tmp/critpusher-skill-short.json
just experiment --suite skill --front 4 --stroke 2 --seeds 101,202,303 --output /tmp/critpusher-skill-holdout.json
just experiment --suite timing --front 4 --stroke 2 --output /tmp/critpusher-timing.json
just experiment --suite stability --front 4 --stroke 2 --output /tmp/critpusher-stability.json
```

JSON retains every input, initial target position/identity, payout step,
accepted/rejected count, warmup/tail totals, and payout digest. `--workers`
sets process concurrency. Scripts run through `tsx` and are typechecked
with the application. Reproducibility is scoped to the pinned dependency
versions and runtime, not promised bit-for-bit across platforms.

### Human playtest questions

- Do five-drop dry stretches feel anticipatory or still feel empty?
- Can a player predict which marked cluster will fall before committing
  drops, rather than recognizing the effect afterward?
- Is waiting for upper-shelf pressure legible enough, or should the normal
  feed path itself change? The isolated back-row result is not permission
  to silently change player controls.
- Do small real payouts and grouped avalanche cues sustain the rhythm
  without disguising an ineffective placement?

The physical toy's historical playtest remained gated on human evidence, not
on higher collection totals alone. The current run has positive functional
feedback; its detailed human and balance acceptance gates remain pending.

## Adaptive lane solver and multi-coin releases

`just solve` runs a separate release-level protocol. Success means at least
90% of player releases produce one or more collected coins within one full
pusher cycle after the first coin in that release. Mean collections per
coin alone cannot satisfy this target: one avalanche must not hide many
empty releases.

### Observation and policies

Five contiguous observation lanes span the physical width from x=-5 to 5,
with chute centers -4, -2, 0, 2, and 4. They are measurement regions, not
physical walls. They are independent of the three marked-target cohorts
in the cabinet's placement probe.

Each lane distinguishes the moving upper pusher from rear, middle, and
front thirds of the lower shelf. Observations contain counts, mean height,
forward motion measured from copied previous positions, near-edge coins,
rim-to-edge gap, and recent lane collections. New coins have no invented
velocity. Geometric support and stack-height rules exclude airborne and
already-falling bodies; they approximate contacts rather than exposing
the physics engine's contact graph.

Policies receive only this observation, the current release size/feed,
and up to six past release decisions and outcomes:

- **Center:** always the center lane, with no deliberate wait.
- **Random:** seeded lane choice, with no deliberate wait.
- **Rule:** a transparent score favoring connected rear-to-front density
  and edge crowding, with center-out ties and rear-phase release timing.
- **Jev:** the pinned `jev-1.13.0` model selects among five lanes and four
  relative waits: zero, one, two, or three quarter-cycles. Its probabilities
  describe action preference, not measured payout probability.

The [TypeSafe API](https://docs.typesafe.ai/api) is called only by the
Node experiment process. `TYPESAFE_API_KEY` stays in its environment, never
in browser code, command arguments, or result files. A missing credential,
HTTP/response error, timeout, or exhausted request cap fails visibly.
There is no retry or substitution of another policy. Raw decisions,
probabilities, model identity, and token counts remain in the report.

### Physical protocol and comparisons

Each trial loads the same seeded starting pile into two real Rapier worlds
and checks identical initial pose digests. Both warm up for 12 seconds.
The player world receives releases; the control receives no coins. The
control follows the exact same timeline, including model-selected waits.
API wall-clock latency advances neither world.

Each release feeds its coins through the existing chute at six coins per
second, then completes a total 2.4-second observation window measured from
the first coin. Spawns never overlap artificially. Release windows never
overlap, and payouts during deliberate pre-release waiting are reported
separately rather than credited as release successes.

The runner reports hit fraction, no-input hit fraction, collections per
inserted coin, signed additional collections, longest empty-release run,
elapsed simulation time, and peak active bodies. It preserves per-seed
outcomes: a pooled 90% result is not a claim that every seed passes.
Every physical step checks conservation, loss, and duplicate resolution.

Equal-release runs compare interaction frequency but spend more coins in
larger bursts. `--coin-budget` instead divides the same total input coins
into different release sizes; its budget must divide evenly by each size.
Those runs have different numbers of releases and observation durations.
Neither comparison is described as equal in both cost and duration.

```sh
# Local policies only; no API credential or requests.
just solve --policies center,random,rule --coins 1,2,3 --densities 300,400 --output /tmp/critpusher-release-baselines.json

# Uses TYPESAFE_API_KEY from the environment; cap checked before workers start.
just solve --policies jev --coins 1,2,3 --densities 300,400 --max-jev-requests 600 --output /tmp/critpusher-release-jev.json

# Equal input material rather than equal numbers of presses.
just solve --policies center,random,rule,jev --coins 1,2,3 --coin-budget 90 --max-jev-requests 600 --output /tmp/critpusher-equal-coins.json
```

`--seeds`, `--releases`, `--densities`, `--stroke`, `--front`, and `--modes`
pin trial inputs. `--modes back-row` isolates upper-shelf travel; ordinary
play still uses the chute. `--coins` supports bursts of 1–6. Reports are
saved after each completed trial with a running/complete/failed status.
The experiment does not silently change the playable cabinet's controls.

### Measured release frequency

The initial sweep uses seeds 7, 42, and 1337, 30 releases per seed, stroke
2, and collection edge z=4. Each cell below is the fraction of 90 releases
with at least one physical payout inside its 2.4-second window.

| Starting coins | Policy | One coin | Two coins | Three coins |
| -------------- | ------ | -------- | --------- | ----------- |
| 300            | Center | 0.500    | 0.633     | 0.656       |
| 300            | Random | 0.389    | 0.533     | 0.622       |
| 300            | Rule   | 0.489    | 0.644     | 0.656       |
| 300            | Jev    | 0.544    | 0.578     | 0.700       |
| 400            | Center | 0.578    | 0.722     | 0.778       |
| 400            | Random | 0.656    | 0.611     | 0.711       |
| 400            | Rule   | 0.589    | 0.656     | 0.733       |
| 400            | Jev    | 0.522    | 0.722     | 0.689       |

None meets the 0.900 target. Jev does not consistently beat the simpler
policies. More input per release improves frequency, but the effect is
not monotonic for every policy and seed. The no-input control pays in
0.222 of windows at density 300 and 0.333 at density 400, so gross
frequency includes continuing movement of the starting pile.

Mean collections per inserted coin tell a different story. With 300
starting coins, Jev's single-coin run collects 2.267 per inserted coin
while only 0.544 of releases pay. Three-coin releases collect 1.285 per
inserted coin while 0.700 of releases pay. Average return alone conceals
empty interactions.

Jev's larger-burst sweep retains the same seeds, geometry, and schedule:

| Starting coins | Four coins | Five coins | Six coins |
| -------------- | ---------- | ---------- | --------- |
| 300            | 0.789      | 0.844      | 0.811     |
| 400            | 0.789      | 0.878      | 0.889     |

The best pooled Jev result in this sweep is 80 paid releases out of 90, still below
target. One seed reaches 29/30 with six coins at density 400; the other
two reach 25/30 and 26/30. A successful seed is not a reliable setting.

The larger-burst baseline sweep reaches the pooled target once: rule-based
placement, 400 starting coins, and six coins per release pays in 81/90
windows. Its seed results are 30/30, 23/30, and 28/30. This is a pooled
pass, not every-seed success. Center placement with six coins pays in
80/90 windows at density 300 and 78/90 at density 400.

Direct back-row feeding with three-coin releases produces 61/90 paid
windows for center, 59/90 for rule, and 64/90 for Jev. It does not remove
the drought. Six-coin back-row trials fail the existing spawn-admission
guard; they are invalid experiments, not zero-payout results. The runner
retains those failures without retrying, moving a coin, or silently reducing
the input budget. Independent planned trials continue; any invalid trial
gives the command a nonzero exit. Its safe back-row spawn position
must clear existing coins without exceeding the cabinet height.

### Held-out comparison

Seeds 101, 202, and 303 were not used in the initial sweep. Geometry and
30-release schedules remain fixed; both starting densities are checked.

| Starting coins | Policy | Coins per release | Paid releases | Worst seed | Longest dry run |
| -------------- | ------ | ----------------- | ------------- | ---------- | --------------- |
| 300            | Center | 3                 | 63/90         | 19/30      | 4               |
| 300            | Jev    | 3                 | 60/90         | 17/30      | 4               |
| 300            | Center | 6                 | 80/90         | 25/30      | 2               |
| 300            | Jev    | 6                 | 79/90         | 24/30      | 2               |
| 400            | Rule   | 6                 | 77/90         | 21/30      | 3               |
| 400            | Jev    | 6                 | 83/90         | 27/30      | 1               |

The no-input control pays in 16/90 windows at density 300 and 22/90 at
density 400. Jev with 400 starting coins and six-coin releases reaches
the target on all three held-out seeds: 27/30, 29/30, and 27/30.
Across the initial and held-out seeds together, that setting pays on
163/180 releases (90.56%). Two initial seeds remain below 90%.

This is the candidate for a human burst-release playtest, not a guaranteed
payout or proof that Jev is generally better. These are repeated releases
from six evolving piles, not 180 independent samples. The comparison
does not establish a statistically reliable advantage over simpler policies.
The six candidate trials admit 1,080 input coins and resolve 1,466
collections, including material from the starting piles. Peak active
count is 399; final counts range from 282 to 311. This bounded run is
not a sustained-session or human-satisfaction claim.

```sh
just solve --policies jev --coins 4,5,6 --densities 300,400 --workers 3 --output /tmp/critpusher-large-bursts-jev.json
just solve --policies center,rule --coins 4,5,6 --densities 300,400 --workers 2 --output /tmp/critpusher-large-bursts-baselines.json
just solve --policies center,rule,jev --coins 3 --modes back-row --output /tmp/critpusher-backrow-three-all.json
just solve --policies center,jev --coins 3,6 --seeds 101,202,303 --workers 3 --output /tmp/critpusher-release-holdout.json
just solve --policies rule,jev --coins 6 --densities 400 --seeds 101,202,303 --workers 3 --output /tmp/critpusher-dense-holdout.json
```

Stored traces retain the actual model decisions. Fresh API calls need
not return identical decisions even with the same physical seed.

### Equal input budget and verification

Each equal-budget trial spends 90 coins at starting density 300. Single,
double, and triple releases therefore allow 90, 45, and 30 interactions,
respectively. Observation time differs; this is not an equal-duration test.

| Policy | Single-coin hit fraction | Two-coin hit fraction | Three-coin hit fraction |
| ------ | ------------------------ | --------------------- | ----------------------- |
| Center | 0.381                    | 0.607                 | 0.656                   |
| Random | 0.370                    | 0.511                 | 0.622                   |
| Rule   | 0.430                    | 0.556                 | 0.656                   |
| Jev    | 0.415                    | 0.593                 | 0.700                   |

Jev's mean collections per input coin decrease from 1.585 for singles to
1.285 for triples, while its worst dry run decreases from 16 interactions
to two. Bursts concentrate real input into fewer, more frequently rewarded
interactions; they do not establish better material efficiency.

Across the reported batches, 189 completed paired trial executions cover
6,570 releases and 19,170 accepted input coins. Some equal-budget runs
repeat earlier deterministic configurations; these are not 189 independent
starting conditions. Every completed run passes physical conservation,
unique-resolution, zero-loss, and full-input-budget checks. Three six-coin
back-row trials are retained as invalid due to rejected spawns.

All 1,935 retained Jev decisions choose zero additional wait. The action
space supports quarter-cycle waits, but this evidence establishes no
learned timing advantage. The model adapts lane placement, not observed
release timing in these runs.

The production build and 74 tests pass, including lane observation,
release-window accounting, action validation, bounded requests, and
response-body timeout coverage. These experiments change no browser
controls or physical defaults. The candidate remains 400 starting coins,
six coins per release at six coins per second, one 2.4-second release
window, stroke 2, and collection edge z=4.

## Final density, stacked release, and flanking chute trials

This physical-only experiment uses one player chute with an enemy chute
on each side. Moving the player center moves both flanks. One action
releases all three chutes simultaneously. These source labels do not add
combat effects or change the browser's controls.

`--patterns stack` releases one or three coins at exactly the same x/z.
Three flat cylinders start at y=3.5, 3.65, and 3.8; each has thickness
0.13, with a 0.02 gap. They are separate bodies, not intersecting spawns.
`--patterns flanks` adds enemy chutes at center x minus/plus `--spacings`.
Each flank releases `--enemy-coins`, either one or three. The sweep
therefore includes three, five, seven, and nine total coins per action;
player and enemy input budgets remain separate in the report.

The simulation preflights the complete batch against actual cylinder
shapes, existing bodies, cabinet bounds, and other batch members. Ordinary
admission refusal creates no bodies and does not consume the cooldown.
Unsafe releases invalidate the trial rather than changing its coin budget.
The existing sequential release and interactive single-coin drop remain
available with their original behavior.

Spacing is center-to-flank distance, in machine units. The initial sweep
checks 0.7, 1.5, and 3.0 (coin diameter 0.64), with requested starting
counts 400, 600, 800, and 1,000. Five center candidates narrow proportionally
to keep every chute inside x=-4.4..4.4; flank positions are never clamped
together. The center baseline isolates spacing without moving the center.
Jev receives actual candidate center coordinates and the synchronized
layout. Observation lanes remain five fixed spatial regions, not chute
walls or automatic enemy targets.

All worlds warm up for 720 steps (12 seconds). Reports distinguish the
requested initial count, opening collections, and actual settled active
count. No-input controls measure continuing starting-pile motion. Flank
trials also run an enemy-only world with exactly the same flank positions,
release times, and enemy budgets. Signed collection differences from this
control measure the consequence of adding player input to that schedule,
not causal credit for an individual coin.

Collections are labelled by physical source: starting pile, player chute,
or enemy chute. A release can pay from earlier feed coins or starting
material. The 90% target still counts any real collection within a
nonoverlapping 144-step window; enemy collections are not assumed beneficial
in the eventual combat game. Pre-release waiting payouts remain excluded.

```sh
just solve --policies center --patterns stack --coins 1,3 --densities 400,600,800,1000 --seeds 7,42 --workers 4 --output /tmp/critpusher-final-stacks.json
just solve --policies center --patterns flanks --coins 1,3 --enemy-coins 1,3 --spacings 0.7,1.5,3 --densities 400,600,800,1000 --seeds 7,42 --workers 4 --output /tmp/critpusher-final-flanks.json
```

### Single-chute density screening

Center placement, seeds 7 and 42, and 30 releases per seed:

| Requested starting coins | Mean active after opening | Single-coin paid windows | Three-coin stack paid windows | No-input paid windows |
| ------------------------ | ------------------------- | ------------------------ | ----------------------------- | --------------------- |
| 400                      | 360.5                     | 33/60                    | 47/60                         | 19/60                 |
| 600                      | 463                       | 39/60                    | 51/60                         | 19/60                 |
| 800                      | 544                       | 38/60                    | 49/60                         | 29/60                 |
| 1,000                    | 640.5                     | 43/60                    | 49/60                         | 34/60                 |

Three-coin stacks improve paid-release frequency over single coins at
every tested density, but no pooled stack configuration reaches 90%.
The 600-coin load is the strongest stack screen at 85%; increasing the
opening load further increases autonomous payout frequency without
improving stacked-release frequency.

Collections still mostly come from opening material. The 600-coin stack
trials collect 423 starting coins and 41 player-feed coins after opening,
from 180 player inputs across two trials. Those counts measure physical
provenance, not which input caused a collection.

At the strongest screened stack load (600), held-out seeds 101, 202, and
303 produce 75/90 paid releases with center placement, 75/90 with random
placement, and 73/90 with Jev. The corresponding no-input control pays in
41/90 windows. Jev chooses different lanes but always zero extra wait;
it does not improve this stack configuration.

```sh
just solve --policies center,random,jev --patterns stack --coins 3 --densities 600 --seeds 101,202,303 --workers 3 --output /tmp/critpusher-final-stack-holdout.json
```

### Flank spacing screening

Each cell counts paid releases out of 60, using center placement and seeds
7 and 42. Player/flank is the number of coins released from the player
chute and from each of its two enemy chutes.

| Starting load | Player/flank | Spacing 0.7 | Spacing 1.5 | Spacing 3.0 |
| ------------- | ------------ | ----------- | ----------- | ----------- |
| 400           | 1/1          | 47/60       | 49/60       | 50/60       |
| 400           | 1/3          | 55/60       | 53/60       | 54/60       |
| 400           | 3/1          | 51/60       | 52/60       | 50/60       |
| 400           | 3/3          | 56/60       | 59/60       | 54/60       |
| 600           | 1/1          | 50/60       | 50/60       | 51/60       |
| 600           | 1/3          | 57/60       | 56/60       | 58/60       |
| 600           | 3/1          | 52/60       | 54/60       | 56/60       |
| 600           | 3/3          | 58/60       | 57/60       | 57/60       |
| 800           | 1/1          | 54/60       | 46/60       | 52/60       |
| 800           | 1/3          | 55/60       | 57/60       | 56/60       |
| 800           | 3/1          | 52/60       | 55/60       | 52/60       |
| 800           | 3/3          | 58/60       | 55/60       | 58/60       |
| 1,000         | 1/1          | 50/60       | 50/60       | 55/60       |
| 1,000         | 1/3          | 57/60       | 57/60       | 60/60       |
| 1,000         | 3/1          | 57/60       | 55/60       | 57/60       |
| 1,000         | 3/3          | 59/60       | 60/60       | 55/60       |

Spacing changes results, but there is no spacing that wins every load and
budget. All nine-coin configurations reach the pooled target in this
screen. This is not equal-cost superiority over single-chute stacks:
three coins at each of three chutes inject nine coins per interaction.
At 400 starting coins and spacing 1.5, the nine-coin layout pays in 59/60
windows, while its six-enemy-coin-only control pays in 51/60. Adding the
player stack increases total collections by 151 across the two trials.
Source totals are 68 player-feed, 77 enemy-feed, and 494 starting coins.
These totals are not net combat rewards.

The held-out configurations cover light side-by-side release (800,
player/flank 1/1, spacing 0.7), asymmetric stacked release (600, 3/1,
spacing 3.0), and matching stacks (400, 600, and 1,000, 3/3, spacing 1.5).
Each compares center, random, and Jev placement on seeds 101, 202, and 303.

```sh
just solve --policies center,random,jev --patterns flanks --coins 1 --enemy-coins 1 --spacings 0.7 --densities 800 --seeds 101,202,303 --workers 2 --output /tmp/critpusher-final-three-holdout.json
just solve --policies center,random,jev --patterns flanks --coins 3 --enemy-coins 1 --spacings 3 --densities 600 --seeds 101,202,303 --workers 2 --output /tmp/critpusher-final-five-holdout.json
just solve --policies center,random,jev --patterns flanks --coins 3 --enemy-coins 3 --spacings 1.5 --densities 400,600,1000 --seeds 101,202,303 --workers 3 --output /tmp/critpusher-final-nine-holdout.json
```

### Held-out light and asymmetric feeds

Each policy has 90 release windows across seeds 101, 202, and 303:

| Starting load | Player/flank | Spacing | Center | Random | Jev   |
| ------------- | ------------ | ------- | ------ | ------ | ----- |
| 800           | 1/1          | 0.7     | 77/90  | 81/90  | 72/90 |
| 600           | 3/1          | 3.0     | 81/90  | 79/90  | 87/90 |

The asymmetric Jev result meets the target on every held-out seed:
29/30, 28/30, and 30/30, with at most one consecutive empty release.
Its enemy-only control pays in 75/90 windows; the no-input control pays
in 41/90. Adding player input increases total collections by 267 relative
to the synchronized enemy-only schedule. Most Jev actions remain at
center, with four inner-left/right adjustments and no additional waiting.

This wide layout is a throughput candidate, not a demonstrated combat
pressure loop: none of its 180 newly fed enemy coins reaches collection
during the 30-release runs. Jev collects 51 player-feed and 981 starting
coins. Enemy coins remain in the machine rather than resolving as threats.
Gross payout frequency cannot by itself establish mixed player/enemy
avalanches or a balanced fight.

### Held-out matching stacks and selected physical setting

All three chutes release three flat coins simultaneously; spacing is 1.5.
Each policy has 90 windows across seeds 101, 202, and 303:

| Starting load | Center | Random | Jev   |
| ------------- | ------ | ------ | ----- |
| 400           | 85/90  | 82/90  | 85/90 |
| 600           | 87/90  | 87/90  | 87/90 |
| 1,000         | 88/90  | 87/90  | 89/90 |

Every individual held-out seed reaches at least 90% for every policy at
these matching-stack settings. More opening coins improve gross frequency
slightly in this configuration, but all three policies already pass at 400. The result does not establish a general adaptive-placement advantage.

The selected physical candidate for the combat prototype is:

- Requested opening load: 600 coins.
- Player chute: three stacked coins per action.
- Two enemy chutes: three stacked coins each, triggered by the same action.
- Center-to-flank distance: 1.5; the full chute span is 3.0.
- Pusher stroke: 2; period: 2.4 seconds; collection edge: z=4.
- One action per full pusher cycle in these tests; no additional model wait.

At center placement this setting pays on 87/90 held-out releases (96.67%),
with seed outcomes 30/30, 29/30, and 28/30 and at most one empty release
in a row. The screening seeds pay on 57/60. The enemy-only held-out
control pays on 85/90, compared with 41/90 without input. Thus synchronized
enemy material supplies much of the frequent collection; the player stack
adds 238 collections relative to that enemy-only schedule.

The full held-out source totals are 83 player-feed, 86 enemy-feed, and
1,122 starting coins. Nineteen windows contain collections from both
player and enemy feeds. These are mixed-source windows, not proof of
same-contact cascades or combat balance. The corresponding source totals
under random placement are only seven player-feed and 19 enemy-feed coins,
despite the same 87/90 gross hit count. Placement changes what leaves the
machine even when gross reward frequency is saturated.

Six hundred is a conservative middle load with all held-out policies
passing and a mean 480 active coins after opening. It is not a uniquely
optimal load: 400 also passes, while 1,000 provides more early material
and higher autonomous throughput. This choice sets a physical starting
point, not damage values, enemy balance, queue-consumption semantics, or
permission to count enemy collections as rewards.

The round completes 166 trial executions, 4,980 release windows, 11,040
player inputs, and 17,460 enemy inputs, excluding the short smoke runs.
No trial is invalid: conservation, unique resolution, zero-loss, complete
input budgets, and matched initial piles hold throughout. Peak active
count across the full round is 912. All 540 measured Jev decisions choose
zero additional wait.

These historical trials measure simultaneous stack releases, not the current
browser's timed drop sets or six-type combat opening pile. Human feel,
real-phone frame rate, long-session behavior, and combat balance are not
verified. The physical test round provides a baseline for combat design.
