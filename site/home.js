/* The home page (#/): our SfN 2026 abstract, each claim linked to the studies and reports behind it (hover a
 * linked phrase for what each shows, and the poster panel it is on), then links to the rest of the atlas. The
 * poster view (#/poster/<panel>) shows the whole poster with one panel highlighted. Hand-written, like the leaderboard's
 * landscape: the abstract is not in the studies repo. A link whose study or report is not in this catalog is
 * dropped, and a phrase left with none is plain text. Registers through window.Atlas; uses map.js's tooltip.
 */
"use strict";

document.addEventListener("atlas:ready", () => {
  const A = window.Atlas;
  const { S, VIEWS, esc } = A;
  const main = () => document.getElementById("main");

  const ABSTRACT_URL = "https://www.abstractsonline.com/pp8/#!/21503/presentation/34984";
  // as SfN lists them; the equal-contribution mark is the first authors' own, not in the SfN listing
  const AUTHORS = ["H. Hou*", "P.-C. Kuo*²", "A. Piet", "X. Yin", "B. Tan", "L. Kinsey", "M. Lee", "J. Kenney", "E. Hilton-VanOsdall",
    "M. Tom", "H. Loeffler", "H. D. Nguyen", "A. M. Amaya", "M. Olsen", "A. Stearns", "D. Rette", "T. Ramirez", "B. Ouellette",
    "M. Woodard", "N. Mars", "A. Cahoon", "K. Svoboda", "L. N. Driscoll", "J. Y. Cohen"];

  // a link: a report ({study, report}), a study ({study}), an atlas page ({route, label}) or a leaderboard model
  // card ({card, label}, opened in the drawer), with one line on what it shows; the phrase's own link is its first
  // one that resolves
  const R = (study, report, note) => ({ study, report, note });
  const P = (route, label, note) => ({ route, label, note });
  const C = (card, label, note) => ({ card, label, note });
  const LINKS = {
    arch: [C("gru-", "The GRU's model card", "Its architecture, a diagram, the equations and sources; the phrase opens it.")],
    cognitive: [P("#/leaderboard", "Leaderboard", "Every model family on the same 149 held-out mice."),
      R("01-gru-scaling-law", "r8", "The GRU against the classical-RL suite, mouse by mouse."),
      R("12-cognitive-literature-leaderboard", "r3", "The models from the literature, fit per subject and as 2-level EM."),
      R("13-hb-subject-vs-gru-heldout", "r1", "A two-level hierarchical Bayesian cognitive model against the GRU.")],
    capacity: [R("01-gru-scaling-law", "r7", "The joint grid of hidden size N and training mice D."),
      R("01-gru-scaling-law", "r1", "The data-scaling curve on its own.")],
    generative: [R("01-gru-scaling-law", "r9", "Closed-loop simulations of the GRU against the animals, across D."),
      R("50-gru-dynamics-embedding", "r2", "One trained GRU against the animals and the classical RL models.")],
    species: [R("09-gru-cross-species-transfer", "r1", "The GRU core on external two-armed-bandit datasets: mice, rats, macaques and humans."),
      R("09-gru-cross-species-transfer", "r3", "What predicts how well the core transfers."),
      R("09-gru-cross-species-transfer", "r7", "How transfer depends on the data used to adapt to the new subjects.")],
    analysis: [R("50-gru-dynamics-embedding", "r3", "The trained GRU's dynamics: fixed points, timescales, flow."),
      R("50-gru-dynamics-embedding", "r5", "What the subject embedding does."),
      R("09-gru-cross-species-transfer", "r2", "Where external subjects land in the embedding space.")],
    classical: [R("01-gru-scaling-law", "r10", "The GRU's subject embedding decodes classical-RL parameters."),
      R("50-gru-dynamics-embedding", "r8", "How the GRU's strategy differs from Q-learning.")],
  };

  // the abstract as SfN printed it, one array per paragraph; [key, phrase] pieces are linked
  const ABSTRACT = [
    ["Animal behavior varies considerably across individuals and over time, particularly in flexible, naturalistic, and " +
      "ethologically relevant settings. Modeling such behavior at scale requires approaches that can accurately predict " +
      "and reproduce behavior while accounting for both shared computational structure and factors contributing to " +
      "behavioral variability."],
    ["Here, we develop a recurrent neural network (RNN) model using a large-scale dataset comprising over 750 " +
      "mice, 22,000 sessions, and 12 million trials from a two-arm bandit task with changing reward contingencies. The model " +
      "combines a ", ["arch", "gated recurrent unit core with learned subject and session embeddings"], " that adapt its " +
      "dynamics to individual animals and sessions. We pre-train variants of the model at multiple scales using data from 10, 30, 100, " +
      "300, or 614 mice and evaluate generalization to 149 held-out mice by fine-tuning only the embeddings while keeping " +
      "the recurrent core fixed. On these held-out mice, the models ",
      ["cognitive", "substantially outperform classical cognitive models in next-choice prediction"], ". Moreover, ",
      ["capacity", "performance improves with both model capacity (number of RNN hidden units) and pre-training dataset size"],
      ", resembling the scaling behavior observed in foundation models for language and vision. Beyond next-choice " +
      "prediction, ", ["generative", "closed-loop generative simulations show that these models faithfully reproduce a wide " +
      "range of empirical history-dependent statistics, whereas classical cognitive models exhibit systematic deviations"],
      ". The same pre-trained models also generalize across task variants and species. When evaluated on ",
      ["species", "external datasets from mice, rats, macaques, and humans"], " performing related two-arm bandit tasks, these " +
      "models often match or outperform task-specific cognitive models. Finally, we ",
      ["analysis", "analyze the learned RNN core and embedding space"], " to identify shared computational motifs and latent " +
      "representations of behavioral variability. These analyses reveal ", ["classical", "connections to classical cognitive " +
      "models"], " and suggest new directions for developing more comprehensive theories of adaptive decision-making."],
    ["Together, our results demonstrate that data-driven models with minimal inductive bias can capture both " +
      "shared computational structure and behavioral heterogeneity at scale, providing a framework for relating rich " +
      "behavioral representations to large-scale, simultaneously recorded neural dynamics."],
  ];

  // the poster as one JPEG (scripts/poster_image.py renders it; the PDF is not published), and each panel's
  // rectangle in PDF points, its top edge in the gap below the panel above
  const POSTER = { img: "poster/sfn2026.jpg", w: 4032, h: 2688 };
  const PANELS = [
    ["introduction", "Introduction", [80, 380, 985, 925]],
    ["task", "Behavioral task", [80, 1080, 990, 2160]],
    ["dataset", "Large-scale dataset", [80, 2165, 1000, 2640]],
    ["architecture", "Model architecture", [1040, 395, 1935, 1015]],
    ["training", "Training and evaluation", [1040, 1020, 1935, 1945]],
    ["ground-truth", "Ground-truth recovery", [1040, 1950, 1940, 2640]],
    ["scaling", "Next-choice prediction and scaling", [2015, 505, 2960, 1232]],
    ["rollouts", "Generative rollouts", [2015, 1240, 2960, 1785]],
    ["external", "Generalization to external datasets", [2015, 1785, 2960, 2645]],
    ["embedding", "Embedding captures individual variability", [3010, 505, 3985, 1105]],
    ["gru-core", "Reverse engineering the GRU core", [3010, 1110, 3985, 2098]],
    ["conclusion", "Conclusion and future work", [3010, 2115, 3985, 2500]],
  ].map(([id, title, rect]) => ({ id, title, rect }));
  const PANEL = Object.fromEntries(PANELS.map((p) => [p.id, p]));
  // the panel each linked phrase of the abstract is on
  const ON_POSTER = { arch: "architecture", cognitive: "scaling", capacity: "scaling", generative: "rollouts",
    species: "external", analysis: "gru-core", classical: "embedding" };

  const EXPLORE = [
    ["#/poster", "Poster", "The SfN 2026 poster; each panel links to the reports behind it."],
    ["#/studies", "Studies", "Every study, how they connect, and each report traced to its inputs and commits."],
    ["#/leaderboard", "Leaderboard", "Every model family's held-out choice likelihood on one axis, with model cards."],
    ["#/timeline", "Timeline", "When each launch ran and what each study is waiting on."],
    ["#/health", "Health", "What the provenance checker found across the studies repo."],
    ["#/framework", "Framework", "The provenance framework behind the atlas, for other ML projects to reuse."],
  ];

  // a link's target, title and href in this catalog, or null when the study or report is not in it
  function resolve(l) {
    if (l.card) return A.openModelCard ? { href: "#/leaderboard", title: l.label, note: l.note, card: l.card } : null;
    if (l.route) return { href: l.route, title: l.label, note: l.note };
    const s = S.study[l.study];
    if (!s) return null;
    if (!l.report) return { href: `#/study/${encodeURIComponent(s.id)}`, title: `Study ${s.id}`, note: l.note };
    const r = s.reports.find((x) => x.id === l.report);
    if (!r) return null;
    return { href: `#/report/${encodeURIComponent(s.id)}/${encodeURIComponent(r.id)}`,
      title: `${s.id.split("-")[0]} ${r.id}: ${r.title.replace(/^(Result|r)\s*\d+\s*[—:-]+\s*/i, "")}`, note: l.note };
  }
  const resolved = Object.fromEntries(Object.entries(LINKS).map(([k, ls]) => [k, ls.map(resolve).filter(Boolean)]));

  const piece = (x) => {
    if (typeof x === "string") return esc(x);
    const [key, text] = x, ls = resolved[key];
    return ls.length ? `<a class="abs-link" href="${esc(ls[0].href)}" data-key="${esc(key)}"${ls[0].card ? ` data-card="${esc(ls[0].card)}"` : ""}>${esc(text)}</a>`
      : esc(text);
  };
  const sources = (key) => `<ul>${resolved[key].map((l) =>
    `<li><a href="${esc(l.href)}"${l.card ? ` data-card="${esc(l.card)}"` : ""}>${esc(l.title)}</a><div class="tip-v">${esc(l.note)}</div></li>`).join("")}</ul>`;
  // a panel cut from the poster JPEG by CSS (no image per panel); its height is known before the image loads, so the
  // tooltip places itself right
  const crop = (p) => {
    const [x0, y0, x1, y1] = p.rect, w = x1 - x0, h = y1 - y0;
    return `<span class="poster-crop" style="aspect-ratio: ${w} / ${h};
      background-image: url(${POSTER.img}); background-size: ${(100 * POSTER.w / w).toFixed(2)}% auto;
      background-position: ${(100 * x0 / (POSTER.w - w)).toFixed(2)}% ${(100 * y0 / (POSTER.h - h)).toFixed(2)}%"></span>`;
  };
  const card = (key) => {
    const p = PANEL[ON_POSTER[key]];
    return (p ? `<a class="tip-poster" href="#/poster/${p.id}" title="Open the poster with this panel highlighted">
      ${crop(p)}<span>On the poster: ${esc(p.title)} ↗</span></a>` : "") + `<b>Where this comes from</b>${sources(key)}`;
  };

  VIEWS.home = () => {
    main().innerHTML = `
      <p class="home-kicker">SfN 2026 · Late-breaking poster LBP081.11 / B9 · Wed, Nov 18, 1–5 PM, WCC Halls A–C ·
        presenter at the poster 2–3 PM</p>
      <h1 class="home-title">Modeling adaptive decision-making at scale</h1>
      <p class="home-authors">${AUTHORS.map(esc).join(", ")}</p>
      <p class="home-affil muted">* Equal contribution (Han Hou and Po-Chen Kuo). All authors: Allen Institute, Neural Dynamics,
        Seattle, WA, except ² Neurobiology and Biophysics &amp; Computational Neuroscience Center, University of Washington,
        Seattle, WA. <a href="${ABSTRACT_URL}" target="_blank" rel="noopener">The abstract on the SfN planner</a>.</p>
      <section class="home-abstract" aria-label="Abstract">
        <h2>Abstract</h2>
        ${ABSTRACT.map((para) => `<p>${para.map(piece).join("")}</p>`).join("")}
        <p class="home-hint"><a href="#/poster">Explore the interactive poster →</a></p>
      </section>
      <h2>Explore the atlas</h2>
      <div class="home-explore">${EXPLORE.map(([href, name, line]) =>
        `<a class="home-tile" href="${href}"><b>${esc(name)}</b><span>${esc(line)}</span></a>`).join("")}</div>`;
    const host = main().querySelector(".home-abstract"), tip = A.tooltip(host);
    // fetch the poster image on the first hover, not on every visit to the home page
    host.addEventListener("pointerenter", () => { new Image().src = POSTER.img; }, { once: true });
    const tipEl = host.querySelector(".tip");
    // a model-card link opens the card in the drawer instead of leaving the page
    host.addEventListener("click", (ev) => {
      const a = ev.target.closest("a[data-card]");
      if (a && A.openModelCard(a.dataset.card)) { ev.preventDefault(); tip.hide(); }
    });
    // keyboard users Tab from a phrase into its card's links: hide the card only once focus leaves both
    tipEl.addEventListener("focusout", (ev) => { if (!tipEl.contains(ev.relatedTarget)) tip.hide(); });
    for (const a of host.querySelectorAll(".abs-link")) {
      const show = () => tip.show(a, card(a.dataset.key));
      a.addEventListener("pointerenter", show);
      a.addEventListener("focus", show);
      a.addEventListener("pointerleave", () => tip.hide());
      a.addEventListener("blur", (ev) => { if (!tipEl.contains(ev.relatedTarget)) tip.hide(); });
      a.addEventListener("keydown", (ev) => { if (ev.key === "ArrowDown") { ev.preventDefault(); tipEl.querySelector("a")?.focus(); } });
    }
  };

  // #/poster or #/poster/<panel>: the whole poster, zoomed to the panel and with the rest dimmed. Clicking another
  // panel moves the highlight there
  VIEWS.poster = (id) => {
    const p = PANEL[id];
    const phrases = p ? Object.keys(ON_POSTER).filter((k) => ON_POSTER[k] === p.id && resolved[k].length) : [];
    const pct = (v, of) => `${(100 * v / of).toFixed(3)}%`;
    main().innerHTML = `
      <p class="home-kicker">SfN 2026 · Late-breaking poster LBP081.11 / B9 · <a href="#/">the abstract</a></p>
      <h1 class="home-title">${p ? esc(p.title) : "Modeling adaptive decision-making at scale"}</h1>
      <div class="poster-tools">
        <button type="button" class="btn" data-zoom="out" aria-label="Zoom out">−</button>
        <button type="button" class="btn" data-zoom="in" aria-label="Zoom in">+</button>
        ${p ? `<button type="button" class="btn" data-zoom="panel">Fit the panel</button>` : ""}
        <button type="button" class="btn" data-zoom="all">Whole poster</button>
        <span class="muted">Click a panel to highlight it.</span>
      </div>
      <div class="poster-stage"><div class="poster-canvas">
        <img src="${POSTER.img}" width="5600" height="3734" alt="The SfN 2026 poster: Modeling adaptive decision-making at scale">
        ${p ? `<div class="poster-hl" style="left: ${pct(p.rect[0], POSTER.w)}; top: ${pct(p.rect[1], POSTER.h)};
          width: ${pct(p.rect[2] - p.rect[0], POSTER.w)}; height: ${pct(p.rect[3] - p.rect[1], POSTER.h)}"></div>` : ""}
      </div></div>
      ${phrases.length ? `<div class="poster-sources">${phrases.map((k) => `<div><span class="muted">In the abstract:</span>
        “${esc(ABSTRACT.flat().find((x) => Array.isArray(x) && x[0] === k)[1])}”${sources(k)}</div>`).join("")}</div>` : ""}
      <h2>Panels</h2>
      <div class="chips poster-panels">${PANELS.map((x) =>
        `<a class="chip${x === p ? " on" : ""}" href="#/poster/${x.id}">${esc(x.title)}</a>`).join("")}</div>
`;
    const stage = main().querySelector(".poster-stage"), canvas = stage.firstElementChild;
    // zoom 1: the poster as wide as the stage; centre (cx, cy) in PDF points
    let zoom = 1;
    // the poster fills the window below the toolbar
    stage.style.height = `${Math.max(320, innerHeight - stage.getBoundingClientRect().top - 12)}px`;
    const set = (z, cx, cy) => {
      zoom = Math.min(Math.max(z, 0.2), 8);
      canvas.style.width = `${100 * zoom}%`;
      const k = stage.clientWidth * zoom / POSTER.w;
      stage.scrollLeft = cx * k - stage.clientWidth / 2;
      stage.scrollTop = cy * k - stage.clientHeight / 2;
    };
    const centre = () => { const k = stage.clientWidth * zoom / POSTER.w;
      return [(stage.scrollLeft + stage.clientWidth / 2) / k, (stage.scrollTop + stage.clientHeight / 2) / k]; };
    const fit = (x0, y0, x1, y1, pad) => set(pad * Math.min(POSTER.w / (x1 - x0),
      stage.clientHeight / stage.clientWidth * POSTER.w / (y1 - y0)), (x0 + x1) / 2, (y0 + y1) / 2);
    const whole = () => fit(0, 0, POSTER.w, POSTER.h, 1);
    p ? fit(...p.rect, 0.94) : whole();
    main().querySelector(".poster-tools").addEventListener("click", (ev) => {
      const z = ev.target.closest("[data-zoom]")?.dataset.zoom;
      if (z === "in" || z === "out") set(zoom * (z === "in" ? 1.25 : 0.8), ...centre());
      else if (z === "panel") fit(...p.rect, 0.94);
      else if (z === "all") whole();
    });
    canvas.addEventListener("click", (ev) => {
      const b = canvas.getBoundingClientRect(), k = b.width / POSTER.w;
      const x = (ev.clientX - b.left) / k, y = (ev.clientY - b.top) / k;
      const hit = PANELS.find((q) => x >= q.rect[0] && x <= q.rect[2] && y >= q.rect[1] && y <= q.rect[3]);
      if (hit && hit !== p) location.hash = `#/poster/${hit.id}`;
    });
  };
});
