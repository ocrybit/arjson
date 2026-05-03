#!/usr/bin/env bash
# Cross-language conformance check.
#
# Runs each implementation's conformance binary and prints a summary
# table. Exit code 0 if all implementations report 0 failures; exit
# code 1 if any implementation has a failure (caller can investigate
# per-impl).
#
# This is the headline check for "all conforming implementations
# agree" — pass = the wire format is genuinely cross-language stable.

set -uo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$REPO_ROOT"

# ── helpers ──────────────────────────────────────────────────────────────

color() {
    case "$1" in
        green) printf '\033[32m';;
        red)   printf '\033[31m';;
        yellow) printf '\033[33m';;
        bold)  printf '\033[1m';;
        reset) printf '\033[0m';;
    esac
}

total_pass=0

run_check() {
    local name="$1"; shift
    local cmd="$*"
    printf "%s%-30s%s " "$(color bold)" "$name" "$(color reset)"
    local start_time=$(date +%s%N)
    if ! out=$(eval "$cmd" 2>&1); then
        local elapsed_ms=$(( ( $(date +%s%N) - start_time ) / 1000000 ))
        printf "%sFAIL%s %s(%dms)%s\n" \
            "$(color red)" "$(color reset)" "$(color yellow)" "$elapsed_ms" "$(color reset)"
        echo "$out" | tail -5 | sed 's/^/    /'
        return 1
    fi
    local elapsed_ms=$(( ( $(date +%s%N) - start_time ) / 1000000 ))
    pass=$(echo "$out" | grep -E "^Pass:" | head -1 | awk '{print $2}')
    fail=$(echo "$out" | grep -E "^Fail:" | head -1 | awk '{print $2}')
    skip=$(echo "$out" | grep -E "^Skip:" | head -1 | awk '{print $2}')
    if [[ "${fail:-1}" == "0" ]]; then
        printf "%spass=%s%s" "$(color green)" "$pass" "$(color reset)"
        total_pass=$((total_pass + ${pass:-0}))
    else
        printf "%spass=%s fail=%s%s" "$(color red)" "$pass" "$fail" "$(color reset)"
    fi
    if [[ -n "${skip:-}" && "$skip" != "0" ]]; then
        printf " %sskip=%s%s" "$(color yellow)" "$skip" "$(color reset)"
    fi
    printf " %s(%dms)%s\n" "$(color yellow)" "$elapsed_ms" "$(color reset)"
    [[ "${fail:-1}" == "0" ]]
}

echo
printf "%sweavepack cross-language conformance%s\n" "$(color bold)" "$(color reset)"
echo

any_fail=0

# ── JS reference (full corpus: JSON + tensor) ─────────────────────────
run_check "JS / verify-test-vectors" \
    "node weavepack/tools/verify-test-vectors.js" \
    || any_fail=1

# ── Rust JSON crate ───────────────────────────────────────────────────
if command -v cargo >/dev/null 2>&1; then
    run_check "Rust / weavepack-json" \
        "cd impl/rust && cargo run -p weavepack-json --bin conformance --quiet 2>/dev/null" \
        || any_fail=1
    run_check "Rust / weavepack-tensor" \
        "cd impl/rust && cargo run -p weavepack-tensor --bin conformance --quiet 2>/dev/null" \
        || any_fail=1
else
    printf "%s%-30s%s SKIP (cargo not found)\n" "$(color yellow)" "Rust crates" "$(color reset)"
fi

# ── Python PoC ────────────────────────────────────────────────────────
if command -v python3 >/dev/null 2>&1; then
    run_check "Python / weavepack-json" \
        "python3 impl/python/conformance.py" \
        || any_fail=1
    run_check "Python / weavepack-tensor" \
        "python3 impl/python/conformance_tensor.py" \
        || any_fail=1
    # Optional: PyO3 binding (requires `maturin develop` first).
    if python3 -c "import weavepack_tensor_rs" 2>/dev/null; then
        run_check "PyO3 / weavepack-tensor-rs" \
            "cd impl/rust/weavepack-tensor-py && python3 test_conformance.py" \
            || any_fail=1
    else
        printf "%s%-30s%s SKIP (run \`maturin develop\` in impl/rust/weavepack-tensor-py to enable)\n" \
            "$(color yellow)" "PyO3 / weavepack-tensor-rs" "$(color reset)"
    fi
else
    printf "%s%-30s%s SKIP (python3 not found)\n" "$(color yellow)" "Python PoC" "$(color reset)"
fi

echo
if [[ $any_fail -eq 0 ]]; then
    printf "%sAll implementations agree.%s\n" "$(color green)" "$(color reset)"
    if [[ -n "${total_pass:-}" ]]; then
        printf "%sTotal: %d vectors passing across all implementations.%s\n" \
            "$(color green)" "$total_pass" "$(color reset)"
    fi
    exit 0
else
    printf "%sAt least one implementation has failures.%s\n" "$(color red)" "$(color reset)"
    printf "Run each binary individually for details.\n"
    exit 1
fi
