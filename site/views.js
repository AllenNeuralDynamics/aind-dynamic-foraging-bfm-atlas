/* Launch timeline, report history, and
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
    if (!all.length) { main().innerHTML = `<h1>Launch timeline</h1><div class="empty">No launch record carries a time.</div>`; return; }
    const t0 = Math.min(...all), t1 = Math.max(...all);
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
      <p class="muted">Every launch record with a time, by study. <span style="color:var(--accent)">●</span> initial launch,
        <span style="color:var(--warn)">●</span> intervention (resubmit, rescue, probe, tier change, backfill, extend).
        ${undated ? `${undated} records carry no time and are not shown.` : ""}</p>
      <div class="table-wrap"><svg viewBox="0 0 ${W} ${H}" width="100%" style="min-width:720px" role="img" aria-label="Launch timeline across studies">
        ${ticks.map((t) => `<line class="axis" x1="${x(t)}" x2="${x(t)}" y1="10" y2="${H - 24}"/>
          <text x="${x(t)}" y="${H - 8}" text-anchor="middle">${new Date(t).toISOString().slice(0, 7)}</text>`).join("")}
        ${rows.map(({ s, pts }, i) => `<a href="#/study/${esc(s.id)}"><text x="4" y="${24 + i * RH}">${esc(studyLabel(s.id))}</text></a>
          ${pts.map((p) => `<a href="${p.r.wandb_groups.length ? `#/group/${encodeURIComponent(p.r.wandb_groups[0])}` : `#/study/${esc(s.id)}`}">
            <circle cx="${x(p.t)}" cy="${20 + i * RH}" r="5" fill="${p.r.kind === "initial" || !p.r.kind ? "var(--accent)" : "var(--warn)"}"
              fill-opacity="${p.r.schema_version === 2 ? 1 : 0.65}">
            <title>${esc(s.id)} · ${esc(p.r.path.split("/variants/")[1] || p.r.path)}\n${esc(p.r.kind || "")} · ${esc(p.r.time)}\n${esc(p.r.note || "")}</title></circle></a>`).join("")}`).join("")}
      </svg></div>`;
  };

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
    main().innerHTML = `<div class="crumbs"><a href="#/">Studies</a> / <a href="#/study/${esc(sid)}">${esc(sid)}</a> /
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
    while (walker.nextNode()) if (!walker.currentNode.parentElement.closest("a, code, pre, .rb-head")) nodes.push(walker.currentNode);
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
