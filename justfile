default:
    @just --list

dev:
    npm run dev

build:
    npm run build

test:
    npm test

typecheck:
    npm run typecheck

format:
    npm run format

# Deterministic headless physical trials; pass --suite throughput or skill.
experiment *args:
    npm run experiment -- {{args}}

# Adaptive lane policies and one-cycle, nonoverlapping release windows.
solve *args:
    npm run solve -- {{args}}
