/* Course UI — renders lessons from window.COURSE, runs queries via the
   same-origin /prom/ nginx proxy (no CORS issues). */
(function () {
  "use strict";
  const PROM = "/prom";           // nginx proxies to http://prometheus:9090
  const GRAFANA = "http://localhost:3000";
  const $ = (s, el) => (el || document).querySelector(s);
  const el = (t, c, html) => {
    const n = document.createElement(t);
    if (c) n.className = c;
    if (html != null) n.innerHTML = html;
    return n;
  };

  /* ---------- tiny markdown renderer (subset) ---------- */
  function esc(s) {
    return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  }
  function inline(s) {
    return esc(s)
      .replace(/`([^`]+)`/g, (_, c) => `<code>${c}</code>`)
      .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
      .replace(/\*([^*]+)\*/g, "<em>$1</em>")
      .replace(/\[([^\]]+)\]\((https?:\/\/[^)]+)\)/g,
        '<a href="$2" target="_blank" rel="noopener">$1</a>')
      .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1");  // relative links -> plain text
  }
  function splitCells(line) {
    // split on | but ignore pipes inside `inline code`
    const cells = [];
    let cur = "", inCode = false;
    for (const ch of line) {
      if (ch === "`") inCode = !inCode;
      if (ch === "|" && !inCode) { cells.push(cur); cur = ""; }
      else cur += ch;
    }
    cells.push(cur);
    const out = cells.map(c => c.trim());
    if (!out[0]) out.shift();          // leading pipe
    if (!out[out.length - 1]) out.pop(); // trailing pipe
    return out;
  }
  function md(src) {
    const lines = src.split("\n");
    const out = [];
    let i = 0, list = null, table = false, firstRow = false;
    const closeList = () => { if (list) { out.push(`</${list}>`); list = null; } };
    const closeTable = () => { if (table) { out.push("</table>"); table = false; firstRow = false; } };
    while (i < lines.length) {
      const L = lines[i];
      if (/^```/.test(L)) {                       // code fence
        closeList(); closeTable();
        const buf = []; i++;
        while (i < lines.length && !/^```/.test(lines[i])) buf.push(lines[i++]);
        i++;
        out.push(`<pre><code>${esc(buf.join("\n"))}</code></pre>`);
        continue;
      }
      if (/^\|.*\|/.test(L)) {                    // table
        closeList();
        const cells = splitCells(L);
        if (/^[-: |]+$/.test(L)) { i++; continue; }        // separator row
        if (!table) { table = true; firstRow = true; out.push("<table>"); }
        const tag = firstRow ? "th" : "td";
        firstRow = false;
        out.push("<tr>" + cells.map(c => `<${tag}>${inline(c)}</${tag}>`).join("") + "</tr>");
        i++; continue;
      }
      closeTable();
      let m;
      if (/^(---|\*\*\*)\s*$/.test(L)) { closeList(); out.push("<hr>"); }
      else if ((m = L.match(/^###\s+(.*)/))) { closeList(); out.push(`<h3>${inline(m[1])}</h3>`); }
      else if ((m = L.match(/^##\s+(.*)/))) { closeList(); out.push(`<h2>${inline(m[1])}</h2>`); }
      else if ((m = L.match(/^[-*]\s+(.*)/))) {
        if (list !== "ul") { closeList(); out.push("<ul>"); list = "ul"; }
        out.push(`<li>${inline(m[1])}</li>`);
      } else if ((m = L.match(/^\d+\.\s+(.*)/))) {
        if (list !== "ol") { closeList(); out.push("<ol>"); list = "ol"; }
        out.push(`<li>${inline(m[1])}</li>`);
      } else if (/^\s*$/.test(L)) { closeList(); }
      else { closeList(); out.push(`<p>${inline(L)}</p>`); }
      i++;
    }
    closeList(); closeTable();
    return out.join("\n");
  }

  /* ---------- Prometheus queries ---------- */
  function isRangeSelector(q) { return /\[[0-9]+[smhdwy](:\s*[0-9]+[smhdwy])?\]\s*$/.test(q); }

  async function queryInstant(q) {
    const r = await fetch(`${PROM}/api/v1/query?query=${encodeURIComponent(q)}`);
    const j = await r.json();
    if (j.status !== "success") throw new Error(j.error || `HTTP ${r.status}`);
    return j.data;
  }
  async function queryRange(q) {
    // strip the trailing [dur(:step)] selector, run as query_range
    const m = q.match(/^(.*)\[([0-9]+[smhdwy])(?::\s*([0-9]+[smhdwy]))?\]\s*$/);
    if (!m) throw new Error("cannot parse range selector");
    const [, expr, dur, stepRaw] = m;
    const durS = parseDur(dur);
    const step = stepRaw ? parseDur(stepRaw) : Math.max(1, Math.floor(durS / 60));
    const end = Math.floor(Date.now() / 1000);
    const start = end - durS;
    const url = `${PROM}/api/v1/query_range?query=${encodeURIComponent(expr)}&start=${start}&end=${end}&step=${step}`;
    const r = await fetch(url);
    const j = await r.json();
    if (j.status !== "success") throw new Error(j.error || `HTTP ${r.status}`);
    return j.data;
  }
  function parseDur(d) {
    const u = { s: 1, m: 60, h: 3600, d: 86400, w: 604800, y: 31536000 };
    const mm = d.match(/^(\d+)([smhdwy])$/);
    return mm ? +mm[1] * u[mm[2]] : 60;
  }
  async function runQuery(q) {
    const t0 = performance.now();
    const data = isRangeSelector(q) ? await queryRange(q) : await queryInstant(q);
    return { data, ms: Math.round(performance.now() - t0) };
  }

  function fmtResult(r) {
    const { resultType, result } = r.data;
    if (!result.length) return `✓ ok (${r.ms} ms) — 0 series (no data right now)`;
    const head = `✓ ok (${r.ms} ms) — ${result.length} serie(s) · ${resultType}`;
    const rows = result.slice(0, 12).map(s => {
      const labels = Object.entries(s.metric || {})
        .map(([k, v]) => `${k}="${v}"`).join(", ");
      if (s.value) return `  {${labels}}\n    = ${s.value[1]}`;
      const pts = (s.values || []).length;
      const last = pts ? s.values[pts - 1][1] : "?";
      return `  {${labels}}\n    ${pts} points, latest = ${last}`;
    });
    const more = result.length > 12 ? `\n  … +${result.length - 12} more` : "";
    return [head, ...rows].join("\n") + more;
  }

  function queryBlock(q) {
    const wrap = el("div", "query");
    const input = el("input");
    input.type = "text";
    input.value = q;
    input.spellcheck = false;
    const run = el("button", "btn primary", "▶ Run");
    const open = el("a", "btn", "Open in Explore");
    open.href = `${GRAFANA}/explore?schemaVersion=1&panes=${encodeURIComponent(JSON.stringify(
      { q: { datasource: "prometheus", queries: [{ expr: q, range: true }], range: { from: "now-1h", to: "now" } } }))}&orgId=1`;
    open.target = "_blank"; open.rel = "noopener";
    wrap.append(input, run, open);
    const out = el("div", "result");

    const go = async () => {
      out.className = "result show";
      out.textContent = "running…";
      run.disabled = true;
      try {
        const r = await runQuery(input.value.trim());
        out.classList.add("ok");
        out.textContent = fmtResult(r);
      } catch (e) {
        out.classList.add("err");
        out.textContent = `✗ ${e.message}\n(Is the lab up? The course UI proxies Prometheus — it should answer via /prom/.)`;
      } finally { run.disabled = false; }
    };
    run.addEventListener("click", go);
    input.addEventListener("keydown", e => { if (e.key === "Enter") go(); });
    return [wrap, out];
  }

  /* ---------- render ---------- */
  const C = window.COURSE || { intro: "", lessons: [] };
  const content = $("#content");
  const tocList = $("#toc-list");

  C.lessons.forEach(l => {
    const li = el("li");
    const a = el("a", null, `${l.n}. ${l.title}`);
    a.href = `#lesson-${l.n}`;
    a.dataset.lesson = l.n;
    li.append(a); tocList.append(li);
  });
  // Intro / landing entry above the lessons.
  {
    const li = el("li");
    const a = el("a", null, "⏱ Course intro");
    a.href = "#intro";
    a.dataset.lesson = "intro";
    li.prepend(a);
    tocList.prepend(li);
  }

  function renderIntro() {
    content.innerHTML = "";
    const art = el("article");
    // strip the duplicate top-level title; header already shows it
    const body = C.intro.replace(/^#\s+.*\n/, "");
    art.innerHTML = md(body);

    // Retarget the "docker compose" hint to this host's script-based start.
    art.querySelectorAll("pre code").forEach(pre => {
      if (/docker(-|\s)compose/.test(pre.textContent)) {
        pre.textContent = "cd lab\n./start.sh        # this host has no compose plugin\n# or: docker compose up -d";
      }
    });

    const nav = el("div", "lesson-nav");
    const start = el("button", "btn primary", "Start lesson 1 →");
    start.addEventListener("click", () => go(0));
    nav.append(el("span"), start);
    art.append(nav);
    content.append(art);
    document.querySelectorAll("#toc-list a").forEach(a =>
      a.classList.toggle("active", a.dataset.lesson === "intro"));
  }

  function render(idx) {
    const l = C.lessons[idx];
    if (!l) return;
    content.innerHTML = "";
    const art = el("article");
    art.innerHTML = `<h2>Lesson ${l.n} — ${esc(l.title)}</h2>` + md(l.body);

    // Replace each rendered <pre> whose content ends with an extracted query
    // by a live runner block.
    const pres = [...art.querySelectorAll("pre")];
    const used = new Set();
    l.queries.forEach(q => {
      const pre = pres.find(p => !used.has(p) && p.textContent.trim().endsWith(q));
      if (pre) {
        used.add(pre);
        const [w, o] = queryBlock(q);
        pre.replaceWith(w, o);
      }
    });
    const leftover = l.queries.filter(q => ![...used].some(p => p.textContent.trim().endsWith(q)));
    if (leftover.length) {
      art.append(el("h3", null, "Try it live"));
      leftover.forEach(q => queryBlock(q).forEach(n => art.append(n)));
    }

    const nav = el("div", "lesson-nav");
    const prev = el("button", "btn", idx === 0 ? "← Course intro" : "← Previous");
    const next = el("button", "btn primary",
      idx < C.lessons.length - 1 ? "Next lesson →" : "Back to start ↺");
    prev.addEventListener("click", () => {
      if (idx === 0) location.hash = "intro";
      else go(idx - 1);
    });
    next.addEventListener("click", () => {
      if (idx < C.lessons.length - 1) go(idx + 1);
      else location.hash = "intro";
    });
    nav.append(prev, next);
    art.append(nav);
    content.append(art);

    document.querySelectorAll("#toc-list a").forEach(a =>
      a.classList.toggle("active", +a.dataset.lesson === l.n));
    window.scrollTo(0, 0);
  }

  function go(idx) {
    const l = C.lessons[idx];
    if (l) location.hash = `lesson-${l.n}`;
  }
  function fromHash() {
    if (/^#?intro$/.test(location.hash.slice(1)) || !location.hash) {
      renderIntro();
      return;
    }
    const m = location.hash.match(/lesson-(\d+)/);
    const idx = m ? C.lessons.findIndex(l => l.n === +m[1]) : -1;
    if (idx < 0) { renderIntro(); return; }
    render(idx);
  }
  window.addEventListener("hashchange", fromHash);
  if (!C.lessons.length) {
    content.innerHTML = "<p>Course content failed to load — regenerate with <code>python3 gen_content.py</code>.</p>";
  } else {
    fromHash();
  }

  /* ---------- stack status ---------- */
  async function ping() {
    const prom = $("#pill-prom"), graf = $("#pill-graf");
    try {
      const r = await fetch(`${PROM}/api/v1/status/runtimeinfo`);
      if (!r.ok) throw 0;
      prom.textContent = "Prometheus ● up"; prom.className = "pill up";
    } catch { prom.textContent = "Prometheus ● down"; prom.className = "pill down"; }
    try {
      const r = await fetch("/grafana-health");
      if (!r.ok) throw 0;
      graf.textContent = "Grafana ● up"; graf.className = "pill up";
    } catch { graf.textContent = "Grafana ● down"; graf.className = "pill down"; }
  }
  ping(); setInterval(ping, 15000);
})();
