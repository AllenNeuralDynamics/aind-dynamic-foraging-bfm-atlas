/* Launch timeline and job list, report history, and
 * click-a-number. Registers into app.js through window.Atlas once the catalog is loaded.
 */
"use strict";

document.addEventListener("atlas:ready", () => {
  const { S, VIEWS, esc, chip, srcLink, short, openDrawer, statusChip } = window.Atlas;
  const main = () => document.getElementById("main");
  const studyLabel = (id) => id.replace(/^(\d{2})-/, "$1 ");

  // ------------------------------------------------------------ launch timeline
  VIEWS.timeline = () => {
    const rows = S.cat.studies.map((s) => ({
      s, pts: [...s.variants.flatMap((v) => v.launch_records), ...(s.root_launch_records || [])]
        .filter((r) => r.format === "json")
        .map((r) => ({ r, t: Date.parse(r.time) })).filter((p) => !isNaN(p.t)),
    }));
    const all = rows.flatMap((x) => x.pts.map((p) => p.t));
    const t0 = all.length ? Math.min(...all) : 0, t1 = all.length ? Math.max(...all) : 0;
    const L = 250, R = 20, W = 1000, RH = 28, H = rows.length * RH + 40;
    const x = (t) => L + ((t - t0) / Math.max(1, t1 - t0)) * (W - L - R);
    const ticks = [];
    // month ticks built in UTC, matching their toISOString() labels in any browser time zone
    const s0 = new Date(t0);
    for (let y = s0.getUTCFullYear(), m = s0.getUTCMonth(); Date.UTC(y, m, 1) <= t1; m++) {
      if (m === 12) { m = 0; y++; }
      if (Date.UTC(y, m, 1) >= t0) ticks.push(Date.UTC(y, m, 1));
    }
    const undated = rows.reduce((n, x) => n + [...x.s.variants.flatMap((v) => v.launch_records), ...(x.s.root_launch_records || [])]
      .filter((r) => r.format === "json" && isNaN(Date.parse(r.time))).length, 0);
    main().innerHTML = `<h1>Launch timeline</h1>
      <p class="muted">Every launch record with a time, by study; every launch is listed in the table below. <span style="color:var(--accent)">●</span> initial launch,
        <span style="color:var(--warn)">●</span> intervention (resubmit, rescue, probe, tier change, backfill, extend).
        ${undated ? `${undated} records carry no time and are not shown.` : ""}</p>
      ${!all.length ? `<div class="empty">No launch record carries a time.</div>` : `<div class="table-wrap"><svg viewBox="0 0 ${W} ${H}" width="100%" style="min-width:720px" role="img" aria-label="Launch timeline across studies">
        ${ticks.map((t) => `<line class="axis" x1="${x(t)}" x2="${x(t)}" y1="10" y2="${H - 24}"/>
          <text x="${x(t)}" y="${H - 8}" text-anchor="middle">${new Date(t).toISOString().slice(0, 7)}</text>`).join("")}
        ${rows.map(({ s, pts }, i) => `<a href="#/study/${esc(s.id)}"><text x="4" y="${24 + i * RH}">${esc(studyLabel(s.id))}</text></a>
          ${pts.map((p) => `<a href="${p.r.wandb_groups.length ? `#/group/${encodeURIComponent(p.r.wandb_groups[0])}` : `#/study/${esc(s.id)}`}">
            <circle cx="${x(p.t)}" cy="${20 + i * RH}" r="5" fill="${p.r.kind === "initial" || !p.r.kind ? "var(--accent)" : "var(--warn)"}"
              fill-opacity="${p.r.schema_version === 2 ? 1 : 0.65}">
            <title>${esc(s.id)} · ${esc(p.r.path.split("/variants/")[1] || p.r.path)}\n${esc(p.r.kind || "")} · ${esc(p.r.time)}\n${esc(p.r.note || "")}</title></circle></a>`).join("")}`).join("")}
      </svg></div>`}
      <h2>All launches</h2>
      <p class="muted">One row per launch record, newest first; click a column to sort. Times are Seattle time.
        Status is not shown: launch records are written at submission and never change, so open the job (Beaker,
        SLURM or Cedar) or the W&amp;B group for its current state.</p>
      <input class="filter" id="job-filter" placeholder="Filter launches…" aria-label="Filter launches">
      <div class="table-wrap"><table id="job-list"><thead><tr>${JOB_COLS.map((c, k) =>
        `<th data-col="${k}" aria-sort="none"><button type="button" class="sort">${c.label}</button></th>`).join("")}</tr></thead>
        <tbody></tbody></table></div>`;
    jobList(rows.map((x) => x.s));
  };

  // ------------------------------------------------------------ job list (under the timeline)
  const PT = new Intl.DateTimeFormat("sv-SE", { timeZone: "America/Los_Angeles", year: "numeric", month: "2-digit",
    day: "2-digit", hour: "2-digit", minute: "2-digit" });
  // a Beaker id is 26 characters: show its head, keep the whole id in the link and tooltip
  const jobRef = (j) => j.type === "beaker_experiment"
    ? `<a class="mono" href="https://beaker.org/ex/${esc(j.id)}" target="_blank" rel="noopener" title="Beaker experiment ${esc(j.id)}">${esc(j.id.slice(0, 10))}…</a>`
    // a Cedar session has no documented web link: show its name; id and CLI command on hover
    : j.type === "cedar_session" && j.name
    ? `<span class="mono" title="Cedar session ${esc(j.id)}\ncedar session get ${esc(j.name)}">cedar ${esc(j.name)}</span>`
    : `<span class="mono" title="${esc(j.type.replace(/_/g, " "))} ${esc(j.id)}">${esc(j.type.split("_")[0])} ${esc(j.id)}</span>`;
  const groupCell = (g) => {
    const e = S.cat.wandb_groups[g];
    return `<a class="mono" href="#/group/${encodeURIComponent(g)}">${esc(g).replace("@", "@<wbr>")}</a>${e?.url
      ? ` <a href="${esc(e.url)}" target="_blank" rel="noopener" title="open in W&amp;B">↗</a>` : ""}`;
  };
  // each column: header, sort key, cell
  const JOB_COLS = [
    { label: "When (PT)", key: (j) => j.t, cell: (j) =>
      srcLink(j.r.path, isNaN(j.t) ? "no time" : PT.format(j.t)).replace("<a ", `<a title="${esc(j.r.path)}" `) },
    { label: "Study · variant", key: (j) => `${j.study} ${j.variant || ""}`, cell: (j) =>
      `<a href="#/study/${esc(j.study)}">${esc(studyLabel(j.study))}</a><div class="muted">${esc(j.variant || "(study root)")}</div>` },
    { label: "Kind · platform", key: (j) => `${j.r.kind || ""} ${j.r.platform || ""}`, cell: (j) =>
      `${chip(j.r.kind || "?")}<div class="muted">${esc(j.r.platform || "—")}</div>` },
    { label: "Jobs", key: (j) => j.refs.map((x) => x.id).join(" "), cell: (j) => j.refs.map(jobRef).join("<br>") || "—" },
    { label: "Tasks", key: (j) => j.r.n_tasks ?? -1, cell: (j) => esc(j.r.n_tasks ?? "—") },
    { label: "W&amp;B group", key: (j) => j.r.wandb_groups[0] || "", cell: (j) => j.r.wandb_groups.map(groupCell).join("<br>") || "—" },
    { label: "Why", key: (j) => j.r.note || "", cell: (j) => `<div class="note" title="${esc(j.r.note || "")}">${esc(j.r.note || "")}</div>` },
  ];

  function jobList(studies) {
    const jobs = studies.flatMap((s) => [
      ...s.variants.flatMap((v) => v.launch_records.map((r) => ({ r, variant: v.name }))),
      ...(s.root_launch_records || []).map((r) => ({ r, variant: null })),
    ].filter(({ r }) => r.format === "json").map((j) => ({ ...j, study: s.id, t: Date.parse(j.r.time),
      // a record the catalog could not parse has no job_refs; keep its row, with only well-formed refs
      refs: (Array.isArray(j.r.job_refs) ? j.r.job_refs : [])
        .filter((x) => x && (typeof x.id === "string" || typeof x.id === "number"))
        .map((x) => ({ type: typeof x.type === "string" ? x.type : "job", id: String(x.id),
          name: typeof x.name === "string" ? x.name : null })) })));
    let col = 0, dir = -1, q = "";
    const draw = () => {
      const c = JOB_COLS[col];
      const cmp = (a, b) => { const x = c.key(a), y = c.key(b);
        // undated records always sort last
        if (col === 0 && (isNaN(x) || isNaN(y))) return isNaN(x) - isNaN(y);
        return (x < y ? -1 : x > y ? 1 : 0) * dir; };
      const shown = jobs.filter((j) => !q || [j.study, j.variant, j.r.kind, j.r.platform, j.r.note, j.r.path,
        ...j.r.wandb_groups, ...j.refs.flatMap((x) => [x.id, x.name])].join(" ").toLowerCase().includes(q)).sort(cmp);
      document.querySelector("#job-list tbody").innerHTML = shown.map((j) =>
        `<tr>${JOB_COLS.map((k) => `<td>${k.cell(j)}</td>`).join("")}</tr>`).join("")
        || `<tr><td colspan="${JOB_COLS.length}" class="muted">No launch matches.</td></tr>`;
      document.querySelectorAll("#job-list th").forEach((th, k) =>
        th.setAttribute("aria-sort", k === col ? (dir > 0 ? "ascending" : "descending") : "none"));
    };
    document.querySelectorAll("#job-list th").forEach((th, k) => th.querySelector("button").addEventListener("click", () => {
      dir = k === col ? -dir : (k === 0 ? -1 : 1); col = k; draw();
    }));
    const input = document.getElementById("job-filter");
    input.addEventListener("input", () => { q = input.value.toLowerCase(); draw(); });
    draw();
  }

  // ------------------------------------------------------------ report history
  function lineDiff(a, b) {
    const x = a.split("\n"), y = b.split("\n"), n = x.length, m = y.length;
    const L = Array.from({ length: n + 1 }, () => new Int32Array(m + 1));
    for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--)
      L[i][j] = x[i] === y[j] ? L[i + 1][j + 1] + 1 : Math.max(L[i + 1][j], L[i][j + 1]);
    const out = [];
    let i = 0, j = 0;
    while (i < n || j < m) {
      if (i < n && j < m && x[i] === y[j]) { out.push(["=", x[i]]); i++; j++; }
      else if (j < m && (i === n || L[i][j + 1] >= L[i + 1][j])) out.push(["+", y[j++]]);
      else out.push(["-", x[i++]]);
    }
    return out;
  }

  VIEWS.history = (sid, rid) => {
    const r = S.reportByKey[`${sid}/${rid}`];
    if (!r) { main().innerHTML = `<h1>Not found</h1>`; return; }
    const h = r.history || [];
    const versions = h.map((v, k) => {
      const older = h[k + 1];
      const names = [...new Set([...Object.keys(v.blocks), ...Object.keys(older?.blocks || {})])];
      const diffs = names.map((name) => {
        const now = v.blocks[name], before = older?.blocks[name];
        if (now === before) return "";
        if (before === undefined) return `<h3><code>${esc(name)}</code> added</h3><pre>${esc(now)}</pre>`;
        if (now === undefined) return `<h3><code>${esc(name)}</code> removed</h3>`;
        return `<h3><code>${esc(name)}</code></h3><pre>${lineDiff(before, now).map(([op, s]) =>
          op === "=" ? esc(s) : `<span class="${op === "+" ? "diff-ins" : "diff-del"}">${op} ${esc(s)}</span>`).join("\n")}</pre>`;
      }).join("");
      return `<details ${k === 0 ? "open" : ""}><summary><span class="mono">${esc(short(v.sha))}</span>
          ${esc(v.date.slice(0, 10))} — ${esc(v.subject)}</summary>
        <p><a href="${window.Atlas.STUDIES_REPO}/commit/${esc(v.sha)}" target="_blank" rel="noopener">commit</a></p>
        ${older ? diffs || `<p class="muted">No result-block change.</p>` : `<p class="muted">Earliest recorded version.</p>
          ${Object.entries(v.blocks).map(([n, b]) => `<h3><code>${esc(n)}</code></h3><pre>${esc(b)}</pre>`).join("")}`}
      </details>`;
    }).join("");
    main().innerHTML = `<div class="crumbs"><a href="#/studies">Studies</a> / <a href="#/study/${esc(sid)}">${esc(sid)}</a> /
        <a href="#/report/${esc(sid)}/${esc(rid)}">${esc(rid)}</a> / history</div>
      <h1>${esc(r.title)} — history</h1>
      <p class="muted">Each commit that changed this report's result blocks, newest first, with the change to each block
        (from <code>git log --follow</code> of the studies repo).</p>
      ${versions || `<div class="empty">No history: the catalog was built from a checkout without it.</div>`}`;
  };

  // ------------------------------------------------------------ click-a-number
  // same token rule as NUMBER in catalog.py
  const NUMBER = /(?<![\w.,])([-−]?\d+\.\d+)(?!\w|[.,]\d)/g;
  window.Atlas.linkNumbers = (div, r, name) => {
    const block = r.result_blocks.find((b) => b.name === name);
    const links = Object.fromEntries((block?.number_links || []).map((l) => [l.text, l]));
    if (!Object.keys(links).length) return;
    const walker = document.createTreeWalker(div, NodeFilter.SHOW_TEXT);
    const nodes = [];
    while (walker.nextNode()) if (!walker.currentNode.parentElement.closest("a, code, pre, .rb-head, .tex")) nodes.push(walker.currentNode);
    for (const node of nodes) {
      const text = node.nodeValue;
      if (!NUMBER.test(text)) continue;
      NUMBER.lastIndex = 0;
      const frag = document.createDocumentFragment();
      let last = 0;
      for (const m of text.matchAll(NUMBER)) {
        const l = links[m[1]];
        if (!l) continue;
        frag.append(text.slice(last, m.index));
        const span = document.createElement("span");
        span.className = "num-link";
        span.tabIndex = 0;
        span.setAttribute("role", "button");
        span.textContent = m[1];
        span.title = `${l.artifact.split("/").pop()} ${l.pointer}`;
        span.addEventListener("keydown", (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); span.click(); } });
        span.addEventListener("click", () => openDrawer(r, name, `
          <div class="banner" style="border-color:var(--block-line);background:var(--block)">
            <b class="mono">${esc(l.text)}</b> is <code>${esc(l.pointer)}</code> in ${srcLink(l.artifact, l.artifact.split("/").pop())}
            = <span class="mono">${esc(l.value)}</span><br>
            <span class="muted">Matched by value: it is the only leaf of the ${l.how === "declared"
              ? "JSON that declares this block in <code>_meta.outputs</code>"
              : "report's JSON inputs"} that rounds to the displayed number.</span></div>`));
        frag.append(span);
        last = m.index + m[0].length;
      }
      if (last) { frag.append(text.slice(last)); node.replaceWith(frag); }
    }
  };
});
