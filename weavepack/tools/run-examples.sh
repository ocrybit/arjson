#!/usr/bin/env bash
# Smoke-run every worked example and report any that fail.
#
# Examples are runnable, dependency-free demos that should always
# exit 0. They double as light integration tests: if the JS or
# Python API drifts in a way that breaks an example, this catches
# it before the example becomes stale.
#
# Run from the repo root:
#   bash weavepack/tools/run-examples.sh

set -uo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$REPO_ROOT"

color() {
    case "$1" in
        green) printf '\033[32m';;
        red)   printf '\033[31m';;
        yellow) printf '\033[33m';;
        bold)  printf '\033[1m';;
        reset) printf '\033[0m';;
    esac
}

any_fail=0
total=0

run_example() {
    local label="$1"; shift
    local cmd="$*"
    total=$((total + 1))
    printf "%s%-60s%s " "$(color bold)" "$label" "$(color reset)"
    local start=$(date +%s%N)
    if eval "$cmd" > /tmp/example-output-$$.log 2>&1; then
        local elapsed_ms=$(( ( $(date +%s%N) - start ) / 1000000 ))
        printf "%sOK%s %s(%dms)%s\n" \
            "$(color green)" "$(color reset)" "$(color yellow)" "$elapsed_ms" "$(color reset)"
    else
        local elapsed_ms=$(( ( $(date +%s%N) - start ) / 1000000 ))
        printf "%sFAIL%s %s(%dms)%s\n" \
            "$(color red)" "$(color reset)" "$(color yellow)" "$elapsed_ms" "$(color reset)"
        sed 's/^/    /' /tmp/example-output-$$.log | tail -5
        any_fail=1
    fi
    rm -f /tmp/example-output-$$.log
}

echo
printf "%sweavepack worked examples — smoke run%s\n" "$(color bold)" "$(color reset)"
echo

# JS tensor examples.
for f in weavepack/profiles/tensor/examples/*.js; do
    run_example "$f" "node $f"
done

# JS JSON examples.
for f in weavepack/profiles/json/examples/*.js; do
    run_example "$f" "node $f"
done

# Python examples.
for f in weavepack/profiles/tensor/examples/*.py; do
    run_example "$f" "PYTHONPATH=impl/python python3 $f"
done

echo
if [[ $any_fail -eq 0 ]]; then
    printf "%sAll %d examples passed.%s\n" "$(color green)" "$total" "$(color reset)"
    exit 0
else
    printf "%sAt least one example failed.%s\n" "$(color red)" "$(color reset)"
    exit 1
fi
