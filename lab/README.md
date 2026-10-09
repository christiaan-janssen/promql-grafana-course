# PromQL/Grafana Course Lab

Three containers: **Prometheus** (metrics DB), **node_exporter** (host metrics), **Grafana** (visualization, pre-provisioned).

## Start

```bash
cd lab
docker compose up -d        # Docker Compose plugin
# or, if you only have the standalone binary:
docker-compose up -d
```

First start pulls three images (~500 MB total).

## URLs and credentials

| Service    | URL                       | Login         |
|------------|---------------------------|---------------|
| Grafana    | http://localhost:3000     | admin / admin |
| Prometheus | http://localhost:9090     | —             |
| Metrics    | http://localhost:9100/metrics | —         |

What's pre-wired:

- **Data source:** Grafana → Prometheus at `http://prometheus:9090` (see `grafana/provisioning/datasources/prometheus.yml`).
- **Dashboard:** "Lab / Node Overview" (CPU %, memory %, filesystem table, network graph) under Dashboards (see `grafana/dashboards/node-overview.json`).
- **Rules:** one recording rule and one alert (`NodeHighCPU`) loaded from `prometheus/rules.yml`; watch them at http://localhost:9090/rules and http://localhost:9090/alerts.

## Course web UI

An interactive course UI is part of the lab — a static nginx app that renders
the lessons and can **run queries live against the lab's Prometheus**.

- **URL:** http://localhost:8080
- **Ports:** course UI :8080, Grafana :3000, Prometheus :9090, node_exporter :9100
- It comes up with `docker compose up -d` (service `course-web`) or `./start.sh`.

No compose plugin? Use the bundled scripts:

```bash
./start.sh    # builds the web image if needed, starts all 4 containers
./stop.sh     # tears everything down
```

Regenerate the lesson content after editing the course README:

```bash
cd ../web && python3 gen_content.py && docker build -t promql-course-web:latest . && ./../lab/start.sh
```

## Queries to try first

In Prometheus (http://localhost:9090/graph) or Grafana Explore:

```promql
# 1. Per-mode CPU usage rate (the "hello world" of PromQL)
rate(node_cpu_seconds_total[5m])

# 2. Memory used, as a percentage
100 * (1 - node_memory_MemAvailable_bytes / node_memory_MemTotal_bytes)

# 3. Filesystems with less than 5 GiB free
node_filesystem_avail_bytes < 5 * 1024^3

# 4. Top 3 network devices by receive rate (bits/s)
topk(3, rate(node_network_receive_bytes_total[5m]) * 8)

# 5. The recording rule from prometheus/rules.yml
instance:node_cpu_seconds_total:rate5m
```

## Useful commands

```bash
docker compose logs -f prometheus      # watch scrape/rule evaluation logs
docker compose restart prometheus      # after editing prometheus.yml or rules.yml
curl -X POST http://localhost:9090/-/reload   # or hot-reload config without restart
docker compose down                    # stop everything
docker compose down -v                 # also delete stored data
```

## Generating load

To see CPU graphs move (and maybe trigger the `NodeHighCPU` alert, which needs the busiest core >90% for 2 minutes):

```bash
yes > /dev/null        # Ctrl-C to stop
```

## Layout

```
lab/
├── docker-compose.yml
├── prometheus/
│   ├── prometheus.yml    # scrape config (15s interval) + rule_files
│   └── rules.yml         # recording rule + NodeHighCPU alert
└── grafana/
    ├── provisioning/
    │   ├── datasources/prometheus.yml
    │   └── dashboards/dashboards.yml
    └── dashboards/
        └── node-overview.json
```
