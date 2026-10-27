/* Behavior Foundation Model Studies Atlas: a static, hash-routed browser over data/catalog.json.
 *
 * Vocabulary follows the studies repo's CONTEXT.md (Study, Variant, Launch, W&B group,
 * Intervention, Report, Correction, Upstream, Freeze). The catalog is built by
 * `bfm-atlas build` from one studies commit; every link to source goes to that commit.
 */
"use strict";

const STUDIES_REPO = "https://github.com/AllenNeuralDynamics/aind-dynamic-foraging-bfm-studies";
const REPO_URLS = {
  studies: STUDIES_REPO,
  dispatcher: "https://github.com/AllenNeuralDynamics/aind-dynamic-foraging-bfm-dispatcher",
  wrapper: "https://github.com/AllenNeuralDynamics/aind-dynamic-foraging-bfm-wrapper",
  foraging_models: "https://github.com/AllenNeuralDynamics/aind-dynamic-foraging-models",
};

const S = {};   // indexes over the catalog, filled by index()

// ---------------------------------------------------------------- helpers
const esc = (v) => String(v ?? "").replace(/[&<>"']/g, (c) =>
  ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const short = (sha) => (sha ? String(sha).slice(0, 8) : "—");
const $main = () => document.getElementById("main");
// Source links pin a commit: the catalog's by default, or the one a producer recorded.
const blob = (path, sha = S.sha) => `${STUDIES_REPO}/blob/${sha || S.sha}/${path.split("#")[0]}`;
const commitLink = (repo, sha) => sha
  ? `<a class="mono" href="${REPO_URLS[repo] || "#"}/commit/${esc(sha)}" target="_blank" rel="noopener">${esc(short(sha))}</a>`
  : `<span class="muted">—</span>`;
const srcLink = (path, label, sha) =>
  `<a class="mono" href="${esc(blob(path, sha))}" target="_blank" rel="noopener">${esc(label ?? path)}</a>`;
// GitHub-style heading slug, so in-document links (#summary-verdict-2026-06-24) resolve.
const slug = (s) => s.trim().toLowerCase().replace(/[^\p{L}\p{N}\s-]/gu, "").replace(/\s/g, "-");
const chip = (text, cls = "") => `<span class="chip ${cls}">${esc(text)}</span>`;
const statusChip = (s) => (s ? chip(s, `status-${s}`) : "");
// a study's declared tags (studies schemas/tags.yaml) as chips; the name's model when it has none
const tagChips = (s) => {
  const tags = s.cover.tags, vocab = S.cat.tags || {};
  if (!tags) return chip(s.model || "?");
  return Object.entries(tags).flatMap(([f, vs]) => vs.map((v) => {
    const d = vocab[f]?.values?.[v];
    return `<span class="chip tag tag-${esc(f)}" title="${esc(d?.description || "")}">${esc(d?.label || v)}</span>`;
  })).join("");
};

function resolvePath(base, rel) {
  // Resolve `rel` against the directory of repo path `base`.
  if (/^[a-z]+:/.test(rel) || rel.startsWith("#")) return rel;
  const parts = base.split("/").slice(0, -1);
  for (const seg of rel.split("/")) {
    if (seg === "..") parts.pop();
    else if (seg !== "." && seg !== "") parts.push(seg);
  }
  return parts.join("/");
}

function findingsFor(prefix, { exact = false, levels = ["error", "warn"] } = {}) {
  return S.findings.filter((f) => levels.includes(f.level) &&
    (exact ? f.path === prefix : f.path === prefix || f.path.startsWith(prefix + "/")));
}

function healthBadges(prefix, opts) {
  const fs = findingsFor(prefix, opts);
  const e = fs.filter((f) => f.level === "error").length;
  const w = fs.filter((f) => f.level === "warn").length;
  if (!S.healthRan) return `<span class="muted">checker not run</span>`;
  if (!e && !w) return `<span class="badge ok" title="no findings">✓</span>`;
  return `${e ? `<span class="badge error" title="errors">${e}</span>` : ""} ` +
         `${w ? `<span class="badge warn" title="warnings">${w}</span>` : ""}`;
}

function renderMarkdown(md, basePath) {
  // Wrap result blocks so they can carry provenance; marked keeps the raw div.
  const wrapped = md.replace(/<!-- BEGIN ([\w.-]+) -->\n?([\s\S]*?)<!-- END \1 -->/g,
    (_, name, body) => `\n<div class="result-block" data-block="${name}">\n\n${body}\n\n</div>\n`);
  const html = DOMPurify.sanitize(marked.parse(wrapped), { ADD_ATTR: ["target"] });
  const div = document.createElement("div");
  div.innerHTML = html;
  for (const img of div.querySelectorAll("img")) {
    const src = img.getAttribute("src") || "";
    if (!/^[a-z]+:/.test(src)) img.src = `data/files/${resolvePath(basePath, src)}`;
    img.loading = "lazy";
  }
  const seen = {};
  for (const h of div.querySelectorAll("h1, h2, h3, h4, h5, h6")) {
    const base = slug(h.textContent);
    h.id = seen[base] ? `${base}-${seen[base]}` : base;
    seen[base] = (seen[base] || 0) + 1;
  }
  for (const a of div.querySelectorAll("a[href]")) {
    const href = a.getAttribute("href");
    if (href.startsWith("#")) {
      // An in-document anchor must not replace the hash route: scroll instead (see below).
      a.dataset.anchor = decodeURIComponent(href.slice(1));
      a.setAttribute("href", location.hash || "#/");
      continue;
    }
    if (/^[a-z]+:/.test(href)) continue;
    const [file, fragment] = href.split("#");
    const target = resolvePath(basePath, file);
    if (S.interactive && S.interactive.has(target)) {
      // an interactive page the build shipped with the site (catalog `interactive`): open it so it
      // runs. Any other .html link (a README's, an uncopied one) keeps the GitHub fallback below.
      a.setAttribute("href", `data/files/${target}` + (fragment ? `#${fragment}` : ""));
      a.target = "_blank"; a.rel = "noopener";
      continue;
    }
    const route = routeForPath(target);
    // a heading fragment rides along as "?<id>" in the hash route and is scrolled to after render
    if (route) a.setAttribute("href", fragment ? `${route}?${fragment}` : route);
    else {
      a.setAttribute("href", blob(target) + (fragment ? `#${fragment}` : ""));
      a.target = "_blank"; a.rel = "noopener";
    }
  }
  return div;
}

function routeForPath(path) {
  if (S.reportByPath[path]) {
    const r = S.reportByPath[path];
    return `#/report/${r._study}/${r.id}`;
  }
  const m = path.match(/^studies\/([^/]+)(\/README\.md)?\/?$/);
  if (m && S.study[m[1]]) return `#/study/${m[1]}`;
  return null;
}

// ---------------------------------------------------------------- indexing
function index(cat) {
  S.cat = cat;
  S.sha = cat._meta.studies_git_sha || "main";
  S.study = {};
  S.reportByPath = {};
  S.reportByKey = {};
  S.artifactByPath = {};
  S.recordByPath = {};
  S.producersOf = {};          // "<report path>#<block>" or file path -> [artifact]
  S.correctedBy = {};          // "<study>/<rN>" -> [{report, note}]
  S.supersededBy = {};
  S.interactive = new Set();   // interactive pages the build shipped (report `interactive`)
  S.healthRan = cat.health.ran;
  S.findings = cat.health.findings || [];
  for (const s of cat.studies) {
    S.study[s.id] = s;
    for (const r of s.reports) {
      r._study = s.id;
      S.reportByPath[r.path] = r;
      S.reportByKey[`${s.id}/${r.id}`] = r;
      for (const i of r.interactive || []) if (i.exists) S.interactive.add(i.path);
      for (const c of r.corrects) {
        (S.correctedBy[`${c.study}/${c.report}`] ||= []).push({ report: r, note: c.note });
      }
    }
    for (const a of s.artifacts) {
      a._study = s.id;
      S.artifactByPath[a.path] = a;
      for (const o of a.meta?.outputs || []) (S.producersOf[o.path] ||= []).push(a);
    }
    for (const v of s.variants) {
      for (const r of v.launch_records) { r._study = s.id; r._variant = v.name; S.recordByPath[r.path] = r; }
    }
    for (const r of s.root_launch_records || []) { r._study = s.id; r._variant = null; S.recordByPath[r.path] = r; }
  }
}

// ---------------------------------------------------------------- views
function viewStudies() {
  const c = S.cat;
  const reports = c.studies.reduce((n, s) => n + s.reports.length, 0);
  const launches = c.studies.reduce((n, s) => n + [...s.variants.flatMap((v) => v.launch_records),
    ...(s.root_launch_records || [])].filter((r) => r.format === "json").length, 0);
  const err = S.findings.filter((f) => f.level === "error").length;
  const warn = S.findings.filter((f) => f.level === "warn").length;
  $main().innerHTML = `
    <h1>Studies</h1>
    <p class="muted">Every scientific question asked of the dynamic foraging behavior foundation model, with each report traced to the
      producer, frozen inputs, W&amp;B group, launch record and commits behind it.</p>
    <div class="stats">
      <div class="stat"><b>${c.studies.length}</b><span>studies</span></div>
      <div class="stat"><b>${reports}</b><span>reports</span></div>
      <div class="stat"><b>${launches}</b><span>launch records</span></div>
      <div class="stat"><b>${Object.keys(c.wandb_groups).length}</b><span>W&amp;B groups</span></div>
      <div class="stat"><b><a href="#/health">${S.healthRan ? `${err} / ${warn}` : "—"}</a></b>
        <span>provenance errors / warnings</span></div>
    </div>
    <h2>How the studies connect</h2>
    <section class="map" id="map" aria-label="Study map"></section>
    <h2>All studies</h2>
    <input class="filter" id="filter" placeholder="Filter studies…" aria-label="Filter studies">
    <div class="cards" id="cards"></div>`;
  if (window.Atlas?.drawMap) window.Atlas.drawMap(document.getElementById("map"));
  const draw = (q) => {
    q = q.toLowerCase();
    document.getElementById("cards").innerHTML = c.studies
      .filter((s) => !q || `${s.id} ${s.title} ${s.cover.question || ""}`.toLowerCase().includes(q))
      .map((s) => `
        <a class="card" href="#/study/${esc(s.id)}">
          <div class="num">${esc(s.id)}</div>
          <div><b>${esc(s.title.replace(/^Study:\s*/, ""))}</b></div>
          <div class="chips">${tagChips(s)}${statusChip(s.cover.status)}
            ${chip(`${s.reports.length} reports`)}${chip(`${s.variants.length} variants`)}
            <span title="provenance findings">${healthBadges(s.path)}</span></div>
          ${s.cover.question ? `<div class="q">${esc(s.cover.question)}</div>` : ""}
          ${s.cover.verdict ? `<div class="v">${esc(s.cover.verdict)}</div>` : ""}
        </a>`).join("") || `<p class="muted">No study matches.</p>`;
  };
  const input = document.getElementById("filter");
  input.addEventListener("input", () => draw(input.value));
  draw("");
}

function viewStudy(id) {
  const s = S.study[id];
  if (!s) return notFound(`study ${id}`);
  const w = s.cover.wandb;
  const inbound = s.reports.flatMap((r) => (S.correctedBy[`${s.id}/${r.id}`] || []).map((c) => ({ r, c })));
  $main().innerHTML = `
    <div class="crumbs"><a href="#/">Studies</a> / ${esc(s.id)}</div>
    <h1>${esc(s.title.replace(/^Study:\s*/, ""))}</h1>
    <div class="chips">${tagChips(s)}${statusChip(s.cover.status)}
      ${w ? `<a class="chip" href="https://wandb.ai/${esc(w.entity)}/${esc(w.project)}" target="_blank" rel="noopener">W&amp;B ${esc(w.project)}</a>` : ""}
      <a class="chip" href="${STUDIES_REPO}/tree/${S.sha}/${esc(s.path)}" target="_blank" rel="noopener">source @ ${short(S.sha)}</a>
      <span class="chip">health ${healthBadges(s.path)}</span>
      ${s.cover.source === "readme" ? chip("cover parsed from README prose") : ""}</div>
    ${s.cover.question ? `<p><b>Question.</b> ${esc(s.cover.question)}</p>` : ""}
    ${s.cover.verdict ? `<p><b>Verdict.</b> ${esc(s.cover.verdict)}</p>` : ""}
    ${inbound.map(({ r, c }) => `<div class="banner correction"><b>Correction.</b>
      <a href="#/report/${s.id}/${r.id}">${esc(r.id)}</a> is corrected by
      <a href="#/report/${c.report._study}/${c.report.id}">${esc(c.report._study)} ${esc(c.report.id)}</a>: ${esc(c.note || "")}</div>`).join("")}
    <h2>How it connects</h2>
    <section class="map" id="local-map-host" aria-label="Studies this one builds on and those that built on it"></section>
    <h2>Reports</h2>
    <div class="table-wrap"><table><thead><tr><th>Report</th><th>Status</th><th>Result blocks</th><th>W&amp;B groups</th><th>Health</th></tr></thead><tbody>
    ${s.reports.map((r) => `<tr>
      <td><a href="#/report/${s.id}/${esc(r.id)}">${esc(r.title)}</a></td>
      <td>${statusChip(r.status)}${(S.correctedBy[`${s.id}/${r.id}`] || []).length ? chip("corrected", "status-superseded") : ""}</td>
      <td>${r.result_blocks.length}</td><td>${r.wandb_groups.length}</td>
      <td>${healthBadges(r.path, { exact: true })}</td></tr>`).join("") || `<tr><td colspan="5" class="muted">No reports.</td></tr>`}
    </tbody></table></div>
    <h2>Variants and launches</h2>
    ${launchTimeline([...s.variants.flatMap((v) => v.launch_records), ...(s.root_launch_records || [])]
      .filter((r) => r.format === "json"))}
    ${s.variants.map((v) => variantBlock(s, v)).join("")}
    ${(s.root_launch_records || []).length ? variantBlock(s, { name: "(study root, no variant)", path: s.path,
      launch_records: s.root_launch_records, wandb_groups: [...new Set(s.root_launch_records.flatMap((r) => r.wandb_groups))],
      notes: null }) : ""}
    <h2>Provenance findings</h2>
    ${findingList(findingsFor(s.path))}
    <details><summary>README</summary><div class="prose" id="readme"></div></details>`;
  document.getElementById("readme").appendChild(renderMarkdown(s.readme, `${s.path}/README.md`));
  if (window.Atlas?.drawLocal) window.Atlas.drawLocal(document.getElementById("local-map-host"), s.id);
}

function variantBlock(s, v) {
  const recs = v.launch_records.filter((r) => r.format === "json");
  return `<details ${recs.length ? "open" : ""}><summary>${esc(v.name)}
      <span class="muted">· ${recs.length} launch record${recs.length === 1 ? "" : "s"} · ${v.wandb_groups.length} W&amp;B group${v.wandb_groups.length === 1 ? "" : "s"}</span></summary>
    <div class="chips">${v.wandb_groups.map((g) => `<a class="chip mono" href="#/group/${encodeURIComponent(g)}">${esc(g)}</a>`).join("")}</div>
    ${recs.length ? `<div class="table-wrap"><table><thead><tr><th>When</th><th>Kind</th><th>Record</th><th>Note</th><th>Commits</th></tr></thead><tbody>
      ${recs.map((r) => `<tr><td class="mono">${esc((r.time || "").slice(0, 16).replace("T", " ") || "—")}</td>
        <td>${chip(r.kind || "?")}${r.schema_version === 2 ? "" : chip("v1")}</td>
        <td>${srcLink(r.path, r.path.split("/").pop())}</td>
        <td>${esc(r.note || "")}</td>
        <td>${Object.entries(r.revisions || {}).map(([k, sha]) => `${esc(k)} ${commitLink(k, sha)}`).join("<br>") || "—"}</td></tr>`).join("")}
      </tbody></table></div>` : `<p class="muted">No launch record.</p>`}
    ${v.notes ? `<details><summary>notes.md</summary><div class="prose" data-notes="${esc(v.path)}"></div></details>` : ""}
  </details>`;
}

function launchTimeline(records) {
  const pts = records.map((r) => ({ r, t: Date.parse(r.time) })).filter((p) => !isNaN(p.t));
  if (pts.length < 2) return "";
  const t0 = Math.min(...pts.map((p) => p.t)), t1 = Math.max(...pts.map((p) => p.t));
  const W = 900, H = 46, pad = 30, x = (t) => pad + ((t - t0) / Math.max(1, t1 - t0)) * (W - 2 * pad);
  const fmt = (t) => new Date(t).toISOString().slice(0, 10);
  return `<svg viewBox="0 0 ${W} ${H}" width="100%" role="img" aria-label="Launch timeline">
    <line class="axis" x1="${pad}" x2="${W - pad}" y1="20" y2="20" stroke-width="2"/>
    ${pts.map((p) => `<circle cx="${x(p.t)}" cy="20" r="5" fill="${p.r.kind === "initial" ? "var(--accent)" : "var(--warn)"}">
      <title>${esc(p.r._variant || "study root")} · ${esc(p.r.kind || "")} · ${esc(p.r.time)}</title></circle>`).join("")}
    <text x="${pad}" y="42">${fmt(t0)}</text><text x="${W - pad}" y="42" text-anchor="end">${fmt(t1)}</text>
  </svg>`;
}

function findingList(fs) {
  if (!S.healthRan) return `<p class="muted">The studies checker did not run for this build: ${esc(S.cat.health.error)}</p>`;
  if (!fs.length) return `<p class="muted">No errors or warnings.</p>`;
  const byCheck = {};
  for (const f of fs) (byCheck[f.check] ||= []).push(f);
  return Object.entries(byCheck).sort().map(([check, list]) => `<details><summary>
      <span class="lvl-${esc(list[0].level)}">${esc(check)}</span> <span class="muted">· ${list.length}</span></summary>
      <p class="muted">Fix: ${esc(list[0].fix || "")}</p>
      <ul class="findings">${list.map((f) => `<li>${srcLink(f.path, f.path.replace(/^studies\//, ""))}: ${esc(f.message)}</li>`).join("")}</ul>
    </details>`).join("");
}

function viewReport(sid, rid) {
  const r = S.reportByKey[`${sid}/${rid}`];
  if (!r) return notFound(`report ${sid}/${rid}`);
  const s = S.study[sid];
  const corrections = S.correctedBy[`${sid}/${rid}`] || [];
  const ref = (u) => u.report
    ? `<a href="#/report/${esc(u.study)}/${esc(u.report)}">${esc(u.study)} ${esc(u.report)}</a>`
    : u.wandb_group ? `<a class="mono" href="#/group/${encodeURIComponent(u.wandb_group)}">${esc(u.wandb_group)}</a>`
    : `<code>${esc(u.command || JSON.stringify(u))}</code>`;
  $main().innerHTML = `
    <div class="crumbs"><a href="#/">Studies</a> / <a href="#/study/${esc(sid)}">${esc(sid)}</a> / ${esc(r.id)}</div>
    <h1>${esc(r.title)}</h1>
    <div class="chips">${statusChip(r.status)}${r.authors.map((a) => chip(a)).join("")}
      ${srcLink(r.path, `source @ ${short(S.sha)}`)} <span class="chip">health ${healthBadges(r.path, { exact: true })}</span>
      ${VIEWS.history ? `<a class="chip" href="#/history/${esc(sid)}/${esc(r.id)}">history</a>` : ""}</div>
    ${r.status === "superseded" && r.superseded_by ? `<div class="banner superseded"><b>Superseded</b> by ${ref(r.superseded_by)}.</div>` : ""}
    ${r.status === "retracted" ? `<div class="banner superseded"><b>Retracted.</b> Its conclusion is wrong and nothing replaces it.</div>` : ""}
    ${corrections.map((c) => `<div class="banner correction"><b>Correction</b> by
      <a href="#/report/${c.report._study}/${c.report.id}">${esc(c.report._study)} ${esc(c.report.id)}</a>: ${esc(c.note || "")}</div>`).join("")}
    <details><summary>Provenance summary</summary>
      <dl class="kv">
        <dt>W&amp;B groups</dt><dd>${r.wandb_groups.map((g) => `<a class="mono" href="#/group/${encodeURIComponent(g)}">${esc(g)}</a>`).join(", ") || "—"}</dd>
        <dt>Inputs</dt><dd>${r.inputs.map((i) => `${esc(i.role)}: ${i.exists ? srcLink(i.path) : `<span class="lvl-error">${esc(i.path)} (missing)</span>`}`).join("<br>") || "—"}</dd>
        <dt>Upstream</dt><dd>${r.upstream.map(ref).join(", ") || "—"}</dd>
        <dt>Corrects</dt><dd>${r.corrects.map((c) => `${ref(c)} — ${esc(c.note || "")}`).join("<br>") || "—"}</dd>
        <dt>Reproduce</dt><dd>${r.reproduce ? `<code>${esc(r.reproduce)}</code>` : "—"}</dd>
      </dl>
      ${findingList(findingsFor(r.path, { exact: true }))}
    </details>
    <div class="prose" id="body"></div>`;
  const body = renderMarkdown(r.markdown, r.path);
  body.querySelector("h1")?.remove();      // the page heading already shows the report title
  for (const div of body.querySelectorAll(".result-block")) {
    const name = div.dataset.block;
    const head = document.createElement("div");
    head.className = "rb-head";
    head.innerHTML = `<span>result block <code>${esc(name)}</code></span>`;
    const btn = document.createElement("button");
    btn.type = "button";
    btn.textContent = "Provenance";
    btn.addEventListener("click", () => openDrawer(r, name));
    head.appendChild(btn);
    div.prepend(head);
    if (window.Atlas?.linkNumbers) window.Atlas.linkNumbers(div, r, name);
  }
  document.getElementById("body").appendChild(body);
}

function producersFor(r, block) {
  // v2: artifacts whose outputs name this block. Else: the report's JSON inputs.
  const exact = S.producersOf[`${r.path}#${block}`] || [];
  if (exact.length) return { list: exact, how: "declared" };
  const viaInputs = r.inputs.map((i) => S.artifactByPath[i.path]).filter(Boolean);
  return { list: viaInputs, how: "inputs" };
}

function openDrawer(r, block, extra = "") {
  // each lineage step opens to its own details (map.js), so the drawer carries no separate list
  const body = document.getElementById("drawer-body");
  body.innerHTML = `
    <div class="k muted">Provenance</div>
    <h2 style="margin-top:0">${esc(r._study)} ${esc(r.id)} · <code>${esc(block)}</code></h2>
    ${extra}
    <div id="drawer-lineage"></div>`;
  if (window.Atlas?.mountLineage) window.Atlas.mountLineage(document.getElementById("drawer-lineage"), r, block);
  const drawer = document.getElementById("drawer");
  if (drawer.hidden) S.drawerOpener = document.activeElement;   // focus returns here on close
  drawer.hidden = false;
  drawer.focus();
}

function closeDrawer() {
  const drawer = document.getElementById("drawer");
  if (drawer.hidden) return;
  drawer.hidden = true;
  if (S.drawerOpener?.isConnected) S.drawerOpener.focus();
  S.drawerOpener = null;
}

function recordSummary(r, path) {
  if (!r) return `<div>${srcLink(path)}</div>`;
  if (r.format !== "json") return `<div class="muted">manifest ${srcLink(r.path, r.path.split("/").pop())}</div>`;
  return `<dl class="kv" style="margin-top:6px">
    <dt>Launch record</dt><dd>${srcLink(r.path, r.path.split("/").slice(-3).join("/"))}</dd>
    <dt>Kind</dt><dd>${esc(r.kind || "?")} on ${esc(r.platform || "?")}${r.schema_version === 2 ? "" : " (v1 record)"}</dd>
    ${r.time ? `<dt>When</dt><dd>${esc(r.time)}</dd>` : ""}
    ${r.note ? `<dt>Why</dt><dd>${esc(r.note)}</dd>` : ""}
    ${r.job_refs.map((j) => `<dt>${esc(j.type)}</dt><dd>${j.type === "beaker_experiment"
      ? `<a href="https://beaker.org/ex/${esc(j.id)}" target="_blank" rel="noopener" class="mono">${esc(j.id)}</a>` : `<code>${esc(j.id)}</code>`}</dd>`).join("")}
    ${Object.entries(r.revisions || {}).map(([k, sha]) => `<dt>${esc(k)}</dt><dd>${commitLink(k, sha)}</dd>`).join("")}
  </dl>`;
}

function viewGroup(g) {
  const e = S.cat.wandb_groups[g];
  if (!e) return notFound(`W&B group ${g}`);
  $main().innerHTML = `
    <div class="crumbs"><a href="#/">Studies</a> / ${e.study ? `<a href="#/study/${esc(e.study)}">${esc(e.study)}</a> / ` : ""}W&amp;B group</div>
    <h1 class="mono">${esc(g)}</h1>
    <div class="chips">${e.variant ? chip(`variant ${e.variant}`) : ""}
      ${e.url ? `<a class="chip" href="${esc(e.url)}" target="_blank" rel="noopener">open in W&amp;B</a>` : ""}</div>
    <h2>Launch records</h2>${e.launch_records.map((p) => recordSummary(S.recordByPath[p], p)).join("<hr>") ||
      `<p class="lvl-warn">No launch record names this group.</p>`}
    <h2>Reports citing it</h2><ul>${e.reports.map((p) => {
      const r = S.reportByPath[p]; return `<li>${r ? `<a href="#/report/${r._study}/${r.id}">${esc(r._study)} ${esc(r.title)}</a>` : esc(p)}</li>`;
    }).join("") || "<li class=muted>none</li>"}</ul>
    <h2>Artifacts reading it</h2><ul>${e.artifacts.map((p) => `<li>${srcLink(p)}</li>`).join("") || "<li class=muted>none</li>"}</ul>`;
}

function viewHealth() {
  const h = S.cat.health;
  $main().innerHTML = `<h1>Provenance health</h1>
    <p class="muted">Findings from the studies repo's <code>scripts/check_provenance.py</code> at
      ${commitLink("studies", S.cat._meta.studies_git_sha)}. Errors and warnings in files that predate a rule sit in its
      baseline; any new one fails the studies CI.${h.ran ? ` Baseline: ${esc(h.baseline_size)} findings.` : ""}</p>
    <div class="table-wrap"><table><thead><tr><th>Study</th><th>Errors</th><th>Warnings</th></tr></thead><tbody>
      ${S.cat.studies.map((s) => { const fs = findingsFor(s.path);
        return `<tr><td><a href="#/study/${esc(s.id)}">${esc(s.id)}</a></td>
          <td>${fs.filter((f) => f.level === "error").length}</td><td>${fs.filter((f) => f.level === "warn").length}</td></tr>`; }).join("")}
    </tbody></table></div>
    <h2>By check</h2>${findingList(S.findings.filter((f) => f.level !== "info"))}`;
}

function notFound(what) {
  $main().innerHTML = `<h1>Not found</h1><p class="muted">No ${esc(what)} in this catalog
    (studies ${esc(short(S.sha))}).</p><p><a href="#/">Back to studies</a></p>`;
}

// Views added by later modules (cross-study, history) register here.
const VIEWS = {};

function route() {
  try { return routeInner(); } catch (err) {
    console.error(err);            // surfaces to the smoke test and devtools
    $main().innerHTML = `<h1>Rendering failed</h1><p class="lvl-error">${esc(err.message)}</p>`;
  }
}

function routeInner() {
  document.getElementById("drawer").hidden = true;
  const [path, anchor] = location.hash.replace(/^#\/?/, "").split("?");
  const parts = path.split("/").map(decodeURIComponent);
  window.scrollTo(0, 0);
  renderRoute(parts);
  if (anchor) document.getElementById(decodeURIComponent(anchor))?.scrollIntoView({ block: "start" });
}

function renderRoute(parts) {
  const [view, a, b] = parts;
  if (!view) return viewStudies();
  if (view === "study") return viewStudy(a);
  if (view === "report") return viewReport(a, b);
  if (view === "group") return viewGroup(parts.slice(1).join("/"));
  if (view === "health") return viewHealth();
  if (VIEWS[view]) return VIEWS[view](...parts.slice(1));
  return notFound(`page ${view}`);
}

// Expand <details> notes lazily (they can be long).
document.addEventListener("toggle", (ev) => {
  const d = ev.target.querySelector?.("[data-notes]");
  if (d && !d.childElementCount) {
    const v = S.cat.studies.flatMap((s) => s.variants).find((x) => x.path === d.dataset.notes);
    if (v?.notes) d.appendChild(renderMarkdown(v.notes, `${v.path}/notes.md`));
  }
}, true);

document.addEventListener("click", (e) => {
  const a = e.target.closest?.("a[data-anchor]");
  if (!a) return;
  e.preventDefault();
  const el = document.getElementById(a.dataset.anchor);
  if (el) el.scrollIntoView({ behavior: "smooth", block: "start" });
});

// Hide navigation to views no module registered.
function syncNav() {
  for (const a of document.querySelectorAll(".top nav a[data-view]")) a.hidden = !VIEWS[a.dataset.view];
}

document.querySelector(".drawer-close").addEventListener("click", closeDrawer);
document.addEventListener("keydown", (e) => { if (e.key === "Escape") closeDrawer(); });

// the banner's GitHub menu closes on a pick, a click elsewhere, or Escape; capture phase, since the
// map and About graphs stop their clicks from bubbling
const reposMenu = document.getElementById("repos");
// right-aligned to its button, shifted to stay 8 px inside both viewport edges (the header wraps at any width)
reposMenu?.addEventListener("toggle", () => {
  const menu = reposMenu.querySelector(".repos-menu");
  menu.style.transform = "";
  if (!reposMenu.open) return;
  const r = menu.getBoundingClientRect(), vw = document.documentElement.clientWidth;
  const dx = r.left < 8 ? 8 - r.left : r.right > vw - 8 ? vw - 8 - r.right : 0;
  if (dx) menu.style.transform = `translateX(${dx}px)`;
});
document.addEventListener("click", (e) => { if (reposMenu?.open && (!reposMenu.contains(e.target) || e.target.closest("a"))) reposMenu.open = false; }, true);
document.addEventListener("keydown", (e) => {
  if (e.key !== "Escape" || !reposMenu?.open) return;
  const inside = reposMenu.contains(document.activeElement);
  reposMenu.open = false;
  if (inside) reposMenu.querySelector("summary").focus();      // keep the keyboard user's place
});

fetch("data/catalog.json")
  .then((r) => { if (!r.ok) throw new Error(`catalog.json: HTTP ${r.status}`); return r.json(); })
  .then((cat) => {
    index(cat);
    const m = cat._meta;
    document.getElementById("pin").innerHTML =
      `studies ${commitLink("studies", m.studies_git_sha)} · built ${esc((m.built_at_pt || "").slice(0, 16).replace("T", " "))} PT`;
    window.Atlas = Object.assign(window.Atlas || {}, { S, VIEWS, esc, chip, srcLink, commitLink, short, openDrawer,
      renderMarkdown, findingsFor, statusChip, route, STUDIES_REPO, producersFor });
    document.dispatchEvent(new Event("atlas:ready"));
    syncNav();
    window.addEventListener("hashchange", route);
    route();
  })
  .catch((err) => {
    console.error(err);
    $main().innerHTML = `<h1>Could not load the catalog</h1><p class="lvl-error">${esc(err.message)}</p>`;
  });
