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
  // With `dock` it sits in the top-left corner of that element's visible part instead of over the target, so it never
  // covers a study being dragged.
  let tipCount = 0;
  function tooltip(host, { dock } = {}) {
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
    // docked: the top-left of the part of the map on screen, below the sticky header, kept there on scroll
    const place = () => {
      const h = host.getBoundingClientRect(), d = dock.getBoundingClientRect();
      // the header is sticky only on wide screens; on phones it scrolls away and the viewport's top is the edge
      const edge = Math.max(0, document.querySelector(".top")?.getBoundingClientRect().bottom ?? 0);
      // with little of the map left on screen it overhangs the map's bottom rather than cover the header
      const top = Math.max(edge, Math.min(Math.max(d.top, edge), d.bottom - tip.offsetHeight - 16));
      tip.style.left = `${d.left - h.left + 8}px`;
      tip.style.top = `${top - h.top + 8}px`;
    };
    if (dock) {
      const follow = () => {
        if (!host.isConnected) { removeEventListener("scroll", follow); removeEventListener("resize", follow); }
        else if (!tip.hidden) place();
      };
      addEventListener("scroll", follow, { passive: true });
      addEventListener("resize", follow);
    }
    return {
      show(target, html) {
        clearTimeout(timer);
        tip.innerHTML = html;
        tip.hidden = false;
        if (current && current !== target) current.removeAttribute("aria-describedby");
        current = target;
        target.setAttribute("aria-describedby", tip.id);   // read out as the step's description
        if (dock) return place();
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
                 "stroke-linecap", "paint-order", "opacity", "font-size", "font-weight", "font-family"];
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
  Object.assign(A, { tooltip, downloadSvg });      // shared with the About page (about.js)

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
  const PHYS_DEFAULT = { link: 0.15, distance: 110, repel: 400, island: 0.25, center: 0.07, hold: 0.6 };
  const SLIDERS = [
    ["link", "Link pull", 0, 1, 0.01, "how strongly linked studies attract"],
    ["distance", "Link length", 30, 260, 5, "rest length of a link"],
    ["repel", "Repel", 0, 1500, 10, "how hard every study pushes the others away"],
    ["island", "Island pull", 0, 1, 0.01, "how strongly a study is drawn to its tag's island (islands on)"],
    ["center", "Centre pull", 0, 0.5, 0.01, "how strongly studies are drawn to the middle (islands off)"],
    ["hold", "Drag hold", 0, 1, 0.05, "how much a study you drag stays where you drop it (0: springs back, 1: stays); Reset lets them all go"],
  ];
  // the study's whole name after its number, model included ("gru vs disrnn embedding recovery"),
  // wrapped but never cut short
  const label = (s) => s.id.slice(3).replace(/-/g, " ");
  function wrap(text, n = 17) {
    const lines = [""];
    for (const w of text.split(" ")) {
      if ((lines[lines.length - 1] + " " + w).trim().length > n && lines[lines.length - 1]) lines.push(w);
      else lines[lines.length - 1] = (lines[lines.length - 1] + " " + w).trim();
    }
    return lines;
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
  // tag values are data: only CSS identifier characters reach the style attribute
  const modelColor = (t) => `var(--m-${String(t).replace(/[^A-Za-z0-9_-]/g, "-")}, var(--m-other))`;
  const arrowFrom = (e) => [e.to, e.from];          // earlier -> later, whatever the kind

  function aggregate(deps, keep) {
    const edges = {};
    for (const d of deps) {
      if (d.from === d.to || !keep(d)) continue;
      (edges[`${d.from}|${d.to}|${d.kind}`] ||= { from: d.from, to: d.to, kind: d.kind, items: [] }).items.push(d);
    }
    // links between the same two studies bend apart, so each keeps its own hover target
    const pairs = {};
    return Object.values(edges).map((e) => {
      const k = [e.from, e.to].sort().join("|"), i = (pairs[k] = (pairs[k] ?? -1) + 1);
      // line weight counts the distinct reports behind a link: the declaring report, or for a
      // supersession (declared on the replaced report) the report replaced; a motivation is one
      return { ...e, bend: 0.12 + 0.16 * i, weight: uniq(e.items.map((d) => d.report || d.to_report || "")).length };
    });
  }
  const edgeTip = (e) => {
    const name = (id) => (id.startsWith("issue:") ? id.slice(6) : id.slice(0, 2));
    return `<b>${esc(KINDS[e.kind].label)}</b> · ${esc(name(e.to))} ${esc(KINDS[e.kind].verb)} ${esc(name(e.from))}
      <ul>${uniq(e.items.map((d) => `${d.to_report ? d.to_report.split("/").pop() + ": " : ""}${d.note || (d.report ? base(d.report) : "")}`))
        .slice(0, 6).map((t) => `<li>${esc(t)}</li>`).join("")}</ul>`;
  };
  function curve(a, b, ra, rb, bend = 0.12) {      // an arc from a's rim to b's rim, arriving along its tangent
    const dx = b.x - a.x, dy = b.y - a.y, L = Math.hypot(dx, dy) || 1, nx = -dy / L, ny = dx / L;
    const mx = (a.x + b.x) / 2 + nx * bend * L, my = (a.y + b.y) / 2 + ny * bend * L;
    const sx = mx - a.x, sy = my - a.y, S0 = Math.hypot(sx, sy) || 1, ex = b.x - mx, ey = b.y - my, E = Math.hypot(ex, ey) || 1;
    return `M${a.x + sx / S0 * ra},${a.y + sy / S0 * ra} Q${mx},${my} ${b.x - ex / E * rb},${b.y - ey / E * rb}`;
  }
  const marker = (k) => `<marker id="m-${k}" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="9" markerHeight="9"
      markerUnits="userSpaceOnUse" orient="auto"><path class="mk mk-${k}" d="M0,0 L10,5 L0,10 z"/></marker>`;
  const radius = (s) => (s ? 13 + Math.sqrt(s.reports.length) * 3.2 : 10);
  // A study's models (tags.model, else the model in its name) in the order it lists them: the
  // fill is the first, and every further one a ring outside it. The label starts below the
  // outermost ring.
  const modelsOf = (s) => (s.cover.tags || {}).model || (s.model ? [s.model] : []);
  const ringsOf = (s, r) => modelsOf(s).slice(1).map((t, i) => ({ t, r: r + 4 + 4 * i }));
  const rimOf = (s, r) => (s ? r + 4 * Math.max(0, modelsOf(s).length - 1) : r);
  const labelY = (s, r) => Math.max(r + 15, rimOf(s, r) + 11);
  const ringSvg = (s, r) => ringsOf(s, r).map((x) => `<circle class="ring" r="${x.r}" style="stroke:${modelColor(x.t)}"/>`).join("");
  const MODEL_KEY = "Fill: a study's first model. Each ring: another model it uses or compares, in the colours of the Model chips.";

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
    for (const e of list) {          // one node per issue, however many studies it motivated
      if (!byId[e.to]) { byId[e.to] = { id: e.to, issue: e.to.slice(6) }; nodes.push(byId[e.to]); }
    }
    const links = list.map((e) => ({ e, source: byId[arrowFrom(e)[0]], target: byId[arrowFrom(e)[1]] }));

    const chips = FACETS.map((f, i) => `<div class="facet"><span class="facet-name" title="${esc(VOCAB[f].description || "")}">${esc(VOCAB[f].label)}</span>
        ${Object.entries(VOCAB[f].values).filter(([v]) => studies.some((s) => allTags(s, f).includes(v))).map(([v, d]) =>
          `<button type="button" class="tag-chip" data-f="${esc(f)}" data-v="${esc(v)}" aria-pressed="false"
            title="${esc(d.description || d.label)}">${f === "model" ? `<span class="dot" style="background:${modelColor(v)}"></span>` : ""}${esc(d.label)}</button>`).join("")}
        ${i === FACETS.length - 1 ? `<button type="button" class="tag-reset" id="map-reset" disabled title="clear every tag filter">Reset</button>` : ""}</div>`).join("");
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
      <p class="muted map-hint">Drag a study to move it (Forces › Drag hold sets how much it stays put); pinch or Ctrl+scroll to zoom. Arrows run from a result to the work that built on it.
        ${esc(MODEL_KEY)}</p>
      <div class="map-panel" id="map-panel" aria-live="polite"></div>`;
    const svg = host.querySelector("svg"), wrapEl = host.querySelector(".map-wrap"), tip = tooltip(host, { dock: wrapEl });
    const view = d3.select(svg).select(".viewport");
    d3.select(svg).call(d3.zoom().scaleExtent([0.4, 3]).filter((ev) => (ev.type !== "wheel" || ev.ctrlKey) && !ev.button)
      .on("zoom", (ev) => view.attr("transform", ev.transform)));

    // ---- elements
    const edgeSel = view.select(".edges").selectAll("g").data(links).join("g")
      .attr("class", (l) => `edge e-${l.e.kind}${layers[l.e.kind] ? "" : " off"}`)
      .attr("data-from", (l) => l.e.from).attr("data-to", (l) => l.e.to);
    edgeSel.append("path").attr("class", "hit");
    edgeSel.append("path").attr("class", "line").attr("marker-end", (l) => `url(#m-${l.e.kind})`)
      .style("stroke-width", (l) => `${1.2 + Math.sqrt(l.e.weight) * 0.9}px`);
    const nodeSel = view.select(".nodes").selectAll("g").data(nodes).join("g")
      .attr("class", (n) => (n.s ? `node st-${n.s.cover.status || "unknown"}` : "node issue"))
      .attr("data-id", (n) => n.id).attr("tabindex", (n) => (n.s ? 0 : null)).attr("role", (n) => (n.s ? "button" : null))
      .attr("aria-label", (n) => (n.s ? `${n.id}, ${n.s.cover.status || "status unknown"}` : `issue ${n.issue}`));
    nodeSel.filter((n) => n.s).each(function (n) {
      const g = d3.select(this), r = radius(n.s), lines = wrap(label(n.s)), y0 = labelY(n.s, r);
      g.append("circle").attr("class", "body").attr("r", r).style("fill", modelColor(modelsOf(n.s)[0] || "other"));
      ringsOf(n.s, r).forEach((x) => g.append("circle").attr("class", "ring").attr("r", x.r).style("stroke", modelColor(x.t)));
      g.append("text").attr("class", "nn").attr("text-anchor", "middle").attr("dy", "0.35em").text(n.id.slice(0, 2));
      lines.forEach((l, k) => g.append("text").attr("class", "lbl").attr("text-anchor", "middle").attr("y", y0 + k * 13).text(l));
      n.below = y0 + 13 * (lines.length - 1) + 6;      // how far the label reaches below the centre
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
      .force("collide", d3.forceCollide((n) => rimOf(n.s, radius(n.s)) + 16)).force("x", d3.forceX()).force("y", d3.forceY());
    function applyForces(alpha = 0.7) {
      sim.force("link").distance(PHYS.distance).strength(PHYS.link);
      sim.force("charge").strength(-PHYS.repel);
      // a study dropped by hand rests that far (Drag hold) toward where it was dropped, held at least as hard
      const pull = islands ? PHYS.island : PHYS.center;
      const rest = (n, ax) => { const g = islands ? goal(n, ax) : ax === "x" ? W / 2 : H / 2;
        return n.drop ? g + (n.drop[ax] - g) * PHYS.hold : g; };
      sim.force("x").x((n) => rest(n, "x")).strength((n) => (n.drop ? Math.max(pull, PHYS.hold) : pull));
      sim.force("y").y((n) => rest(n, "y")).strength((n) => (n.drop ? Math.max(pull, PHYS.hold) : pull));
      nodes.forEach((n) => { if (!held.has(n)) pin(n); });
      sim.alpha(alpha).restart();
    }
    // at full hold a dropped study is pinned where it was dropped; below it, only the springs above hold it.
    // Studies under a finger or the pointer (several at once on a touch screen) are left alone.
    const held = new Set();
    const pin = (n) => { const on = !!n.drop && PHYS.hold >= 1; n.fx = on ? n.drop.x : null; n.fy = on ? n.drop.y : null; };
    nodeSel.call(d3.drag()
      .on("start", (ev, n) => { if (!ev.active) sim.alphaTarget(0.25).restart(); held.add(n); n.fx = n.x; n.fy = n.y; n.moved = false; })
      .on("drag", (ev, n) => { n.fx = ev.x; n.fy = ev.y; n.moved = true; })
      .on("end", (ev, n) => {
        if (!ev.active) sim.alphaTarget(0);
        held.delete(n);
        if (n.moved) n.drop = { x: ev.x, y: ev.y };      // a click is not a drop
        pin(n);
        if (n.moved) applyForces(0.3);
      }));

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
      // kept inside the drawing, label included
      nodes.forEach((n) => { const r = radius(n.s) + 30; n.x = Math.max(r, Math.min(W - r, n.x)); n.y = Math.max(r, Math.min(H - Math.max(r + 10, n.below || 0), n.y)); });
      nodeSel.attr("transform", (n) => `translate(${n.x},${n.y})`);
      edgeSel.selectAll("path").attr("d", (l) => curve(l.source, l.target, rimOf(l.source.s, radius(l.source.s)) + 2,
        rimOf(l.target.s, radius(l.target.s)) + 3, l.e.bend));
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
    edgeSel.attr("tabindex", 0).attr("role", "button")
      .attr("aria-label", (l) => `${l.e.to} ${KINDS[l.e.kind].verb} ${l.e.from}`);
    edgeSel.each(function (l) {
      this.addEventListener("pointerenter", () => tip.show(this, edgeTip(l.e)));
      this.addEventListener("pointerleave", () => tip.hide());
      this.addEventListener("focus", () => tip.show(this, edgeTip(l.e)));
      this.addEventListener("blur", () => tip.hide());
      this.addEventListener("click", (ev) => { ev.stopPropagation(); tip.show(this, edgeTip(l.e)); });
    });
    wrapEl.addEventListener("click", () => tip.hide());
    const resetBtn = host.querySelector("#map-reset");
    const syncReset = () => { if (resetBtn) resetBtn.disabled = FACETS.every((f) => !selected[f].size); };
    host.querySelectorAll(".tag-chip").forEach((b) => b.addEventListener("click", () => {
      const set = selected[b.dataset.f], v = b.dataset.v;
      set.has(v) ? set.delete(v) : set.add(v);
      b.setAttribute("aria-pressed", String(set.has(v)));
      syncReset();
      paint();
    }));
    resetBtn?.addEventListener("click", () => {
      FACETS.forEach((f) => selected[f].clear());
      host.querySelectorAll(".tag-chip").forEach((b) => b.setAttribute("aria-pressed", "false"));
      syncReset();
      paint();
    });
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
      nodes.forEach((n) => { delete n.drop; });     // and every study let go back to its forces
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
    const rOf = (id) => (S.study[id] ? radius(S.study[id]) + (id === sid ? 6 : 0) : 12);
    // a row holds a node above its centre and its wrapped label below: space rows by the tallest
    const extent = (id) => (S.study[id] ? labelY(S.study[id], rOf(id)) + 13 * (wrap(label(S.study[id])).length - 1) + 8 : rOf(id) + 4);
    const gap = Math.max(...[...back, ...fwd].map((id) => rOf(id) + extent(id)), 40) + 10;
    // every node sits at an offset from the middle row (centred at 15 + H/2): the drawing is tall
    // enough for the lowest label's end and the highest ring, in either column or the middle
    const off = { [sid]: 0 };
    [back, fwd].forEach((ids) => ids.forEach((id, i) => { off[id] = (i - (ids.length - 1) / 2) * gap; }));
    const reach = Math.max(...Object.keys(off).map((id) => off[id] + extent(id)));
    const lift = Math.max(...Object.keys(off).map((id) => rimOf(S.study[id], rOf(id)) + 4 - off[id]));
    const W = 900, colX = 300, rows = Math.max(back.length, fwd.length, 1),
      H = Math.max(200, 80 + rows * gap, 2 * (reach + 23), 2 * (lift + 15));
    const cx = W / 2, cy = 30 + (H - 30) / 2, pos = {};
    Object.keys(off).forEach((id) => { pos[id] = { x: id === sid ? cx : back.includes(id) ? cx - colX : cx + colX, y: cy + off[id] }; });
    const nodeSvg = Object.keys(pos).map((id) => {
      const p = pos[id], s = S.study[id];
      if (!s) return `<g class="node issue" data-id="${esc(id)}" transform="translate(${p.x},${p.y})">
          <rect x="-22" y="-10" width="44" height="20" rx="10"/><text class="lbl" text-anchor="middle" y="4">#${esc(id.slice(6).split("#").pop())}</text></g>`;
      return `<g class="node st-${esc(s.cover.status || "unknown")}${id === sid ? " focused" : ""}" data-id="${esc(id)}" transform="translate(${p.x},${p.y})"
          ${id === sid ? "" : `tabindex="0" role="link" aria-label="${esc(id)}"`}>
        <circle class="body" r="${rOf(id)}" style="fill:${modelColor(modelsOf(s)[0] || "other")}"/>
        ${ringSvg(s, rOf(id))}
        <text class="nn" text-anchor="middle" dy="0.35em">${esc(id.slice(0, 2))}</text>
        ${wrap(label(s)).map((l, k) => `<text class="lbl" text-anchor="middle" y="${labelY(s, rOf(id)) + k * 13}">${esc(l)}</text>`).join("")}</g>`;
    }).join("");
    const edgeSvg = list.map((e, i) => {
      const [a, b] = arrowFrom(e);
      const d = curve(pos[a], pos[b], rimOf(S.study[a], rOf(a)) + 2, rimOf(S.study[b], rOf(b)) + 3, e.bend);
      return `<g class="edge e-${e.kind}" data-i="${i}" tabindex="0" role="button"
        aria-label="${esc(`${e.to} ${KINDS[e.kind].verb} ${e.from}`)}"><path class="hit" d="${d}"/><path class="line" d="${d}" marker-end="url(#m-${e.kind})"
        style="stroke-width:${1.2 + Math.sqrt(e.weight) * 0.9}px"/></g>`;
    }).join("");
    host.innerHTML = `<div class="map-tools"><span class="muted">Left: what this study builds on. Right: what built on it. ${esc(MODEL_KEY)}</span>
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
      g.addEventListener("focus", () => tip.show(g, edgeTip(e)));
      g.addEventListener("blur", () => tip.hide());
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
  // [key, name, what the step is]. The keys are permalink segments and stay fixed; the names are
  // plain labels, and each explanation names the CONTEXT.md term behind it.
  const HOPS = [
    ["report", "Report block", "The delimited numbers in the report: its result block."],
    ["analysis", "Analysis", "The producer that computed them and the analysis artifact it wrote, with digests of its code."],
    ["query", "Run results", "The files the producer read, by digest: run results frozen from W&B, other committed files, and other studies' results."],
    ["tracking", "Tracked runs", "The W&B group those runs belong to: one launch, one group."],
    ["compute", "Launch records", "The record of each launch and intervention on those runs: what was submitted, from which commits, and why."],
    ["experiment", "Launch manifests", "The sweep and experiment manifests the launch submitted."],
    ["model", "Code & image", "The commits of the code that trained the model, and its container image."],
    ["data", "Data snapshot", "The data snapshot the runs trained and were evaluated on."],
  ];
  const STATE = { ok: "recorded", partial: "partly recorded", gap: "not recorded" };
  const plural = (n, word) => `${n} ${word}${n === 1 ? "" : "s"}`;
  const inStudy = (p) => String(p).replace(/^studies\/[^/]+\//, "");
  // a step's details: rows of a definition list, and a titled sub-block per artifact, variant or group
  const kv = (rows) => `<dl class="kv">${rows.filter(Boolean).map(([k, v]) => `<dt>${esc(k)}</dt><dd>${v}</dd>`).join("")}</dl>`;
  const sub = (title, body) => `<div class="lin-sub"><div class="lin-sub-h">${title}</div>${body}</div>`;
  const digestList = (xs, at) => (xs.length ? `<ul class="lin-list">${xs.map((d) => `<li>${srcLink(d.path, inStudy(d.path), at)}
      <span class="muted mono">${esc(short(d.sha256))}</span></li>`).join("")}</ul>` : `<span class="muted">none</span>`);
  const groupTitle = (g) => `<a class="mono" href="#/group/${encodeURIComponent(g)}">${esc(g)}</a>`;
  // with several W&B groups each gets its own sub-block; with one, its details stand alone
  const perGroup = (parts) => (parts.length === 1 ? parts[0].html : parts.map((p) => sub(groupTitle(p.g), p.html)).join(""));

  function artifactDetail(a) {
    const m = a.meta, head = `${srcLink(a.path, inStudy(a.path))} <span class="muted mono">sha256 ${esc(short(a.sha256))}</span>`;
    if (!m) return sub(head, `<p class="muted">No <code>_meta</code> block, so the chain stops here.</p>`);
    // source links pin the producer's own studies revision (as in the report drawer's chain)
    const at = m.studies_git_sha || null;
    const revision = m.studies_git_sha ? `studies ${A.commitLink("studies", m.studies_git_sha)}`
      : m.dispatcher_git_sha ? `dispatcher ${A.commitLink("dispatcher", m.dispatcher_git_sha)}
          <span class="muted">(pre-split checkout; source links show the catalog's commit)</span>`
      : `<span class="muted">not recorded (source links show the catalog's commit)</span>`;
    const v1 = `<span class="muted">not recorded (_meta v${esc(m.schema_version)})</span>`;
    return sub(head, kv([
      ["Producer", m.produced_by ? srcLink(`${S.study[a._study].path}/${m.produced_by}`, m.produced_by, at) : "—"],
      ["Revision", revision],
      m.produced_at_pt ? ["Produced", `${esc(m.produced_at_pt)}`] : null,
      ["Code", m.schema_version === 2 ? digestList(m.code || [], at) : v1],
      ["Inputs", m.schema_version === 2 ? digestList(m.inputs || [], at) : v1],
      (m.sources || []).length ? ["Sources", m.sources.map((x) => `${esc(x.type)} <code>${esc(x.id)}</code>${x.step != null ? ` step ${esc(x.step)}` : ""}`).join("<br>")] : null,
      (m.provenance_findings || []).length ? ["Producer's findings", `<ul class="lin-list">${m.provenance_findings.map((x) => `<li>${esc(x)}</li>`).join("")}</ul>`] : null,
    ]) + `<details class="lin-raw"><summary><code>_meta</code></summary><pre>${esc(JSON.stringify(m, null, 2))}</pre></details>`);
  }

  // Launch times come as UTC or with a Pacific offset (created_utc, submitted_at, produced_at_pt),
  // some with a space for "T" or microseconds: parse to an instant, show it in Seattle time.
  const launchTime = (t) => {
    const ms = t ? Date.parse(String(t).replace(" ", "T").replace(/(\.\d{3})\d+/, "$1")) : NaN;
    return Number.isNaN(ms) ? null : ms;
  };
  const ptTime = (ms) => `${new Date(ms).toLocaleString("sv-SE", { timeZone: "America/Los_Angeles", year: "numeric",
    month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" })} PT`;

  function recordDetail(x) {
    const name = srcLink(x.path, x.path.split("/").slice(-3).join("/"));
    if (x.format !== "json") return `<li>${name} <span class="muted">older record file (a copied manifest)</span></li>`;
    const jobs = (x.job_refs || []).map((j) => (j.type === "beaker_experiment"
      ? `<a class="mono" href="https://beaker.org/ex/${esc(j.id)}" target="_blank" rel="noopener">${esc(j.id)}</a>`
      : `${esc(String(j.type ?? "job").replace(/_/g, " "))} <code>${esc(j.id)}</code>`));   // the catalog keeps job refs as written
    const ms = launchTime(x.time);
    const facts = [x.platform, ms !== null ? ptTime(ms) : x.time,
                   x.n_tasks != null ? plural(x.n_tasks, "task") : null, x.label ? `label ${x.label}` : null].filter(Boolean);
    return `<li>${name} ${chip(x.kind || "launch")} <span class="muted">${esc(facts.join(" · "))}</span>
      ${x.note ? `<div>${esc(x.note)}</div>` : ""}
      ${jobs.length ? `<div class="muted">jobs: ${jobs.join(", ")}</div>` : ""}</li>`;
  }

  // a data source as recorded at launch or recovered: every field it carries, so a new one still shows
  const DATA_KEYS = { source: "Source", type: "Type", snapshot: "Snapshot", uri: "URI", manifest_sha256: "Manifest digest",
                      build_id: "Build", n_sessions: "Sessions", n_runs: "Runs", config: "Config", how: "Recorded" };
  const dataKv = (d) => kv(Object.entries(d).filter(([, v]) => v !== null && v !== undefined && v !== "").map(([k, v]) =>
    [DATA_KEYS[k] || k.replace(/_/g, " "), typeof v === "object" ? `<code>${esc(JSON.stringify(v))}</code>`
      : typeof v === "number" ? esc(v.toLocaleString("en-US"))
      : ["uri", "manifest_sha256", "snapshot", "build_id"].includes(k) ? `<span class="mono">${esc(v)}</span>` : esc(v)]));
  // where recovered values came from, and what the recovery could not find
  function recoveredNote(rv) {
    if (!rv) return "";
    const un = Object.entries(rv.unrecovered || {});
    return `<p class="muted">Recovered ${esc(String(rv.recovered_at_pt || "").slice(0, 16).replace("T", " "))} PT from
        ${esc(plural(rv.n_runs || 0, "run"))} by ${srcLink(rv.artifact, base(rv.artifact))}.</p>
      ${un.length ? `<p class="lvl-warn">Not recovered: ${esc(un.map(([k, v]) => `${k} (${typeof v === "number" ? plural(v, "run") : JSON.stringify(v)})`).join(", "))}</p>` : ""}`;
  }

  // Checker findings sit on the step they concern: a report's by its check, an artifact, input or
  // launch record by its path, and a variant's on the step that reads files under it.
  function attachFindings(L) {
    const groups = new Set(L.groups);
    for (const f of S.findings) {
      if (f.level !== "error" && f.level !== "warn") continue;
      if (f.path === L.r.path) {
        const k = f.check === "report-group-unrecorded" ? (groups.has(f.item) ? "tracking" : null)
          : f.check === "report-input-missing" ? "query" : f.check === "report-reproduce" ? "analysis" : "report";
        if (k) L.hops[k].findings.push(f);
        continue;
      }
      const under = String(f.check).startsWith("variant-");
      const k = f.check === "variant-launch-record-dir" ? "compute" : under ? "experiment" : null;
      for (const [hk, h] of Object.entries(L.hops)) {
        if (k ? hk === k && h.paths.some((p) => p.startsWith(`${f.path}/`)) : h.paths.includes(f.path)) h.findings.push(f);
      }
    }
  }

  function buildLineage(r, block) {
    const { list: arts, how } = A.producersFor(r, block);
    const v2 = arts.filter((a) => a.meta?.schema_version === 2);
    const out = { r, block, hops: {} };
    // count: a multi-valued step's collapsed summary; paths: the files it cites, for its findings
    const set = (k, state, items, why, more = {}) => {
      out.hops[k] = { state, items, why, count: null, paths: [], detail: "", findings: [], ...more };
    };
    const blockKey = `${r.path}#${block}`;
    const declared = arts.flatMap((a) => (a.meta?.outputs || []).filter((o) => o.path === blockKey).map((o) => ({ a, o })));
    set("report", declared.length ? "ok" : "partial",
      [{ text: `${r.id} · ${block}`, sub: declared[0] ? `digest ${short(declared[0].o.sha256)}` : null, href: `#/report/${r._study}/${r.id}` }],
      declared.length ? `Its digest is in ${base(declared[0].a.path)}'s outputs, so a hand edit fails the studies CI.`
        : "No producer declares this block in _meta.outputs, so an edit by hand would go unnoticed.",
      { paths: [r.path], detail: kv([
        ["Report", `<a href="#/report/${esc(r._study)}/${esc(r.id)}">${esc(r.title)}</a>`],
        ["Source", srcLink(r.path, inStudy(r.path))],
        ["Result block", `<code>${esc(block)}</code>`],
        ["Digest", declared.length ? declared.map(({ a, o }) => `<span class="mono">${esc(short(o.sha256))}</span>
            <span class="muted">in the outputs of</span> ${srcLink(a.path, base(a.path))}`).join("<br>")
          : `<span class="muted">not declared by any producer</span>`],
        r.reproduce ? ["Reproduce", `<code>${esc(r.reproduce)}</code>`] : null,
      ]) });
    set("analysis", !arts.length ? "gap" : v2.length === arts.length ? "ok" : "partial",
      arts.map((a) => ({ text: a.meta?.produced_by ? base(a.meta.produced_by) : base(a.path),
        sub: a.meta?.schema_version === 2 ? `${(a.meta.code || []).length} code digests` : "no code digests (_meta v1)",
        link: srcLink(a.path, base(a.path)) })),
      !arts.length ? "No analysis JSON is linked to this block." : how === "inputs"
        ? "Found through the report's declared inputs, not through _meta.outputs." : "Code digests are checked in CI: an edited producer marks this stale.",
      { count: arts.length > 1 ? plural(arts.length, "analysis artifact") : null,
        paths: [...arts.map((a) => a.path), ...arts.filter((a) => a.meta?.produced_by).map((a) => `${S.study[a._study].path}/${a.meta.produced_by}`)],
        detail: (how === "inputs" && arts.length ? `<p class="muted">No producer declares this block in <code>_meta.outputs</code>
            (a v2 producer would); these are the report's JSON inputs.</p>` : "") + arts.map(artifactDetail).join("") });
    const inputs = uniq(arts.flatMap((a) => (a.meta?.inputs || []).map((i) => i.path)));
    // an input is linked at the revision of the producer that read it; every distinct digest the
    // producers recorded for it is kept, with who read it, so a disagreement stays visible
    const readAt = {}, readsOf = {};
    arts.forEach((a) => (a.meta?.inputs || []).forEach((i) => {
      readAt[i.path] ||= a.meta?.studies_git_sha || undefined;
      const reads = (readsOf[i.path] ||= []);
      if (i.sha256 && !reads.some((x) => x.sha256 === i.sha256))
        reads.push({ sha256: i.sha256, by: a.meta?.produced_by ? base(a.meta.produced_by) : base(a.path), at: a.meta?.studies_git_sha });
    }));
    const readsHtml = (reads = []) => reads.map((x) => `<span class="muted mono">${esc(short(x.sha256))}</span>${reads.length > 1
      ? ` <span class="muted">read by ${esc(x.by)}${x.at ? ` at ${esc(short(x.at))}` : ""}</span>` : ""}`).join("; ");
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
        : "Every input is a freeze or another study's result, each by digest.",
      { count: inputs.length > 1 ? plural(inputs.length, "file") : null, paths: inputs,
        detail: inputs.length ? `<ul class="lin-list">${inputs.map((p, i) => `<li>${itemHtml(items[i])}
            ${readsHtml(readsOf[p])}
            ${items[i].xref ? "" : `<span class="muted">${esc(inStudy(p))}</span>`}</li>`).join("")}</ul>` : "" });
    const groups = uniq([...arts, ...freezes].flatMap((a) => a.meta?.wandb_groups || []));
    out.groups = groups;
    const recsOf = (g) => (S.cat.wandb_groups[g]?.launch_records || []).map((p) => S.recordByPath[p]).filter(Boolean);
    set("tracking", groups.length ? "ok" : "gap",
      groups.map((g) => ({ text: g, href: `#/group/${encodeURIComponent(g)}` })),
      groups.length ? "Pinned by exact name; one launch mints one group (ADR 0001)." : "No W&B group is recorded for this result.",
      { count: groups.length > 1 ? plural(groups.length, "W&B group") : null,
        detail: groups.length ? `<ul class="lin-list">${groups.map((g) => { const e = S.cat.wandb_groups[g] || {};
          return `<li>${groupTitle(g)}${e.url ? ` · <a href="${esc(e.url)}" target="_blank" rel="noopener">open in W&amp;B</a>` : ""}
            <div class="muted">${e.study ? `${esc(e.study)}${e.variant ? ` / ${esc(e.variant)}` : ""} · ` : ""}${plural(recsOf(g).length, "launch record")}</div></li>`; })
          .join("")}</ul>` : "" });
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
        : json.length ? "Every launch and intervention writes a launch record." : "Only older record files (copied manifests), without the launch's kind, jobs or commits.",
      { paths: recs.map((x) => x.path),
        // launches first, in time order; older record files after
        detail: recs.length ? `<ul class="lin-list">${[...json].sort((a, b) => (launchTime(a.time) ?? Infinity) - (launchTime(b.time) ?? Infinity))
          .concat(recs.filter((x) => x.format !== "json")).map(recordDetail).join("")}</ul>` : "" });
    // Per variant: the manifests its launch records snapshot (named relative to the variant, as the
    // studies launchers write them), or else the variant's files as they are now, marked so.
    const variantOf = (x) => S.study[x._study]?.variants.find((v) => v.name === x._variant);
    const resolve = (x, m) => (m.startsWith("studies/") ? m
      : `${variantOf(x)?.path || S.study[x._study]?.path}/${m.replace(/^\.\//, "")}`);
    const byVariant = {};
    recs.forEach((x) => { (byVariant[`${x._study}/${x._variant || "(study root)"}`] ||= []).push(x); });
    let snapshotted = 0;
    const expGroups = Object.entries(byVariant).map(([key, xs]) => {
      // a manifest as submitted is the file at the launch's recorded studies revision
      const recorded = uniq(xs.filter((x) => x.format === "json").flatMap((x) =>
        (x.manifests || []).map((m) => `${resolve(x, m)}@${x.revisions?.studies || ""}`)));
      // a snapshot needs the revision it was submitted at; without one the link shows today's file
      if (recorded.length && recorded.every((k) => k.split("@")[1])) snapshotted++;
      const its = recorded.length ? recorded.map((k) => { const [m, sha] = k.split("@");
          return sha ? { text: base(m), sub: `at ${short(sha)}`, path: m, link: srcLink(m, base(m), sha) }
                     : { text: base(m), sub: "current file", path: m, link: srcLink(m, base(m)) }; })
        : (variantOf(xs[0])?.manifests || []).map((m) => ({ text: base(m), sub: "current file", path: m, link: srcLink(m, base(m)) }));
      // the variant's directory too, so its checker findings attach even when no manifest is found
      return { key, items: its, dir: variantOf(xs[0]) ? `${variantOf(xs[0]).path}/` : null };
    });
    const expItems = expGroups.flatMap((g) => g.items);
    const nVariants = expGroups.length;
    set("experiment", !nVariants ? "gap" : snapshotted === nVariants ? "ok" : expItems.length ? "partial" : "gap", expItems,
      !nVariants ? "No launch record to read manifests from."
        : snapshotted === nVariants ? "Manifests as submitted, copied into the launch record."
        : "Some launches did not snapshot their manifests; those show the variant's files as they are now, which may have changed since.",
      { count: expItems.length > 1 ? `${plural(expItems.length, "manifest")}${nVariants > 1 ? ` in ${nVariants} variants` : ""}` : null,
        paths: [...expItems.map((i) => i.path), ...expGroups.map((g) => g.dir).filter(Boolean)],
        detail: expGroups.map((g) => sub(`<span class="mono">${esc(g.key)}</span>`, g.items.length
          ? `<ul class="lin-list">${g.items.map((it) => `<li>${itemHtml(it)} <span class="muted">${esc(inStudy(it.path))}</span></li>`).join("")}</ul>`
          : `<span class="muted">no manifests recorded or found</span>`)).join("") });
    // Code & image and Data snapshot: what the launch recorded (studies#25), else what a provenance
    // freeze recovered from W&B runs and Beaker jobs (studies#28), else not recorded.
    const recovered = (g) => S.cat.wandb_groups[g]?.recovered || null;
    const when = (rv) => `recovered ${String(rv.recovered_at_pt || "").slice(0, 10)}`;
    const recordsOf = (g) => recsOf(g).filter((x) => x.format === "json");
    const recoveredFrom = uniq(groups.map(recovered).filter(Boolean).map((rv) => rv.artifact));
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
      // otherwise the recovered commits fill the gap; each commit keeps the source(s) that gave it
      const recs = recordsOf(g), out = {};
      recs.forEach((x) => Object.entries(x.revisions || {}).forEach(([k, v]) => {
        if (!v) return;
        const r = (out[k] ||= { shas: new Map(), n: 0 });
        r.shas.set(v, "at launch"); r.n += 1; }));
      Object.values(out).forEach((r) => { r.all = r.n === recs.length; });
      const rv = recovered(g);
      Object.entries(rv?.revisions || {}).forEach(([k, shas]) => {
        const r = (out[k] ||= { shas: new Map() });
        if (r.all) return;
        Object.keys(shas).forEach((sha) => r.shas.set(sha, r.shas.has(sha) ? `${r.shas.get(sha)}; ${when(rv)}` : when(rv)));
        r.all = covers(rv, Object.values(shas).map((n) => ({ n_runs: n })));
      });
      return out;
    };
    // a repository's commits grouped by the source that gave them: [[how, [sha, ...]], ...]
    const byHow = (shas) => Object.entries([...shas].reduce((o, [sha, how]) => ((o[how] ||= []).push(sha), o), {}));
    const modelItems = [], modelParts = [], modelHas = groups.map((g) => {
      const img = imageOf(g), revs = revsOf(g);
      Object.entries(revs).forEach(([k, v]) => byHow(v.shas).forEach(([how, shas]) =>
        modelItems.push({ text: `${k} ${shas.map(short).join(", ")}`, sub: how })));
      img.items.forEach((i) => modelItems.push({ text: `image ${short(i.id)}`, sub: i.how }));
      const rows = [...Object.entries(revs).map(([k, v]) => [k, byHow(v.shas).map(([how, shas]) =>
          `${shas.map((sha) => A.commitLink(k, sha)).join(", ")} <span class="muted">${esc(how)}</span>`).join("<br>")
          + (v.all ? "" : ` <span class="muted">(not every run)</span>`)]),
        ...img.items.map((i) => ["image", `<span class="mono">${esc(i.id)}</span> <span class="muted">${esc(i.how)}${img.all ? "" : ", not every run"}</span>`])];
      modelParts.push({ g, html: (rows.length ? kv(rows) : `<p class="muted">Not recorded at launch and not recovered.</p>`) + recoveredNote(recovered(g)) });
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
            : "Not recorded at launch and not recovered (studies#25, #28).",
      { paths: recoveredFrom, detail: groups.length ? perGroup(modelParts) : "" });
    const dataOf = (g) => {
      const recs = recordsOf(g), atLaunch = recs.map((x) => x.data).filter(Boolean);
      if (atLaunch.length && atLaunch.length === recs.length) return { ds: atLaunch.map((d) => ({ ...d, how: "at launch" })), all: true };
      const rv = recovered(g), ds = (rv?.data || []).map((d) => ({ ...d, how: when(rv) }));
      return { ds: [...atLaunch.map((d) => ({ ...d, how: "at launch" })), ...ds], all: covers(rv, ds) };
    };
    const dataItems = [], dataParts = [], dataState = groups.map((g) => {
      const { ds, all } = dataOf(g);
      ds.forEach((d) => dataItems.push(d.source === "snapshot"
        ? { text: `snapshot ${d.snapshot}`, sub: `${d.manifest_sha256 ? `manifest ${short(d.manifest_sha256)}, ` : ""}${d.how}` }
        : { text: d.source === "live" ? "live database" : d.source === "external" ? `external: ${d.config}`
              : d.source === "generated" ? "generated" : "not logged",
            sub: d.how }));
      dataParts.push({ g, html: (ds.length ? ds.map(dataKv).join("") : `<p class="muted">Not recorded at launch and not recovered.</p>`)
        + recoveredNote(recovered(g)) });
      if (!ds.length) return "none";
      // an external dataset is named but not digested: known, not pinned
      return all && ds.every((d) => (d.source === "snapshot" && d.manifest_sha256) || d.source === "generated")
        ? "pinned" : "partial";
    });
    const dataUniq = uniq(dataItems.map((i) => JSON.stringify(i))).map((s) => JSON.parse(s));
    set("data", !groups.length || dataState.every((s) => s === "none") ? "gap"
        : dataState.every((s) => s === "pinned") ? "ok" : "partial",
      dataUniq,
      !groups.length || dataState.every((s) => s === "none") ? "Not recorded at launch and not recovered (studies#25, #28)."
        : dataState.every((s) => s === "pinned") ? "A dated database snapshot, identified by the digest of its manifest."
        : dataItems.some((i) => i.text === "live database")
          ? "Some runs read the live database (before snapshots existed), so their exact data cannot be fetched again."
        : dataItems.some((i) => i.text.startsWith("external:"))
          ? "An external dataset is named, but no digest pins its contents."
          : "Known only in part: some groups or runs have no digested snapshot, or the recovery does not cover every run.",
      { count: dataUniq.length > 1 ? plural(dataUniq.length, "data source") : null,
        paths: recoveredFrom, detail: groups.length ? perGroup(dataParts) : "" });
    out.decisions = [
      ...(S.correctedBy[`${r._study}/${r.id}`] || []).map((c) => ({ text: `corrected by ${c.report._study.slice(0, 2)} ${c.report.id}`,
        href: `#/report/${c.report._study}/${c.report.id}`, note: c.note })),
      ...(r.superseded_by ? [{ text: `superseded by ${r.superseded_by.study.slice(0, 2)} ${r.superseded_by.report}`,
        href: reportHref(`${r.superseded_by.study}/${r.superseded_by.report}`) }] : []),
    ];
    if (S.healthRan) attachFindings(out);
    return out;
  }

  function itemHtml(it) {
    const body = `${esc(it.text)}${it.sub ? ` <span class="sub">${esc(it.sub)}</span>` : ""}`;
    if (it.link) return `<span class="lchip">${it.link}${it.sub ? ` <span class="sub">${esc(it.sub)}</span>` : ""}</span>`;
    if (it.href) return `<a class="lchip${it.xref ? " xref" : ""}" href="${esc(it.href)}">${it.xref ? "→ " : ""}${body}</a>`;
    return `<span class="lchip">${body}</span>`;
  }

  // The collapsed row: a count when the step has several values, else the value itself.
  function summaryHtml(h) {
    if (!h.items.length) return `<span class="muted">${STATE[h.state]}</span>`;
    const text = (it) => `${esc(it.text)}${it.sub ? ` <span class="muted">${esc(it.sub)}</span>` : ""}`;
    if (h.count) return `<b>${esc(h.count)}</b> <span class="muted">${h.items.map((it) => esc(it.text)).join(" · ")}</span>`;
    return h.items.map(text).join(" · ");
  }
  const badges = (fs) => ["error", "warn"].map((lvl) => { const n = fs.filter((f) => f.level === lvl).length;
    return n ? `<span class="badge ${lvl}" title="${plural(n, `checker ${lvl === "warn" ? "warning" : lvl}`)}">${n}<span class="sr">
      ${lvl === "warn" ? "warning" : lvl}${n === 1 ? "" : "s"}</span></span>` : ""; }).join("");
  const findingsHtml = (fs) => (fs.length ? `<div class="k">Checker findings</div><ul class="findings">${fs.map((f) =>
    `<li><span class="lvl-${esc(f.level)}">${esc(f.check)}</span> ${srcLink(f.path, f.path.replace(/^studies\//, ""))}: ${esc(f.message)}
      ${f.fix ? `<div class="muted">Fix: ${esc(f.fix)}</div>` : ""}</li>`).join("")}</ul>` : "");

  let linCount = 0;
  A.mountLineage = (host, r, block, { full = false, open = null } = {}) => {
    const L = buildLineage(r, block), id = `lin${++linCount}`;
    const permalink = `#/lineage/${encodeURIComponent(r._study)}/${encodeURIComponent(r.id)}/${encodeURIComponent(block)}`;
    const cap = (s) => s[0].toUpperCase() + s.slice(1);
    host.innerHTML = `<div class="lineage">
      <div class="lin-head"><span class="k">Lineage</span>
        ${full ? "" : `<a class="lin-full" href="${permalink}">full page</a>`}
        <button type="button" class="export lin-all">Expand all</button>
        <button type="button" class="export lin-export">Export SVG</button></div>
      <ol class="lin">${HOPS.map(([k, name, hint]) => { const h = L.hops[k];
        return `<li class="slot s-${h.state}" data-hop="${k}">
          <button type="button" class="slot-head" aria-expanded="false" aria-controls="${id}-${k}">
            <span class="dot" aria-hidden="true"></span>
            <span class="slot-name">${esc(name)} <span class="sr">(${STATE[h.state]})</span></span>
            <span class="slot-val">${summaryHtml(h)}</span>
            <span class="slot-badges">${badges(h.findings)}</span>
            <span class="chev" aria-hidden="true"></span></button>
          <div class="slot-detail" id="${id}-${k}" hidden>
            <p><b>${esc(cap(STATE[h.state]))}.</b> ${esc(h.why)} <span class="muted">${esc(hint)}</span></p>
            ${h.detail}${findingsHtml(h.findings)}</div></li>`; }).join("")}
        ${L.decisions.map((d) => `<li class="slot s-decision" data-hop="decision"><div class="slot-head lin-static">
            <span class="dot" aria-hidden="true"></span><span class="slot-name">Decision</span>
            <span class="slot-val"><a href="${esc(d.href || "#/")}">${esc(d.text)}</a>${d.note ? ` <span class="muted">${esc(d.note)}</span>` : ""}</span>
          </div></li>`).join("")}
      </ol></div>`;
    const heads = [...host.querySelectorAll("button.slot-head")], all = host.querySelector(".lin-all");
    const fullLink = host.querySelector(".lin-full");
    const isOpen = (b) => b.getAttribute("aria-expanded") === "true";
    const show = (b, on) => { b.setAttribute("aria-expanded", String(on)); b.nextElementSibling.hidden = !on; };
    // The permalink names the step opened last; on the page the address bar follows without a
    // re-render (replaceState fires no hashchange), in the drawer the "full page" link does.
    let current = null;
    const remember = (k) => {
      current = k;
      const href = k ? `${permalink}/${encodeURIComponent(k)}` : permalink;
      if (full) history.replaceState(null, "", href);
      else if (fullLink) fullLink.href = href;
    };
    const sync = () => { all.textContent = heads.every(isOpen) ? "Collapse all" : "Expand all"; };
    heads.forEach((b) => b.addEventListener("click", () => {
      const k = b.closest(".slot").dataset.hop, on = !isOpen(b);
      show(b, on);
      if (on) remember(k); else if (current === k) remember(null);
      sync();
    }));
    all.addEventListener("click", () => {
      const on = !heads.every(isOpen);
      heads.forEach((b) => show(b, on));
      if (!on) remember(null);
      sync();
    });
    const start = open && heads.find((b) => b.closest(".slot").dataset.hop === open);
    if (start) { show(start, true); current = open; start.scrollIntoView({ block: "nearest" }); }
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
    // .../<block>/<step> opens that step; a block name never contains "/" (its BEGIN/END marker is [\w.-]+)
    const step = rest.length === 2 && HOPS.some((h) => h[0] === rest[1]) ? rest.pop() : null;
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
        catalog at studies ${esc(short(S.sha))}. A hollow step is not recorded yet; open a step for its evidence and the
        checker's findings about it.</p>
      <div id="lineage-full"></div>`;
    A.mountLineage(document.getElementById("lineage-full"), r, block, { full: true, open: step });
  };
});
