#!/usr/bin/env bash
# Measures msg/s and p50/p99 per replica count on an isolated stack (project "ctrl-perf"); the demo database is not touched.
#   scripts/scale-curve.sh [replicas] [rates] [seconds] [tag]
#   scripts/scale-curve.sh "1 2 4" "250 500 1000 2000" 15 baseline
# A rate counts as sustained with no HTTP errors, every event stored, >=95% of target achieved, HTTP p99 < 1 s and an empty queue.
# CHANNELS=ui (default) measures CTRL itself; CHANNELS=ui,email adds the local MailHog sink, which then competes for CPU.
# Each replica count gets a warm-up run first, because a cold instance is slower. Higher rates are skipped for a replica count once one is not sustained. Output: results/curve-<tag>.tsv
set -euo pipefail
cd "$(dirname "$0")/.."

REPLICAS=${1:-"1 2 4"}
RATES=${2:-"250 500 1000 2000"}
SECONDS_PER_RATE=${3:-15}
TAG=${4:-run}
CHANNELS=${CHANNELS:-ui}
if docker compose version >/dev/null 2>&1; then DC=(docker compose); else DC=(docker-compose); fi
DC+=(-p ctrl-perf -f docker-compose.yml -f deploy/docker-compose.perf.yml)
OUT="results/curve-$TAG.tsv"

mkdir -p results
printf 'replicas\ttarget\tachieved\terrors\tnot_stored\thttp_p50\thttp_p99\te2e_p50\te2e_p99\tpending\tsustained\tcpu_mid_run\n' > "$OUT"
trap '"${DC[@]}" down -v --remove-orphans >/dev/null 2>&1 || true' EXIT

cpu_sample() {
  docker stats --no-stream --format '{{.Name}} {{.CPUPerc}}' | awk '
    /^ctrl-perf-postgres/ { pg += $2 } /^ctrl-perf-app/ { app += $2 } /^ctrl-perf-lb/ { lb += $2 }
    END { printf "pg=%d%% app=%d%% lb=%d%%", pg, app, lb }'
}

for n in $REPLICAS; do
  APP_REPLICAS=$n "${DC[@]}" up --build -d --wait --remove-orphans >/dev/null 2>&1
  sleep 7 # nginx re-resolves replicas every 5 s
  load() { docker run --rm --network ctrl-perf_default -v "$PWD/scripts:/s:ro" -v "$PWD/results:/w/results" -w /w \
    -e BASE_URL=http://lb oven/bun:1.3 bun /s/loadtest.ts --channels "$CHANNELS" --row results/.row "$@" >/dev/null; }
  load --rate 300 --duration 8
  for rate in $RATES; do
    "${DC[@]}" exec -T postgres psql -q -U postgres -d ctrl -c 'truncate events, alerts, deliveries, audit_log' >/dev/null
    (sleep $((SECONDS_PER_RATE / 2 + 1)); cpu_sample > results/.cpu) &
    sampler=$!
    load --rate "$rate" --duration "$SECONDS_PER_RATE"
    wait "$sampler"
    row=$(cat results/.row)
    ok=$(awk -F'\t' '{ print ($3 == 0 && $4 == 0 && $2 >= 0.95 * $1 && $6 < 1000 && $9 == 0) ? "yes" : "no" }' <<<"$row")
    printf '%s\t%s\t%s\t%s\n' "$n" "$row" "$ok" "$(cat results/.cpu)" | tee -a "$OUT"
    [ "$ok" = yes ] || break
  done
done
rm -f results/.row results/.cpu
