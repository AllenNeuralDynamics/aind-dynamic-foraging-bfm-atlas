# aind-dynamic-foraging-bfm-atlas

An interactive, provenance-traced browser for
[aind-dynamic-foraging-bfm-studies](https://github.com/AllenNeuralDynamics/aind-dynamic-foraging-bfm-studies):
every study, report and number, traced back through the producer that computed it, the frozen
inputs it read, the W&B group and launch record that produced them, and the exact
studies / dispatcher / wrapper commits.

It is the last of four repositories: the
[studies](https://github.com/AllenNeuralDynamics/aind-dynamic-foraging-bfm-studies) say what to run
and why and keep the results, the
[dispatcher](https://github.com/AllenNeuralDynamics/aind-dynamic-foraging-bfm-dispatcher) launches
it, the [wrapper](https://github.com/AllenNeuralDynamics/aind-dynamic-foraging-bfm-wrapper) trains
it, and this site shows it. The dispatcher's
[stack diagram](https://raw.githack.com/AllenNeuralDynamics/aind-dynamic-foraging-bfm-dispatcher/main/docs/diagrams/bfm-stack.html)
draws how they connect; the About page embeds it.

**Live site: <https://allenneuraldynamics.github.io/aind-dynamic-foraging-bfm-atlas/>** (rebuilt on every push to `main` and daily at 13:17 UTC, i.e. 06:17 PDT / 05:17 PST, from studies `main`).

## What it shows

- **Study map** (home page): every study by creation order, in lanes by model family, with the
  relationships the studies repo declares (its ADR 0002): **motivation** (why a study exists),
  **correction**, and **upstream** (a report uses another study's results) as a toggle layer.
  Hover a study for its question and verdict; select it for what motivated it, what it led to,
  and its reports. Plain links between studies are citations and are not drawn.
- **Lineage** of any result block: the report drawer (the block's *Provenance* button, or a
  number) and its own page, `#/lineage/<study>/<rN>/<block>`. Each step back from the block to
  its data (report block, analysis, run results, tracked runs, launch records, launch manifests,
  code & image, data snapshot) is filled,
  half filled or hollow by what the catalog records. Open a step for its evidence (producer and
  digests, W&B groups, launch records, commits and image, data snapshot) and the checker findings
  about it; `#/lineage/<study>/<rN>/<block>/<step>` opens that step.
- **Interactive explainers**: a report that links to a tracked `.html` file in its study (for
  example study 13's sampling explainer) gets that page shipped with the site; the link opens it
  so it runs, rather than as source on GitHub.
- **Export SVG** on both, stamped with the studies commit, for slides.
- **About** (`#/about`): the framework itself, for other ML projects to reuse. The stack
  diagram of the four repositories (the dispatcher's `docs/diagrams/bfm-stack.html`, read from the
  same dispatcher commit as the skills and shipped under `data/dispatcher/`); an interactive map
  of the objects it defines (study, launch, launch record, freeze, producer, report, ...) by
  lifecycle stage, each with its definition, schema fields, checker rules and the skills that
  operate it; the skills pack, marked by how much carries over; and copyable prompts that port
  the framework to another repository. Definitions, fields, rules and skill descriptions are read
  from the source files at build time; the object map and skill levels are an editorial model in
  `src/bfm_atlas/framework.py`, and the build fails if it names a term or field the sources no
  longer have.

## How it works

```
studies checkout @ SHA ─┐
                        ├─bfm-atlas build──> catalog.json + files/ + dispatcher/ ──> static site (GitHub Pages)
dispatcher checkout @ SHA (optional, About page: skills pack + stack diagram)
```

- `bfm-atlas build --studies <checkout> [--skills <dispatcher>/aind-behavior-foundation-model-skills]`
  reads only committed files (no W&B, no Beaker), so the catalog is a pure function of the
  studies SHA it records in `_meta.studies_git_sha` and, with `--skills`, of the dispatcher SHA
  in `_meta.dispatcher_git_sha`. The skills and the stack diagram are read from that dispatcher
  commit with `git show`, never from its working tree.
- Field names follow the studies repo's `schemas/`; vocabulary (study, variant, launch,
  intervention, report, correction, upstream, freeze) follows its `CONTEXT.md`.
- Provenance findings are **not** computed here: the build runs the studies repo's own
  `scripts/check_provenance.py --format json` and embeds the result, so the atlas shows
  exactly what gates a studies PR.
- `schema/catalog.schema.json` describes the catalog; CI builds it from studies `main` and
  checks it against that schema.
- Markdown (reports, READMEs, variant notes) renders with marked, and TeX math with KaTeX:
  `$...$` inline and `$$...$$` display, the delimiters GitHub renders. As in pandoc, `$...$` is
  math only when no space is just inside either `$` and no digit follows the closing one, so
  `$5 and $10` stays prose here; GitHub's own rules for a lone `$` may differ, so write `\$` for
  a literal dollar anywhere else.

## Develop

```bash
python -m venv .venv && .venv/bin/pip install -e '.[dev]'
.venv/bin/pytest -q
git clone https://github.com/AllenNeuralDynamics/aind-dynamic-foraging-bfm-studies ../studies-main
git clone https://github.com/AllenNeuralDynamics/aind-dynamic-foraging-bfm-dispatcher ../dispatcher-main
.venv/bin/bfm-atlas build --studies ../studies-main \
  --skills ../dispatcher-main/aind-behavior-foundation-model-skills --out site/data/catalog.json
```

## Contributing

- Every change starts from an issue on the
  [AIND-behavior-fm board](https://github.com/orgs/AllenNeuralDynamics/projects/184).
- Branch from `main`, use Conventional Commits, open a PR. Never squash-merge.
- Tests use a small fixture studies repo (`tests/conftest.py`); add a case there when the
  studies schemas change.
