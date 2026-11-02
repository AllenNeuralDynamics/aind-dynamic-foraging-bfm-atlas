/* The leaderboard (#/leaderboard): every model family's held-out choice likelihood on one axis.
 * Data come from catalog.leaderboard (src/bfm_atlas/leaderboard.py), read at build time from the
 * studies files that hold each number. Hover a dot for what it is; click it to open the result
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
  const legendLabel = (s) => s.overlay ? `Literature (other fit): ${s.label}` : s.family ? `Literature: ${s.label}` : s.label;
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
        <tr><td>CTT, Hattori, study 12's literature models: MLE</td><td>nothing</td><td>all of its parameters, by maximum
          likelihood (no prior, nothing shared across mice)</td></tr>
        <tr><td>Study 12's literature models: 2-level EM</td><td>nothing</td><td>its own typical parameters, with each
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
        const g0 = x;
        for (const v of g.x) { pos[`${p.id}|${v}`] = x; x += step; }
        if (g.label) labels.push({ label: g.label, at: (g0 + x - step) / 2, width: p.id === "literature" ? x - g0 : undefined });
      });
      x -= step;
      spans.push({ id: p.id, label: p.label, x0: start, x1: x, groups: labels });
      x += 2 * PANEL_PAD;
    }
    return { pos, spans, xmax: x - PANEL_PAD };
  }

  VIEWS.leaderboard = () => {
    const L = S.cat.leaderboard;
    if (!L) {
      main().innerHTML = `<h1>Leaderboard</h1><p class="muted">This catalog has no leaderboard data (built by an older bfm-atlas).</p>`;
      return;
    }
    const missing = L.missing || [];
    const missingNote = missing.length ? `<p class="muted lb-missing">Not on studies <span class="mono">main</span> yet, so left out:
        ${[...new Map(missing.map((m) => [`${m.series}|${m.path}`, m])).values()].map((m) =>
          `${esc(m.label || m.series)} (study ${esc(studyNo(m.block.study))} ${esc(m.block.report)}, <span class="mono">${esc(m.path.split("/").pop())}</span>)`).join("; ")}.</p>` : "";
    if (!L.available) {
      main().innerHTML = `<h1>Leaderboard</h1><p class="muted">This catalog has no leaderboard data.</p>${missingNote}`;
      return;
    }
    main().innerHTML = `
      <h1>Leaderboard</h1>
      <p class="lb-lede">${esc(L.metric)}. Each model family is read from the study that measured it.
        Large markers are the mean ± SEM over seeds; small dots are single seeds.
        <b>Hover</b> a marker for what it is; <b>click</b> it to open the result block that reports it
        (a literature model opens its own panel: what it is, its equations, paper and code).
        In the literature panel each model is a pair, its per-subject fit (hollow, left) and its 2-level EM fit (filled,
        right), joined by a line and named above; pairs are ranked by study 12's headline score (the 2-level EM score, or
        the per-subject one where it is higher). With the keyboard: Tab to a marker, Enter opens its block, Down arrow moves into its card, Escape returns.</p>
      ${missingNote}
      <div class="map-tools"><button type="button" class="export" id="lb-export">Export SVG</button></div>
      <div class="lb-host"><div class="lb-wrap"><svg id="leaderboard" role="img" aria-label="Leaderboard: held-out choice likelihood by model"></svg></div></div>
      ${notes(L.series.some((s) => s.id === "glmhmm-pooled"))}`;
    // the hover card lives on the non-scrolling .lb-host: tooltip() places it from viewport bounds,
    // which would be off by the scroll offset inside the horizontally scrolling .lb-wrap
    draw(L, main().querySelector(".lb-host"));
    document.getElementById("lb-export").addEventListener("click", () =>
      A.downloadSvg(document.getElementById("leaderboard"), `leaderboard-${(S.sha || "main").slice(0, 8)}.svg`));
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
    const M = { l: 70, r: 14, t: 16, b: 84 }, W = Math.round(M.l + M.r + xmax * PX_PER_UNIT);
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
    const perRow = 3, rowH = 18, legendH = Math.ceil(legendItems.length / perRow) * rowH + 8;
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
        // a family label wider than its group (about 6 px a character) is left to the legend
        if (gl.width !== undefined && gl.label.length * 6 > x(gl.width) - x(0) + 14) continue;
        // study 12's family labels go at the top, clear of the ▼ markers at the bottom edge
        g.append("text").attr("x", x(gl.at)).attr("y", sp.id === "literature" ? plotTop + 12 : H - M.b - 8)
          .attr("text-anchor", "middle").attr("class", "lb-group")
          .style("fill", s ? colour(s) : null).text(gl.label);
      }
    });
    g.append("text").attr("transform", `translate(16,${(plotTop + H - M.b) / 2}) rotate(-90)`).attr("text-anchor", "middle")
      .attr("class", "lb-ylabel").text("Choice likelihood, held-out mice");

    // series in three layers, so no line covers another series' markers: lines and error bars,
    // then seed dots, then the mean markers on top (a marker's card lists its seeds)
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
            .on("pointerenter", (ev) => tip.show(ev.currentTarget, card(s, p, i)))
            .on("pointerleave", () => tip.hide())
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
        // a literature model opens its model panel (equations, paper, code); every other point its result block
        const open = () => { if (p.summary) openModel(s, p); else location.hash = blockRoute(p.block); };
        mk.on("pointerenter focus", (ev) => tip.show(ev.currentTarget, card(s, p, undefined, off)))
          .on("pointerleave", () => tip.hide())
          .on("blur", (ev) => { if (!tipEl.contains(ev.relatedTarget)) tip.hide(); })   // Tab into the card keeps it
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
          .text("Literature pair: per-subject fit (hollow, left), 2-level EM fit (filled, right)");
        it.on("pointerenter", () => layer.classed("lb-focus", true).selectAll(".lb-series")
            .classed("lb-on", function () { return this.dataset.series.startsWith("literature-"); }))   // both fits of every pair
          .on("pointerleave", () => layer.classed("lb-focus", false));
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
        .on("pointerleave", () => layer.classed("lb-focus", false));
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
      <div class="lb-tip-links">${p.summary ? `Click for its equations · ` : ""}<a href="${blockRoute(b)}">Open the result block →</a> · <a href="${lineageRoute(b)}">Lineage</a></div>`;
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
      <div class="k muted">Literature model · study ${esc(studyNo(b.study))} ${esc(b.report)}</div>
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
});
