/* The study map (home page), the local graph (study page) and lineage (report drawer and #/lineage/<study>/<rN>/<block>), both
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
  let tipCount = 0;
  function tooltip(host) {
    host.classList.add("tip-host");
    const tip = document.createElement("div");
    tip.className = "tip";
    tip.hidden = true;
    tip.setAttribute("role", "tooltip");
    tip.id = `tip-${++tipCount}`;
    host.append(tip);
    let current = null, timer = null;
    const hideNow = () => { clearTimeout(timer); tip.hidden = true; current?.removeAttribute("aria-describedby"); current = null; };
    // the pointer may move from the trigger onto the explanation without losing it; Escape dismisses
    tip.addEventListener("pointerenter", () => clearTimeout(timer));
    tip.addEventListener("pointerleave", () => { timer = setTimeout(hideNow, 150); });
    document.addEventListener("keydown", (e) => { if (e.key === "Escape" && !tip.hidden) hideNow(); });
    return {
      show(target, html) {
        clearTimeout(timer);
        tip.innerHTML = html;
        tip.hidden = false;
        if (current && current !== target) current.removeAttribute("aria-describedby");
        current = target;
        target.setAttribute("aria-describedby", tip.id);   // read out as the step's description
        const h = host.getBoundingClientRect(), b = target.getBoundingClientRect();
        const left = Math.min(Math.max(b.left - h.left + b.width / 2 - tip.offsetWidth / 2, 4),
                              Math.max(4, host.clientWidth - tip.offsetWidth - 4));
        const above = b.top - h.top - tip.offsetHeight - 8;
        tip.style.left = `${left}px`;
        tip.style.top = `${above > 0 ? above : b.bottom - h.top + 8}px`;
      },
      hide() { clearTimeout(timer); timer = setTimeout(hideNow, 150); },
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
  // A force-directed graph (d3-force). Studies drift to islands by tag (studies schemas/tags.yaml);
  // chips filter by a study's tags plus its reports'. Arrows run from the earlier study to the
  // one that builds on it, for every kind of relationship.
  const KINDS = {
    motivation: { label: "Motivated", verb: "motivated", hint: "an earlier result this study follows up (motivated_by)" },
    upstream: { label: "Cited by", verb: "is cited by", hint: "a later report uses this study's results (upstream)" },
    corrects: { label: "Corrected by", verb: "is corrected by", hint: "a later report amends this report (corrects)" },
    supersedes: { label: "Superseded by", verb: "is superseded by", hint: "a later report replaces this one (superseded_by)" },
  };
  const LAYERS = { motivation: true, upstream: true, corrects: true, supersedes: true };
  const PHYS_DEFAULT = { link: 0.15, distance: 110, repel: 400, island: 0.25, center: 0.07 };
  const SLIDERS = [
    ["link", "Link pull", 0, 1, 0.01, "how strongly linked studies attract"],
    ["distance", "Link length", 30, 260, 5, "rest length of a link"],
    ["repel", "Repel", 0, 1500, 10, "how hard every study pushes the others away"],
    ["island", "Island pull", 0, 1, 0.01, "how strongly a study is drawn to its tag's island (islands on)"],
    ["center", "Centre pull", 0, 0.5, 0.01, "how strongly studies are drawn to the middle (islands off)"],
  ];
  const label = (s) => (s.purpose || s.id.slice(3)).replace(/-/g, " ");
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

  // tags: a `/` nests (`cognitive/bh` also counts as `cognitive`); a catalog without a vocabulary
  // (an older studies checkout) falls back to the model in the study's name
  const expand = (ts) => uniq(ts.flatMap((t) => t.split("/").map((_, i, a) => a.slice(0, i + 1).join("/"))));
  function vocabulary() {
    if (S.cat.tags && Object.keys(S.cat.tags).length) return S.cat.tags;
    const values = {};
    S.cat.studies.forEach((s) => { if (s.model) values[s.model] = { label: s.model, description: null }; });
    return { model: { label: "Model", description: null, values } };
  }
  const studyTags = (s, f) => expand((s.cover.tags || {})[f] || (f === "model" && !s.cover.tags && s.model ? [s.model] : []));
  const reportTags = (r, f) => expand(((r.tags || {})[f]) || []);
  const allTags = (s, f) => uniq([...studyTags(s, f), ...s.reports.flatMap((r) => reportTags(r, f))]);
  const modelColor = (t) => `var(--m-${String(t).replace(/\//g, "-")}, var(--m-other))`;
  const arrowFrom = (e) => [e.to, e.from];          // earlier -> later, whatever the kind

  function aggregate(deps, keep) {
    const edges = {};
    for (const d of deps) {
      if (d.from === d.to || !keep(d)) continue;
      (edges[`${d.from}|${d.to}|${d.kind}`] ||= { from: d.from, to: d.to, kind: d.kind, items: [] }).items.push(d);
    }
    return Object.values(edges);
  }
  const edgeTip = (e) => {
    const name = (id) => (id.startsWith("issue:") ? id.slice(6) : id.slice(0, 2));
    return `<b>${esc(KINDS[e.kind].label)}</b> · ${esc(name(e.to))} ${esc(KINDS[e.kind].verb)} ${esc(name(e.from))}
      <ul>${uniq(e.items.map((d) => `${d.to_report ? d.to_report.split("/").pop() + ": " : ""}${d.note || (d.report ? base(d.report) : "")}`))
        .slice(0, 6).map((t) => `<li>${esc(t)}</li>`).join("")}</ul>`;
  };
  function curve(a, b, ra, rb) {      // a gentle arc from a's rim to b's rim, arriving along its tangent
    const dx = b.x - a.x, dy = b.y - a.y, L = Math.hypot(dx, dy) || 1, nx = -dy / L, ny = dx / L;
    const mx = (a.x + b.x) / 2 + nx * 0.12 * L, my = (a.y + b.y) / 2 + ny * 0.12 * L;
    const sx = mx - a.x, sy = my - a.y, S0 = Math.hypot(sx, sy) || 1, ex = b.x - mx, ey = b.y - my, E = Math.hypot(ex, ey) || 1;
    return `M${a.x + sx / S0 * ra},${a.y + sy / S0 * ra} Q${mx},${my} ${b.x - ex / E * rb},${b.y - ey / E * rb}`;
  }
  const marker = (k) => `<marker id="m-${k}" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="9" markerHeight="9"
      markerUnits="userSpaceOnUse" orient="auto"><path class="mk mk-${k}" d="M0,0 L10,5 L0,10 z"/></marker>`;
  const radius = (s) => (s ? 13 + Math.sqrt(s.reports.length) * 3.2 : 10);

  A.drawMap = (host) => {
    const d3 = window.d3;
    if (!d3) { host.innerHTML = `<p class="muted">The study map needs d3, which did not load.</p>`; return; }
    const VOCAB = vocabulary(), FACETS = Object.keys(VOCAB);
    const studies = [...S.cat.studies].sort((a, b) => a.id.localeCompare(b.id));
    const layers = { ...LAYERS, ...store.get("atlas.graph.layers", {}) };
    const PHYS = { ...PHYS_DEFAULT, ...store.get("atlas.graph.forces", {}) };
    let islands = store.get("atlas.graph.islands", "model");
    if (islands !== null && !VOCAB[islands]) islands = FACETS[0] || null;
    const selected = Object.fromEntries(FACETS.map((f) => [f, new Set()]));
    const W = 1100, H = 640;

    const nodes = studies.map((s) => ({ id: s.id, s }));
    const byId = Object.fromEntries(nodes.map((n) => [n.id, n]));
    const list = aggregate(S.cat.dependencies, (d) => byId[d.from] && (byId[d.to] || d.to.startsWith("issue:")));
    list.filter((e) => !byId[e.to]).forEach((e) => { byId[e.to] = { id: e.to, issue: e.to.slice(6) }; nodes.push(byId[e.to]); });
    const links = list.map((e) => ({ e, source: byId[arrowFrom(e)[0]], target: byId[arrowFrom(e)[1]] }));

    const chips = FACETS.map((f) => `<div class="facet"><span class="facet-name" title="${esc(VOCAB[f].description || "")}">${esc(VOCAB[f].label)}</span>
        ${Object.entries(VOCAB[f].values).filter(([v]) => studies.some((s) => allTags(s, f).includes(v))).map(([v, d]) =>
          `<button type="button" class="tag-chip" data-f="${esc(f)}" data-v="${esc(v)}" aria-pressed="false"
            title="${esc(d.description || d.label)}">${f === "model" ? `<span class="dot" style="background:${modelColor(v)}"></span>` : ""}${esc(d.label)}</button>`).join("")}</div>`).join("");
    host.innerHTML = `
      <div class="map-tools">
        <div class="facets">${chips}
          <div class="facet"><span class="facet-name">Links</span>
          ${Object.entries(KINDS).filter(([k]) => list.some((e) => e.kind === k)).map(([k, v]) =>
            `<button type="button" class="layer layer-${k}" data-kind="${k}" aria-pressed="${layers[k]}" title="${esc(v.hint)}">
              <span class="swatch"></span>${esc(v.label)}</button>`).join("")}</div>
        </div>
        <div class="map-actions">
          <button type="button" class="export" id="map-islands" aria-pressed="${!!islands}"></button>
          <button type="button" class="export" id="map-export">Export SVG</button>
        </div>
      </div>
      <div class="map-wrap graph-wrap">
        <svg id="study-map" viewBox="0 0 ${W} ${H}" role="img" aria-label="Study map: studies grouped by tag, with their relationships">
          <defs>${Object.keys(KINDS).map(marker).join("")}</defs>
          <g class="viewport"><g class="islands"></g><g class="edges"></g><g class="nodes"></g></g>
        </svg>
        <details class="forces" id="map-forces"><summary>Forces</summary>
          ${SLIDERS.map(([k, lab, lo, hi, st, tip]) => `<label title="${esc(tip)}"><span>${esc(lab)}</span>
            <input id="f-${k}" type="range" min="${lo}" max="${hi}" step="${st}" value="${PHYS[k]}"><output id="o-${k}">${PHYS[k]}</output></label>`).join("")}
          <button type="button" class="export" id="f-reset">Reset</button>
        </details>
      </div>
      <p class="muted map-hint">Drag a study to move it; pinch or Ctrl+scroll to zoom. Arrows run from a result to the work that built on it.</p>
      <div class="map-panel" id="map-panel" aria-live="polite"></div>`;
    const svg = host.querySelector("svg"), wrapEl = host.querySelector(".map-wrap"), tip = tooltip(host);
    const view = d3.select(svg).select(".viewport");
    d3.select(svg).call(d3.zoom().scaleExtent([0.4, 3]).filter((ev) => (ev.type !== "wheel" || ev.ctrlKey) && !ev.button)
      .on("zoom", (ev) => view.attr("transform", ev.transform)));

    // ---- elements
    const edgeSel = view.select(".edges").selectAll("g").data(links).join("g")
      .attr("class", (l) => `edge e-${l.e.kind}${layers[l.e.kind] ? "" : " off"}`)
      .attr("data-from", (l) => l.e.from).attr("data-to", (l) => l.e.to);
    edgeSel.append("path").attr("class", "hit");
    edgeSel.append("path").attr("class", "line").attr("marker-end", (l) => `url(#m-${l.e.kind})`)
      .style("stroke-width", (l) => `${1.2 + Math.sqrt(l.e.items.length) * 0.9}px`);
    const nodeSel = view.select(".nodes").selectAll("g").data(nodes).join("g")
      .attr("class", (n) => (n.s ? `node st-${n.s.cover.status || "unknown"}` : "node issue"))
      .attr("data-id", (n) => n.id).attr("tabindex", (n) => (n.s ? 0 : null)).attr("role", (n) => (n.s ? "button" : null))
      .attr("aria-label", (n) => (n.s ? `${n.id}, ${n.s.cover.status || "status unknown"}` : `issue ${n.issue}`));
    nodeSel.filter((n) => n.s).each(function (n) {
      const g = d3.select(this), r = radius(n.s);
      const own = (n.s.cover.tags || {}).model || (n.s.model ? [n.s.model] : []);
      g.append("circle").attr("class", "body").attr("r", r).style("fill", modelColor(own[0] || "other"));
      if (own[1]) g.append("circle").attr("class", "ring").attr("r", r + 4).style("stroke", modelColor(own[1]));
      g.append("text").attr("class", "nn").attr("text-anchor", "middle").attr("dy", "0.35em").text(n.id.slice(0, 2));
      wrap(label(n.s)).forEach((l, k) => g.append("text").attr("class", "lbl").attr("text-anchor", "middle").attr("y", r + 15 + k * 13).text(l));
    });
    nodeSel.filter((n) => !n.s).each(function (n) {
      const g = d3.select(this);
      g.append("rect").attr("x", -22).attr("y", -10).attr("width", 44).attr("height", 20).attr("rx", 10);
      g.append("text").attr("class", "lbl").attr("text-anchor", "middle").attr("y", 4).text(`#${String(n.issue).split("#").pop()}`);
    });

    // ---- physics
    let anchors = {};
    const placeAnchors = () => {
      anchors = {};
      if (!islands) return;
      const vals = Object.keys(VOCAB[islands].values), R = Math.min(W, H) * 0.36;
      vals.forEach((v, i) => { const a = -Math.PI / 2 + (2 * Math.PI * i) / vals.length; anchors[v] = { x: W / 2 + R * Math.cos(a), y: H / 2 + R * Math.sin(a) }; });
    };
    const goal = (n, ax) => {
      const ts = n.s ? studyTags(n.s, islands).filter((t) => anchors[t]) : [];
      if (!ts.length) return ax === "x" ? W / 2 : H / 2;
      return ts.reduce((a, t) => a + anchors[t][ax], 0) / ts.length;
    };
    const sim = d3.forceSimulation(nodes)
      .force("link", d3.forceLink(links)).force("charge", d3.forceManyBody())
      .force("collide", d3.forceCollide((n) => radius(n.s) + 16)).force("x", d3.forceX()).force("y", d3.forceY());
    function applyForces() {
      sim.force("link").distance(PHYS.distance).strength(PHYS.link);
      sim.force("charge").strength(-PHYS.repel);
      sim.force("x").x((n) => (islands ? goal(n, "x") : W / 2)).strength(islands ? PHYS.island : PHYS.center);
      sim.force("y").y((n) => (islands ? goal(n, "y") : H / 2)).strength(islands ? PHYS.island : PHYS.center);
      sim.alpha(0.7).restart();
    }
    nodeSel.call(d3.drag()
      .on("start", (ev, n) => { if (!ev.active) sim.alphaTarget(0.25).restart(); n.fx = n.x; n.fy = n.y; })
      .on("drag", (ev, n) => { n.fx = ev.x; n.fy = ev.y; })
      .on("end", (ev, n) => { if (!ev.active) sim.alphaTarget(0); n.fx = n.fy = null; }));

    const matches = (n) => !n.s ? true : FACETS.every((f) => !selected[f].size || allTags(n.s, f).some((t) => selected[f].has(t)));
    function drawIslands() {
      const g = view.select(".islands");
      if (!islands) { g.selectAll("*").remove(); return; }
      const chosen = selected[islands];
      const all = Object.keys(VOCAB[islands].values).filter((v) => !chosen.size || chosen.has(v))
        .map((v) => ({ v, pts: nodes.filter((n) => n.s && matches(n) && studyTags(n.s, islands).includes(v)) })).filter((x) => x.pts.length);
      const key = (x) => x.pts.map((n) => n.id).join();
      const groups = all.filter((x) => !all.some((y) => y !== x && y.v.startsWith(x.v + "/") && key(y) === key(x)));
      g.selectAll("g").data(groups, (x) => x.v).join((e) => { const k = e.append("g").attr("class", "island"); k.append("path"); k.append("text"); return k; })
        .each(function (x) {
          const pts = x.pts.flatMap((n) => { const r = radius(n.s) + 24; return d3.range(10).map((i) => [n.x + r * Math.cos(i * Math.PI / 5), n.y + r * Math.sin(i * Math.PI / 5)]); });
          const hull = d3.polygonHull(pts), c = d3.polygonCentroid(hull), top = d3.min(hull, (p) => p[1]);
          const col = islands === "model" ? modelColor(x.v) : "var(--accent)";
          d3.select(this).select("path").attr("d", d3.line().curve(d3.curveCatmullRomClosed)(hull)).style("fill", col).style("stroke", col);
          d3.select(this).select("text").attr("x", c[0]).attr("y", Math.max(14, top - 6)).style("fill", col)
            .text(VOCAB[islands].values[x.v].label);
        });
    }
    sim.on("tick", () => {
      nodes.forEach((n) => { const r = radius(n.s) + 30; n.x = Math.max(r, Math.min(W - r, n.x)); n.y = Math.max(r, Math.min(H - r - 10, n.y)); });
      nodeSel.attr("transform", (n) => `translate(${n.x},${n.y})`);
      edgeSel.selectAll("path").attr("d", (l) => curve(l.source, l.target, radius(l.source.s) + 2, radius(l.target.s) + (l.target.s && studyTags(l.target.s, "model").length > 1 ? 7 : 3)));
      drawIslands();
    });

    // ---- filters, highlight, panel
    let focused = store.get("atlas.map.focus", null);
    if (focused && !S.study[focused]) focused = null;
    function paint() {
      nodeSel.classed("dim", (n) => !matches(n));
      edgeSel.classed("dim", (l) => !matches(l.source) || !matches(l.target));
      drawIslands();
    }
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
    const tagLine = (s) => FACETS.map((f) => studyTags(s, f).filter((t) => !studyTags(s, f).some((o) => o.startsWith(t + "/")))
      .map((t) => VOCAB[f].values[t]?.label || t).join(", ")).filter(Boolean).join(" · ");
    const matchedBy = (s) => FACETS.flatMap((f) => [...selected[f]].map((t) => {
      const rs = s.reports.filter((r) => reportTags(r, f).includes(t)).map((r) => r.id);
      return rs.length ? `${VOCAB[f].values[t]?.label || t}: ${rs.join(", ")}` : null;
    })).filter(Boolean);
    const studyTip = (s) => `<b>${esc(s.id)}</b> ${statusChip(s.cover.status)}
      ${tagLine(s) ? `<div class="tip-tags">${esc(tagLine(s))}</div>` : ""}
      ${s.cover.question ? `<div>${esc(s.cover.question)}</div>` : ""}
      ${matchedBy(s).length ? `<div class="tip-v">Matching reports · ${esc(matchedBy(s).join("; "))}</div>` : ""}`;
    nodeSel.each(function (n) {
      const g = this, s = n.s;
      const show = () => { light(n.id); if (s) tip.show(g, studyTip(s)); };
      const hide = () => { tip.hide(); light(focused); };
      g.addEventListener("pointerenter", show);
      g.addEventListener("pointerleave", hide);
      g.addEventListener("focus", show);
      g.addEventListener("blur", hide);
      if (!s) return;
      const pick = () => { focused = focused === s.id ? null : s.id; store.set("atlas.map.focus", focused); panel(); light(focused); };
      g.addEventListener("click", (ev) => { if (ev.defaultPrevented) return; ev.stopPropagation(); pick(); });
      g.addEventListener("keydown", (ev) => { if (ev.key === "Enter" || ev.key === " ") { ev.preventDefault(); pick(); } });
    });
    edgeSel.each(function (l) {
      this.addEventListener("pointerenter", () => tip.show(this, edgeTip(l.e)));
      this.addEventListener("pointerleave", () => tip.hide());
      this.addEventListener("click", (ev) => { ev.stopPropagation(); tip.show(this, edgeTip(l.e)); });
    });
    wrapEl.addEventListener("click", () => tip.hide());
    host.querySelectorAll(".tag-chip").forEach((b) => b.addEventListener("click", () => {
      const set = selected[b.dataset.f], v = b.dataset.v;
      set.has(v) ? set.delete(v) : set.add(v);
      b.setAttribute("aria-pressed", String(set.has(v)));
      paint();
    }));
    host.querySelectorAll(".layer").forEach((b) => b.addEventListener("click", () => {
      const k = b.dataset.kind;
      layers[k] = !layers[k];
      b.setAttribute("aria-pressed", String(layers[k]));
      svg.querySelectorAll(`.e-${k}`).forEach((g) => g.classList.toggle("off", !layers[k]));
      store.set("atlas.graph.layers", layers);
    }));
    const cycle = [...FACETS, null];
    const islandsBtn = host.querySelector("#map-islands");
    const islandsLabel = () => { islandsBtn.textContent = `Islands: ${islands ? VOCAB[islands].label : "off"}`; islandsBtn.setAttribute("aria-pressed", String(!!islands)); };
    islandsBtn.addEventListener("click", () => {
      islands = cycle[(cycle.indexOf(islands) + 1) % cycle.length];
      store.set("atlas.graph.islands", islands);
      islandsLabel(); placeAnchors(); applyForces(); drawIslands();
    });
    const forces = host.querySelector("#map-forces");
    SLIDERS.forEach(([k]) => {
      const input = forces.querySelector(`#f-${k}`);
      input.addEventListener("input", () => {
        PHYS[k] = +input.value; forces.querySelector(`#o-${k}`).textContent = input.value;
        store.set("atlas.graph.forces", PHYS); applyForces();
      });
    });
    forces.querySelector("#f-reset").addEventListener("click", () => {
      Object.assign(PHYS, PHYS_DEFAULT); store.set("atlas.graph.forces", PHYS);
      SLIDERS.forEach(([k]) => { forces.querySelector(`#f-${k}`).value = PHYS[k]; forces.querySelector(`#o-${k}`).textContent = PHYS[k]; });
      applyForces();
    });
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
        el.innerHTML = `<p class="muted">Select a study to see why it exists, what it led to, what it uses, and its reports.</p>`;
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
        ${tagLine(s) ? `<p class="muted">${esc(tagLine(s))}</p>` : ""}
        ${s.cover.question ? `<p>${esc(s.cover.question)}</p>` : ""}
        ${s.cover.verdict ? `<p class="muted">Verdict: ${esc(s.cover.verdict)}</p>` : ""}
        <div class="rels">
          ${relList("Motivated by", motivated)}${relList("Led to", ledTo)}
          ${relList("Uses results from", uses)}${relList("Used by", usedBy)}${relList("Corrections", corr)}
          ${relList(`Reports (${s.reports.length})`, reports)}
        </div>`;
      el.querySelector(".panel-close").addEventListener("click", () => { focused = null; store.set("atlas.map.focus", null); panel(); light(null); });
    }
    islandsLabel();
    placeAnchors();
    applyForces();
    paint();
    panel();
    light(focused);
  };

  // ------------------------------------------------------------ local graph (study page)
  // One study in the middle: what it builds on (left) and what built on it (right).
  A.drawLocal = (host, sid) => {
    const s0 = S.study[sid];
    if (!s0) return;
    const list = aggregate(S.cat.dependencies, (d) => (d.from === sid && (S.study[d.to] || d.to.startsWith("issue:"))) || (d.to === sid && S.study[d.from]));
    const back = uniq(list.filter((e) => e.from === sid).map((e) => e.to));
    const fwd = uniq(list.filter((e) => e.to === sid).map((e) => e.from)).filter((id) => !back.includes(id));
    if (!list.length) { host.innerHTML = `<p class="muted">This study has no relationships to other studies yet.</p>`; return; }
    const W = 900, colX = 300, gap = 54, rows = Math.max(back.length, fwd.length, 1), H = Math.max(200, 80 + rows * gap);
    const cx = W / 2, cy = 30 + (H - 30) / 2, pos = { [sid]: { x: cx, y: cy } };
    const column = (ids, x) => ids.forEach((id, i) => { pos[id] = { x, y: cy + (i - (ids.length - 1) / 2) * gap }; });
    column(back, cx - colX);
    column(fwd, cx + colX);
    const rOf = (id) => (S.study[id] ? radius(S.study[id]) + (id === sid ? 6 : 0) : 12);
    const nodeSvg = Object.keys(pos).map((id) => {
      const p = pos[id], s = S.study[id];
      if (!s) return `<g class="node issue" data-id="${esc(id)}" transform="translate(${p.x},${p.y})">
          <rect x="-22" y="-10" width="44" height="20" rx="10"/><text class="lbl" text-anchor="middle" y="4">#${esc(id.slice(6).split("#").pop())}</text></g>`;
      const own = (s.cover.tags || {}).model || (s.model ? [s.model] : []);
      return `<g class="node st-${esc(s.cover.status || "unknown")}${id === sid ? " focused" : ""}" data-id="${esc(id)}" transform="translate(${p.x},${p.y})"
          ${id === sid ? "" : `tabindex="0" role="link" aria-label="${esc(id)}"`}>
        <circle class="body" r="${rOf(id)}" style="fill:${modelColor(own[0] || "other")}"/>
        ${own[1] ? `<circle class="ring" r="${rOf(id) + 4}" style="stroke:${modelColor(own[1])}"/>` : ""}
        <text class="nn" text-anchor="middle" dy="0.35em">${esc(id.slice(0, 2))}</text>
        ${wrap(label(s)).map((l, k) => `<text class="lbl" text-anchor="middle" y="${rOf(id) + 15 + k * 13}">${esc(l)}</text>`).join("")}</g>`;
    }).join("");
    const edgeSvg = list.map((e, i) => {
      const [a, b] = arrowFrom(e);
      const d = curve(pos[a], pos[b], rOf(a) + 2, rOf(b) + 3);
      return `<g class="edge e-${e.kind}" data-i="${i}"><path class="hit" d="${d}"/><path class="line" d="${d}" marker-end="url(#m-${e.kind})"
        style="stroke-width:${1.2 + Math.sqrt(e.items.length) * 0.9}px"/></g>`;
    }).join("");
    host.innerHTML = `<div class="map-tools"><span class="muted">Left: what this study builds on. Right: what built on it.</span>
        <button type="button" class="export" id="local-export">Export SVG</button></div>
      <div class="map-wrap"><svg id="local-map" viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(sid)} and the studies it connects to">
        <defs>${Object.keys(KINDS).map(marker).join("")}</defs>
        <text class="col-label" x="12" y="20">Builds on</text><text class="col-label" x="${W - 12}" y="20" text-anchor="end">Followed up by</text>
        ${edgeSvg}${nodeSvg}</svg></div>`;
    const svg = host.querySelector("svg"), tip = tooltip(host);
    svg.querySelectorAll(".edge").forEach((g) => {
      const e = list[+g.dataset.i];
      g.addEventListener("pointerenter", () => tip.show(g, edgeTip(e)));
      g.addEventListener("pointerleave", () => tip.hide());
      g.addEventListener("click", (ev) => { ev.stopPropagation(); tip.show(g, edgeTip(e)); });
    });
    svg.querySelectorAll(".node[tabindex]").forEach((g) => {
      const go = () => { location.hash = `#/study/${g.dataset.id}`; };
      g.addEventListener("click", go);
      g.addEventListener("keydown", (ev) => { if (ev.key === "Enter" || ev.key === " ") { ev.preventDefault(); go(); } });
    });
    host.querySelector("#local-export").addEventListener("click", () => { tip.hide(); downloadSvg(svg, `study-${sid.slice(0, 2)}-${short(S.sha)}.svg`); });
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
    // an input is linked at the revision of the producer that read it (as in the detail list)
    const readAt = {};
    arts.forEach((a) => (a.meta?.inputs || []).forEach((i) => { readAt[i.path] ||= a.meta?.studies_git_sha || undefined; }));
    const freezes = inputs.map((p) => S.artifactByPath[p]).filter((a) => a?.meta?.kind === "freeze");
    const items = inputs.map((p) => {
      const st = studyOfPath(p), cross = st && st !== r._study, art = S.artifactByPath[p];
      if (cross) {
        // the upstream report whose inputs name this file; ambiguous or unknown -> the study page
        const ups = r.upstream.filter((u) => u.study === st && u.report).map((u) => S.reportByKey[`${st}/${u.report}`]).filter(Boolean);
        const named = ups.filter((u) => u.inputs.some((i) => i.path === p));
        const to = named.length === 1 ? named[0] : ups.length === 1 && !named.length ? ups[0] : null;
        return { text: base(p), sub: `study ${st.slice(0, 2)}`, xref: true,
          href: to ? `#/report/${to._study}/${to.id}` : `#/study/${st}` };
      }
      return { text: base(p), sub: art?.meta?.kind === "freeze" ? "freeze" : "committed input", link: srcLink(p, base(p), readAt[p]) };
    });
    const plain = inputs.filter((p) => (!studyOfPath(p) || studyOfPath(p) === r._study) && S.artifactByPath[p]?.meta?.kind !== "freeze");
    set("query", !inputs.length ? "gap" : plain.length ? "partial" : "ok", items,
      !inputs.length ? (v2.length ? "The producer recorded no inputs." : "_meta v1 records no input digests.")
        : plain.length ? `${plain.length} input${plain.length > 1 ? "s are" : " is"} a committed file whose freeze is not recorded (studies#25).`
        : "Every input is a freeze or another study's result, each by digest.");
    const groups = uniq([...arts, ...freezes].flatMap((a) => a.meta?.wandb_groups || []));
    set("tracking", groups.length ? "ok" : "gap",
      groups.map((g) => ({ text: g, href: `#/group/${encodeURIComponent(g)}` })),
      groups.length ? "Pinned by exact name; one launch mints one group (ADR 0001)." : "No W&B group is recorded for this result.");
    const recsOf = (g) => (S.cat.wandb_groups[g]?.launch_records || []).map((p) => S.recordByPath[p]).filter(Boolean);
    const recs = uniq(groups.flatMap(recsOf));
    const json = recs.filter((x) => x.format === "json");
    const kinds = uniq(json.map((x) => x.kind || "launch"));
    const older = recs.length - json.length;
    // fully recorded only when every group has a JSON launch record (older YAML copies carry no
    // kind, jobs or commits)
    set("compute", !recs.length ? "gap" : groups.every((g) => recsOf(g).some((x) => x.format === "json")) ? "ok" : "partial",
      [...(json.length ? [{ text: `${json.length} launch record${json.length > 1 ? "s" : ""}`, sub: kinds.join(", ") }] : []),
       ...(older ? [{ text: `${older} older record file${older > 1 ? "s" : ""}`, sub: "pre-JSON manifests" }] : [])],
      !recs.length ? (groups.length ? "No launch record names these groups." : "No W&B group, so no launch to find.")
        : json.length ? "Every launch and intervention writes a launch record." : "Only older record files (copied manifests), without the launch's kind, jobs or commits.");
    // Per variant: the manifests its launch records snapshot (named relative to the variant, as the
    // studies launchers write them), or else the variant's files as they are now, marked so.
    const variantOf = (x) => S.study[x._study]?.variants.find((v) => v.name === x._variant);
    const resolve = (x, m) => (m.startsWith("studies/") ? m
      : `${variantOf(x)?.path || S.study[x._study]?.path}/${m.replace(/^\.\//, "")}`);
    const byVariant = {};
    recs.forEach((x) => { (byVariant[`${x._study}/${x._variant}`] ||= []).push(x); });
    let snapshotted = 0;
    const expItems = Object.values(byVariant).flatMap((xs) => {
      // a manifest as submitted is the file at the launch's recorded studies revision
      const recorded = uniq(xs.filter((x) => x.format === "json").flatMap((x) =>
        (x.manifests || []).map((m) => `${resolve(x, m)}@${x.revisions?.studies || ""}`)));
      // a snapshot needs the revision it was submitted at; without one the link shows today's file
      if (recorded.length && recorded.every((k) => k.split("@")[1])) {
        snapshotted++;
        return recorded.map((k) => { const [m, sha] = k.split("@");
          return { text: base(m), sub: `at ${short(sha)}`, link: srcLink(m, base(m), sha) }; });
      }
      if (recorded.length) return recorded.map((k) => { const [m, sha] = k.split("@");
        return sha ? { text: base(m), sub: `at ${short(sha)}`, link: srcLink(m, base(m), sha) }
                   : { text: base(m), sub: "current file", link: srcLink(m, base(m)) }; });
      return (variantOf(xs[0])?.manifests || []).map((m) => ({ text: base(m), sub: "current file", link: srcLink(m, base(m)) }));
    });
    const nVariants = Object.keys(byVariant).length;
    set("experiment", !nVariants ? "gap" : snapshotted === nVariants ? "ok" : expItems.length ? "partial" : "gap", expItems,
      !nVariants ? "No launch record to read manifests from."
        : snapshotted === nVariants ? "Manifests as submitted, copied into the launch record."
        : "Some launches did not snapshot their manifests; those show the variant's files as they are now, which may have changed since.");
    // Model & image and Data: what the launch recorded (studies#25), else what a provenance
    // freeze recovered from W&B runs and Beaker jobs (studies#28), else not recorded.
    const recovered = (g) => S.cat.wandb_groups[g]?.recovered || null;
    const when = (rv) => `recovered ${String(rv.recovered_at_pt || "").slice(0, 10)}`;
    const recordsOf = (g) => recsOf(g).filter((x) => x.format === "json");
    // recovered values count as known only when they cover every run of the group
    const covers = (rv, entries) => !!rv && entries.reduce((n, e) => n + (e.n_runs || 0), 0) >= (rv.n_runs || Infinity);
    // a launch-record value is complete only when every JSON launch record of the group has it
    const imageOf = (g) => {
      const recs = recordsOf(g), atLaunch = recs.map((x) => x.image).filter((i) => i && (i.id || i.lock_sha256));
      if (atLaunch.length && atLaunch.length === recs.length)
        return { items: atLaunch.map((i) => ({ id: i.id || i.lock_sha256, how: "at launch" })), all: true };
      const rv = recovered(g), known = (rv?.image || []).filter((i) => i.id);
      return { items: [...atLaunch.map((i) => ({ id: i.id || i.lock_sha256, how: "at launch" })),
                       ...known.map((i) => ({ id: i.id, how: when(rv) + (i.via && i.via !== "beaker job" ? ` via ${i.via}` : "") }))],
               all: covers(rv, known) };
    };
    const revsOf = (g) => {
      // per repository: the launch records' commits, complete only when every record has one;
      // otherwise the recovered commits fill the gap, and both sources stay labelled
      const recs = recordsOf(g), out = {};
      recs.forEach((x) => Object.entries(x.revisions || {}).forEach(([k, v]) => {
        if (!v) return;
        const r = (out[k] ||= { shas: new Set(), how: "at launch", n: 0 });
        r.shas.add(v); r.n += 1; }));
      Object.values(out).forEach((r) => { r.all = r.n === recs.length; });
      const rv = recovered(g);
      Object.entries(rv?.revisions || {}).forEach(([k, shas]) => {
        const r = out[k];
        if (r?.all) return;
        const got = { shas: new Set(Object.keys(shas)), how: when(rv), all: covers(rv, Object.values(shas).map((n) => ({ n_runs: n }))) };
        out[k] = r ? { shas: new Set([...r.shas, ...got.shas]), how: `${r.how}; ${got.how}`, all: got.all } : got;
      });
      return out;
    };
    const modelItems = [], modelHas = groups.map((g) => {
      const img = imageOf(g), revs = revsOf(g);
      Object.entries(revs).forEach(([k, v]) => modelItems.push({ text: `${k} ${[...v.shas].map(short).join(", ")}`, sub: v.how }));
      img.items.forEach((i) => modelItems.push({ text: `image ${short(i.id)}`, sub: i.how }));
      // the training code: the wrapper that trained and the dispatcher config it ran
      return { image: img.items.length > 0 && img.all,
               code: ["wrapper", "dispatcher"].every((k) => revs[k]) && Object.values(revs).every((v) => v.all),
               any: img.items.length > 0 || Object.keys(revs).length > 0 };
    });
    const modelUniq = uniq(modelItems.map((i) => JSON.stringify(i))).map((s) => JSON.parse(s));
    set("model", !groups.length || !modelHas.some((h) => h.any) ? "gap"
        : modelHas.every((h) => h.image && h.code) ? "ok" : "partial", modelUniq,
      !groups.length ? "No W&B group, so no launch to read commits or an image from."
        : modelHas.every((h) => h.image && h.code)
          ? "Code commits and the exact image id are known for every group (at launch, or recovered from W&B and Beaker)."
          : modelHas.some((h) => h.any)
            ? "Known only in part: some groups, repositories or runs predate recording and could not be recovered (studies#25, #28)."
            : "Not recorded at launch and not recovered (studies#25, #28).");
    const dataOf = (g) => {
      const recs = recordsOf(g), atLaunch = recs.map((x) => x.data).filter(Boolean);
      if (atLaunch.length && atLaunch.length === recs.length) return { ds: atLaunch.map((d) => ({ ...d, how: "at launch" })), all: true };
      const rv = recovered(g), ds = (rv?.data || []).map((d) => ({ ...d, how: when(rv) }));
      return { ds: [...atLaunch.map((d) => ({ ...d, how: "at launch" })), ...ds], all: covers(rv, ds) };
    };
    const dataItems = [], dataState = groups.map((g) => {
      const { ds, all } = dataOf(g);
      ds.forEach((d) => dataItems.push(d.source === "snapshot"
        ? { text: `snapshot ${d.snapshot}`, sub: `${d.manifest_sha256 ? `manifest ${short(d.manifest_sha256)}, ` : ""}${d.how}` }
        : { text: d.source === "live" ? "live database" : d.source === "external" ? `external: ${d.config}`
              : d.source === "generated" ? "generated" : "not logged",
            sub: d.how }));
      if (!ds.length) return "none";
      // an external dataset is named but not digested: known, not pinned
      return all && ds.every((d) => (d.source === "snapshot" && d.manifest_sha256) || d.source === "generated")
        ? "pinned" : "partial";
    });
    set("data", !groups.length || dataState.every((s) => s === "none") ? "gap"
        : dataState.every((s) => s === "pinned") ? "ok" : "partial",
      uniq(dataItems.map((i) => JSON.stringify(i))).map((s) => JSON.parse(s)),
      !groups.length || dataState.every((s) => s === "none") ? "Not recorded at launch and not recovered (studies#25, #28)."
        : dataState.every((s) => s === "pinned") ? "A dated database snapshot, identified by the digest of its manifest."
        : dataItems.some((i) => i.text === "live database")
          ? "Some runs read the live database (before snapshots existed), so their exact data cannot be fetched again."
        : dataItems.some((i) => i.text.startsWith("external:"))
          ? "An external dataset is named, but no digest pins its contents."
          : "Known only in part: some groups or runs have no digested snapshot, or the recovery does not cover every run.");
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
      li.addEventListener("pointerenter", (ev) => { if (ev.pointerType !== "touch") tip.show(li, html); });
      li.addEventListener("pointerleave", (ev) => { if (ev.pointerType !== "touch") tip.hide(); });
      li.addEventListener("focus", () => tip.show(li, html));
      li.addEventListener("blur", () => tip.hide());
      li.addEventListener("click", (ev) => { if (!ev.target.closest("a, button")) tip.show(li, html); });
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
    // widen to the longest row so no provenance label is clipped
    const right = Math.max(...[...svg.querySelectorAll("text")].map((t) => t.getBBox().x + t.getComputedTextLength()));
    if (right + 24 > W) { svg.setAttribute("viewBox", `0 0 ${Math.ceil(right + 24)} ${H}`); svg.style.width = `${Math.ceil(right + 24)}px`; }
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
