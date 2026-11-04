/* The home page (#/): our SfN 2026 abstract, each claim linked to the studies and reports behind it (hover a
 * linked phrase for what each shows), then links to the rest of the atlas. Hand-written, like the leaderboard's
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
    bias: [P("#/leaderboard", "Leaderboard: Why these models", "The models laid out from hypothesis-driven to data-driven, and what each step buys on held-out mice.")],
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
    ["Together, our results demonstrate that ", ["bias", "data-driven models with minimal inductive bias"], " can capture both " +
      "shared computational structure and behavioral heterogeneity at scale, providing a framework for relating rich " +
      "behavioral representations to large-scale, simultaneously recorded neural dynamics."],
  ];

  const EXPLORE = [
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
  const card = (key) => `<b>Where this comes from</b><ul>${resolved[key].map((l) =>
    `<li><a href="${esc(l.href)}"${l.card ? ` data-card="${esc(l.card)}"` : ""}>${esc(l.title)}</a><div class="tip-v">${esc(l.note)}</div></li>`).join("")}</ul>`;

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
        <p class="muted home-hint">Linked phrases open the study, report or model card behind each claim; hover one (or Tab to it)
          for every source it draws on.</p>
      </section>
      <h2>Explore the atlas</h2>
      <div class="home-explore">${EXPLORE.map(([href, name, line]) =>
        `<a class="home-tile" href="${href}"><b>${esc(name)}</b><span>${esc(line)}</span></a>`).join("")}</div>`;
    const host = main().querySelector(".home-abstract"), tip = A.tooltip(host);
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
});
