#!/usr/bin/env bash
# Failure drill on an isolated stack (project "ctrl-perf"); the demo database is not touched.
#   scripts/chaos.sh [replicas] [rate] [seconds]
# Under constant load: the SMS gateway is down from 20% to 50% of the run, one app replica is killed (SIGKILL) at 33%
# and started again at 66%. Exits non-zero if an accepted event was lost or delivered twice. Output: results/chaos.txt
set -euo pipefail
cd "$(dirname "$0")/.."

REPLICAS=${1:-3}
RATE=${2:-100}
DURATION=${3:-30}
if docker compose version >/dev/null 2>&1; then DC=(docker compose); else DC=(docker-compose); fi
DC+=(-p ctrl-perf -f docker-compose.yml -f deploy/docker-compose.perf.yml)

mkdir -p results
trap '"${DC[@]}" down -v --remove-orphans >/dev/null 2>&1 || true' EXIT
APP_REPLICAS=$REPLICAS "${DC[@]}" up --build -d --wait >/dev/null 2>&1
sleep 7 # nginx re-resolves replicas every 5 s

(
  set -o pipefail
  docker run --rm --network ctrl-perf_default -v "$PWD/scripts:/s:ro" \
    -e BASE_URL=http://lb -e GATEWAY_URL=http://mock-gateway oven/bun:1.3 \
    bun /s/chaos.ts --rate "$RATE" --duration "$DURATION" 2>&1 | tee results/chaos.txt
) &
drill=$!

sleep $((DURATION / 3))
echo "t+$((DURATION / 3))s  killing replica ctrl-perf-app-2" | tee -a results/chaos.txt
docker kill ctrl-perf-app-2 >/dev/null
sleep $((DURATION / 3))
echo "t+$((2 * DURATION / 3))s  starting replica ctrl-perf-app-2" | tee -a results/chaos.txt
docker start ctrl-perf-app-2 >/dev/null
wait "$drill"
