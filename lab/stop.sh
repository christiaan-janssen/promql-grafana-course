#!/usr/bin/env bash
# Stop the PromQL/Grafana lab + course web UI.
set -euo pipefail
docker rm -f promql-lab-prometheus promql-lab-node-exporter \
             promql-lab-grafana promql-lab-web >/dev/null 2>&1 || true
docker network rm promql-lab >/dev/null 2>&1 || true
echo "lab stopped"
