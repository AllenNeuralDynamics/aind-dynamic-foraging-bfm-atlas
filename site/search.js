/* Search (the box in the header, and #/search/<query>): studies and the full text of every report, in the browser.
 * The documents are a study (id, title, question, verdict, README), each report's result block (linked to the
 * block), and the rest of each report (linked to the report). Every word of the query must appear in a document;
 * "quoted words" must appear together. Ranked by where the words hit (title, then question or heading, then
 * text). No index file and no library: about 1 MB of text, searched as plain strings. Registers through
 * window.Atlas.
 */
"use strict";

document.addEventListener("atlas:ready", () => {
  const A = window.Atlas;
  const { S, VIEWS, esc } = A;
  const main = () => document.getElementById("main");
  const MAX_DROPDOWN = 8;

  // markdown to readable text: comments, tags, image and link syntax, emphasis and table pipes go; math stays
  const plain = (md) => (md || "")
    .replace(/<!--[\s\S]*?-->/g, " ").replace(/<[^>]+>/g, " ")
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1").replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/^#{1,6}\s*/gm, "").replace(/^\s*>\s?/gm, "").replace(/[*_`|]+/g, " ").replace(/^\s*[-:]{3,}\s*$/gm, " ")
    .replace(/\s+/g, " ").trim();
  // case, and the typographic minus, do not matter
  const norm = (t) => t.toLowerCase().replace(/[−–]/g, "-");
  const studyNo = (id) => id.split("-")[0];
  const shortTitle = (t) => (t || "").replace(/^(Result|r)\s*\d+\s*[—:-]+\s*/i, "");

  let docs = null;
  function build() {
    docs = [];
    const add = (d) => docs.push({ ...d, hay: norm(`${d.title} ${d.head} ${d.text}`), t: norm(d.title), h: norm(d.head) });
    for (const s of S.cat.studies) {
      add({ kind: "study", href: `#/study/${encodeURIComponent(s.id)}`, title: `Study ${s.id}`,
        head: [s.cover.question, s.cover.verdict].filter(Boolean).join(" "), text: plain(s.readme) });
      for (const r of s.reports) {
        const base = `#/report/${encodeURIComponent(s.id)}/${encodeURIComponent(r.id)}`;
        const title = `${studyNo(s.id)} ${r.id} · ${shortTitle(r.title)}`;
        for (const b of r.result_blocks || []) {
          add({ kind: "block", href: `${base}?block-${encodeURIComponent(b.name)}`, title, head: b.name, text: plain(b.markdown) });
        }
        // the report outside its result blocks: question, method, decisions
        const rest = (r.markdown || "").replace(/<!-- BEGIN ([\w.-]+) -->[\s\S]*?<!-- END \1 -->/g, " ");
        add({ kind: "report", href: base, title, head: "", text: plain(rest) });
      }
    }
  }

  // query terms: "quoted phrases" stay whole, other words split on spaces
  const terms = (q) => [...norm(q).matchAll(/"([^"]+)"|(\S+)/g)].map((m) => (m[1] || m[2]).trim()).filter(Boolean);

  function search(q) {
    if (!docs) build();
    const ts = terms(q);
    if (!ts.length) return [];
    const whole = norm(q.replace(/"/g, "")).trim();
    const hits = [];
    for (const d of docs) {
      if (!ts.every((t) => d.hay.includes(t))) continue;
      let score = 0;
      for (const t of ts) {
        if (d.t.includes(t)) score += 10;
        if (d.h.includes(t)) score += 4;
        let n = 0, i = d.hay.indexOf(t);
        while (i >= 0 && n < 5) { n++; i = d.hay.indexOf(t, i + t.length); }
        score += n;
      }
      if (ts.length > 1 && d.hay.includes(whole)) score += 6;     // the words together, as typed
      if (d.kind === "study") score += 2;                          // a study page outranks its reports on a tie
      hits.push({ d, score });
    }
    return hits.sort((a, b) => b.score - a.score);
  }

  // a stretch of text around the first hit, every term marked
  function snippet(d, ts) {
    const text = d.text || d.head;
    const low = norm(text);
    const found = ts.map((t) => low.indexOf(t)).filter((i) => i >= 0);
    const at = found.length ? Math.min(...found) : 0;       // a hit in the title only: the text from its start
    const from = Math.max(0, at - 70), to = Math.min(text.length, at + 170);
    let out = esc(text.slice(from, to));
    for (const t of [...ts].sort((a, b) => b.length - a.length)) {
      out = out.replace(new RegExp(esc(t).replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "gi"), (m) => `<mark>${m}</mark>`);
    }
    return `${from > 0 ? "…" : ""}${out}${to < text.length ? "…" : ""}`;
  }
  const label = (d) => d.kind === "block" ? `${d.title} · ${d.head}` : d.title;
  const kindChip = (d) => `<span class="search-kind">${d.kind === "study" ? "study" : d.kind === "block" ? "result" : "report"}</span>`;

  // ---- the header box: results drop down as you type; arrows move, Enter opens, Escape closes
  const box = document.getElementById("search"), list = document.getElementById("search-results");
  let shown = [], active = -1, timer = null;
  const close = () => { list.hidden = true; box.setAttribute("aria-expanded", "false"); box.removeAttribute("aria-activedescendant"); active = -1; };
  const fullHref = (q) => `#/search/${encodeURIComponent(q.trim())}`;
  function render() {
    const q = box.value;
    if (!q.trim()) return close();
    const hits = search(q), ts = terms(q);
    shown = hits.slice(0, MAX_DROPDOWN);
    active = -1;
    list.innerHTML = (shown.length ? shown.map(({ d }, i) => `<a role="option" id="sr-${i}" class="search-hit" href="${esc(d.href)}">
        <span class="search-title">${kindChip(d)} ${esc(label(d))}</span><span class="search-snip">${snippet(d, ts)}</span></a>`).join("")
      : `<p class="search-none">No study or report mentions all of “${esc(q.trim())}”.</p>`) +
      (hits.length > MAX_DROPDOWN ? `<a class="search-all" href="${esc(fullHref(q))}">All ${hits.length} results →</a>` : "");
    list.hidden = false;
    box.setAttribute("aria-expanded", "true");
  }
  const move = (k) => {
    if (!shown.length) return;
    active = (active + k + shown.length) % shown.length;
    list.querySelectorAll(".search-hit").forEach((a, i) => a.classList.toggle("active", i === active));
    box.setAttribute("aria-activedescendant", `sr-${active}`);
    list.querySelector(`#sr-${active}`)?.scrollIntoView({ block: "nearest" });
  };
  box.addEventListener("input", () => { clearTimeout(timer); timer = setTimeout(render, 120); });
  box.addEventListener("focus", () => { if (box.value.trim()) render(); });
  box.addEventListener("keydown", (ev) => {
    if (ev.key === "ArrowDown") { ev.preventDefault(); if (list.hidden) render(); move(1); }
    else if (ev.key === "ArrowUp") { ev.preventDefault(); move(-1); }
    else if (ev.key === "Enter") {
      ev.preventDefault();
      if (!box.value.trim()) return;
      location.hash = active >= 0 ? shown[active].d.href : fullHref(box.value);
      close(); box.blur();
    } else if (ev.key === "Escape") { close(); }
  });
  list.addEventListener("click", (ev) => { if (ev.target.closest("a")) close(); });
  document.addEventListener("pointerdown", (ev) => { if (!ev.target.closest(".search")) close(); });
  window.addEventListener("hashchange", close);

  // ---- the full results page
  VIEWS.search = (...parts) => {
    const q = parts.join("/");          // the router has decoded each part already
    const hits = q ? search(q) : [], ts = terms(q);
    main().innerHTML = `<h1>Search</h1>
      <p class="muted">${q ? `${hits.length} result${hits.length === 1 ? "" : "s"} for “${esc(q)}” in studies and the full text of their reports.`
        : "Type in the search box at the top: it looks through every study and the full text of every report."}
        Every word must appear; put words in quotes to find them together.</p>
      <ol class="search-page">${hits.map(({ d }) => `<li><a href="${esc(d.href)}">${kindChip(d)} ${esc(label(d))}</a>
        <div class="search-snip">${snippet(d, ts)}</div></li>`).join("")}</ol>`;
    if (q && box.value !== q) box.value = q;
  };
});
