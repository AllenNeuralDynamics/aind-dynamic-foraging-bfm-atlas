/* The leaderboard (#/leaderboard): every model family's held-out choice likelihood on one axis.
 * Data come from catalog.leaderboard (src/bfm_atlas/leaderboard.py), read at build time from the
 * studies files that hold each number. The boards with ignored trials (#/leaderboard/three_way,
 * #/leaderboard/engage) come from catalog.leaderboard_ignore and are drawn the same way. Hover a dot for what it is; click it to open the result
 * block that reports it. Registers through window.Atlas; uses map.js's tooltip and Export SVG.
 */
"use strict";

document.addEventListener("atlas:ready", () => {
  const A = window.Atlas;
  const { S, VIEWS, esc } = A;
  const main = () => document.getElementById("main");

  // x units per category, in each panel; the layout follows the original matplotlib figure
  const STEP = { cognitive: 1, literature: 0.5, glmhmm: 0.55, disrnn: 1, gru: 1.35 };
  const GROUP_GAP = 0.4, PANEL_PAD = 0.65;
  const EMPTY_SPAN = 5;          // x units an empty panel (its source not on main yet) keeps for its note
  const PX_PER_UNIT = 44;        // the chart widens with its x range instead of squeezing every panel
  const MIN_W = 760;             // #leaderboard's min-width in style.css
  const H_ALL = [16, 64, 128, 256, 512];
  const H_DODGE = 0.15;          // x offset per hidden size, inside a GRU D column
  const HEXAGON = { draw(ctx, size) {          // d3 has no hexagon symbol
    const r = Math.sqrt(size / (1.5 * Math.sqrt(3)));
    for (let i = 0; i < 6; i++) {
      const a = Math.PI / 3 * i + Math.PI / 6;
      i ? ctx.lineTo(r * Math.cos(a), r * Math.sin(a)) : ctx.moveTo(r * Math.cos(a), r * Math.sin(a));
    }
    ctx.closePath();
  } };
  // style per series id: CSS colour token, marker, line dash, marker fill
  const STYLE = {
    "ctt": { c: "--lb-ctt", m: d3.symbolCircle, fill: "hb" },
    "hattori": { c: "--lb-hattori", m: d3.symbolSquare, fill: "hb" },
    // the three GLM-HMM protocols share x and cross near K = 3-5: nudge them apart and shrink their
    // hover circles so each marker stays selectable
    "glmhmm-refit": { c: "--lb-glm", m: d3.symbolCircle, size: 34, dx: -0.12, hit: 5 },
    "glmhmm-pooled": { c: "--lb-glm-pooled", m: d3.symbolSquare, size: 30, dx: 0, hit: 5 },
    "glmhmm-zeroshot": { c: "--lb-glm", m: d3.symbolCircle, size: 34, dash: "4 3", fill: "hollow", dx: 0.12, hit: 5 },
    "disrnn-b3e-4": { c: "--lb-dis-op", m: HEXAGON, dash: "5 3" },
    "disrnn-b1e-4": { c: "--lb-dis-best", m: HEXAGON },
    "gru-reservoir": { c: "--lb-res", m: d3.symbolTimes, dash: "4 2", stroke: true, size: 60 },
    ...Object.fromEntries(H_ALL.map((h) => [`gru-h${h}`, { c: `--lb-h${h}`, m: d3.symbolDiamond }])),
  };
  // study 12's families: a colour each, in the panel's family order; different models, so no line
  let familyIndex = () => 0;     // set per draw
  // a literature model is a pair: its per-subject fit hollow on the left, its 2-level EM fit filled on the right
  const PAIR_DX = 0.1;
  const fitDx = (p) => (p.fit_kind === "em" ? PAIR_DX : p.fit_kind === "per_subject" ? -PAIR_DX : 0);
  const styleOf = (s) => s.family ? { c: `--lb-fam${(familyIndex(s.family) % 6) + 1}`, m: d3.symbolCircle, size: 40, noline: true, hit: 6 }
    : STYLE[s.id] || { c: "--m-other", m: d3.symbolCircle };
  const legendLabel = (s) => s.overlay ? `From the literature (other fit): ${s.label}` : s.family ? `From the literature: ${s.label}` : s.label;
  const signed = (v) => `${v >= 0 ? "+" : "−"}${fmt(Math.abs(v))}`;
  let twinOf = new Map(), emOf = new Map();     // per draw: literature model -> its headline / other-fit point
  const FORAGING_MODELS = "https://github.com/AllenNeuralDynamics/aind-dynamic-foraging-models";
  const httpsOnly = (u) => (/^https:\/\//.test(u || "") ? u : null);
  const colour = (s) => `var(${styleOf(s).c})`;

  const fmt = (v) => v.toFixed(4);
  let rankOf = () => 0;          // set per draw from the literature panel's order
  const xText = (panel, x) => panel === "cognitive" ? x.replace(" MLE", ", per-mouse fit (MLE)").replace(" HB", ", hierarchical Bayes (HB)")
    : panel === "literature" ? `${x}, rank ${rankOf(x)}`
    : panel === "glmhmm" ? `K = ${x} states` : `D = ${x} training mice`;
  const blockRoute = (b) => `#/report/${encodeURIComponent(b.study)}/${encodeURIComponent(b.report)}?block-${encodeURIComponent(b.block)}`;
  const lineageRoute = (b) => `#/lineage/${encodeURIComponent(b.study)}/${encodeURIComponent(b.report)}/${encodeURIComponent(b.block)}`;
  const studyNo = (id) => id.split("-")[0];
  // deterministic jitter, so a redraw does not move the seed dots
  const jitter = (key) => { let h = 0; for (const ch of key) h = (h * 31 + ch.charCodeAt(0)) | 0; return ((h >>> 0) % 1000) / 1000 - 0.5; };

  // what each family may fit to a held-out mouse before it is scored (wrapper and study docs:
  // study 01 r4, study 13, study 14 r1); plain HTML, so it reads the same in every theme
  // the pooled-refit row and sentence appear only when that series is drawn (its source, study 14's r2,
  // may not be on studies main yet)
  const notes = (pooled) => `<section class="lb-notes">
    <h2>How each model meets a held-out mouse</h2>
    <p>Every model is scored on sessions of a held-out mouse that nothing was fitted to. Before that, a model may
      learn from the mouse's other sessions, and how much it may learn differs by family:</p>
    <div class="table-wrap"><table>
      <thead><tr><th>Model</th><th>Learned from the training mice</th><th>Fitted to each held-out mouse</th></tr></thead>
      <tbody>
        <tr><td>CTT, Hattori, study 12's models from the literature: MLE</td><td>nothing</td><td>all of its parameters, by maximum
          likelihood (no prior, nothing shared across mice)</td></tr>
        <tr><td>Study 12's models from the literature: 2-level EM</td><td>nothing</td><td>its own typical parameters, with each
          session's parameters varying around them under a fixed prior (Laplace-EM on its even sessions; odd sessions
          scored by the session marginal)</td></tr>
        <tr><td>CTT, Hattori: HB</td><td>nothing</td><td>its own parameters plus how they vary from session to session
          (hierarchical Bayes, one mouse at a time, under a fixed prior)</td></tr>
        <tr><td>GLM-HMM, refit</td><td>one shared GLM-HMM</td><td>its own GLM-HMM, started from the shared fit</td></tr>
        ${pooled ? `<tr><td>GLM-HMM, refit pooled</td><td>one shared GLM-HMM</td><td>its own GLM-HMM, with its weights
          pulled toward the shared fit (and, at larger K, its transitions); how hard is picked on the training
          mice</td></tr>` : ""}
        <tr><td>GLM-HMM, zero-shot</td><td>one shared GLM-HMM</td><td>nothing: the shared fit predicts every mouse</td></tr>
        <tr><td>disRNN, GRU</td><td>one shared network</td><td>a subject embedding (a short vector for that mouse); the
          network stays as trained</td></tr>
        <tr><td>GRU, reservoir only</td><td>embeddings and readout around a random, frozen core</td><td>a subject embedding</td></tr>
      </tbody></table></div>
    <p><b>Why the ${pooled ? "three" : "two"} GLM-HMM lines differ.</b> The refit line gives each held-out mouse its own model, as the GRU
      and disRNN get their own embedding, so it is the like-for-like comparison. But each state adds parameters to
      that per-mouse model, and from a few states on it fits the noise in the mouse's sessions: the refit score
      peaks at a small K and then falls. The zero-shot line fits nothing per mouse, so extra states cannot overfit
      one mouse; with more states the shared fit can hold more kinds of behaviour seen across the training mice
      (study 14 finds side-biased states at large K), and it keeps rising. Study 14's
      <a href="#/report/14-glmhmm-vs-gru-heldout/r1?block-result-1">r1</a> shows both scores.${pooled ? `
      The pooled line keeps the per-mouse refit but pulls its weights toward the shared fit (and, where the
      training mice's score prefers it, its transitions too), so a mouse moves only as far as its own sessions
      support. It scores above the zero-shot line at every K and keeps rising with K, so the early peak of the
      plain refit came from overfitting each mouse
      (<a href="#/report/14-glmhmm-vs-gru-heldout/r2?block-result-2">r2</a>).` : ""}</p>
  </section>`;

  // the boards with ignored trials: which models are on them, and what each score counts
  const ignoreNotes = (L) => `<section class="lb-notes">
    <h2>Which models are on this board</h2>
    <p>Every trial of the held-out sessions is scored here, ignored trials included, so only models that predict an
      ignore can be drawn: study 02's 3-way GRU (left, right or ignore as its output; trained with ignored trials kept)
      and study 14's GLM-HMM (hurdle emission: per state, a respond-or-ignore GLM times a left-or-right GLM). Study 12's
      models from the literature and study 13's CTT and Hattori fits predict left vs right only, and are on the
      <a href="#/leaderboard">choice board</a>; so are the disRNN and study 01's 2-way GRU.</p>
    <div class="table-wrap"><table>
      <thead><tr><th>Score</th><th>What it counts</th><th>Chance</th></tr></thead>
      <tbody>
        <tr><td>3-way</td><td>probability of the actual outcome (left, right or ignore), every trial</td><td>1/3</td></tr>
        <tr><td>Engagement</td><td>probability of respond vs ignore, every trial</td><td>1/2</td></tr>
        <tr><td>Choice (other board)</td><td>probability of left vs right, responded trials only</td><td>1/2</td></tr>
      </tbody></table></div>
    <p>A held-out mouse meets each model as on the choice board: the GRU fits only a subject embedding; the GLM-HMM is
      refitted to the mouse (refit), refitted with its weights pulled toward the shared fit (pooled), or not fitted at
      all (zero-shot).${L.id === "engage" ? ` On this board the GLM-HMM has no pooled line: study 14 reports the
      engagement score of its pooled refit in no result block.` : ""}</p>
  </section>`;

  // a family name on at most two lines, broken at the space that leaves the shorter longest line
  const LABEL_PX = 6.2;          // about one character of the 11 px bold group label
  function wrapLabel(label) {
    const words = label.split(" ");
    if (label.length <= 14 || words.length < 2) return [label];
    let best = [label];
    for (let i = 1; i < words.length; i++) {
      const cut = [words.slice(0, i).join(" "), words.slice(i).join(" ")];
      if (Math.max(...cut.map((l) => l.length)) < Math.max(...best.map((l) => l.length))) best = cut;
    }
    return best;
  }

  function layout(panels) {
    const pos = {}, spans = [];
    let x = PANEL_PAD;
    for (const p of panels) {
      const step = STEP[p.id] || 1, start = x;
      const groups = p.groups || [{ label: null, x: p.x }];
      if (!groups.some((g) => g.x.length)) {
        spans.push({ id: p.id, label: p.label, x0: start, x1: start + EMPTY_SPAN, groups: [] });
        x = start + EMPTY_SPAN + 2 * PANEL_PAD;
        continue;
      }
      const labels = [];
      groups.forEach((g, gi) => {
        if (gi) x += GROUP_GAP;
        // a study 12 family is at least as wide as its name (up to two lines), its models centred under it
        const lines = p.id === "literature" && g.label ? wrapLabel(g.label) : null;
        const natural = (g.x.length - 1) * step;
        const w = Math.max(natural, lines ? Math.max(...lines.map((l) => l.length)) * LABEL_PX / PX_PER_UNIT : 0);
        const g0 = x;
        g.x.forEach((v, i) => { pos[`${p.id}|${v}`] = g0 + (w - natural) / 2 + i * step; });
        if (g.label) labels.push({ label: g.label, lines, at: g0 + w / 2 });
        x = g0 + w + step;
      });
      x -= step;
      spans.push({ id: p.id, label: p.label, x0: start, x1: x, groups: labels });
      x += 2 * PANEL_PAD;
    }
    return { pos, spans, xmax: x - PANEL_PAD };
  }

  // the modelling landscape (from the lab's "modeling dynamic foraging" slide): why these models. Editorial and
  // hand-written: rows assume less about the strategy going up, columns assume less about how stable it is going
  // right. A box with series prefixes is on the leaderboard; hovering it highlights those series in the chart, and
  // clicking it keeps them highlighted (pins it) until it is clicked again.
  const COLS = ["Per session / per subject", "Hierarchical (pooled across mice and sessions)", "State-space: discrete states (HMM)",
    "State-space: continuous drift (dynamic)"];
  const LANDSCAPE = [   // top row first; col is [first column, span]
    [{ label: "Gated recurrent units (GRUs)", col: [1, 4], series: ["gru-"], key: "gru",
       note: "A recurrent network that learns the strategy from data; a held-out mouse gets its own embedding." }],
    [{ label: "Disentangled recurrent neural networks (disRNNs)", col: [1, 4], series: ["disrnn-"], key: "disrnn",
       note: "A recurrent network with a bottleneck that keeps its latent variables few and readable." }],
    [{ label: "Per-session / per-subject GLM", col: [1, 1], note: "A logistic regression on recent choices and rewards. Not on the leaderboard." },
     { label: "Hierarchical GLM", col: [2, 1], note: "Not on the leaderboard yet." },
     { label: "HMM + GLM", col: [3, 1], series: ["glmhmm-"], key: "glmhmm",
       note: "GLM-HMM: the GLM's weights switch between a few hidden states (study 14)." },
     { label: "Dynamic GLM", col: [4, 1], note: "GLM weights that drift from trial to trial. Not on the leaderboard yet." }],
    [{ label: "Per-session / per-subject cognitive models", col: [1, 1], series: ["ctt", "hattori", "literature-"], key: "cog-subject",
       note: "A named strategy (e.g. Q-learning, compare-to-threshold) fitted to each session or each mouse alone (on the leaderboard: per mouse): CTT and Hattori MLE, and the hollow per-subject markers of the models from the literature." },
     { label: "Hierarchical cognitive models", col: [2, 1], series: ["ctt", "hattori", "literature-"], key: "cog-hier",
       note: "The same strategies with each session's parameters varying around the mouse's own: CTT and Hattori HB, and the filled (2-level EM) markers of the models from the literature." },
     { label: "HMM + cognitive", col: [3, 1], note: "A cognitive model whose parameters switch between hidden states. Not on the leaderboard yet." },
     { label: "Dynamic cognitive", col: [4, 1], note: "Cognitive parameters that drift over time. Not on the leaderboard yet." }],
  ];
  const landscape = () => `<details class="lb-landscape" open><summary>Why these models</summary>
    <p><b>Going up</b>, a model assumes less about the strategy (cognitive hypothesis, GLM weights, recurrent network).
      <b>Going right</b>, it assumes less about how stable the strategy is across mice and time. Filled boxes are on the
      leaderboard below: hover one to highlight its models, click it to keep them highlighted, click again to clear.
      Hovering a marker in the chart lights its box here.</p>
    <div class="lsc" role="group" aria-label="The modelling landscape">
      <div class="lsc-y" aria-hidden="true"><span>Data-driven</span><span class="lsc-arrow-y"></span><span>Hypothesis-driven</span></div>
      ${LANDSCAPE.map((row, r) => row.map((c) => `<div class="lsc-cell ${c.series ? "lsc-on" : "lsc-off"}"
        style="grid-row:${r + 1};grid-column:${c.col[0] + 1} / span ${c.col[1]}" title="${esc(c.note)}"
        ${c.series ? `data-series="${esc(c.series.join(" "))}" data-key="${c.key}" role="button" aria-pressed="false" tabindex="0"` : ""}>${esc(c.label)}</div>`).join("")).join("")}
      ${COLS.map((c, i) => `<div class="lsc-col" style="grid-row:5;grid-column:${i + 2}">${esc(c)}</div>`).join("")}
      <div class="lsc-x" aria-hidden="true"><span>Stationary</span><span class="lsc-arrow-x"></span><span>Non-stationary</span></div>
    </div></details>`;
  // hovering a chart marker lights its box in the landscape: a CTT, Hattori or literature point by its fit (per-subject
  // MLE, or hierarchical: HB and 2-level EM), every other point by its series; markCell() with nothing clears it
  function markCell(s, p) {
    const key = !s ? null
      : s.panel === "cognitive" ? (/ HB$/.test(p.x) ? "cog-hier" : "cog-subject")
      : s.panel === "literature" ? (p.fit_kind === "em" ? "cog-hier" : "cog-subject")
      : LANDSCAPE.flat().find((c) => c.series && c.series.some((q) => s.id.startsWith(q)))?.key;
    for (const cell of main().querySelectorAll(".lsc-cell[data-key]")) cell.classList.toggle("lsc-lit", cell.dataset.key === key);
  }
  // the series test of the pinned landscape box (null: none); leaving any hover returns the chart to it
  let pinned = null;
  const highlight = (keep) => {
    const layer = d3.select("#leaderboard .lb-data").classed("lb-focus", !!keep);
    if (keep) layer.selectAll(".lb-series").classed("lb-on", function () { return keep(this.dataset.series); });
  };
  const unhighlight = () => highlight(pinned);
  // hovering (or focusing) a filled box highlights its series in the chart, as a legend entry does; a click (or
  // Enter / Space) pins it, so the highlight stays while the reader looks at the chart
  function wireLandscape() {
    pinned = null;
    const cells = [...main().querySelectorAll(".lsc-cell[data-series]")];
    for (const cell of cells) {
      const prefixes = cell.dataset.series.split(" ");
      const keep = (id) => prefixes.some((p) => id.startsWith(p));
      const toggle = () => {
        const was = cell.getAttribute("aria-pressed") === "true";
        for (const c of cells) c.setAttribute("aria-pressed", "false");
        cell.setAttribute("aria-pressed", String(!was));
        pinned = was ? null : keep;
        highlight(keep);     // the pointer (or focus) is still on this box
      };
      cell.addEventListener("pointerenter", () => highlight(keep)); cell.addEventListener("focus", () => highlight(keep));
      cell.addEventListener("pointerleave", unhighlight); cell.addEventListener("blur", unhighlight);
      cell.addEventListener("click", toggle);
      cell.addEventListener("keydown", (ev) => { if (ev.key === "Enter" || ev.key === " ") { ev.preventDefault(); toggle(); } });
    }
  }

  // the boards: the choice board, then the boards with ignored trials (if this catalog has them)
  const tabs = (current) => {
    const boards = [{ id: "", title: "Choice (left / right)" }, ...(S.cat.leaderboard_ignore || [])];
    if (boards.length < 2) return "";
    return `<nav class="lb-tabs" aria-label="Leaderboard boards">${boards.map((b) =>
      `<a href="#/leaderboard${b.id ? `/${encodeURIComponent(b.id)}` : ""}"${b.id === current ? ` aria-current="page"` : ""}>${esc(b.title)}</a>`).join("")}</nav>`;
  };

  VIEWS.leaderboard = (which) => {
    const ignore = (S.cat.leaderboard_ignore || []).find((b) => b.id === which);
    const L = ignore || S.cat.leaderboard;
    const id = ignore ? ignore.id : "";
    if (!L) {
      main().innerHTML = `<h1>Leaderboard</h1><p class="muted">This catalog has no leaderboard data (built by an older bfm-atlas).</p>`;
      return;
    }
    const missing = L.missing || [];
    const missingNote = missing.length ? `<p class="muted lb-missing">Not on studies <span class="mono">main</span> yet, so left out:
        ${[...new Map(missing.map((m) => [`${m.series}|${m.path}`, m])).values()].map((m) =>
          `${esc(m.label || m.series)} (study ${esc(studyNo(m.block.study))} ${esc(m.block.report)}, <span class="mono">${esc(m.path.split("/").pop())}</span>)`).join("; ")}.</p>` : "";
    if (!L.available) {
      main().innerHTML = `<h1>Leaderboard</h1>${tabs(id)}<p class="muted">This board has no data yet.</p>${missingNote}`;
      return;
    }
    const howTo = `Large markers are the mean ± SEM over seeds; small dots are single seeds.
        <b>Hover</b> a marker for what it is; <b>click</b> it to open the result block that reports it`;
    main().innerHTML = ignore ? `
      <h1>Leaderboard</h1>
      ${tabs(id)}
      <p class="lb-lede">${esc(L.metric)}. Each model family is read from the study that measured it. ${howTo}.
        With the keyboard: Tab to a marker, Enter opens its block, Down arrow moves into its card, Escape returns.</p>
      ${missingNote}
      ${landscape()}
      <div class="map-tools"><button type="button" class="export" id="lb-export">Export SVG</button></div>
      <div class="lb-host"><div class="lb-wrap"><svg id="leaderboard" role="img" aria-label="Leaderboard: ${esc(L.ylabel)}"></svg></div></div>
      ${ignoreNotes(L)}` : `
      <h1>Leaderboard</h1>
      ${tabs(id)}
      <p class="lb-lede">${esc(L.metric)}. Each model family is read from the study that measured it.
        ${howTo}
        (a model from the literature opens its own panel: what it is, its equations, paper and code).
        In the panel of models from the literature each model is a pair, its per-subject fit (hollow, left) and its 2-level EM fit (filled,
        right), joined by a line and named above; pairs are ranked by study 12's headline score (the 2-level EM score, or
        the per-subject one where it is higher). With the keyboard: Tab to a marker, Enter opens its block, Down arrow moves into its card, Escape returns.</p>
      ${missingNote}
      ${landscape()}
      <div class="map-tools"><button type="button" class="export" id="lb-export">Export SVG</button></div>
      <div class="lb-host"><div class="lb-wrap"><svg id="leaderboard" role="img" aria-label="Leaderboard: held-out choice likelihood by model"></svg></div></div>
      ${notes(L.series.some((s) => s.id === "glmhmm-pooled"))}`;
    // the hover card lives on the non-scrolling .lb-host: tooltip() places it from viewport bounds,
    // which would be off by the scroll offset inside the horizontally scrolling .lb-wrap
    draw(L, main().querySelector(".lb-host"));
    wireLandscape();
    document.getElementById("lb-export").addEventListener("click", () =>
      A.downloadSvg(document.getElementById("leaderboard"), `leaderboard-${id ? `${id}-` : ""}${(S.sha || "main").slice(0, 8)}.svg`));
  };

  function draw(L, host) {
    const tip = A.tooltip(host);
    // keyboard users Tab from a marker into its card's links: hide the card only once focus leaves it
    const tipEl = host.querySelector(".tip");
    tipEl.addEventListener("focusout", (ev) => { if (!tipEl.contains(ev.relatedTarget)) tip.hide(); });
    // Down arrow on a marker enters its card (the card sits after the whole chart in Tab order);
    // Escape inside the card returns to that marker
    let active = null;
    tipEl.addEventListener("keydown", (ev) => { if (ev.key === "Escape" && active) { ev.stopPropagation(); active.focus(); } });
    const { pos, spans, xmax } = layout(L.panels);
    const series = L.series;
    // at least the chart's CSS min-width (a board with few panels, e.g. the ones with ignored trials, would be
    // narrower and get stretched past its frame)
    const M = { l: 70, r: 14, t: 16, b: 84 }, W = Math.max(MIN_W, Math.round(M.l + M.r + xmax * PX_PER_UNIT));
    host.style.setProperty("--lb-w", `${W + 2}px`);
    const litPanel = L.panels.find((p) => p.id === "literature");
    const ranks = new Map(series.filter((s) => s.family && !s.overlay).flatMap((s) => s.points.map((p) => [p.x, p.rank])));
    twinOf = new Map(series.filter((s) => s.family && !s.overlay).flatMap((s) => s.points.map((p) => [p.x, p])));
    emOf = new Map(series.filter((s) => s.overlay).flatMap((s) => s.points.map((p) => [p.x, p])));
    rankOf = (v) => ranks.get(v) || 0;
    familyIndex = (f) => Math.max(0, (litPanel?.groups || []).findIndex((g) => g.label === f));
    // legend rows above the plot
    // the other-fit series share one legend entry
    const legendItems = [...series.filter((s) => !s.overlay), ...(series.some((s) => s.overlay) ? [{ em: true }] : [])];
    const perRow = W < 1000 ? 2 : 3, rowH = 18, legendH = Math.ceil(legendItems.length / perRow) * rowH + 8;
    const plotTop = M.t + legendH, H = plotTop + 340 + M.b;
    const svg = d3.select("#leaderboard").attr("viewBox", `0 0 ${W} ${H}`);
    const xAt = (s, p) => pos[`${s.panel}|${p.x}`] + (s.h ? (H_ALL.indexOf(s.h) - 2) * H_DODGE : 0) + (styleOf(s).dx || 0) + fitDx(p);
    // the axis is set by every series but study 12's ranking, whose weakest models sit far below the rest
    // (unless it is the only one); a point outside it is drawn at the edge (▼ / ▲) with its value in the card
    const axisSeries = series.some((s) => s.panel !== "literature") ? series.filter((s) => s.panel !== "literature") : series;
    const all = axisSeries.flatMap((s) => s.points.flatMap((p) => [...p.values, p.mean - (p.sem || 0), p.mean + (p.sem || 0)]));
    const [lo, hi] = d3.extent(all), pad = (hi - lo) * 0.06;
    const x = d3.scaleLinear([0, xmax], [M.l, W - M.r]);
    const y = d3.scaleLinear([lo - pad, hi + pad], [H - M.b, plotTop]).nice();

    // axes, panel dividers, labels
    const ticks = L.panels.flatMap((p) =>
      (p.groups ? p.groups.flatMap((g) => g.x) : p.x).map((v) => ({ at: pos[`${p.id}|${v}`],
        text: p.id === "cognitive" ? String(v).split(" ").pop() : p.id === "literature" ? String(rankOf(v)) : String(v) })));
    const g = svg.append("g").attr("class", "lb-axes");
    g.append("g").attr("transform", `translate(${M.l},0)`).call(d3.axisLeft(y).ticks(8).tickFormat(d3.format(".3f")));
    const xa = g.append("g").attr("transform", `translate(0,${H - M.b})`);
    xa.append("line").attr("x1", M.l).attr("x2", W - M.r).attr("class", "lb-axisline");
    for (const t of ticks) {
      xa.append("line").attr("x1", x(t.at)).attr("x2", x(t.at)).attr("y2", 5).attr("class", "lb-axisline");
      xa.append("text").attr("x", x(t.at)).attr("y", 17).attr("text-anchor", "middle").attr("class", "lb-tick").text(t.text);
    }
    spans.forEach((sp, i) => {
      if (i) {
        const xd = x((spans[i - 1].x1 + sp.x0) / 2);
        g.append("line").attr("x1", xd).attr("x2", xd).attr("y1", plotTop).attr("y2", H - M.b).attr("class", "lb-divider");
      }
      // a label wider than its panel (about 6.5 px a character) wraps at its parenthesis
      const lab = g.append("text").attr("x", x((sp.x0 + sp.x1) / 2)).attr("y", H - M.b + 38).attr("text-anchor", "middle")
        .attr("class", "lb-panel");
      const cut = sp.label.indexOf(" (");
      if (sp.label.length * 6.5 > x(sp.x1) - x(sp.x0) + 40 && cut > 0) {
        lab.append("tspan").attr("x", x((sp.x0 + sp.x1) / 2)).text(sp.label.slice(0, cut));
        lab.append("tspan").attr("x", x((sp.x0 + sp.x1) / 2)).attr("dy", "1.2em").text(sp.label.slice(cut + 1));
      } else lab.text(sp.label);
      if (!series.some((s) => s.panel === sp.id)) {     // every source of this panel is still off main
        g.append("text").attr("x", x((sp.x0 + sp.x1) / 2)).attr("y", (plotTop + H - M.b) / 2).attr("text-anchor", "middle")
          .attr("class", "lb-pending").text("not on studies main yet");
      }
      const offAxis = series.filter((q) => q.panel === sp.id)
        .some((q) => q.points.some((p) => p.mean < y.domain()[0] || p.mean > y.domain()[1]));
      if (offAxis) {
        g.append("text").attr("x", x((sp.x0 + sp.x1) / 2)).attr("y", H - M.b + 70).attr("text-anchor", "middle")
          .attr("class", "lb-pending").text("▼ below the axis: hover for the value");
      }
      for (const gl of sp.groups) {
        const s = series.find((q) => q.panel === sp.id && q.label.startsWith(gl.label));
        // study 12's family labels go at the top, clear of the ▼ markers at the bottom edge
        const lab = g.append("text").attr("x", x(gl.at)).attr("y", sp.id === "literature" ? plotTop + 12 : H - M.b - 8)
          .attr("text-anchor", "middle").attr("class", "lb-group").style("fill", s ? colour(s) : null);
        if (gl.lines) gl.lines.forEach((l, i) => lab.append("tspan").attr("x", x(gl.at)).attr("dy", i ? "1.15em" : 0).text(l));
        else lab.text(gl.label);
      }
    });
    g.append("text").attr("transform", `translate(16,${(plotTop + H - M.b) / 2}) rotate(-90)`).attr("text-anchor", "middle")
      .attr("class", "lb-ylabel").text(L.ylabel || "Choice likelihood, held-out mice");

    // series in three layers, so no line covers another series' markers: lines and error bars,
    // then seed dots, then the mean markers on top (a marker's card lists its seeds)
    // hovering a dot draws a dashed line at its value, in its colour, across the plot (under the data)
    const guide = svg.append("line").attr("class", "lb-guide").attr("x1", M.l).attr("x2", W - M.r).style("display", "none");
    const showGuide = (v, c) => {
      const [g0, g1] = y.domain();
      if (v < g0 || v > g1) return;     // a point drawn at the axis edge has no true height to mark
      guide.attr("y1", y(v)).attr("y2", y(v)).style("stroke", c).style("display", null);
    };
    const hideGuide = () => guide.style("display", "none");
    const layer = svg.append("g").attr("class", "lb-data");
    const [lines, seeds, marks] = ["lb-lines", "lb-seeds", "lb-marks"].map((c) => layer.append("g").attr("class", c));
    for (const s of series) {
      const st = styleOf(s), c = colour(s);
      const [lg_, sg_, mg] = [lines, seeds, marks].map((l) => l.append("g").attr("class", "lb-series").attr("data-series", s.id).style("color", c));
      const pts = [...s.points].sort((a, b) => xAt(s, a) - xAt(s, b));
      for (const p of pts) {
        p.values.forEach((v, i) => {
          if (p.n < 2) return;            // a single value is the marker itself
          sg_.append("circle").attr("class", "lb-seed").attr("r", 2.4)
            .attr("cx", x(xAt(s, p) + 0.16 * jitter(`${s.id}|${p.x}|${i}`))).attr("cy", y(v))
            .on("pointerenter", (ev) => { tip.show(ev.currentTarget, card(s, p, i)); showGuide(v, c); })
            .on("pointerleave", () => { tip.hide(); hideGuide(); })
            .on("click", () => { location.hash = blockRoute(p.block); });
        });
        if (p.sem) {
          const cx = x(xAt(s, p));
          lg_.append("path").attr("class", "lb-err")
            .attr("d", `M${cx},${y(p.mean - p.sem)}V${y(p.mean + p.sem)}M${cx - 3},${y(p.mean - p.sem)}h6M${cx - 3},${y(p.mean + p.sem)}h6`);
        }
      }
      if (!st.noline) {
        lg_.append("path").attr("class", "lb-line").attr("stroke-dasharray", st.dash || null)
          .attr("d", d3.line().x((p) => x(xAt(s, p))).y((p) => y(p.mean))(pts));
      }
      const [y0, y1] = y.domain();
      const yPos = (v) => (v < y0 ? y.range()[0] - 7 : v > y1 ? y.range()[1] + 7 : y(v));
      if (s.overlay) {                   // a line from the headline marker to the same model's other fit
        for (const p of pts) {
          const base = twinOf.get(p.x);
          if (base) lg_.append("line").attr("class", "lb-twin")
            .attr("x1", x(pos[`${s.panel}|${p.x}`] + fitDx(base))).attr("y1", yPos(base.mean)).attr("x2", x(xAt(s, p))).attr("y2", yPos(p.mean));
        }
      }
      for (const p of pts) {
        const off = p.mean < y0 ? "below" : p.mean > y1 ? "above" : null;
        const hollow = st.fill === "hollow" || (st.fill === "hb" && String(p.x).endsWith("MLE")) || p.fit_kind === "per_subject";
        const mk = mg.append("g").attr("class", "lb-mean").attr("tabindex", 0).attr("role", "link")
          .attr("aria-label", `${s.overlay ? `${legendLabel(s)}, ${p.x} (${p.fit})` : `${s.label}, ${xText(s.panel, p.x)}`}: ${fmt(p.mean)}${off ? ` (${off} the axis)` : ""}`)
          .attr("transform", `translate(${x(xAt(s, p))},${off === "below" ? y.range()[0] - 7 : off === "above" ? y.range()[1] + 7 : y(p.mean)})`);
        mk.append("circle").attr("r", st.hit || 9).attr("class", "lb-hit");
        mk.append("path").attr("d", d3.symbol(off ? d3.symbolTriangle : st.m, st.size || (s.panel === "cognitive" ? 70 : 42))())
          .attr("transform", off === "below" ? "rotate(180)" : null)
          .attr("class", st.stroke ? "lb-mk-x" : hollow ? "lb-mk-hollow" : "lb-mk");
        // a model from the literature opens its model panel (equations, paper, code), a GRU, disRNN or GLM-HMM
        // its family's card; every other point its result block
        const open = () => { if (p.summary) openModel(s, p); else if (cardOf(s)) openCard(s, p); else location.hash = blockRoute(p.block); };
        mk.on("pointerenter focus", (ev) => { tip.show(ev.currentTarget, card(s, p, undefined, off)); showGuide(p.mean, c); markCell(s, p); })
          .on("pointerleave", () => { tip.hide(); hideGuide(); markCell(); })
          .on("blur", (ev) => { hideGuide(); markCell(); if (!tipEl.contains(ev.relatedTarget)) tip.hide(); })   // Tab into the card keeps it
          .on("click", open)
          .on("keydown", (ev) => {
            if (ev.key === "Enter") open();
            if (ev.key === "ArrowDown") { ev.preventDefault(); active = ev.currentTarget; tipEl.querySelector("a")?.focus(); }
          });
      }
    }

    // each literature pair's short name, vertical above its higher marker, so a screenshot names the model
    const [ly0, ly1] = y.domain();
    const lyPos = (v) => (v < ly0 ? y.range()[0] - 7 : v > ly1 ? y.range()[1] + 7 : y(v));
    const names = layer.append("g").attr("class", "lb-pair-names");
    for (const s of series.filter((q) => q.family && !q.overlay)) {
      for (const p of s.points) {
        const other = emOf.get(p.x);
        const top = Math.min(lyPos(p.mean), other ? lyPos(other.mean) : Infinity) - 9;
        names.append("text").attr("class", "lb-pair-name").style("fill", colour(s))
          .attr("transform", `translate(${x(pos[`${s.panel}|${p.x}`]) + 3},${top}) rotate(-90)`).text(p.short_name || p.x);
      }
    }

    // legend: hover an entry to bring its series forward
    const lg = svg.append("g").attr("class", "lb-legend");
    const colW = (W - M.l - M.r) / perRow;
    legendItems.forEach((s, i) => {
      if (s.em) {
        const it = lg.append("g").attr("class", "lb-legend-item").style("color", "var(--muted)")
          .attr("transform", `translate(${M.l + (i % perRow) * colW},${M.t + Math.floor(i / perRow) * rowH + 6})`);
        it.append("line").attr("x1", 5).attr("x2", 19).attr("class", "lb-twin");
        it.append("path").attr("transform", "translate(5,0)").attr("d", d3.symbol(d3.symbolCircle, 32)()).attr("class", "lb-mk-hollow");
        it.append("path").attr("transform", "translate(19,0)").attr("d", d3.symbol(d3.symbolCircle, 32)()).attr("class", "lb-mk");
        it.append("text").attr("x", 30).attr("dy", "0.35em").attr("class", "lb-legend-text")
          .text("Model from the literature, a pair: per-subject fit (hollow, left), 2-level EM fit (filled, right)");
        it.on("pointerenter", () => layer.classed("lb-focus", true).selectAll(".lb-series")
            .classed("lb-on", function () { return this.dataset.series.startsWith("literature-"); }))   // both fits of every pair
          .on("pointerleave", unhighlight);
        return;
      }
      const st = styleOf(s);
      const it = lg.append("g").attr("class", "lb-legend-item").style("color", colour(s))
        .attr("transform", `translate(${M.l + (i % perRow) * colW},${M.t + Math.floor(i / perRow) * rowH + 6})`);
      it.append("line").attr("x1", 0).attr("x2", 22).attr("class", "lb-line").attr("stroke-dasharray", st.dash || null);
      it.append("path").attr("transform", "translate(11,0)").attr("d", d3.symbol(st.m, st.size ? st.size * 0.8 : 36)())
        .attr("class", st.stroke ? "lb-mk-x" : st.fill === "hollow" ? "lb-mk-hollow" : "lb-mk");
      it.append("text").attr("x", 30).attr("dy", "0.35em").attr("class", "lb-legend-text").text(legendLabel(s));
      it.on("pointerenter", () => layer.classed("lb-focus", true).selectAll(".lb-series")
          .classed("lb-on", function () { return this.dataset.series === s.id; }))
        .on("pointerleave", unhighlight);
    });
  }

  function card(s, p, seed, off) {
    const b = p.block;
    const value = seed !== undefined ? `seed ${seed + 1} of ${p.n}: <b>${fmt(p.values[seed])}</b> (mean ${fmt(p.mean)})`
      : p.n > 1 ? `<b>${fmt(p.mean)}</b> ± ${fmt(p.sem)} (mean ± SEM, ${p.n} seeds: ${p.values.map(fmt).join(", ")})`
      : `<b>${fmt(p.mean)}</b>`;
    const head = s.overlay ? `<b>${esc(p.x)}</b><div>${esc(s.label)} · its ${esc(p.fit)}</div>`
      : p.summary ? `<b>${esc(p.x)}</b><div>${esc(s.label)} · rank ${esc(p.rank)}${p.fit ? ` · ${esc(p.fit)}` : ""}</div>`
      : `<b>${esc(s.label)}</b><div>${esc(xText(s.panel, p.x))}</div>`;
    return `${head}
      <div class="lb-tip-value">${value}${off ? ` <span class="tip-v">(${off} the axis, drawn at its edge)</span>` : ""}</div>
      ${twinLine(s, p)}
      ${p.fit_flag ? `<div class="lb-tip-flag">Flagged by study 12: ${esc(p.fit_flag.reason || p.fit_flag.kind)}</div>` : ""}
      ${p.summary ? `<div class="lb-tip-summary">${esc(p.summary)}</div>`        // its fitting text is in the model panel
        : `<div class="tip-v">${esc(p.description)}</div>`}
      <div class="tip-v">Reported in study ${esc(studyNo(b.study))} ${esc(b.report)}, ${esc(b.block)};
        read from <span class="mono">${esc(p.source.path.split("/").pop())}</span></div>
      <div class="lb-tip-links">${(p.summary || cardOf(s)) && seed === undefined ? `Click for its equations · ` : ""}<a href="${blockRoute(b)}">Open the result block →</a> · <a href="${lineageRoute(b)}">Lineage</a></div>`;
  }

  // a literature model's two fits: the headline marker names the other fit, and the other fit the headline
  function twinLine(s, p) {
    if (s.overlay) {
      const base = twinOf.get(p.x);
      return base ? `<div class="tip-v">Headline (${esc(base.fit || "")}): ${fmt(base.mean)}; this fit ${signed(p.mean - base.mean)}</div>` : "";
    }
    const other = s.family ? emOf.get(p.x) : null;
    return other ? `<div class="tip-v">Its ${esc(other.fit)}: ${fmt(other.mean)} (${signed(other.mean - p.mean)})</div>` : "";
  }

  // a literature model's panel, in the page's drawer: what it is, its equations, paper and code
  function openModel(s, p) {
    const b = p.block, paper = p.paper || {}, code = p.code || {};
    const body = document.getElementById("drawer-body");
    const codeUrl = code.path && code.commit ? `${FORAGING_MODELS}/blob/${encodeURIComponent(code.commit)}/${code.path.split("/").map(encodeURIComponent).join("/")}` : null;
    body.innerHTML = `
      <div class="k muted">Model from the literature · study ${esc(studyNo(b.study))} ${esc(b.report)}</div>
      <h2 style="margin-top:0">${esc(p.x)}</h2>
      <p>${A.chip(s.label)} rank ${esc(p.rank)} · ${s.overlay ? `its ${esc(p.fit)}` : `headline${p.fit ? ` (${esc(p.fit)})` : ""}`}
        <b>${fmt(p.mean)}</b></p>
      ${p.family_note ? `<p class="muted">${esc(p.family_note)}</p>` : ""}
      ${twinLine(s, p)}
      ${p.fit_flag ? `<p><b>Flagged by study 12:</b> ${esc(p.fit_flag.reason || p.fit_flag.kind)}</p>` : ""}
      <p>${esc(p.summary)}</p>
      <h3>Equations</h3><div class="lb-model-eq">${p.equations ? "" : `<p class="muted">Not written yet.</p>`}</div>
      <h3>How it was fitted</h3><p>${esc(p.description)}</p>
      <h3>Sources</h3><ul>
        <li>Paper: ${httpsOnly(paper.url) ? `<a href="${esc(paper.url)}" target="_blank" rel="noopener">${esc(paper.cite || paper.url)}</a>` : esc(paper.cite || "not given")}</li>
        <li>Code: ${codeUrl ? `<a href="${esc(codeUrl)}" target="_blank" rel="noopener"><code>${esc(code.agent_class || code.path)}</code></a> in aind-dynamic-foraging-models @ <span class="mono">${esc(String(code.commit).slice(0, 8))}</span>`
          : code.agent_class ? `<code>${esc(code.agent_class)}</code>` : "not given"}</li>
      </ul>
      <p><a href="${blockRoute(b)}">Open the result block →</a> · <a href="${lineageRoute(b)}">Lineage</a></p>`;
    if (p.equations) body.querySelector(".lb-model-eq").append(A.renderMarkdown(p.equations, b.report_path));
    const drawer = document.getElementById("drawer");
    if (drawer.hidden) S.drawerOpener = document.activeElement;   // focus returns here on close
    drawer.hidden = false;
    drawer.focus();
  }

  // ------------------------------------------------------------ model cards for the GRU, disRNN and GLM-HMM
  // Hand-written, as the landscape is: the models from the literature bring their text from study 12's JSON,
  // these families have no such source. Facts are from the code each study ran (pinned below) and the
  // studies' sweeps (study 01: session conditioning on; study 06: 5 latents, linear choice net; study 14:
  // hurdle emission, L = 10). Diagrams are inline SVG on the theme's colours.
  const WRAPPER = "https://github.com/AllenNeuralDynamics/aind-dynamic-foraging-bfm-wrapper/blob/5affee531856d6eff31c9285e981c93747699efc";
  const DISRNN_LIB = "https://github.com/AllenNeuralDynamics/aind-disentangled-rnns/blob/a9b9978831cb22d37e2a75c15805c621dfe00b1f";
  const GLMHMM_CODE = `${FORAGING_MODELS}/tree/cf38f45d38eddaade38434bd9dbecfa4a98f7388/src/aind_dynamic_foraging_models/glm_hmm`;

  // diagram pieces: a box with one or two centred lines, an arrow along points
  const box = (x, y, w, h, cls, lines) => `<rect class="mc-box ${cls}" x="${x}" y="${y}" width="${w}" height="${h}" rx="6"/>` +
    lines.map((t, i) => `<text x="${x + w / 2}" y="${y + h / 2 + (i - (lines.length - 1) / 2) * 15}" dy="0.35em" text-anchor="middle"
      ${i ? `class="mc-sub"` : ""}>${t}</text>`).join("");
  const arrow = (pts, cls = "") => `<polyline class="mc-arrow ${cls}" points="${pts}" marker-end="url(#${cls.includes("mc-orange") ? "mc-ah-o" : "mc-ah"})"/>`;
  const diagram = (h, body, label) => `<svg class="mc-diagram" viewBox="0 0 520 ${h}" role="img" aria-label="${esc(label)}">
    <defs>
      <marker id="mc-ah" class="mc-ah" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0,0 L10,5 L0,10 z"/></marker>
      <marker id="mc-ah-o" class="mc-ah mc-orange" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0,0 L10,5 L0,10 z"/></marker>
    </defs>${body}</svg>`;

  // the GRU and the disRNN share the subject and session embedding; only the core differs
  const embedDiagram = (core, coreSub, label) => diagram(212, `
    ${box(4, 22, 104, 36, "mc-in mc-blue", ["Subject ID i"])}
    ${box(134, 14, 150, 52, "mc-blue", ["Subject embedding", "eᵢ, a row of a table"])}
    ${box(4, 132, 104, 36, "mc-in mc-orange", ["Session index s"])}
    ${box(134, 124, 150, 52, "mc-orange", ["Session-delta MLP", "Δ(eᵢ, s)"])}
    ${box(300, 80, 62, 44, "mc-grey", ["eᵢ + Δ", "context"])}
    ${box(392, 70, 116, 64, "mc-green", [core, coreSub])}
    ${box(400, 4, 100, 32, "mc-in", ["aₜ₋₁, rₜ₋₁"])}
    ${box(400, 172, 100, 34, "mc-in", ["P(aₜ)"])}
    ${arrow("108,40 132,40")} ${arrow("209,66 209,122")} ${arrow("108,150 132,150")}
    ${arrow("284,40 331,40 331,78")} ${arrow("284,150 331,150 331,126")}
    ${arrow("362,102 390,102")} ${arrow("450,36 450,68")} ${arrow("450,134 450,170")}`, label);
  const GRU_DIAGRAM = embedDiagram("GRU core", "hidden state hₜ",
    "GRU: the subject embedding plus a session delta, with the previous choice and reward, drive a GRU core that outputs the choice probabilities");

  // inside the disRNN core, laid out as Miller et al.'s figure: the latents feed the choice network and, with the
  // observations and the context, each latent's update network; the new latents get noise and loop back
  const DISRNN_CORE = diagram(292, `
    ${box(200, 8, 124, 36, "mc-blue", ["Choice MLP"])}
    <text x="358" y="26" dy="0.35em">P(aₜ) vs the actual aₜ</text>
    ${box(20, 14, 110, 44, "mc-grey", ["Context", "eᵢ + Δ"])}
    ${box(20, 96, 110, 44, "mc-grey", ["Latents", "z̃¹ₜ … z̃ᴺₜ"])}
    ${box(20, 176, 110, 44, "mc-in", ["Observations oₜ", "aₜ, rₜ"])}
    ${box(200, 92, 124, 36, "mc-blue", ["Update MLP 1"])}
    <text x="262" y="152" text-anchor="middle" class="mc-sub">⋮</text>
    ${box(200, 172, 124, 36, "mc-blue", ["Update MLP N"])}
    ${[110, 190].map((y0, i) => `<rect class="mc-box mc-in mc-noise mc-orange" x="340" y="${y0 - 16}" width="128" height="32" rx="6"/>
      <text x="366" y="${y0}" dy="0.35em" text-anchor="middle">${["z¹ₜ₊₁", "zᴺₜ₊₁"][i]}</text>
      <text x="446" y="${y0}" dy="0.35em" text-anchor="middle">${["z̃¹ₜ₊₁", "z̃ᴺₜ₊₁"][i]}</text>
      ${arrow(`324,${y0} 338,${y0}`)} ${arrow(`386,${y0} 422,${y0}`, "mc-orange")}`).join("")}
    ${arrow("130,30 198,24", "mc-orange")} ${arrow("130,44 198,104", "mc-orange")} ${arrow("130,52 198,182", "mc-orange")}
    ${arrow("130,102 198,36", "mc-orange")} ${arrow("130,114 198,112", "mc-orange")} ${arrow("130,126 198,188", "mc-orange")}
    ${arrow("130,190 198,120", "mc-orange")} ${arrow("130,200 198,196", "mc-orange")}
    ${arrow("324,26 352,26")}
    ${arrow("468,110 504,110 504,258 6,258 6,112 18,112")}
    ${arrow("468,190 496,190 496,250 12,250 12,124 18,124")}
    <text x="300" y="236" dy="0.35em" text-anchor="middle" class="mc-sub">z̃ₜ₊₁ are the latents for trial t + 1</text>
    <text x="6" y="278" dy="0.35em" class="mc-sub mc-orange-text">Orange: noisy bottlenecks, penalised by β; the dashed box adds noise to each new latent.</text>`,
    "Inside the disRNN core: the context and the latents feed the choice network; with the observations they feed each latent's update network, whose noisy output becomes the next trial's latents");
  const DISRNN_DIAGRAM = embedDiagram("disRNN core", "latents zₜ",
    "disRNN: the same subject embedding and session delta as the GRU, with a disRNN core") +
    `<p class="mc-cap">Inside the disRNN core</p>${DISRNN_CORE}`;

  const GLMHMM_DIAGRAM = diagram(212, `
    <text x="70" y="44" dy="0.35em" text-anchor="middle" class="mc-sub">…</text>
    ${[170, 300, 430].map((cx, i) => `<circle class="mc-box mc-green" cx="${cx}" cy="44" r="24"/>
      <text x="${cx}" y="44" dy="0.35em" text-anchor="middle">${["zₜ₋₁", "zₜ", "zₜ₊₁"][i]}</text>
      ${box(cx - 56, 112, 112, 42, "mc-blue", ["GLM of its state", "σ(a·eₜ), σ(w·hₜ)"])}
      <text x="${cx}" y="196" dy="0.35em" text-anchor="middle">${["yₜ₋₁", "yₜ", "yₜ₊₁"][i]}</text>
      ${arrow(`${cx},68 ${cx},110`)} ${arrow(`${cx},154 ${cx},184`)}`).join("")}
    ${arrow("84,44 144,44")} ${arrow("194,44 274,44")} ${arrow("324,44 404,44")}
    <text x="234" y="34" text-anchor="middle" class="mc-sub">A</text><text x="364" y="34" text-anchor="middle" class="mc-sub">A</text>
    ${box(4, 112, 92, 42, "mc-in mc-orange", ["history xₜ", "last 10 trials"])}
    <polyline class="mc-arrow mc-orange" points="96,133 102,133 102,96 456,96"/>
    ${[196, 326, 456].map((x0) => arrow(`${x0},96 ${x0},110`, "mc-orange")).join("")}`,
    "GLM-HMM: a hidden state follows a Markov chain; each state has its own GLM of the trial history that gives the choice");

  const MODEL_CARDS = [
    { prefix: "gru-", title: "Gated recurrent unit (GRU)", diagram: GRU_DIAGRAM,
      summary: `A recurrent neural network that learns the strategy from the data, with no hypothesis built in. On each
        trial it reads the previous choice and reward, together with a short vector that says which mouse (and which
        session) this is, updates its hidden state, and reads out the choice probabilities. Every mouse shares the
        network; only the vector differs.`,
      heldout: `A held-out mouse gets its own subject embedding, fitted on its other sessions; the network stays as
        trained. In the reservoir-only line the recurrent core keeps its random initial weights, and only the
        embeddings and the readout are trained.`,
      equations: String.raw`Notation: trial $t$; choice $a_t$; reward $r_t$; mouse $i$; session $s$; $\sigma$ the logistic
function; $\odot$ the element-wise product.

**Context.** A learned subject embedding plus a learned session delta (study 01 ran with session conditioning on):

$$c_{i,s} = e_i + \Delta(e_i, s), \qquad x_t = [\,a_{t-1},\ r_{t-1},\ c_{i,s}\,]$$

**GRU core** (hidden state $h_t$ of size $H$):

$$\begin{aligned} z_t &= \sigma(W_z x_t + U_z h_{t-1} + b_z) \\ g_t &= \sigma(W_g x_t + U_g h_{t-1} + b_g) \\ \tilde h_t &= \tanh\!\big(W_h x_t + U_h (g_t \odot h_{t-1}) + b_h\big) \\ h_t &= (1 - z_t) \odot h_{t-1} + z_t \odot \tilde h_t \end{aligned}$$

**Choice.** A linear readout and a softmax over left and right (and ignore, for the 3-way GRU):

$$P(a_t) = \mathrm{softmax}(W_o h_t + b_o)$$

**Training.** Cross-entropy of the actual choices, by Adam, on the training mice's sessions.`,
      sources: [`Paper: <a href="https://arxiv.org/abs/1406.1078" target="_blank" rel="noopener">Cho et al. (2014)</a>, the GRU`,
        `Code: <a href="${WRAPPER}/code/models/gru_network.py" target="_blank" rel="noopener"><code>MultisubjectGru</code></a> in aind-dynamic-foraging-bfm-wrapper @ <span class="mono">5affee53</span>`] },
    { prefix: "disrnn-", title: "Disentangled RNN (disRNN)", diagram: DISRNN_DIAGRAM,
      summary: `A recurrent neural network built to be read. Its state is a few latent variables, and each latent has
        its own small update network. Noisy bottlenecks sit on every input an update network reads and on every
        latent it keeps; a penalty (β) on them makes the network use as few latents and as few interactions as the
        data allow. A larger β closes more bottlenecks and gives a simpler, more readable model. It meets mice and
        sessions through the same subject embedding and session delta as the GRU (top diagram); only the core differs
        (bottom diagram).`,
      heldout: `A held-out mouse gets its own subject embedding, fitted on its other sessions; the network stays as
        trained.`,
      equations: String.raw`Notation: trial $t$; latents $\tilde z_t \in \mathbb{R}^N$ ($N = 5$ in study 06), what the
network carries into trial $t$; observations $o_t = (a_t, r_t)$, trial $t$'s choice and reward; $M$ a fixed bound on
each latent; $\epsilon \sim \mathcal{N}(0, 1)$ fresh noise each time. (The code runs the same model one step shifted:
each step reads the last trial's outcome, updates, then predicts the next choice.)

**Context.** As in the GRU (study 06 ran with session conditioning on), then through one shared bottleneck:

$$c_{i,s} = e_i + \Delta(e_i, s)$$

**Bottleneck.** An input $x$ passes as $\tilde x = m\,x + \sigma \epsilon$, with a learned multiplier $m$ and noise scale
$\sigma$. Its cost is $\mathrm{KL}\big(\mathcal{N}(m x, \sigma^2)\,\|\,\mathcal{N}(0, 1)\big) = \tfrac12\,(m^2x^2 + \sigma^2 - 1 - \log\sigma^2)$.
A large $\sigma$ drowns the input: the bottleneck is closed.

**Choice.** A choice network reads bottlenecked copies of the latents and the context; in study 06 it is linear:

$$P(a_t) = \mathrm{softmax}\big(\mathrm{ChoiceNet}(\tilde z_t, \tilde c_{i,s})\big)$$

**Update.** Latent $k$ has its own network, which reads bottlenecked copies of the observations, the latents and the
context; the new latent then gets its own noise:

$$(u_k, v_k) = \mathrm{MLP}_k(\tilde o_t, \tilde z_t, \tilde c_{i,s}), \qquad w_k = \sigma(u_k)$$

$$z^k_{t+1} = (1 - w_k)\, \tilde z^k_t + w_k\, M \tanh(v_k / M), \qquad \tilde z^k_{t+1} = z^k_{t+1} + \sigma_k \epsilon$$

**Training.** Minimise $-\sum_t \log P(a_t) + \beta \sum \mathrm{KL}$ over every bottleneck.`,
      sources: [`Paper: <a href="https://doi.org/10.52202/075280-2682" target="_blank" rel="noopener">Miller et al., Cognitive model discovery via disentangled RNNs, NeurIPS 36 (2023)</a>
          (<a href="https://doi.org/10.1101/2023.06.23.546250" target="_blank" rel="noopener">bioRxiv</a>); the core diagram is redrawn and simplified from theirs`,
        `Code: <a href="${DISRNN_LIB}/disentangled_rnns/library/disrnn.py" target="_blank" rel="noopener"><code>HkDisentangledRNN</code></a> in aind-disentangled-rnns @ <span class="mono">a9b99788</span>; the multisubject model in <a href="${WRAPPER}/code/models/multisubject_disrnn.py" target="_blank" rel="noopener">the wrapper</a>`] },
    { prefix: "glmhmm-", title: "GLM-HMM (hurdle emission)", diagram: GLMHMM_DIAGRAM,
      summary: `A hidden Markov model whose states each have their own regression of the choice on recent history. The
        mouse switches between a few strategies (for example engaged, biased to one side, or disengaged) by a Markov
        chain; within a state, the choice follows that state's GLM. Study 14 uses the hurdle emission: first whether
        the mouse responds, then which side.`,
      heldout: `Refit: the held-out mouse gets its own GLM-HMM, started from the shared fit. Refit pooled: the same, with
        its weights pulled toward the shared fit. Zero-shot: nothing is fitted; the shared fit predicts every mouse.
        The choice board scores only the side half, on the trials the mouse responded; the engagement board
        scores only the respond-or-ignore half; the 3-way board scores both together.`,
      equations: String.raw`Notation: trial $t$; outcome $y_t \in \{L, R, \text{ignore}\}$; side $s = +1$ (right),
$-1$ (left) or $0$ (ignore); reward $r$; $\sigma$ the logistic function.

**States.** Each session is a sequence of hidden states $z_t \in \{1, \dots, K\}$, restarted every session:

$$P(z_1 = k) = \pi_k, \qquad P(z_t = k \mid z_{t-1} = j) = A_{jk}$$

**Regressors**, for lags $l = 1, \dots, L$ ($L = 10$ in study 14's K grid):

$$\begin{aligned} &\text{side:} && \text{RewC}_l = s_{t-l}\, r_{t-l}, \quad \text{UnrC}_l = s_{t-l}\,(1 - r_{t-l}) \\ &\text{engagement:} && \text{Ignored}_l = [\,y_{t-l} = \text{ignore}\,], \quad \text{Rewarded}_l = r_{t-l} \end{aligned}$$

$h_t$ holds the side lags (RewC, UnrC) plus a bias; $e_t$ the engagement lags (Ignored, Rewarded) plus a bias.

**Hurdle emission.** In state $k$:

$$P(\text{respond} \mid k) = \sigma(a_k \cdot e_t), \qquad P(R \mid \text{respond}, k) = \sigma(w_k \cdot h_t)$$

**Fitting.** EM: the E-step infers the states (forward-backward); the M-step solves each state's two logistic
regressions exactly (Newton), weighted by the state posteriors.`,
      sources: [`Paper: <a href="https://doi.org/10.1038/s41593-021-01007-z" target="_blank" rel="noopener">Ashwood et al., Mice alternate between discrete strategies during perceptual decision-making, Nature Neuroscience 25, 201–212 (2022)</a>`,
        `Code: <a href="${GLMHMM_CODE}" target="_blank" rel="noopener"><code>glm_hmm</code></a> in aind-dynamic-foraging-models @ <span class="mono">cf38f45d</span> (the version study 14 ran)`] },
  ];
  const cardOf = (s) => MODEL_CARDS.find((c) => s.id.startsWith(c.prefix));

  // a GRU, disRNN or GLM-HMM point's card, in the drawer: its family's text, diagram and equations, and this point
  function openCard(s, p) {
    const c = cardOf(s), b = p.block;
    const body = document.getElementById("drawer-body");
    body.innerHTML = `
      <div class="k muted">Model · study ${esc(studyNo(b.study))} ${esc(b.report)}</div>
      <h2 style="margin-top:0">${esc(c.title)}</h2>
      <p>${A.chip(s.label)} ${esc(xText(s.panel, p.x))} · <b>${fmt(p.mean)}</b>${p.n > 1 ? ` ± ${fmt(p.sem)} (${p.n} seeds)` : ""}</p>
      <p>${c.summary}</p>
      ${c.diagram}
      <h3>Equations</h3><div class="lb-model-eq"></div>
      <h3>How a held-out mouse meets it</h3><p>${c.heldout}</p>
      <h3>This point</h3><p>${esc(p.description)}</p>
      <h3>Sources</h3><ul>${c.sources.map((x) => `<li>${x}</li>`).join("")}</ul>
      <p><a href="${blockRoute(b)}">Open the result block →</a> · <a href="${lineageRoute(b)}">Lineage</a></p>`;
    body.querySelector(".lb-model-eq").append(A.renderMarkdown(c.equations, b.report_path));
    const drawer = document.getElementById("drawer");
    if (drawer.hidden) S.drawerOpener = document.activeElement;   // focus returns here on close
    drawer.hidden = false;
    drawer.focus();
  }
});
