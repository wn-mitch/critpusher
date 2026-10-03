default:
    @just --list

dev:
    npm run dev

build:
    npm run build

deploy:
    npm run deploy

test:
    npm test

typecheck:
    npm run typecheck

format:
    npm run format

# Author the shared-spec cabinet in Blender and export its runtime GLB.
cabinet-assets:
    npm exec -- tsx scripts/cabinet-assets.ts build

# Inspect the authored GLB geometry, hierarchy, transforms, poses, and budgets.
cabinet-check:
    npm exec -- tsx scripts/cabinet-assets.ts check

# Deterministic headless physical trials; pass --suite throughput or skill.
experiment *args:
    npm run experiment -- {{args}}

# Adaptive lane policies and one-cycle, nonoverlapping release windows.
solve *args:
    npm run solve -- {{args}}

# Preregistered combat mixture screen and fresh-seed evaluation.
fight-study *args:
    npm run fight-study -- {{args}}

# Seeded whole-run screen, frozen evaluation, and recorded-decision replay.
run-study *args:
    npm run run-study -- {{args}}
