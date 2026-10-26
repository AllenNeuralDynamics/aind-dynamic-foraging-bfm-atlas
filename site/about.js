/* The About page (#/about): the framework behind the studies repo, described for other projects
 * that train models on several compute platforms, track runs in W&B and analyse afterwards.
 * Everything comes from catalog.framework (src/bfm_atlas/framework.py): an editorial model of the
 * framework's objects, filled in at build time from the studies CONTEXT.md, schemas/, ADRs and
 * checker, and from the dispatcher's skills pack; plus the porting prompts in porting.md.
 * Registers through window.Atlas; uses map.js's tooltip and Export SVG.
 */
"use strict";

document.addEventListener("atlas:ready", () => {
  const A = window.Atlas;
  const { S, VIEWS, esc, chip, short } = A;
  const main = () => document.getElementById("main");
  const DISPATCHER_REPO = "https://github.com/AllenNeuralDynamics/aind-dynamic-foraging-bfm-dispatcher";
  const LEVELS = {
    general: ["General", "The pattern carries over as is."],
    site: ["Swap site specifics", "General, with this site's clusters, ids or sandbox to replace."],
    project: ["This project only", "Describes this project's code: write your own."],
    none: ["Unclassified", "Not yet assessed for reuse."],
  };
  const KIND = { term: "CONTEXT.md term", field: "launch-record field" };
  let porting = null;                // porting.md text, fetched once per page load

  // links pin the commits the catalog was built from
  const srcs = (fw) => {
    const d = fw.sources?.dispatcher || {};
    const repo = d.remote || DISPATCHER_REPO;        // the build turns any origin into a web URL, or null
    return { studies: `${A.STUDIES_REPO}/blob/${fw.sources?.studies_git_sha || S.sha}`,
             dispatcher: `${repo}/blob/${d.sha || "main"}`, dsha: d.sha };
  };
  const ext = (href, text, cls = "") => `<a class="${cls}" href="${esc(href)}" target="_blank" rel="noopener">${esc(text)}</a>`;
  const level = (l) => { const [name, hint] = LEVELS[l || "none"]; return `<span class="lvl-chip lv-${esc(l || "none")}" title="${esc(hint)}">${esc(name)}</span>`; };

  VIEWS.about = () => {
    const fw = S.cat.framework;
    if (!fw || !fw.available) {
      main().innerHTML = `<h1>About</h1><p class="muted">This catalog was built without the framework description
        (${esc(fw?.error || "no framework section")}).</p>`;
      return;
    }
    const L = srcs(fw);
    main().innerHTML = `
      <h1>A provenance framework for ML studies</h1>
      <p class="about-lede">Every number in these reports traces back to the exact bytes, code and compute that produced
        it, across Beaker, an on-premise SLURM cluster and Weights &amp; Biases, while people and coding agents work in the
        same repositories. This page describes the framework that makes that hold, so that other machine-learning
        projects can adopt it: the objects it defines and how they connect, the schemas and checker that enforce it, the
        agent skills that operate it, and prompts to port it.</p>
      <div class="pillars">
        <div><b>Record what went out</b>Every submission writes an immutable launch record: commits, data snapshot,
          image, manifests, and why it was run.</div>
        <div><b>Freeze, then analyse offline</b>Only a freeze reads W&amp;B. Every other step computes from committed files,
          each recorded by its SHA-256.</div>
        <div><b>Reports are code</b>Numbers live in result blocks their producer regenerates; another study's number
          is read, never retyped.</div>
        <div><b>One checker, in CI</b>Schemas and a single checker hold the rules; old findings sit in a baseline
          that may only shrink.</div>
      </div>
      <h2>How it fits together</h2>
      <p class="muted">Each box is an object the framework defines, in the stage of a run's life where it appears; dashed
        boxes are fields of the launch record. Select one for its definition, its schema, the checker rules about it and
        the skills that operate it.</p>
      <section class="fw" id="fw">
        <div class="map-tools"><span class="muted fw-legend"><span class="sw sw-term"></span>term
          <span class="sw sw-field"></span>launch-record field</span>
          <button type="button" class="export" id="fw-export">Export SVG</button></div>
        <div class="map-wrap"><svg id="fw-map" role="img" aria-label="The framework's objects by lifecycle stage, and how they connect"></svg></div>
        <div class="fw-panel" id="fw-panel" aria-live="polite"></div>
      </section>
      <h2>Skills</h2>
      <p class="muted">Agent skills (Claude Code plugin) that carry the workflow and the why behind each rule, from the
        ${ext(`${L.dispatcher}/aind-behavior-foundation-model-skills/README.md`, "dispatcher's skills pack")}${L.dsha ? ` at ${esc(short(L.dsha))}` : ""}.
        Each is marked by how much carries over to another project.</p>
      <div id="fw-skills"></div>
      <h2>Schemas and decisions</h2>
      <p class="muted">The machine-checked layer, from the studies repo's ${ext(`${L.studies}/schemas/README.md`, "schemas/")}.
        ${fw.checks.length} checker rules in ${ext(`${L.studies}/scripts/check_provenance.py`, "check_provenance.py")} enforce them.</p>
      <div id="fw-schemas"></div>
      <div id="fw-adrs"></div>
      <div class="prose porting" id="porting"><p class="muted">Loading the porting prompts…</p></div>
      <p class="muted about-foot">Generated from studies ${A.commitLink("studies", fw.sources?.studies_git_sha)}${L.dsha
        ? ` and dispatcher ${A.commitLink("dispatcher", L.dsha)}` : ""}. Definitions, schema fields, checker rules and skill
        descriptions are read from those files at build time; which objects exist, how they connect and how general each
        skill is are an editorial model in the atlas (${ext("https://github.com/AllenNeuralDynamics/aind-dynamic-foraging-bfm-atlas/blob/main/src/bfm_atlas/framework.py", "framework.py")}),
        checked against those files on every build.</p>`;
    const select = drawMap(fw, L);
    drawSkills(fw, L, select);
    drawSchemas(fw, L);
    drawPorting(L);
  };

  // ------------------------------------------------------------ the map
  function drawMap(fw, L) {
    const COLW = 170, PADX = 14, TOP = 88, ROWH = 56, NW = 138, NH = 34;
    const byId = Object.fromEntries(fw.objects.map((o) => [o.id, o]));
    const cols = fw.stages.map((st) => fw.objects.filter((o) => o.stage === st.id));
    const rows = Math.max(...cols.map((c) => c.length));
    const W = PADX * 2 + fw.stages.length * COLW, H = TOP + rows * ROWH + 16;
    const pos = {};
    cols.forEach((c, i) => c.forEach((o, k) => {
      pos[o.id] = { x: PADX + i * COLW + (COLW - NW) / 2, y: TOP + ((rows - c.length) * ROWH) / 2 + k * ROWH, col: i, k };
    }));
    const wrapText = (t, n) => t.split(" ").reduce((ls, w) => {
      const last = ls[ls.length - 1];
      if (last && (last + " " + w).length > n) ls.push(w); else ls[ls.length - 1] = last ? `${last} ${w}` : w;
      return ls;
    }, [""]);
    // across columns: side to side; within a column: an arc beside it (to a launch-record field on the right)
    function path(e) {
      const a = pos[e.from], b = pos[e.to];
      if (a.col !== b.col) {
        const fwd = a.col < b.col, x1 = fwd ? a.x + NW : a.x, x2 = fwd ? b.x : b.x + NW, y1 = a.y + NH / 2, y2 = b.y + NH / 2;
        const dx = Math.max(30, Math.abs(x2 - x1) / 2) * (fwd ? 1 : -1);
        return `M${x1},${y1} C${x1 + dx},${y1} ${x2 - dx},${y2} ${x2},${y2}`;
      }
      const right = byId[e.to].kind === "field", x = right ? a.x + NW : a.x, s = right ? 1 : -1;
      const bulge = 14 + 7 * Math.abs(b.k - a.k), y1 = a.y + NH / 2, y2 = b.y + NH / 2;
      return `M${x},${y1} C${x + s * bulge},${y1} ${x + s * bulge},${y2} ${x},${y2}`;
    }
    const svg = document.getElementById("fw-map");
    svg.setAttribute("viewBox", `0 0 ${W} ${H}`);
    svg.innerHTML = `<defs><marker id="fw-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7"
        markerUnits="userSpaceOnUse" orient="auto"><path class="fw-mk" d="M0,0 L10,5 L0,10 z"/></marker></defs>
      ${fw.stages.map((st, i) => `<g class="fw-stage"><rect class="fw-lane" x="${PADX + i * COLW + 3}" y="6" width="${COLW - 6}" height="${H - 12}" rx="8"/>
        <text class="fw-stage-name" x="${PADX + i * COLW + COLW / 2}" y="26" text-anchor="middle">${i + 1}. ${esc(st.label)}</text>
        ${wrapText(st.summary, 28).slice(0, 3).map((l, k) => `<text class="fw-stage-sum" x="${PADX + i * COLW + COLW / 2}" y="${42 + k * 12}"
          text-anchor="middle">${esc(l)}</text>`).join("")}</g>`).join("")}
      ${fw.edges.map((e, i) => (pos[e.from] && pos[e.to] ? `<g class="fw-edge" data-i="${i}" data-from="${esc(e.from)}" data-to="${esc(e.to)}">
        <path class="hit" d="${path(e)}"/><path class="line" d="${path(e)}" marker-end="url(#fw-arrow)"/></g>` : "")).join("")}
      ${fw.objects.map((o) => { const p = pos[o.id];
        return `<g class="fw-node k-${esc(o.kind)}" data-id="${esc(o.id)}" tabindex="0" role="button"
            aria-label="${esc(`${o.label}, ${KIND[o.kind]}`)}" transform="translate(${p.x},${p.y})">
          <rect width="${NW}" height="${NH}" rx="8"/><text x="${NW / 2}" y="${NH / 2 + 4}" text-anchor="middle">${esc(o.label)}</text></g>`; }).join("")}`;

    const host = document.getElementById("fw"), tip = A.tooltip(host), panel = document.getElementById("fw-panel");
    let picked = null;
    const edgeText = (e) => `${byId[e.from].label} ${e.label} ${byId[e.to].label}`;
    function light(id) {
      svg.classList.toggle("lighting", !!id);
      svg.querySelectorAll(".lit, .nbr").forEach((el) => el.classList.remove("lit", "nbr"));
      if (!id) return;
      svg.querySelector(`.fw-node[data-id="${CSS.escape(id)}"]`)?.classList.add("lit");
      svg.querySelectorAll(".fw-edge").forEach((g) => {
        if (g.dataset.from !== id && g.dataset.to !== id) return;
        g.classList.add("lit");
        svg.querySelector(`.fw-node[data-id="${CSS.escape(g.dataset.from === id ? g.dataset.to : g.dataset.from)}"]`)?.classList.add("nbr");
      });
    }
    function select(id, { scroll = false } = {}) {
      picked = byId[id] ? id : null;
      svg.querySelectorAll(".fw-node.focused").forEach((n) => n.classList.remove("focused"));
      if (picked) svg.querySelector(`.fw-node[data-id="${CSS.escape(picked)}"]`)?.classList.add("focused");
      light(picked);
      panel.innerHTML = picked ? panelHtml(byId[picked]) : `<p class="muted">Select an object above. Start with
        <button type="button" class="linkish" data-go="launch-record">Launch record</button> or
        <button type="button" class="linkish" data-go="freeze">Freeze</button>.</p>`;
      if (scroll) host.scrollIntoView({ behavior: "smooth", block: "start" });
    }
    function panelHtml(o) {
      const sch = fw.schemas.find((s) => s.file === o.schema);
      const out = fw.edges.filter((e) => e.from === o.id), inn = fw.edges.filter((e) => e.to === o.id);
      const go = (id) => `<button type="button" class="linkish" data-go="${esc(id)}">${esc(byId[id].label)}</button>`;
      const skills = (fw.skills || []).filter((s) => s.objects.includes(o.id));
      const prop = o.kind === "field" ? o.field.split("#")[1] : null;
      const fields = sch ? (prop ? sch.fields.filter((f) => f.name === prop) : sch.fields) : [];
      return `<div class="panel-head"><b>${esc(o.label)}</b> ${chip(KIND[o.kind])} ${chip(fw.stages.find((s) => s.id === o.stage)?.label || o.stage)}
          <button type="button" class="panel-close" aria-label="Clear selection">×</button></div>
        <p>${esc(o.definition || "No description in its source.")}${o.editorial ? ` <span class="muted">(editorial note: the schema
          gives this field no description)</span>` : ""}</p>
        ${o.avoid ? `<p class="muted">Avoid calling it: ${esc(o.avoid)}</p>` : ""}
        <div class="rels">
          ${inn.length ? `<div class="rel"><div class="k">From</div><ul>${inn.map((e) => `<li>${go(e.from)} ${esc(e.label)} it</li>`).join("")}</ul></div>` : ""}
          ${out.length ? `<div class="rel"><div class="k">To</div><ul>${out.map((e) => `<li>${esc(e.label)} ${go(e.to)}</li>`).join("")}</ul></div>` : ""}
          ${o.checks.length ? `<div class="rel"><div class="k">Checker rules (${o.checks.length})</div><div class="chips">${o.checks.map((c) =>
            `<code class="rule">${esc(c)}</code>`).join("")}</div></div>` : ""}
          ${skills.length ? `<div class="rel"><div class="k">Skills</div><ul>${skills.map((s) => `<li>${s.path ? ext(`${L.dispatcher}/${s.path}`, s.name)
            : esc(s.name)} ${level(s.level)}</li>`).join("")}</ul></div>` : ""}
        </div>
        ${sch ? `<div class="k">Schema</div><p>${ext(`${L.studies}/${sch.path}`, sch.file, "mono")}${sch.governs ? ` <span class="muted">governs
          ${esc(sch.governs.replace(/`/g, ""))}</span>` : ""}</p>
          ${fields.length ? fieldTable(fields) : sch.entries != null ? `<p class="muted">${sch.entries} known findings in existing files.</p>` : ""}` : ""}`;
    }
    svg.querySelectorAll(".fw-node").forEach((g) => {
      const id = g.dataset.id;
      g.addEventListener("pointerenter", () => light(id));
      g.addEventListener("pointerleave", () => light(picked));
      g.addEventListener("focus", () => light(id));
      g.addEventListener("blur", () => light(picked));
      g.addEventListener("click", (ev) => { ev.stopPropagation(); select(picked === id ? null : id); });
      g.addEventListener("keydown", (ev) => { if (ev.key === "Enter" || ev.key === " ") { ev.preventDefault(); select(picked === id ? null : id); } });
    });
    svg.querySelectorAll(".fw-edge").forEach((g) => {
      const e = fw.edges[+g.dataset.i];
      g.addEventListener("pointerenter", () => tip.show(g, esc(edgeText(e))));
      g.addEventListener("pointerleave", () => tip.hide());
      g.addEventListener("click", (ev) => { ev.stopPropagation(); tip.show(g, esc(edgeText(e))); });
    });
    panel.addEventListener("click", (ev) => {
      const b = ev.target.closest("[data-go]");
      if (b) select(b.dataset.go);
      else if (ev.target.closest(".panel-close")) select(null);
    });
    document.getElementById("fw-export").addEventListener("click", () => {
      tip.hide(); light(null);
      A.downloadSvg(svg, `framework-${short(S.sha)}.svg`);
      light(picked);
    });
    select(null);
    return select;
  }

  const fieldTable = (fields) => `<div class="table-wrap"><table class="fw-fields"><thead><tr><th>Field</th><th></th><th>What it holds</th></tr></thead><tbody>
    ${fields.map((f) => `<tr><td class="mono">${esc(f.name)}</td><td>${f.required ? `<span class="req" title="required">required</span>` : ""}</td>
      <td>${esc(f.description || "")}</td></tr>`).join("")}</tbody></table></div>`;

  // ------------------------------------------------------------ skills, schemas, decisions
  function drawSkills(fw, L, select) {
    const host = document.getElementById("fw-skills");
    if (!fw.skills) { host.innerHTML = `<p class="muted">${esc(fw.skills_error || "No skills in this build.")}</p>`; return; }
    const order = { general: 0, site: 1, project: 2 };
    const label = (id) => fw.objects.find((o) => o.id === id)?.label || id;
    host.innerHTML = `<div class="skill-grid">${[...fw.skills].sort((a, b) => (order[a.level] ?? 3) - (order[b.level] ?? 3) || a.name.localeCompare(b.name))
      .map((s) => `<div class="skill-card">
        <div class="skill-head">${s.path ? ext(`${L.dispatcher}/${s.path}`, s.name, "mono") : `<span class="mono">${esc(s.name)}</span>`} ${level(s.level)}</div>
        <p class="skill-desc" tabindex="0" title="Show all">${esc(s.description || "")}</p>
        ${s.swap ? `<p class="muted"><b>When porting:</b> ${esc(s.swap)}</p>` : ""}
        ${s.objects.length ? `<div class="chips">${s.objects.map((id) => `<button type="button" class="tag-chip" data-go="${esc(id)}">${esc(label(id))}</button>`).join("")}</div>` : ""}
        ${s.headings?.length ? `<details class="skill-toc"><summary>Sections (${s.headings.length})</summary><ul>${s.headings.map((h) => `<li>${esc(h)}</li>`).join("")}</ul></details>` : ""}
      </div>`).join("")}</div>`;
    // a chip selects its object on the map; a clamped description opens in full
    const open = (d) => { d.classList.toggle("open"); d.title = d.classList.contains("open") ? "" : "Show all"; };
    host.addEventListener("click", (ev) => {
      const b = ev.target.closest("[data-go]"), d = ev.target.closest(".skill-desc");
      if (b) select(b.dataset.go, { scroll: true });
      else if (d) open(d);
    });
    host.addEventListener("keydown", (ev) => {
      const d = ev.target.closest(".skill-desc");
      if (d && (ev.key === "Enter" || ev.key === " ")) { ev.preventDefault(); open(d); }
    });
  }

  function drawSchemas(fw, L) {
    document.getElementById("fw-schemas").innerHTML = fw.schemas.map((s) => `<details class="fw-schema">
        <summary><span class="mono">${esc(s.file)}</span> <span class="muted">${esc((s.governs || "").replace(/`/g, ""))}</span></summary>
        <p>${ext(`${L.studies}/${s.path}`, `${s.path} at ${short(fw.sources?.studies_git_sha)}`, "mono")}${s.schema_version != null
          ? ` · schema_version ${esc(s.schema_version)}` : ""}${s.entries != null ? ` · ${s.entries} known findings` : ""}</p>
        ${s.fields.length ? fieldTable(s.fields) : ""}</details>`).join("");
    document.getElementById("fw-adrs").innerHTML = fw.adrs.length ? `<h3>Decisions</h3><ul class="fw-adrs">${fw.adrs.map((a) =>
      `<li>${ext(`${L.studies}/${a.path}`, a.title)}<div class="muted">${esc(a.summary)}</div></li>`).join("")}</ul>` : "";
  }

  // ------------------------------------------------------------ porting prompts
  function drawPorting(L) {
    const host = document.getElementById("porting");
    const show = (md) => {
      const text = md.replaceAll("{{studies}}", L.studies).replaceAll("{{dispatcher}}", L.dispatcher);
      host.innerHTML = "";
      host.appendChild(A.renderMarkdown(text, "porting.md"));
      host.querySelectorAll("pre").forEach((pre) => {
        const b = document.createElement("button");
        b.type = "button"; b.className = "copy"; b.textContent = "Copy";
        b.setAttribute("aria-label", "Copy this prompt");
        b.addEventListener("click", async () => {
          const code = pre.querySelector("code")?.textContent ?? pre.textContent;
          try { await navigator.clipboard.writeText(code); b.textContent = "Copied"; }
          catch {                                   // no clipboard permission: select it for Ctrl+C
            const r = document.createRange(); r.selectNodeContents(pre.querySelector("code") || pre);
            const sel = getSelection(); sel.removeAllRanges(); sel.addRange(r); b.textContent = "Selected: press Ctrl+C";
          }
          setTimeout(() => { b.textContent = "Copy"; }, 2000);
        });
        pre.classList.add("has-copy");
        pre.prepend(b);
      });
    };
    if (porting !== null) return show(porting);
    fetch("porting.md").then((r) => { if (!r.ok) throw new Error(`porting.md: HTTP ${r.status}`); return r.text(); })
      .then((md) => { porting = md; if (document.getElementById("porting") === host) show(md); })
      .catch((err) => { host.innerHTML = `<p class="lvl-error">${esc(err.message)}</p>`; });
  }
});
