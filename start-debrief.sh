#!/usr/bin/env bash
set -euo pipefail
# Dev default: ~/engine_analysis (120+ real FlyTab CSVs)
# Production: set FLIGHTS_DIR=~/flights or rely on systemd Environment=
export FLIGHTS_DIR="${FLIGHTS_DIR:-$HOME/engine_analysis}"
export DEBRIEF_PORT="${DEBRIEF_PORT:-8092}"
cd "$(dirname "$0")"
python3 server/debrief-server.py
