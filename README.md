# aind-dynamic-foraging-bfm-atlas

An interactive, provenance-traced browser for
[aind-dynamic-foraging-bfm-studies](https://github.com/AllenNeuralDynamics/aind-dynamic-foraging-bfm-studies):
every study, report and number, traced back through the producer that computed it, the frozen
inputs it read, the W&B group and launch record that produced them, and the exact
studies / dispatcher / wrapper commits.

**Live site: <https://allenneuraldynamics.github.io/aind-dynamic-foraging-bfm-atlas/>** (rebuilt on every push to `main` and daily at 13:17 UTC, i.e. 06:17 PDT / 05:17 PST, from studies `main`).

## How it works

```
studies checkout @ SHA ──bfm-atlas build──> catalog.json ──> static site (GitHub Pages)
```

- `bfm-atlas build --studies <checkout>` reads only committed files (no W&B, no Beaker), so the
  catalog is a pure function of the studies SHA it records in `_meta.studies_git_sha`.
- Field names follow the studies repo's `schemas/`; vocabulary (study, variant, launch,
  intervention, report, correction, upstream, freeze) follows its `CONTEXT.md`.
- Provenance findings are **not** computed here: the build runs the studies repo's own
  `scripts/check_provenance.py --format json` and embeds the result, so the atlas shows
  exactly what gates a studies PR.
- `schema/catalog.schema.json` describes the catalog; CI builds it from studies `main` and
  checks it against that schema.

## Develop

```bash
python -m venv .venv && .venv/bin/pip install -e '.[dev]'
.venv/bin/pytest -q
git clone https://github.com/AllenNeuralDynamics/aind-dynamic-foraging-bfm-studies ../studies-main
.venv/bin/bfm-atlas build --studies ../studies-main --out site/data/catalog.json
```

## Contributing

- Every change starts from an issue on the
  [AIND-behavior-fm board](https://github.com/orgs/AllenNeuralDynamics/projects/184).
- Branch from `main`, use Conventional Commits, open a PR. Never squash-merge.
- Tests use a small fixture studies repo (`tests/conftest.py`); add a case there when the
  studies schemas change.
