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
  const STEP = { cognitive: 1, glmhmm: 0.55, disrnn: 1, gru: 1.35 };
  const GROUP_GAP = 0.4, PANEL_PAD = 0.65;
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
  const styleOf = (s) => STYLE[s.id] || { c: "--m-other", m: d3.symbolCircle };
  const colour = (s) => `var(${styleOf(s).c})`;

  const fmt = (v) => v.toFixed(4);
  const xText = (panel, x) => panel === "cognitive" ? x.replace(" MLE", ", per-mouse fit (MLE)").replace(" HB", ", hierarchical Bayes (HB)")
    : panel === "glmhmm" ? `K = ${x} states` : `D = ${x} training mice`;
  const blockRoute = (b) => `#/report/${encodeURIComponent(b.study)}/${encodeURIComponent(b.report)}?block-${encodeURIComponent(b.block)}`;
  const lineageRoute = (b) => `#/lineage/${encodeURIComponent(b.study)}/${encodeURIComponent(b.report)}/${encodeURIComponent(b.block)}`;
  const studyNo = (id) => id.split("-")[0];
  // deterministic jitter, so a redraw does not move the seed dots
  const jitter = (key) => { let h = 0; for (const ch of key) h = (h * 31 + ch.charCodeAt(0)) | 0; return ((h >>> 0) % 1000) / 1000 - 0.5; };

  // what each family may fit to a held-out mouse before it is scored (wrapper and study docs:
  // study 01 r4, study 13, study 14 r1); plain HTML, so it reads the same in every theme
  const NOTES = `<section class="lb-notes">
    <h2>How each model meets a held-out mouse</h2>
    <p>Every model is scored on sessions of a held-out mouse that nothing was fitted to. Before that, a model may
      learn from the mouse's other sessions, and how much it may learn differs by family:</p>
    <div class="table-wrap"><table>
      <thead><tr><th>Model</th><th>Learned from the training mice</th><th>Fitted to each held-out mouse</th></tr></thead>
      <tbody>
        <tr><td>CTT, Hattori: MLE</td><td>nothing</td><td>all of its parameters, by maximum likelihood</td></tr>
        <tr><td>CTT, Hattori: HB</td><td>nothing</td><td>its own parameters plus how they vary from session to session
          (hierarchical Bayes, one mouse at a time, under a fixed prior)</td></tr>
        <tr><td>GLM-HMM, refit</td><td>one shared GLM-HMM</td><td>its own GLM-HMM, started from the shared fit</td></tr>
        <tr><td>GLM-HMM, refit pooled</td><td>one shared GLM-HMM</td><td>its own GLM-HMM, with its weights and
          transitions pulled toward the shared fit; how hard is picked on the training mice</td></tr>
        <tr><td>GLM-HMM, zero-shot</td><td>one shared GLM-HMM</td><td>nothing: the shared fit predicts every mouse</td></tr>
        <tr><td>disRNN, GRU</td><td>one shared network</td><td>a subject embedding (a short vector for that mouse); the
          network stays as trained</td></tr>
        <tr><td>GRU, reservoir only</td><td>embeddings and readout around a random, frozen core</td><td>a subject embedding</td></tr>
      </tbody></table></div>
    <p><b>Why the two GLM-HMM lines differ.</b> The refit line gives each held-out mouse its own model, as the GRU
      and disRNN get their own embedding, so it is the like-for-like comparison. But each state adds parameters to
      that per-mouse model, and from a few states on it fits the noise in the mouse's sessions: the refit score
      peaks at a small K and then falls. The zero-shot line fits nothing per mouse, so extra states cannot overfit
      one mouse; with more states the shared fit can hold more kinds of behaviour seen across the training mice
      (study 14 finds side-biased states at large K), and it keeps rising. Study 14's
      <a href="#/report/14-glmhmm-vs-gru-heldout/r1?block-result-1">r1</a> shows both scores.
      The pooled line keeps the per-mouse refit but pulls it toward the shared fit, so a mouse moves only as far
      as its own sessions support. It scores above the zero-shot line at every K and keeps rising with K, so the
      early peak of the plain refit came from overfitting each mouse
      (<a href="#/report/14-glmhmm-vs-gru-heldout/r2?block-result-2">r2</a>).</p>
  </section>`;

  function layout(panels) {
    const pos = {}, spans = [];
    let x = PANEL_PAD;
    for (const p of panels) {
      const step = STEP[p.id] || 1, start = x;
      const groups = p.groups || [{ label: null, x: p.x }];
      const labels = [];
      groups.forEach((g, gi) => {
        if (gi) x += GROUP_GAP;
        const g0 = x;
        for (const v of g.x) { pos[`${p.id}|${v}`] = x; x += step; }
        if (g.label) labels.push({ label: g.label, at: (g0 + x - step) / 2 });
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
        <b>Hover</b> a marker for what it is; <b>click</b> it to open the result block that reports it.
        With the keyboard: Tab to a marker, Enter opens its block, Down arrow moves into its card, Escape returns.</p>
      ${missingNote}
      <div class="map-tools"><button type="button" class="export" id="lb-export">Export SVG</button></div>
      <div class="lb-host"><div class="lb-wrap"><svg id="leaderboard" role="img" aria-label="Leaderboard: held-out choice likelihood by model"></svg></div></div>
      ${NOTES}`;
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
    const W = 1100, M = { l: 70, r: 14, t: 16, b: 64 };
    // legend rows above the plot
    const perRow = 3, rowH = 18, legendH = Math.ceil(series.length / perRow) * rowH + 8;
    const plotTop = M.t + legendH, H = plotTop + 340 + M.b;
    const svg = d3.select("#leaderboard").attr("viewBox", `0 0 ${W} ${H}`);
    const xAt = (s, p) => pos[`${s.panel}|${p.x}`] + (s.h ? (H_ALL.indexOf(s.h) - 2) * H_DODGE : 0) + (styleOf(s).dx || 0);
    const all = series.flatMap((s) => s.points.flatMap((p) => [...p.values, p.mean - (p.sem || 0), p.mean + (p.sem || 0)]));
    const [lo, hi] = d3.extent(all), pad = (hi - lo) * 0.06;
    const x = d3.scaleLinear([0, xmax], [M.l, W - M.r]);
    const y = d3.scaleLinear([lo - pad, hi + pad], [H - M.b, plotTop]).nice();

    // axes, panel dividers, labels
    const ticks = L.panels.flatMap((p) =>
      (p.groups ? p.groups.flatMap((g) => g.x) : p.x).map((v) => ({ at: pos[`${p.id}|${v}`],
        text: p.id === "cognitive" ? String(v).split(" ").pop() : String(v) })));
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
      g.append("text").attr("x", x((sp.x0 + sp.x1) / 2)).attr("y", H - M.b + 38).attr("text-anchor", "middle")
        .attr("class", "lb-panel").text(sp.label);
      if (!series.some((s) => s.panel === sp.id)) {     // every source of this panel is still off main
        g.append("text").attr("x", x((sp.x0 + sp.x1) / 2)).attr("y", (plotTop + H - M.b) / 2).attr("text-anchor", "middle")
          .attr("class", "lb-pending").text("not on studies main yet");
      }
      for (const gl of sp.groups) {
        const s = series.find((q) => q.panel === sp.id && q.label.startsWith(gl.label));
        g.append("text").attr("x", x(gl.at)).attr("y", H - M.b - 8).attr("text-anchor", "middle").attr("class", "lb-group")
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
      lg_.append("path").attr("class", "lb-line").attr("stroke-dasharray", st.dash || null)
        .attr("d", d3.line().x((p) => x(xAt(s, p))).y((p) => y(p.mean))(pts));
      for (const p of pts) {
        const hollow = st.fill === "hollow" || (st.fill === "hb" && String(p.x).endsWith("MLE"));
        const mk = mg.append("g").attr("class", "lb-mean").attr("tabindex", 0).attr("role", "link")
          .attr("aria-label", `${s.label}, ${xText(s.panel, p.x)}: ${fmt(p.mean)}`)
          .attr("transform", `translate(${x(xAt(s, p))},${y(p.mean)})`);
        mk.append("circle").attr("r", st.hit || 9).attr("class", "lb-hit");
        mk.append("path").attr("d", d3.symbol(st.m, st.size || (s.panel === "cognitive" ? 70 : 42))())
          .attr("class", st.stroke ? "lb-mk-x" : hollow ? "lb-mk-hollow" : "lb-mk");
        const open = () => { location.hash = blockRoute(p.block); };
        mk.on("pointerenter focus", (ev) => tip.show(ev.currentTarget, card(s, p)))
          .on("pointerleave", () => tip.hide())
          .on("blur", (ev) => { if (!tipEl.contains(ev.relatedTarget)) tip.hide(); })   // Tab into the card keeps it
          .on("click", open)
          .on("keydown", (ev) => {
            if (ev.key === "Enter") open();
            if (ev.key === "ArrowDown") { ev.preventDefault(); active = ev.currentTarget; tipEl.querySelector("a")?.focus(); }
          });
      }
    }

    // legend: hover an entry to bring its series forward
    const lg = svg.append("g").attr("class", "lb-legend");
    const colW = (W - M.l - M.r) / perRow;
    series.forEach((s, i) => {
      const st = styleOf(s);
      const it = lg.append("g").attr("class", "lb-legend-item").style("color", colour(s))
        .attr("transform", `translate(${M.l + (i % perRow) * colW},${M.t + Math.floor(i / perRow) * rowH + 6})`);
      it.append("line").attr("x1", 0).attr("x2", 22).attr("class", "lb-line").attr("stroke-dasharray", st.dash || null);
      it.append("path").attr("transform", "translate(11,0)").attr("d", d3.symbol(st.m, st.size ? st.size * 0.8 : 36)())
        .attr("class", st.stroke ? "lb-mk-x" : st.fill === "hollow" ? "lb-mk-hollow" : "lb-mk");
      it.append("text").attr("x", 30).attr("dy", "0.35em").attr("class", "lb-legend-text").text(s.label);
      it.on("pointerenter", () => layer.classed("lb-focus", true).selectAll(".lb-series")
          .classed("lb-on", function () { return this.dataset.series === s.id; }))
        .on("pointerleave", () => layer.classed("lb-focus", false));
    });
  }

  function card(s, p, seed) {
    const b = p.block;
    const value = seed !== undefined ? `seed ${seed + 1} of ${p.n}: <b>${fmt(p.values[seed])}</b> (mean ${fmt(p.mean)})`
      : p.n > 1 ? `<b>${fmt(p.mean)}</b> ± ${fmt(p.sem)} (mean ± SEM, ${p.n} seeds: ${p.values.map(fmt).join(", ")})`
      : `<b>${fmt(p.mean)}</b>`;
    return `<b>${esc(s.label)}</b><div>${esc(xText(s.panel, p.x))}</div>
      <div class="lb-tip-value">${value}</div>
      <div class="tip-v">${esc(p.description)}</div>
      <div class="tip-v">Reported in study ${esc(studyNo(b.study))} ${esc(b.report)}, ${esc(b.block)};
        read from <span class="mono">${esc(p.source.path.split("/").pop())}</span></div>
      <div class="lb-tip-links"><a href="${blockRoute(b)}">Open the result block →</a> · <a href="${lineageRoute(b)}">Lineage</a></div>`;
  }
});
