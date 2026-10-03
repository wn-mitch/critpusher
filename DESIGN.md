# Critpusher design bible

Living design context for the game. Measurements live in `TUNING.md`; run
instructions live in `README.md`. Public repository:
https://github.com/wn-mitch/critpusher

## Status

| Stage   | Scope                                                                                                 | State       |
| ------- | ----------------------------------------------------------------------------------------------------- | ----------- |
| MVP 1   | Physical machine: dense pile, pusher, collection edge, opening rain, live tuning, measurement harness | Shipped     |
| MVP 1.5 | Atomic timed drop sets and captured chute settings                                                   | Shipped     |
| MVP 2   | Continuous loading combat, typed catches, impact bombs, readable feeds, seeded diagnostics            | Shipped     |
| MVP 3   | Three-encounter run: waves, escalating pressure, persistent build, shops, authored cabinet            | Functional UI approved; balance pending |

## The physical contract

Coins are real Rapier cylinders. Nothing is animated to imitate a pile.

- Up to three player and three enemy lanes use stable owner slots. Player slot 0
  is aimed over the rear of the upper pusher at z = -3.15; player slots +1/-1
  and enemy slots -2/+2/-3 retain their positions when lanes shutter.
  Pointer and slider control the shared aim x only; a fixed camera frames the
  whole machine.
- The pusher sweeps with cosine motion, stroke 2, period 2.4 s. Coins ride
  the pusher, jam, and avalanche; a coin past the collection edge (z = 4)
  and below y = -0.45 is caught exactly once.
- Active coins are never deleted to hold density. Out-of-bounds exits are
  losses, never payouts, and are counted separately from catches.
- A **drop set** is the coins requested by one click. Each round opens every
  chute escapement simultaneously. **Coins per chute per click** sets the
  number of rounds; **Delay between coins (s)** is the minimum interval.
  A ready first round is immediate; otherwise the request waits for gravity.
- Admission checks real cylinder shapes, including freshly inserted colliders.
  An occupied or unsettled lane delays the entire round without partial
  consumption. Pause, reset, and hidden-page handling cancel remaining rounds.
- A split floor and its low lip retract for release, then close after the
  admitted cylinder clears. Unmotorized prismatic rails support and guide stock;
  a passive upstream travel stop retains the higher coins until closure.
  Gravity and native contacts advance the queue. Release and queue advance
  apply no prescribed poses or velocities. Live aim/drop-height edits move
  only stocked assemblies, not admitted bodies. Stock uses the rails for
  normal support; floor collision applies to admitted coins.

## The run loop

1. Choose Collector, Pocket army, or Volley. The selected five-token bag and
   starter sticker become the initial owned build.
2. Opening rain is already combat. Read the loading pile, live catches,
   incoming damage, healing, and currency while the first wave feeds.
3. Aim and release ordinary synchronized rounds, or capture a native five-row
   cohort when magazine-dump is active. Read the front enemy, lane ownership,
   escalation pressure, and the resulting batch.
4. When a wave clears, reinforcements enter after that complete batch. Every
   encounter victory—including an opening or final victory—awards 12 currency
   once. After encounters one and two, offer 12 fixed healing and the
   transactional shop before the next fresh pile; there is no final shop or
   automatic final healing.

5. Finish the third encounter for victory, or reach zero HP for defeat. New run
   and restart return to kit selection and clear run-owned state.

Player HP starts at 100. HP, currency, bags, stickers, effect levels, and
physical preferences carry across encounters; the pile and native streams do
not. Completion service is serialised so a repeated terminal step cannot grant
another reward or recovery.

## Owner lanes and encounter roster

The run reserves three player and three enemy lane positions. Every lane has a
stable owner and ID. A dead enemy removes only unadmitted stock and does not
shift surviving lanes or charge unadmitted tokens. Its outlet closes after
already-admitted bodies clear the shared corridor. Replacement owners use
fresh IDs at the reserved positions and wait for that clearance before
stocking their five native coins; admitted pile coins are never relocated or
deleted. The ordered catalog is:

| Encounter | Wave 1 | Wave 2 |
| --- | --- | --- |
| Training floor | Trainee 20 + Trainee 20 | Guard 30 |
| Overclock floor | Guard 35 + Escalator 40 | Escalator 50 + Guard 35 |
| Foreman floor | Guard 35 + Escalator 50 + Guard 35 | Foreman 65 + Escort 25 + Escort 25 |

Each encounter has its own seeded opening mix; escalation and enemy five-token
bags are fixed by the catalog, with no branching roster selection.
Opening weights use gold/diamond/sword/skull/potion/bomb order:
Training `25/1/35/28/10/1`, Overclock `23/1/32/27/16/1`, and Foreman
`22/1/30/32/14/1`. Trainees and escorts use three skulls/two gold;
guards use four skulls/one gold; escalators use three skulls/two gold before
their admitted-round escalation; the foreman uses three skulls, one bomb, and
one gold.

## Coin effects, feeds, and build composition

Gold gives 1 currency, diamond 10, sword deals configured enemy damage
(baseline 3), skull deals configured player damage (2), and potion offers
configured healing (4). A safely caught bomb deals no damage. Losses have no
gameplay effect. Types stay on their bodies through contacts.

The run catalog uses encounter-specific opening weights and enemy bags. Each
player and enemy chute owns a seeded five-token replenishing stream. A tray
holds five native face-up cylinders; admission transfers the lowest body and
collider unchanged into gameplay accounting. Surviving stock keeps its identity
and slides downhill; replenishment enters only behind the rear cover. Bag
tokens advance only for that chute's admitted body.

Ordinary releases open synchronized escapements after physical preflight and
may wait for occupied lanes, settling stock, or an obstructed outlet. The
magazine-dump sticker captures the actual five stocked rows across participating
lanes, opens all upper travel stops together, and admits each moving native
body at the real outlet. It never teleports coins, schedules five ordinary
single releases, or converts rear stock into board coins. A blocked cohort
waits safely. Pause, hidden-page cancellation, wave replacement, reset, and
terminal cancellation stop future admissions without charging unadmitted
tokens. Dead or replaced enemy stock is removed outside the board ledger;
already-admitted coins remain physical board bodies.

Each complete physical event batch resolves currency, healing, incoming damage,
and outgoing damage together. Swords target living enemies in order; excess
damage is recorded and cannot reach an unborn wave. Reinforcements appear only
after the clearing batch. Escalators replace gold with skulls after five and
ten actually admitted rounds while preserving already committed stock.

Run builds apply persistent bag composition, physical stickers, additive
upgrades, and timed effects in a fixed order. Collected-only suppresses only
detonation HP damage, not contacts, impulses, or effects. Miniature scales
radius and thickness by 0.75, increases opening population by 50%, and sets
base sword damage to 2. Magazine-dump enables native five-row cohorts.
Combo-bell chains collected swords ×1/×2/×3, refreshes its 144-tick window,
and expires when the fixed-tick boundary is reached. Its separate bell gizmo
has radius 0.38, density 1.5, pays 3 once on collection, and has independent
coin/gizmo conservation. Combo remains active if the bell is lost or collected;
the owned sticker returns on the next encounter.

Policy observation exposes owned composition, resolved effects, and live combo
timing, but not shuffled future tokens or seeds. The mascot silhouette is
included in the same readable-cap projection without becoming a coin type.

## Controls and diagnostic tuning surface

- Player chute rails/gates/arrows are teal; enemy hardware is coral. HUD keys
  combine circles/squares with explicit Your chute / Enemy chute labels.
- Between encounters, the shop docks inside the cabinet frame beside the frozen
  board on desktop or beneath it on phones. Offers have coin, upgrade, chute,
  and sticker icons. Offers/previews scroll independently; Review and Next
  encounter remain available. Purchase previews retain bag/effect changes,
  limits, costs, blockers, announcements, and keyboard focus.
- Aim by pointer, arrow keys, or the chute-position slider; drop by button,
  Space, tap, or hold.
- Pause, mute/volume, and reduced motion are independent preferences. Reduced
  motion suppresses presentation effects without changing physical motion.
- The Tuning panel exposes diagnostic physical values and ordinary release
  settings, but the run owner determines starter inventory, enemy count, and
  encounter roster. It cannot mutate owned bags or enemy lanes mid-run.
- Ordinary defaults are one round and a 0.3-second minimum delay. Aim and
  spacing are captured for a release set; native mechanical cadence may be
  slower. A magazine-dump action captures its cohort until emission ends.
- Pause, reset, terminal completion, or a hidden page cancels pending work
  without counting unspawned rain as losses. Further run steps and drops are
  inert outside the encounter phase.

## Exercised behavior

Headless Chromium exercised a controlled opening victory with no player
actions: loading advanced directly to finished, displayed Victory and the
damage cue, and subsequent steps left physical time frozen. The desktop
surface had no horizontal overflow. This is runtime proof, not human
satisfaction or whole-run balance evidence.

Controlled real-engine configurations produced defeat and simultaneous defeat.
The latter displayed **Defeat: both combatants fell**. Normal and reduced-motion
replays of the bomb fixture had identical body poses and combat totals.
Keyboard aim preserved the feed, Space admitted one round, and trusted
touchscreen control events admitted exactly one round. Desktop 1280×800,
portrait 390×844, and landscape 844×390 showed no horizontal overflow;
short landscape scrolls vertically to keep the machine readable.

Historical payout-only measurements remain in `TUNING.md`. They are physical
provenance, not causal credit for one release or evidence of combat balance.

## Authored cabinet and loading

The runtime cabinet is the authored `src/assets/cabinet.glb`, loaded
asynchronously before starter selection. Its source is `assets/cabinet.blend`,
generated by `scripts/build-cabinet.py` from the shared machine/tray
specification. `just cabinet-assets` discovers Blender from `BLENDER_BIN`,
then PATH, then the confirmed application executable. `just cabinet-check`
inspects actual exported vertices and transforms, required module hierarchy,
contact faces and gate poses, finite/unit transforms, and the 20,000-triangle
and 1 MB GLB budgets. A missing or invalid asset is an actionable fatal
startup error that disables gameplay controls; there is no procedural runtime
primitive fallback.

The authored modules are `cabinet_shell`, `playfield`, `pusher`,
`collection_tray`, `feed_rail`, `feed_gate`, `feed_cover`, and `combo_bell`.
Rail, gate, and cover prototypes remain local tray geometry and are instanced
for six stable lane IDs at runtime. Decorative surfaces may embellish outside
the reachable playfield, but every gameplay contact surface has its matching
Rapier primitive. The collection tray is below the actual collection detector.

## Progression and evidence boundaries

The run coordinator owns starter selection, three encounters, two waves per
encounter, persistent bags/stickers/upgrades, exact transactional shops,
fixed inter-encounter recovery, completion tokens, and restart. The physical
solver and first-fight diagnostic remain separate protocols; their payout or
fight measurements do not establish whole-run balance. The run-study protocol
retains every planned row, including invalid and unfinished trials.

Whole-run smoke and replay establish deterministic execution, not balance.
Screening must pass every registered gate before a configuration can freeze;
the disjoint held-out cohort and actual human observations remain separate
completion gates. Full raw trace rows are streamed without truncation.

## What is not verified

Accepted whole-run balance, long-session stability, and real-phone behaviour
remain unverified. Human playtesting finds the run functional and satisfying,
and the ownership colors/docked shop refinements are approved, but the run is
far too easy. Detailed kit, purchase, mascot, and enemy-pressure observations
remain pending. Browser evidence uses hidden desktop Chromium with emulated
portrait/landscape touch viewports, not a physical phone.
