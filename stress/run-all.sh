#!/usr/bin/env bash
# Runs every stress pass in order on the box: smoke, scenario suite, soak + chaos, fuzz. Each writes its own results
# directory under ~/stress-results/. Run it in tmux so it survives the SSH session:
#   tmux new -d -s stress 'bash ~/browse/stress/run-all.sh 60 15 2>&1 | tee ~/stress-results/run-all.log'
set -uo pipefail
SOAK_MINUTES="${1:-60}"
FUZZ_MINUTES="${2:-15}"
cd "$(dirname "$0")/.."
export PATH="/usr/local/bin:$HOME/.bun/bin:$PATH"
mkdir -p "$HOME/stress-results"
echo "== smoke";     node stress/smoke.ts;         echo "smoke exit $?"
echo "== scenarios"; node stress/run-scenarios.ts; echo "scenarios exit $?"
echo "== soak";      node stress/soak.ts --minutes "$SOAK_MINUTES"; echo "soak exit $?"
echo "== fuzz";      node stress/fuzz.ts --minutes "$FUZZ_MINUTES"; echo "fuzz exit $?"
echo "== done"
