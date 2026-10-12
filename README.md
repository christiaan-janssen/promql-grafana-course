# PromQL with Grafana — A Practical Introduction

A hands-on course for technical people (Linux, Docker, basic observability) who are new to PromQL.

**Time:** ~45–60 minutes total
**Prerequisites:** Docker and Docker Compose; a shell; no Prometheus experience needed.
**Lab:** All examples run against the bundled lab in [`lab/`](./lab/). Start it first:

```bash
cd lab
docker compose up -d   # or: docker-compose up -d
```

Course: http://localhost:8080/
Grafana: http://localhost:3000 (admin / admin) — Prometheus: http://localhost:9090

**How to use this course:** read each lesson, run the example queries yourself in the (web ui)[http://localhost:8080/] or in Prometheus at http://localhost:9090/graph or Grafana Explore, then do the exercise. Queries return live data from the lab's `node_exporter`.

---

## Lesson 1 — The Prometheus data model and selecting series (~8 min)

### Concept

Prometheus stores **time series**: streams of `(timestamp, value)` samples. Every series is identified by a **metric name** plus a set of **labels** (key=value pairs):

```
node_cpu_seconds_total{cpu="0", instance="node_exporter:9100", job="node", mode="idle"}
└────── metric name ─────┘ └────────────────── labels ──────────────────────┘
```

Same metric name + different label values = different series. Labels are how you slice and aggregate data, so learn to read them.

The lab's `node_exporter` exposes host metrics like:

- `node_cpu_seconds_total` — CPU time per `cpu` and `mode` (counter)
- `node_memory_MemTotal_bytes`, `node_memory_MemAvailable_bytes` (gauges)
- `node_network_receive_bytes_total`, `node_network_transmit_bytes_total` per `device` (counters)
- `node_filesystem_avail_bytes`, `node_filesystem_size_bytes` per `mountpoint`, `fstype` (gauges)

### Selecting series

A bare metric name selects all its series:

```promql
node_cpu_seconds_total
```

Narrow down with **label matchers** inside `{}`:

| Matcher | Meaning    | Example                                        |
|---------|------------|------------------------------------------------|
| `=`     | equals     | `node_cpu_seconds_total{mode="idle"}`           |
| `!=`    | not equals | `node_cpu_seconds_total{mode!="idle"}`          |
| `=~`    | regex match| `node_network_receive_bytes_total{device=~"e.*"}` |
| `!~`    | regex no-match | `node_network_receive_bytes_total{device!~"lo\|veth.*"}` |

Notes:

- Regex matchers are **fully anchored** (`e.*` matches `eth0`; `th` does not).
- Matchers can be combined: `{job="node", mode!="idle"}`.
- You can also select by labels alone: `{job="node"}` returns every series with that job label.

### Exercise 1

1. Select all memory-related series for the lab node (hint: they all belong to `job="node"` and the names start with `node_memory_`; use a metric name directly, e.g. `node_memory_MemAvailable_bytes`).
2. Select filesystem series but exclude `tmpfs` and `overlay` filesystem types using `!~` on `fstype`.
3. How many distinct `mode` values does `node_cpu_seconds_total` have? (Look at the label values in the result table.)

---

## Lesson 2 — Instant vectors vs range vectors (~6 min)

### Concept

PromQL has two vector types you'll use constantly:

- **Instant vector** — one sample per series, at a single point in time. This is what a plain selector returns: `node_memory_MemAvailable_bytes`.
- **Range vector** — a window of samples per series, written with a **range selector** in square brackets: `node_memory_MemAvailable_bytes[5m]` (all samples from the last 5 minutes).

Range vectors are not directly plottable; they exist to feed functions like `rate()` that need multiple samples.

Durations: `s`, `m`, `h`, `d`, `w`, `y`. Examples: `[30s]`, `[5m]`, `[1h]`.

A **subquery** lets you run an instant-vector expression over time with a step: `<expr>[1h:5m]` = evaluate `<expr>` every 5 minutes for the last hour, returned as a range vector.

```promql
# Instant vector: current value
node_memory_MemAvailable_bytes

# Range vector: raw samples from the last 5 minutes (try the Table view)
node_memory_MemAvailable_bytes[5m]

# Subquery: memory sampled every minute over the last 15 minutes
node_memory_MemAvailable_bytes[15m:1m]
```

In Prometheus's graph UI, a "range query" (graph over time) is built by evaluating an **instant vector expression at many timestamps** — you rarely write range selectors except inside functions.

### Exercise 2

1. In http://localhost:9090/graph, query `node_memory_MemAvailable_bytes` and switch between the **Table** (instant) and **Graph** (range over time) tabs. What changes?
2. Query `node_memory_MemAvailable_bytes[10m]` in the Table tab. How does the result differ from the instant query?
3. What happens if you try to graph a raw range selector? Why?

---

## Lesson 3 — Counters: rate(), increase(), irate() (~8 min)

### Concept

Many metrics (CPU seconds, bytes received, requests served) are **counters**: they only go up (and reset to 0 on restart). The raw value is useless; you want the **per-second rate of change**.

```promql
# Per-second rate of CPU time spent in each mode, averaged over 5 minutes
rate(node_cpu_seconds_total[5m])

# Total bytes received over the last 15 minutes (absolute increase)
increase(node_network_receive_bytes_total[15m])

# Instantaneous rate: uses only the last two samples (spiky, responsive)
irate(node_cpu_seconds_total[5m])
```

- **`rate(v[d])`** — per-second average increase over the window. Smooth, extrapolation-aware, counter-reset-aware. **Default choice for graphs and alerts.**
- **`increase(v[d])`** — same math, but returns the total increase over the window instead of per-second. Handy for "how many requests in the last hour".
- **`irate(v[d])`** — per-second rate from the last two samples only. Use for fast-moving things where you want responsiveness over smoothness (e.g. watching a spike live).

**Rules of thumb:**

- Only use these on counters. On gauges they produce garbage.
- The window must be at least ~2× the scrape interval, usually ≥ 4× (lab scrapes every 15s → use `[1m]` minimum, `[5m]` for smooth graphs).
- Multiply network rates by 8 to get bits: `rate(node_network_receive_bytes_total[5m]) * 8`.

### Exercise 3

1. Graph `rate(node_cpu_seconds_total[5m])`. Which `mode` dominates while the machine is idle?
2. Query `increase(node_network_receive_bytes_total[5m])` and `rate(node_network_receive_bytes_total[5m])`. How are the two results related mathematically? (Verify: one ≈ the other × 300.)
3. Compare `rate(...)` vs `irate(...)` on `node_cpu_seconds_total` while you run `yes > /dev/null` for a few seconds in another shell. Which reacts faster? Which is smoother?

---

## Lesson 4 — Aggregation and operators: sum, avg, by/without, topk, sort_desc, arithmetic (~8 min)

### Concept

Raw selectors return many series; **aggregation operators** collapse them.

```promql
# Total CPU rate across all cores, still split by mode
sum(rate(node_cpu_seconds_total[5m])) by (mode)

# Same thing — "without" drops the listed labels instead of keeping only them
sum(rate(node_cpu_seconds_total[5m])) without (cpu, instance, job)
```

- **`by (labels)`** — group by the listed labels; all other labels are dropped.
- **`without (labels)`** — drop the listed labels; group by everything else.

Common aggregators: `sum`, `avg`, `min`, `max`, `count`, `count_values`, `stddev`, `topk(k, v)`, `bottomk(k, v)`, `quantile(φ, v)`.

```promql
# Top 3 mountpoints by free space
topk(3, node_filesystem_avail_bytes)

# Network interfaces sorted by receive rate, fastest first
sort_desc(rate(node_network_receive_bytes_total[5m]))
```

### Arithmetic and filtering operators

Vectors support `+ - * / % ^`, comparisons (`>`, `<`, `>=`, `<=`, `==`, `!=`) and set operators (`and`, `or`, `unless`). Comparing a vector to a scalar **filters** it:

```promql
# Filesystems with less than 5 GiB free
node_filesystem_avail_bytes < 5 * 1024^3

# CPU busy percentage per instance: 100 - idle%
100 - (avg by (instance) (rate(node_cpu_seconds_total{mode="idle"}[5m])) * 100)

# Memory used %
100 * (1 - node_memory_MemAvailable_bytes / node_memory_MemTotal_bytes)
```

### Vector matching (joins)

Binary operations between two vectors match series by labels. Default: match on **all** labels (one-to-one). Use `on(...)`/`ignoring(...)` to control which labels are used:

```promql
# Filesystem fill ratio: labels (instance, mountpoint, fstype, device) match on both sides
node_filesystem_avail_bytes / node_filesystem_size_bytes

# Same, explicitly
node_filesystem_avail_bytes / on(instance, mountpoint, fstype, device) node_filesystem_size_bytes
```

Many-to-one joins use `group_left` (or `group_right`) to enrich a vector with labels from an "info" metric — for example attaching the hostname from `node_uname_info` to other metrics. You'll know you need one when a match fails with "found duplicate series" or "multiple matches".

### Exercise 4

1. Write a query for total CPU usage % across all cores (all non-idle modes) as a single number per instance. (Hint: `sum ... by (instance)` over `mode!="idle"`, or 100 − idle%.)
2. Which single mountpoint has the least free space? Solve it with `bottomk(1, ...)`.
3. `count(node_cpu_seconds_total) by (mode)` — what does the result tell you?

---

## Lesson 5 — Histograms and histogram_quantile() (~7 min)

### Concept

A Prometheus **histogram** samples observations (e.g. request durations) into cumulative **buckets**, exposed as a set of series with a `le` ("less than or equal") label:

```
prometheus_http_request_duration_seconds_bucket{handler="/api/v1/query", le="0.1"}   42
prometheus_http_request_duration_seconds_bucket{handler="/api/v1/query", le="0.3"}   55
prometheus_http_request_duration_seconds_bucket{handler="/api/v1/query", le="+Inf"}  60
```

Plus `_sum` (total of observed values) and `_count` (number of observations).

To compute a **quantile** (p90, p99…) over a time window:

```promql
# 90th percentile of HTTP request latency, all handlers combined
histogram_quantile(0.9, sum by (le) (rate(prometheus_http_request_duration_seconds_bucket[5m])))

# 99th percentile per handler
histogram_quantile(0.99, sum by (le, handler) (rate(prometheus_http_request_duration_seconds_bucket[5m])))
```

Key points:

- **Always `rate()` the buckets first**, then aggregate `sum by (le, ...)` — and `le` must survive the aggregation, or `histogram_quantile` returns garbage/NaN.
- Quantiles are estimated by linear interpolation within a bucket; accuracy depends on your bucket layout.
- Average latency without quantiles: `rate(..._sum[5m]) / rate(..._count[5m])`.

(The sibling **summary** type precomputes quantiles client-side via a `quantile` label; you can't aggregate those across instances — that's why histograms are usually preferred.)

### Exercise 5

1. Run the p90 query above. What's the current p90 for Prometheus's own API?
2. Compute the average request duration per handler using `_sum` / `_count`.
3. Deliberately break the query: drop `le` from the `by` clause. What does the result look like, and why is it wrong?

---

## Lesson 6 — Grafana: data source, Explore, dashboards, panel types (~10 min)

### Concept

Prometheus evaluates queries; **Grafana** is where you explore and visualize them. The lab has already provisioned a Prometheus data source (`http://prometheus:9090`) and a starter dashboard, so this lesson is about using the UI.

### Adding a Prometheus data source (how the lab does it)

Manually: **Connections → Data sources → Add data source → Prometheus**, set URL to `http://prometheus:9090` (inside Docker; `http://localhost:9090` from your browser is only for "Browser" access mode), leave **Server** access, Save & test.

Provisioned (the lab way — see `lab/grafana/provisioning/datasources/prometheus.yml`):

```yaml
datasources:
  - name: Prometheus
    type: prometheus
    access: proxy
    url: http://prometheus:9090
    isDefault: true
```

### Explore — your PromQL scratchpad

**Drill-down / compass icon → Explore**, pick the Prometheus data source:

- **Metrics browser** lets you click through metric names and labels — great when you don't know what's available.
- Type a query, press **Run query** (Shift+Enter). Toggle between **Time series** graph and **Table**.
- `$__rate_interval` — Grafana macro that expands to a sensible rate window for the current zoom. Prefer `rate(metric[$__rate_interval])` in dashboards over a hardcoded `[5m]`.
- **Explain** / builder mode shows what each function does.

### Building dashboard panels

**Dashboards → New → New dashboard → Add visualization**, pick the data source, write PromQL in the query editor. Useful options: **Legend** (`{{device}}` to label series by label values), **Unit** (bytes, percent, s/s…), **Min/Max** for percentages.

### Panel types and when to use them

| Panel      | Use for                              | Example query |
|------------|--------------------------------------|---------------|
| Time series| Anything over time (the default)     | `100 - (avg by (instance)(rate(node_cpu_seconds_total{mode="idle"}[$__rate_interval])) * 100)` |
| Stat       | Single big number, optionally sparkline | `100 * (1 - node_memory_MemAvailable_bytes / node_memory_MemTotal_bytes)` |
| Gauge      | Value with min/max context (percentages) | filesystem fill % |
| Table      | Per-label breakdown, exact values    | `node_filesystem_avail_bytes` with **Format: Table, Type: Instant** |
| Heatmap    | Distribution of histogram buckets over time | `sum by (le)(increase(prometheus_http_request_duration_seconds_bucket[$__rate_interval]))` with **Format: Heatmap** |
| Bar gauge  | Compact ranked values                | `topk(5, node_filesystem_avail_bytes)` |

Tips: set **Instant** queries for stat/gauge/table panels that show "right now"; use **Format: Table** to get one row per series; use `{{label}}` in legend formats.

### Exercise 6

1. Open the provisioned "Lab / Node Overview" dashboard. Identify which panel type each panel uses and why it fits.
2. Build a new dashboard with: a time series of CPU busy %, a stat of memory used %, and a table of filesystem free space. Save it.
3. Change the CPU panel's query from `rate(...[5m])` to `rate(...[$__rate_interval])` and zoom in/out. What changes?

---

## Lesson 7 — Recording rules, alerting rules, and common pitfalls (~8 min)

### Recording rules

Precompute expensive queries into new metrics. Evaluated on a schedule, stored like any other series. The lab loads `lab/prometheus/rules.yml`:

```yaml
groups:
  - name: node
    interval: 30s
    rules:
      # Recording rule: per-instance total CPU rate, precomputed
      - record: instance:node_cpu_seconds_total:rate5m
        expr: sum by (instance) (rate(node_cpu_seconds_total[5m]))
```

Then dashboards/alerts can use the cheap `instance:node_cpu_seconds_total:rate5m` instead of re-aggregating raw series. Naming convention: `level:metric:operations`.

### Alerting rules

Same file, same group mechanics; an alert fires when `expr` is true for longer than `for`:

```yaml
      # Alerting rule: warn when the busiest core stays hot
      - alert: NodeHighCPU
        expr: max by (instance) (100 - rate(node_cpu_seconds_total{mode="idle"}[5m]) * 100) > 90
        for: 2m
        labels:
          severity: warning
        annotations:
          summary: "High CPU on {{ $labels.instance }}"
```

States: **inactive → pending → firing**. Prometheus evaluates and shows alerts at http://localhost:9090/alerts; routing/notifications (email, Slack, PagerDuty) are **Alertmanager**'s job — out of scope here.

### Common pitfalls

1. **Counters vs gauges.** `rate()` on a gauge (e.g. memory) is meaningless. If you need change-over-time on a gauge, use `deriv()` or `delta()` — but usually you want the gauge itself.
2. **Rate window too small.** `[15s]` with a 15s scrape interval often yields 1 sample → empty or spiky results. Rule of thumb: window ≥ 4× scrape interval. In Grafana, prefer `$__rate_interval`.
3. **Label cardinality.** Every unique label-set is a new series. Never put unbounded values (user IDs, request IDs, timestamps) into labels — this is the classic way to blow up a Prometheus. Check with `count by (__name__)({__name__=~".+"})` if you want to see how many series each metric has.
4. **Staleness.** If a target disappears or a series stops being exposed, Prometheus keeps it "fresh" for ~5 minutes, then it vanishes. Graphs can show stale flat lines in that window; instant queries may still return data up to 5 min after a crash.
5. **Wrong order of operations.** `sum(rate(x[5m]))` works; `rate(sum(x)[5m])` is a syntax error (`rate` needs a range vector) — and aggregating first would lose the labels anyway. For histograms: `rate` each bucket, `sum by (le)`, *then* `histogram_quantile`. The general rule: never aggregate away a label (like `le`) that a later function still needs.
6. **Regex matchers are anchored.** `{device=~"eth"}` matches nothing; use `eth.*`.
7. **Gauges that should be counters (and vice versa).** If your "rate" graph is a sawtooth that drops to zero periodically, you may be looking at a counter reset — `rate()` handles resets, but only if it sees ≥2 samples per window.

### Exercise 7

1. Generate load so the graphs move: run `yes > /dev/null` on the host for a few minutes (Ctrl-C to stop). Watch http://localhost:9090/alerts — the `NodeHighCPU` alert (busiest core >90% busy) should go **pending**, and after ~2 minutes of sustained load, **firing**.
2. Modify the lab's `rules.yml` to add a recording rule `instance:node_network_receive_bytes:rate5m` and restart Prometheus (`docker compose restart prometheus`). Query your new metric.
3. Intentionally cause a staleness event: `docker compose stop node_exporter`, then query `up{job="node"}` every minute. When does the metric disappear vs. when does `up` change?

---

## Further reading

- **PromQL Cheat Sheet (PromLabs):** https://promlabs.com/promql-cheat-sheet/ — the best one-page reference for query patterns.
- **Official PromQL docs:** https://prometheus.io/docs/prometheus/latest/querying/basics/ (and `/functions/`, `/operators/`)
- **Official Grafana docs:** https://grafana.com/docs/grafana/latest/ (data sources, panels, provisioning)
- **Interactive practice (no install):** Killercoda Prometheus scenarios — https://killercoda.com/promlabs — and PromLabs' PromQL training labs. (Check reachability from your network; both are free.)
- **Robust Perception blog:** https://www.robustperception.io/blog/ — deep dives on cardinality, rates, and edge cases.
