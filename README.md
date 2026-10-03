# Critpusher

A browser coin-pusher game with real Rapier cylinders, contacts, and avalanches,
rendered with Three.js and an authored GLB cabinet.

Choose one of three starter kits, survive two waves in each of three encounters,
and carry health, currency, coin bags, and stickers through transactional shops.
Combat starts during opening rain and ends in a terminal victory or defeat.

## Run it

Node 24 or newer.

```sh
npm install
just dev      # or: npm run dev
just build    # typecheck + production bundle
just test     # physics, combat, run, purchase, and replay regressions
```

For a phone on the same network, bind explicitly:
`npm run dev -- --host 0.0.0.0` and open the LAN address.

## Publish the development build

The playable development build is at <https://critpusher.alpacasoft.dev>.
Cloudflare Workers serves the static Vite bundle and authored cabinet from
`dist/`; the game runs entirely in the browser, with no server-side simulation.
`wrangler.jsonc` owns the custom domain and asset directory.

Authenticate with `npm exec -- wrangler login`, then run `just deploy`.
Deployment runs the regression suite and production build before uploading
assets. Wrangler provisions the custom-domain DNS record and certificate.
Balance remains experimental; publishing does not freeze a study selection.

## UI styling

Tailwind CSS 4 runs through the Vite plugin. `src/style.css` defines the shared
color, spacing, typography, radius, and shadow tokens plus shell components.
`src/ui/combat.css` uses the same tokens for the fight HUD and tuning controls.
`src/ui/run.css` styles starter choices, the machine-docked shop, offer icons,
and purchase previews.
Use these component layers for repeated controls; reserve custom CSS for the
cabinet finish, dynamic progress values, and scene sizing. Three.js renders
the machine independently of DOM styling.

## Play

- The starter screen offers three kits: **Collector** (three swords, potion,
  gold; collected-only), **Pocket army** (four swords, potion; miniature), and
  **Volley** (four swords, bomb; magazine-dump). Each bag is a persistent
  five-token replenishing stream. The kit description shows its tradeoff.
- A run has three ordered encounters, each with two waves: Training floor,
  Overclock floor, and Foreman floor. Enemy rosters, bags, opening weights,
  HP, and escalation thresholds are catalogued and seeded. Player HP starts at
  100; HP, currency, player bags, stickers, and effect levels carry forward.
- Opening loading is active combat. Catches, healing, currency, impacts, and
  bomb effects resolve from the first loading tick; a victory or defeat can
  happen before magazines engage. There is no manual Start fight action.
- Aim with the pointer, arrows, or **Chute position** slider. Space, tap, or
  **Drop coin** releases an ordinary captured round; P pauses and R restarts
  when focus is outside a form control. Pause, hidden-page handling, and
  terminal states stop physical time and pending release work.
- Ordinary releases open synchronized escapements subject to native mechanical
  admission and waiting. The magazine-dump sticker instead captures the actual
  five stocked rows in each participating lane and opens that native cohort
  under gravity; it is not five teleported drops or five scheduled ordinary
  releases. Stable owner lanes reserve up to three player and three enemy
  positions. Dead enemy lanes remove only unadmitted stock, without shifting
  surviving lanes or deleting pile coins. Outlet hardware stays open until
  admitted bodies clear; a replacement owner waits for that clearance before
  installing stock at the same reserved position.
  Player chute hardware is teal; enemy hardware is coral. Matching HUD keys use
  circles for your chutes, squares for enemy chutes, and explicit ownership labels.
- Caught swords damage the front living enemy, skulls damage the player,
  potions heal, and gold/diamonds add currency. Physical bombs arm and
  detonate under the playable impact rules. The collected-only sticker
  suppresses detonation HP damage but keeps contacts, impulses, and effects.
  A wave clears only after its complete batch; reinforcements enter afterward.
- Each encounter victory—including an opening or final victory—grants exactly
  12 currency once. Encounters one and two then offer exactly 12 fixed healing
  (used and wasted are recorded) and a shop. There is no shop or automatic
  healing after the final victory, and defeat grants neither.
  Shop previews show current/resulting bag counts, effective effects, limits,
  price, and remaining money. A purchase rechecks all conditions and
  atomically changes nothing on failure. Stable failure
  codes are `not-in-shop`, `unknown-offer`, `unknown-chute`,
  `invalid-replacement`, `insufficient-currency`, `limit-reached`, and
  `already-owned`.
  Successful purchases preserve keyboard focus on the refreshed purchase
  button, or on the selected offer when another purchase is blocked.
  The machine shop shares the cabinet frame with the frozen board: alongside it
  on desktop and beneath it on phones. Icon-labelled offers reuse the coin
  symbols and add mechanical/sticker marks. Review brings the selected preview
  into view; Review and Next encounter remain available while offers scroll.
- Shops can replace bag tokens, add up to two Tempered swords or Restorative
  brew levels, add up to three player chutes by cloning a bag, or buy each
  unique sticker at most once. The four stickers are collected-only,
  miniature, magazine-dump, and combo-bell. Combo bell chains collected
  swords ×1/×2/×3 within 144 simulation ticks (maximum ×3) and spawns a
  separate physical bell that pays 3 currency once when collected; its ledger
  is separate from coin accounting.
- **Next encounter** starts a fresh seeded pile while retaining the run build.
  **New run** and toolbar **Restart** clear encounters, ownership, currency,
  queued work, effects, and physical state, returning to kit selection. Mute,
  pause, and reduced-motion preferences are independent; reduced motion only
  changes presentation effects, not gameplay physics.

The Tuning panel remains a diagnostic surface for physical values and
release settings. It does not choose the run's enemy roster or owned inventory.
Native admissions preserve body, collider, pose, velocity, contact history, and
identity; replacements enter behind the rear cover. The shared machine supports
six stable lanes and the actual six-by-five stock capacity.

The authored cabinet is `src/assets/cabinet.glb`, loaded asynchronously before
kit selection. A load or validation failure is fatal and actionable; runtime
code has no procedural primitive cabinet fallback. `just cabinet-assets` finds
Blender through `BLENDER_BIN`, PATH, or the confirmed application path and
authors `assets/cabinet.blend` plus the GLB. `just cabinet-check` inspects the
exported hierarchy, vertices, transforms, contact faces, gate poses, triangle
budget, and file-size budget against the shared machine specification.

## What is measured

`DESIGN.md` is the design bible and `TUNING.md` records physical experiments,
the historical fight diagnostic, and the current whole-run protocol. Historical
physical solver and fight-study evidence are not run-balance evidence.

```sh
just solve --patterns flanks --coins 3 --enemy-coins 3 --spacings 1.5 \
  --densities 600 --seeds 42 --releases 30
```

The separate fight diagnostic uses real Rapier bodies and API-free replay:

```sh
just fight-study --phase smoke --policies center,random,rule --seeds 42 \
  --actions 12 --output /tmp/critpusher-fight-smoke.json
just fight-study --phase replay --replay /tmp/critpusher-fight-smoke.json \
  --max-jev-requests 0 --output /tmp/critpusher-fight-replay.json
```

The current whole-run report is `mvp3-run-v1`. It has `smoke`, `screen`,
`evaluate`, and `replay` phases, center/random/rule policies, explicit build
profiles, and JSON traces of loading, admissions, combat, shops, recovery,
rewards, and terminal state:

```sh
just run-study --phase smoke --seeds 7,42,1337 \
  --builds collector,swarm,volley,tempo,recovery \
  --policies rule --actions 60 --workers 3 \
  --output ../critpusher-mvp3-evidence/run-smoke.json
just run-study --phase screen --policies center,random,rule --actions 60 \
  --workers 4 --output ../critpusher-mvp3-evidence/run-screen.json \
  --selection ../critpusher-mvp3-evidence/run-selection.json
just run-study --phase evaluate --policies rule --actions 60 --workers 4 \
  --selection ../critpusher-mvp3-evidence/run-selection.json \
  --output ../critpusher-mvp3-evidence/run-evaluation.json
just run-study --phase replay --replay ../critpusher-mvp3-evidence/run-smoke.json \
  --output ../critpusher-mvp3-evidence/run-replay.json
```

Screening and evaluation use fixed preregistered cohorts and held-out seeds;
only smoke accepts seed/build overrides. Budgets are 60 actions and at most
300 admitted rounds per encounter, with 1,440-tick loading and mechanical
stall caps and at most eight shop purchases. Every planned row, including
invalid and unfinished rows, remains in denominators; replay requires an exact
nonempty manifest. Whole-run smoke, replay, and complete screening cohorts have
been exercised. The latest recorded screen, before the ownership/shop UI pass,
passed nine of ten gates; matched post-shop recovery reduction had median zero.
That candidate is not accepted or frozen, and held-out evaluation has not run.

## Current progress

The functional run is implemented: authored physical machine, continuous loading
combat, three two-wave encounters, stable synchronized owner lanes, seeded bags,
persistent build and transactional shops, four composable stickers, impact-armed
bombs, native magazine bursts, batch combat resolution, visual/audio feedback,
and whole-run trace/replay infrastructure.

Player chutes use teal hardware and enemy chutes use coral, with labelled
circle/square HUD keys. The shop shares the cabinet frame with the frozen board
and uses icons for coins, upgrades, chutes, and stickers. The functional run has
positive human playtest feedback, and the ownership/shop refinements are approved.

Recorded verification: 366 tests across 36 files, typecheck, production build,
and cabinet checks pass. Muted Chromium exercised desktop 1280×800, portrait
390×844, and landscape 844×390; six normal/miniature lanes; purchases and blockers;
focus retention; native burst; wave/encounter transitions; results and restart.
The production build loads the authored cabinet and has no DEV bridge.

**Balancing is next.** Human feedback says the run is far too easy. Gameplay
numbers are unchanged by the functional UI pass. Balance selection, held-out
evaluation, and detailed human observations of kit tradeoffs, recovery purchases,
combined stickers, mascot behavior, and enemy pressure remain completion gates.
Historical physical/fight diagnostics and automated victories do not replace them.

## License

MIT.
