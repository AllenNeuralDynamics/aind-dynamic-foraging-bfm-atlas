/* The study map (home page) and lineage (report drawer and #/lineage/<study>/<rN>/<block>), both
 * generated from the catalog, plus Export SVG. Vocabulary: the studies repo's CONTEXT.md
 * (Motivation, Upstream, Correction, Lineage) and docs/adr/0002. Registers through window.Atlas.
 */
"use strict";

document.addEventListener("atlas:ready", () => {
  const A = window.Atlas;
  const { S, VIEWS, esc, chip, srcLink, short, statusChip } = A;
  const NS = "http://www.w3.org/2000/svg";
  const base = (p) => String(p).split("#")[0].split("/").pop();
  const studyOfPath = (p) => (String(p).match(/^studies\/([^/]+)\//) || [])[1] || null;
  const uniq = (xs) => [...new Set(xs)];
  const store = {
    get(k, d) { try { const v = localStorage.getItem(k); return v === null ? d : JSON.parse(v); } catch { return d; } },
    set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* storage blocked: keep in memory */ } },
  };

  // ------------------------------------------------------------ shared: tooltip
  // Hover, keyboard focus and tap all show it (phones have no hover); a tap elsewhere hides it.
  function tooltip(host) {
    host.classList.add("tip-host");
    const tip = document.createElement("div");
    tip.className = "tip";
    tip.hidden = true;
    tip.setAttribute("role", "tooltip");
    host.append(tip);
    return {
      show(target, html) {
        tip.innerHTML = html;
        tip.hidden = false;
        const h = host.getBoundingClientRect(), b = target.getBoundingClientRect();
        const left = Math.min(Math.max(b.left - h.left + b.width / 2 - tip.offsetWidth / 2, 4),
                              Math.max(4, host.clientWidth - tip.offsetWidth - 4));
        const above = b.top - h.top - tip.offsetHeight - 8;
        tip.style.left = `${left}px`;
        tip.style.top = `${above > 0 ? above : b.bottom - h.top + 8}px`;
      },
      hide() { tip.hidden = true; },
    };
  }

  // ------------------------------------------------------------ shared: Export SVG
  // Resolves the page's CSS (theme variables included) into attributes, so the file renders the
  // same anywhere, and stamps the studies commit the catalog was built from.
  const PROPS = ["fill", "fill-opacity", "stroke", "stroke-width", "stroke-dasharray", "stroke-opacity",
                 "opacity", "font-size", "font-weight", "font-family"];
  function downloadSvg(svg, filename) {
    const clone = svg.cloneNode(true);
    const src = [svg, ...svg.querySelectorAll("*")], dst = [clone, ...clone.querySelectorAll("*")];
    src.forEach((el, i) => {
      const cs = getComputedStyle(el);
      if (cs.display === "none" || cs.visibility === "hidden") { dst[i].setAttribute("data-drop", "1"); return; }
      for (const p of PROPS) { const v = cs.getPropertyValue(p); if (v) dst[i].setAttribute(p, v); }
      dst[i].removeAttribute("class");
      dst[i].removeAttribute("style");
      dst[i].removeAttribute("tabindex");
    });
    clone.querySelectorAll("[data-drop]").forEach((e) => e.remove());
    const vb = svg.viewBox.baseVal;
    const bg = document.createElementNS(NS, "rect");
    Object.entries({ x: vb.x, y: vb.y, width: vb.width, height: vb.height, fill: getComputedStyle(document.body).backgroundColor })
      .forEach(([k, v]) => bg.setAttribute(k, v));
    clone.insertBefore(bg, clone.firstChild);
    const stamp = document.createElementNS(NS, "text");
    Object.entries({ x: vb.x + vb.width - 8, y: vb.y + vb.height - 8, "text-anchor": "end", "font-size": 11,
                     "font-family": getComputedStyle(document.body).fontFamily, fill: getComputedStyle(document.body).color, opacity: 0.6 })
      .forEach(([k, v]) => stamp.setAttribute(k, v));
    stamp.textContent = `studies ${short(S.sha)} · built ${(S.cat._meta.built_at_pt || "").slice(0, 16).replace("T", " ")} PT`;
    clone.append(stamp);
    clone.setAttribute("xmlns", NS);
    const blob = new Blob([new XMLSerializer().serializeToString(clone)], { type: "image/svg+xml" });
    const a = Object.assign(document.createElement("a"), { href: URL.createObjectURL(blob), download: filename });
    document.body.append(a);
    a.click();
    setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
  }

  // ------------------------------------------------------------ study map
  const KINDS = {
    motivation: { label: "Motivation", hint: "why a study exists (study motivated_by)" },
    corrects: { label: "Correction", hint: "a report amends an earlier report (corrects)" },
    supersedes: { label: "Supersession", hint: "a report replaces an earlier one (superseded_by)" },
    upstream: { label: "Upstream", hint: "a report uses another study's results (upstream)" },
  };
  const LAYERS = { motivation: true, corrects: true, supersedes: true, upstream: false };
  const LANES = ["GRU", "disRNN", "Baselines & comparisons"];
  const laneOf = (s) => (/-vs-/.test(s.id) || !["gru", "disrnn"].includes(s.model) ? 2 : s.model === "gru" ? 0 : 1);
  const label = (s) => (laneOf(s) === 2 ? s.id.slice(3) : s.purpose || s.id.slice(3)).replace(/-/g, " ");
  function wrap(text, n = 17) {
    const lines = [""];
    for (const w of text.split(" ")) {
      if ((lines[lines.length - 1] + " " + w).trim().length > n && lines[lines.length - 1]) lines.push(w);
      else lines[lines.length - 1] = (lines[lines.length - 1] + " " + w).trim();
    }
    return lines.length > 2 ? [lines[0], `${lines.slice(1).join(" ").slice(0, n - 1)}…`] : lines;
  }
  const issueHref = (i) => (typeof i === "number" ? `${A.STUDIES_REPO}/issues/${i}`
    : `https://github.com/${String(i).replace("#", "/issues/")}`);
  const reportHref = (key) => { const r = S.reportByKey[key]; return r ? `#/report/${r._study}/${r.id}` : null; };

  A.drawMap = (host) => {
    const studies = [...S.cat.studies].sort((a, b) => a.id.localeCompare(b.id));
    const layers = { ...LAYERS, ...store.get("atlas.map.layers", {}) };
    const W = 1240, L = 190, R = 40, TOP = 10, LH = 160, H = TOP + LH * LANES.length + 6, rad = 21;
    const step = (W - L - R) / Math.max(1, studies.length - 1);
    const pos = {};
    studies.forEach((s, i) => { pos[s.id] = { x: L + i * step, y: TOP + laneOf(s) * LH + 98 }; });
    // aggregate per (from, to, kind); a motivation to an issue gets a small node left of its study
    const edges = {};
    for (const d of S.cat.dependencies) {
      if (d.from === d.to || !pos[d.from]) continue;
      if (!pos[d.to]) {
        if (!d.to.startsWith("issue:")) continue;
        pos[d.to] = { x: pos[d.from].x - step * 0.55, y: pos[d.from].y - 34, issue: d.to.slice(6) };
      }
      (edges[`${d.from}|${d.to}|${d.kind}`] ||= { from: d.from, to: d.to, kind: d.kind, items: [] }).items.push(d);
    }
    const list = Object.values(edges);
    // Motivation and upstream flow forward in time (from the earlier result to the later study);
    // correction and supersession point back at the report they amend or replace.
    function path(e) {
      const fwd = e.kind === "motivation" || e.kind === "upstream";
      const a = pos[fwd ? e.to : e.from], b = pos[fwd ? e.from : e.to];
      const ra = a.issue ? 10 : rad, rb = b.issue ? 10 : rad;
      if (Math.abs(a.y - b.y) < 1) {                      // same lane: arc over the nodes between
        // capped, so a long arc stays inside the lane's headroom
        const h = Math.min({ motivation: 26, upstream: 12, corrects: 40, supersedes: 48 }[e.kind] + Math.abs(b.x - a.x) * 0.1,
                           { motivation: 62, upstream: 46, corrects: 70, supersedes: 74 }[e.kind]);
        return `M${a.x},${a.y - ra} C${a.x},${a.y - ra - h} ${b.x},${b.y - rb - h} ${b.x},${b.y - rb}`;
      }
      const dn = b.y > a.y ? 1 : -1, off = { motivation: 0, upstream: 16, corrects: -16, supersedes: -28 }[e.kind];
      const y1 = a.y + dn * ra, y2 = b.y - dn * (rb + (dn > 0 ? 0 : 40)), ym = (y1 + y2) / 2;
      return `M${a.x + off * 0.4},${y1} C${a.x + off},${ym} ${b.x + off},${ym} ${b.x + off * 0.4},${y2}`;
    }
    const lanes = LANES.map((name, i) => `<rect class="lane" x="0" y="${TOP + i * LH}" width="${W}" height="${LH - 8}" rx="8"/>
      <text class="lane-label" x="14" y="${TOP + i * LH + 22}">${esc(name)}</text>`).join("");
    const marker = (k) => `<marker id="m-${k}" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7"
      orient="auto-start-reverse"><path class="mk mk-${k}" d="M0,0 L10,5 L0,10 z"/></marker>`;
    const edgeSvg = list.map((e, i) => `<g class="edge e-${e.kind}${layers[e.kind] ? "" : " off"}" data-i="${i}"
        data-from="${esc(e.from)}" data-to="${esc(e.to)}">
        <path class="hit" d="${path(e)}"/><path class="line" d="${path(e)}" marker-end="url(#m-${e.kind})"/></g>`).join("");
    const nodeSvg = studies.map((s) => {
      const p = pos[s.id], st = s.cover.status || "unknown";
      return `<g class="node st-${esc(st)}" data-id="${esc(s.id)}" tabindex="0" role="button"
          aria-label="${esc(`${s.id}, ${st}`)}">
        <circle cx="${p.x}" cy="${p.y}" r="${rad}"/>
        <text class="nn" x="${p.x}" y="${p.y + 5}" text-anchor="middle">${esc(s.id.slice(0, 2))}</text>
        ${wrap(label(s)).map((l, k) => `<text class="lbl" x="${p.x}" y="${p.y + rad + 16 + k * 14}" text-anchor="middle">${esc(l)}</text>`).join("")}
      </g>`;
    }).join("");
    const issueSvg = Object.entries(pos).filter(([, p]) => p.issue).map(([id, p]) => `<g class="node issue" data-id="${esc(id)}">
        <rect x="${p.x - 22}" y="${p.y - 10}" width="44" height="20" rx="10"/>
        <text class="lbl" x="${p.x}" y="${p.y + 4}" text-anchor="middle">#${esc(String(p.issue).split("#").pop())}</text></g>`).join("");
    host.innerHTML = `
      <div class="map-tools">
        <span class="muted">Relationships:</span>
        ${Object.entries(KINDS).filter(([k]) => list.some((e) => e.kind === k) || k !== "supersedes").map(([k, v]) =>
          `<button type="button" class="layer layer-${k}" data-kind="${k}" aria-pressed="${layers[k]}" title="${esc(v.hint)}">
            <span class="swatch"></span>${esc(v.label)}</button>`).join("")}
        <button type="button" class="export" id="map-export">Export SVG</button>
      </div>
      <div class="map-wrap">
        <svg id="study-map" viewBox="0 0 ${W} ${H}" role="img" aria-label="Study map: studies by creation order and model family, with their relationships">
          <defs>${Object.keys(KINDS).map(marker).join("")}</defs>
          ${lanes}${edgeSvg}${issueSvg}${nodeSvg}
        </svg>
      </div>
      <div class="map-panel" id="map-panel" aria-live="polite"></div>`;
    const svg = host.querySelector("svg"), wrapEl = host.querySelector(".map-wrap"), tip = tooltip(host);
    let focused = store.get("atlas.map.focus", null);
    if (focused && !pos[focused]) focused = null;

    function light(id) {
      svg.classList.toggle("lighting", !!id);
      svg.querySelectorAll(".lit, .nbr").forEach((el) => el.classList.remove("lit", "nbr"));
      if (!id) return;
      svg.querySelector(`.node[data-id="${CSS.escape(id)}"]`)?.classList.add("lit");
      svg.querySelectorAll(".edge").forEach((g) => {
        if (g.dataset.from !== id && g.dataset.to !== id) return;
        g.classList.add("lit");
        const other = g.dataset.from === id ? g.dataset.to : g.dataset.from;
        svg.querySelector(`.node[data-id="${CSS.escape(other)}"]`)?.classList.add("nbr");
      });
    }
    const studyTip = (s) => `<b>${esc(s.id)}</b> ${statusChip(s.cover.status)}
      ${s.cover.question ? `<div>${esc(s.cover.question)}</div>` : ""}
      ${s.cover.verdict ? `<div class="tip-v">${esc(s.cover.verdict)}</div>` : ""}`;
    const edgeTip = (e) => `<b>${esc(KINDS[e.kind].label)}</b> · ${esc(e.from.slice(0, 2))} ${e.kind === "motivation" ? "follows up" :
        e.kind === "upstream" ? "uses" : e.kind === "corrects" ? "corrects" : "supersedes"} ${esc(e.to.startsWith("issue:") ? e.to.slice(6) : e.to.slice(0, 2))}
      <ul>${uniq(e.items.map((d) => `${d.to_report ? d.to_report.split("/").pop() + ": " : ""}${d.note || (d.report ? base(d.report) : "")}`))
        .slice(0, 6).map((t) => `<li>${esc(t)}</li>`).join("")}</ul>`;

    svg.querySelectorAll(".node[data-id]").forEach((g) => {
      const s = S.study[g.dataset.id];
      const show = () => { light(g.dataset.id); if (s) tip.show(g, studyTip(s)); };
      const hide = () => { tip.hide(); light(focused); };
      g.addEventListener("pointerenter", show);
      g.addEventListener("pointerleave", hide);
      g.addEventListener("focus", show);
      g.addEventListener("blur", hide);
      if (!s) return;
      const pick = () => { focused = focused === s.id ? null : s.id; store.set("atlas.map.focus", focused); panel(); light(focused); };
      g.addEventListener("click", (ev) => { ev.stopPropagation(); pick(); });
      g.addEventListener("keydown", (ev) => { if (ev.key === "Enter" || ev.key === " ") { ev.preventDefault(); pick(); } });
    });
    svg.querySelectorAll(".edge").forEach((g) => {
      const e = list[+g.dataset.i];
      g.addEventListener("pointerenter", () => tip.show(g, edgeTip(e)));
      g.addEventListener("pointerleave", () => tip.hide());
      g.addEventListener("click", (ev) => { ev.stopPropagation(); tip.show(g, edgeTip(e)); });
    });
    wrapEl.addEventListener("click", () => tip.hide());
    host.querySelectorAll(".layer").forEach((b) => b.addEventListener("click", () => {
      const k = b.dataset.kind;
      layers[k] = !layers[k];
      b.setAttribute("aria-pressed", String(layers[k]));
      svg.querySelectorAll(`.e-${k}`).forEach((g) => g.classList.toggle("off", !layers[k]));
      store.set("atlas.map.layers", layers);
    }));
    host.querySelector("#map-export").addEventListener("click", () => {
      tip.hide();
      light(null);
      downloadSvg(svg, `study-map-${short(S.sha)}.svg`);
      light(focused);
    });

    function relList(title, rows) {
      return rows.length ? `<div class="rel"><div class="k">${esc(title)}</div><ul>${rows.join("")}</ul></div>` : "";
    }
    function refLink(study, rkey) {
      const href = rkey ? reportHref(rkey) : `#/study/${study}`;
      const text = rkey ? `${study.slice(0, 2)} ${rkey.split("/").pop()}` : study;
      return href ? `<a href="${esc(href)}">${esc(text)}</a>` : esc(text);
    }
    function panel() {
      const el = host.querySelector("#map-panel");
      svg.querySelectorAll(".node.focused").forEach((n) => n.classList.remove("focused"));
      if (!focused) {
        el.innerHTML = `<p class="muted">Select a study to see why it exists, what it led to, what it uses, and its reports.
          Arrows run from a result to the work that followed it; a correction points back at the report it amends.</p>`;
        return;
      }
      svg.querySelector(`.node[data-id="${CSS.escape(focused)}"]`)?.classList.add("focused");
      const s = S.study[focused], deps = S.cat.dependencies;
      const mb = s.cover.motivated_by;
      const motivated = mb === null || mb === undefined
        ? [`<li class="muted">Not declared (this study has no <code>motivated_by</code>).</li>`]
        : !mb.length ? [`<li class="muted">None: a root study.</li>`]
        : mb.map((m) => `<li>${m.issue !== undefined ? `<a href="${esc(issueHref(m.issue))}" target="_blank" rel="noopener">issue ${esc(m.issue)}</a>`
            : refLink(m.study, m.report ? `${m.study}/${m.report}` : null)} — ${esc(m.note || "")}</li>`);
      const ledTo = deps.filter((d) => d.kind === "motivation" && d.to === focused)
        .map((d) => `<li>${refLink(d.from, null)}${d.to_report ? ` (from ${esc(d.to_report.split("/").pop())})` : ""} — ${esc(d.note || "")}</li>`);
      const uses = uniq(deps.filter((d) => d.kind === "upstream" && d.from === focused)
        .map((d) => `<li>${refLink(d.to, d.to_report)} <span class="muted">in ${esc(base(d.report || ""))}</span></li>`));
      const usedBy = uniq(deps.filter((d) => d.kind === "upstream" && d.to === focused)
        .map((d) => `<li>${refLink(d.from, null)} <span class="muted">${esc(base(d.report || ""))} uses ${esc((d.to_report || "").split("/").pop() || "a launch")}</span></li>`));
      const corr = deps.filter((d) => (d.kind === "corrects" || d.kind === "supersedes") && (d.from === focused || d.to === focused))
        .map((d) => `<li>${d.from === focused ? `${esc(d.kind)} ${refLink(d.to, d.to_report)}` : `${refLink(d.from, null)} ${esc(d.kind)} ${esc((d.to_report || "").split("/").pop())}`}
          ${d.note ? ` — ${esc(d.note)}` : ""}</li>`);
      const reports = s.reports.map((r) => `<li><a href="#/report/${esc(s.id)}/${esc(r.id)}">${esc(r.id)}</a> ${statusChip(r.status)}
          ${esc(r.title.replace(/^(Result|r)\s*\d+\s*[—:-]\s*/i, ""))}</li>`);
      el.innerHTML = `<div class="panel-head"><a href="#/study/${esc(s.id)}"><b>${esc(s.id)}</b></a> ${statusChip(s.cover.status)}
          <button type="button" class="panel-close" aria-label="Clear selection">×</button></div>
        ${s.cover.question ? `<p>${esc(s.cover.question)}</p>` : ""}
        ${s.cover.verdict ? `<p class="muted">Verdict: ${esc(s.cover.verdict)}</p>` : ""}
        <div class="rels">
          ${relList("Motivated by", motivated)}${relList("Led to", ledTo)}
          ${relList("Uses results from", uses)}${relList("Used by", usedBy)}${relList("Corrections", corr)}
          ${relList(`Reports (${s.reports.length})`, reports)}
        </div>`;
      el.querySelector(".panel-close").addEventListener("click", () => { focused = null; store.set("atlas.map.focus", null); panel(); light(null); });
    }
    panel();
    light(focused);
  };

  // ------------------------------------------------------------ lineage
  const HOPS = [
    ["report", "Report block", "The delimited numbers in the report."],
    ["analysis", "Analysis", "The producer that computed them, with digests of its code."],
    ["query", "Query", "What it read: frozen W&B pulls and other committed inputs, by digest."],
    ["tracking", "Tracking", "The W&B groups those runs belong to."],
    ["compute", "Compute", "The launch records for those groups: the launch and every intervention."],
    ["experiment", "Experiment", "The sweep and experiment manifests the launch submitted."],
    ["model", "Model & image", "The commits of the code that trained the model, and its container image."],
    ["data", "Data", "The data snapshot the runs trained and were evaluated on."],
  ];
  const STATE = { ok: "recorded", partial: "partly recorded", gap: "not recorded" };

  function buildLineage(r, block) {
    const { list: arts, how } = A.producersFor(r, block);
    const v2 = arts.filter((a) => a.meta?.schema_version === 2);
    const out = { r, block, hops: {} };
    const set = (k, state, items, why) => { out.hops[k] = { state, items, why }; };
    const blockKey = `${r.path}#${block}`;
    const declared = arts.flatMap((a) => (a.meta?.outputs || []).filter((o) => o.path === blockKey).map((o) => ({ a, o })));
    set("report", declared.length ? "ok" : "partial",
      [{ text: `${r.id} · ${block}`, sub: declared[0] ? `digest ${short(declared[0].o.sha256)}` : null, href: `#/report/${r._study}/${r.id}` }],
      declared.length ? `Its digest is in ${base(declared[0].a.path)}'s outputs, so a hand edit fails the studies CI.`
        : "No producer declares this block in _meta.outputs, so an edit by hand would go unnoticed.");
    set("analysis", !arts.length ? "gap" : v2.length === arts.length ? "ok" : "partial",
      arts.map((a) => ({ text: a.meta?.produced_by ? base(a.meta.produced_by) : base(a.path),
        sub: a.meta?.schema_version === 2 ? `${(a.meta.code || []).length} code digests` : "no code digests (_meta v1)",
        link: srcLink(a.path, base(a.path)) })),
      !arts.length ? "No analysis JSON is linked to this block." : how === "inputs"
        ? "Found through the report's declared inputs, not through _meta.outputs." : "Code digests are checked in CI: an edited producer marks this stale.");
    const inputs = uniq(arts.flatMap((a) => (a.meta?.inputs || []).map((i) => i.path)));
    const freezes = inputs.map((p) => S.artifactByPath[p]).filter((a) => a?.meta?.kind === "freeze");
    const items = inputs.map((p) => {
      const st = studyOfPath(p), cross = st && st !== r._study, art = S.artifactByPath[p];
      const up = cross && r.upstream.find((u) => u.study === st && u.report);
      if (cross) return { text: base(p), sub: `study ${st.slice(0, 2)}`, xref: true,
        href: up ? reportHref(`${st}/${up.report}`) : `#/study/${st}` };
      return { text: base(p), sub: art?.meta?.kind === "freeze" ? "freeze" : "committed input", link: srcLink(p, base(p)) };
    });
    const plain = inputs.filter((p) => studyOfPath(p) === r._study && S.artifactByPath[p]?.meta?.kind !== "freeze");
    set("query", !inputs.length ? "gap" : plain.length ? "partial" : "ok", items,
      !inputs.length ? (v2.length ? "The producer recorded no inputs." : "_meta v1 records no input digests.")
        : plain.length ? `${plain.length} input${plain.length > 1 ? "s are" : " is"} a committed file whose freeze is not recorded (studies#25).`
        : "Every input is a freeze or another study's result, each by digest.");
    const groups = uniq([...arts, ...freezes].flatMap((a) => a.meta?.wandb_groups || []));
    set("tracking", groups.length ? "ok" : "gap",
      groups.map((g) => ({ text: g, href: `#/group/${encodeURIComponent(g)}` })),
      groups.length ? "Pinned by exact name; one launch mints one group (ADR 0001)." : "No W&B group is recorded for this result.");
    const recs = uniq(groups.flatMap((g) => S.cat.wandb_groups[g]?.launch_records || [])).map((p) => S.recordByPath[p]).filter(Boolean);
    const json = recs.filter((x) => x.format === "json");
    const kinds = uniq(json.map((x) => x.kind || "launch"));
    const older = recs.length - json.length;
    set("compute", !recs.length ? "gap" : json.length && groups.every((g) => (S.cat.wandb_groups[g]?.launch_records || []).length) ? "ok" : "partial",
      [...(json.length ? [{ text: `${json.length} launch record${json.length > 1 ? "s" : ""}`, sub: kinds.join(", ") }] : []),
       ...(older ? [{ text: `${older} older record file${older > 1 ? "s" : ""}`, sub: "pre-JSON manifests" }] : [])],
      !recs.length ? (groups.length ? "No launch record names these groups." : "No W&B group, so no launch to find.")
        : json.length ? "Every launch and intervention writes a launch record." : "Only older record files (copied manifests), without the launch's kind, jobs or commits.");
    const manifests = uniq(json.flatMap((x) => x.manifests || []));
    // older records snapshot nothing: fall back to the variant's manifests as they are now
    const current = manifests.length ? [] : uniq(recs.flatMap((x) =>
      (S.study[x._study]?.variants.find((v) => v.name === x._variant)?.manifests) || []));
    set("experiment", manifests.length ? "ok" : current.length ? "partial" : "gap",
      manifests.length ? manifests.map((m) => ({ text: base(m), link: srcLink(m, base(m)) }))
        : current.map((m) => ({ text: base(m), sub: "current file", link: srcLink(m, base(m)) })),
      manifests.length ? "Manifests as submitted, copied into the launch record."
        : current.length ? "The launch records do not snapshot their manifests; these are the variant's files as they are now, which may have changed since."
        : "No launch record to read manifests from.");
    const revs = {};
    json.forEach((x) => Object.entries(x.revisions || {}).forEach(([k, v]) => { (revs[k] ||= new Set()).add(v); }));
    set("model", Object.keys(revs).length ? "partial" : "gap",
      Object.entries(revs).map(([k, v]) => ({ text: `${k} ${[...v].map(short).join(", ")}` })),
      Object.keys(revs).length ? "Repository commits are recorded; the container image digest is not yet (studies#25)."
        : "No commits recorded for the launch (older launch records).");
    set("data", "gap", [], "The data snapshot is pinned in the sweep config but not recorded with a digest yet (studies#25).");
    out.decisions = [
      ...(S.correctedBy[`${r._study}/${r.id}`] || []).map((c) => ({ text: `corrected by ${c.report._study.slice(0, 2)} ${c.report.id}`,
        href: `#/report/${c.report._study}/${c.report.id}`, note: c.note })),
      ...(r.superseded_by ? [{ text: `superseded by ${r.superseded_by.study.slice(0, 2)} ${r.superseded_by.report}`,
        href: reportHref(`${r.superseded_by.study}/${r.superseded_by.report}`) }] : []),
    ];
    return out;
  }

  function itemHtml(it) {
    const body = `${esc(it.text)}${it.sub ? ` <span class="sub">${esc(it.sub)}</span>` : ""}`;
    if (it.link) return `<span class="lchip">${it.link}${it.sub ? ` <span class="sub">${esc(it.sub)}</span>` : ""}</span>`;
    if (it.href) return `<a class="lchip${it.xref ? " xref" : ""}" href="${esc(it.href)}">${it.xref ? "→ " : ""}${body}</a>`;
    return `<span class="lchip">${body}</span>`;
  }

  A.mountLineage = (host, r, block, { full = false } = {}) => {
    const L = buildLineage(r, block);
    const permalink = `#/lineage/${encodeURIComponent(r._study)}/${encodeURIComponent(r.id)}/${encodeURIComponent(block)}`;
    host.innerHTML = `<div class="lineage">
      <div class="lin-head"><span class="k">Lineage</span>
        ${full ? "" : `<a href="${permalink}">full page</a>`}
        <button type="button" class="export lin-export">Export SVG</button></div>
      <ol class="lin">${HOPS.map(([k, name]) => { const h = L.hops[k];
        return `<li class="slot s-${h.state}" data-hop="${k}" tabindex="0">
          <span class="dot" aria-hidden="true"></span>
          <div class="slot-body"><div class="slot-name">${esc(name)} <span class="sr">(${STATE[h.state]})</span></div>
            <div class="slot-items">${h.items.slice(0, 3).map(itemHtml).join("")}
              ${h.items.length > 3 ? `<button type="button" class="more">+${h.items.length - 3} more</button>
                <span class="rest" hidden>${h.items.slice(3).map(itemHtml).join("")}</span>` : ""}
              ${!h.items.length ? `<span class="muted gap-text">${STATE[h.state]}</span>` : ""}</div></div></li>`; }).join("")}
        ${L.decisions.map((d) => `<li class="slot s-decision" tabindex="0" data-hop="decision"><span class="dot" aria-hidden="true"></span>
          <div class="slot-body"><div class="slot-name">Decision</div><div class="slot-items">
            <a class="lchip" href="${esc(d.href || "#/")}">${esc(d.text)}</a>${d.note ? ` <span class="muted">${esc(d.note)}</span>` : ""}</div></div></li>`).join("")}
      </ol></div>`;
    const tip = tooltip(host.querySelector(".lineage"));
    host.querySelectorAll(".slot").forEach((li) => {
      const k = li.dataset.hop, hop = L.hops[k], meta = HOPS.find((h) => h[0] === k);
      const html = k === "decision" ? "<b>Decision</b><div>A later report amends or replaces this one.</div>"
        : `<b>${esc(meta[1])}</b> · ${esc(STATE[hop.state])}<div>${esc(meta[2])}</div><div class="tip-v">${esc(hop.why)}</div>`;
      li.addEventListener("pointerenter", () => tip.show(li, html));
      li.addEventListener("pointerleave", () => tip.hide());
      li.addEventListener("focus", () => tip.show(li, html));
      li.addEventListener("blur", () => tip.hide());
      li.querySelector(".more")?.addEventListener("click", (ev) => {
        ev.target.hidden = true; ev.target.nextElementSibling.hidden = false;
      });
    });
    host.querySelector(".lin-export").addEventListener("click", () =>
      downloadSvg(lineageSvg(L), `lineage-${r._study.slice(0, 2)}-${r.id}-${block}-${short(S.sha)}.svg`));
  };

  // A self-contained vertical drawing of the same lineage, for slides.
  function lineageSvg(L) {
    const rows = [...HOPS.map(([k, name]) => ({ name, ...L.hops[k] })),
                  ...L.decisions.map((d) => ({ name: "Decision", state: "decision", items: [{ text: d.text }] }))];
    const RH = 54, W = 720, H = 58 + rows.length * RH;
    const svg = document.createElementNS(NS, "svg");
    svg.setAttribute("viewBox", `0 0 ${W} ${H}`);
    svg.setAttribute("class", "lin-svg");
    svg.innerHTML = `<text class="lin-title" x="24" y="30">${esc(`${L.r._study} · ${L.r.id} · ${L.block}`)}</text>
      <line class="lin-rail" x1="34" y1="${58}" x2="34" y2="${58 + (rows.length - 1) * RH}"/>
      ${rows.map((row, i) => { const y = 58 + i * RH;
        return `<circle class="lin-dot d-${row.state}" cx="34" cy="${y}" r="8"/>
          <text class="lin-name" x="56" y="${y + 5}">${esc(row.name)}</text>
          <text class="lin-items" x="200" y="${y + 5}">${esc(row.items.length ? row.items.slice(0, 3).map((it) => it.text).join("  ·  ")
            + (row.items.length > 3 ? `  +${row.items.length - 3}` : "") : STATE[row.state] || "")}</text>`; }).join("")}`;
    // drawn off-screen so computed styles resolve, then removed
    svg.style.position = "absolute"; svg.style.left = "-10000px"; svg.style.width = `${W}px`;
    document.body.append(svg);
    setTimeout(() => svg.remove(), 0);
    return svg;
  }

  VIEWS.lineage = (sid, rid, ...rest) => {
    const block = rest.join("/");
    const r = S.reportByKey[`${sid}/${rid}`];
    const main = document.getElementById("main");
    if (!r || !r.result_blocks.some((b) => b.name === block)) {
      main.innerHTML = `<h1>Not found</h1><p class="muted">No result block ${esc(block)} in ${esc(sid)} ${esc(rid)}.</p>`;
      return;
    }
    main.innerHTML = `<div class="crumbs"><a href="#/">Studies</a> / <a href="#/study/${esc(sid)}">${esc(sid)}</a> /
        <a href="#/report/${esc(sid)}/${esc(rid)}">${esc(rid)}</a> / lineage</div>
      <h1>Lineage of ${esc(rid)} <code>${esc(block)}</code></h1>
      <p class="muted">${esc(r.title)}. Each step back from this result block to the data it came from, generated from the
        catalog at studies ${esc(short(S.sha))}. A hollow step is not recorded yet.</p>
      <div id="lineage-full"></div>
      <h2>Details</h2>
      ${A.producersFor(r, block).list.map(A.artifactChain).join("<hr>") || `<p class="muted">No analysis JSON is linked to this block.</p>`}`;
    A.mountLineage(document.getElementById("lineage-full"), r, block, { full: true });
  };
});
