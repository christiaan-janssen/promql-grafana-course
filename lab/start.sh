#!/usr/bin/env bash
# Start the PromQL/Grafana lab + course web UI without docker compose.
# Usage: ./start.sh   (from the lab/ directory)
set -euo pipefail
cd "$(dirname "$0")"

NET=promql-lab
docker network create "$NET" 2>/dev/null || true

# Build the course web image if missing or stale.
if ! docker image inspect promql-course-web:latest >/dev/null 2>&1; then
  (cd ../web && docker build -t promql-course-web:latest .)
fi

run() { # name image network-alias ports...
  local name=$1; shift
  docker rm -f "$name" >/dev/null 2>&1 || true
  docker run -d --name "$name" --network "$NET" "$@" >/dev/null
  echo "started $name"
}

run promql-lab-prometheus --network-alias prometheus \
  -p 9090:9090 \
  -v "$PWD/prometheus/prometheus.yml:/etc/prometheus/prometheus.yml:ro" \
  -v "$PWD/prometheus/rules.yml:/etc/prometheus/rules.yml:ro" \
  prom/prometheus:latest \
  --config.file=/etc/prometheus/prometheus.yml \
  --storage.tsdb.retention.time=7d \
  --web.enable-lifecycle

run promql-lab-node-exporter --network-alias node_exporter \
  -p 9100:9100 --pid host \
  -v /:/host:ro,rslave \
  prom/node-exporter:latest --path.rootfs=/host

run promql-lab-grafana --network-alias grafana \
  -p 3000:3000 \
  -e GF_SECURITY_ADMIN_USER=admin \
  -e GF_SECURITY_ADMIN_PASSWORD=admin \
  -e GF_USERS_ALLOW_SIGN_UP=false \
  -v "$PWD/grafana/provisioning:/etc/grafana/provisioning:ro" \
  -v "$PWD/grafana/dashboards:/var/lib/grafana/dashboards:ro" \
  grafana/grafana:latest

run promql-lab-web --network-alias course-web \
  -p 8080:80 \
  promql-course-web:latest

cat <<MSG

Lab is up:
  Course UI   http://localhost:8080
  Grafana     http://localhost:3000   (admin / admin)
  Prometheus  http://localhost:9090
MSG
