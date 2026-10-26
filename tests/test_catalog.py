import json
from pathlib import Path

from jsonschema import Draft202012Validator

import pytest

from bfm_atlas.catalog import DirtyCheckoutError, build_catalog
from bfm_atlas.cli import main
from conftest import GROUP, SHA, git, make_studies

SCHEMA = json.loads((Path(__file__).parents[1] / "schema" / "catalog.schema.json").read_text())


def by_id(cat, sid):
    return next(s for s in cat["studies"] if s["id"] == sid)


def test_catalog_matches_its_schema(studies):
    cat = build_catalog(studies)
    errors = list(Draft202012Validator(SCHEMA).iter_errors(cat))
    assert errors == [], [e.message for e in errors]


def test_meta_pins_the_sha_and_strips_credentials(studies):
    meta = build_catalog(studies)["_meta"]
    assert len(meta["studies_git_sha"]) == 40
    assert meta["studies_git_dirty"] is False
    assert "secret" not in meta["studies_remote"]


def test_cover_from_frontmatter_then_readme(studies):
    cat = build_catalog(studies)
    a, b = by_id(cat, "01-gru-alpha")["cover"], by_id(cat, "02-disrnn-beta")["cover"]
    assert (a["source"], a["status"], a["verdict"]) == ("frontmatter", "complete", "Yes, and it saturates.")
    assert (b["source"], b["question"]) == ("readme", "Does beta match alpha?")
    assert b["wandb"] == {"entity": "AIND-disRNN", "project": "beta"}


def test_launch_records_v2_and_legacy(studies):
    cat = build_catalog(studies)
    v2 = by_id(cat, "01-gru-alpha")["variants"][0]["launch_records"][0]
    assert v2["schema_version"] == 2 and v2["kind"] == "initial" and v2["wandb_groups"] == [GROUP]
    assert v2["revisions"]["dispatcher"] == "b" * 40 and v2["note"] == "baseline launch for alpha"
    legacy = by_id(cat, "02-disrnn-beta")["variants"][0]["launch_records"][0]
    assert legacy["schema_version"] == 1 and legacy["revisions"] == {"dispatcher": "d" * 40}
    assert legacy["job_refs"] == [{"type": "beaker_experiment", "id": "01KOLD"}]


def test_group_index_links_records_reports_artifacts_and_wandb(studies):
    g = build_catalog(studies)["wandb_groups"][GROUP]
    assert (g["study"], g["variant"]) == ("01-gru-alpha", "base")
    assert g["url"] == f"https://wandb.ai/AIND-disRNN/alpha/groups/{GROUP}"
    assert len(g["launch_records"]) == 2 and len(g["reports"]) == 1 and len(g["artifacts"]) == 1


def test_report_fields(studies):
    r = by_id(build_catalog(studies), "01-gru-alpha")["reports"][0]
    assert (r["id"], r["slug"], r["status"]) == ("r1", "curve", "live")
    assert r["result_blocks"][0]["name"] == "result-1"
    assert r["figures"] == [{"alt": "curve", "src": "../fig.png",
                             "path": "studies/01-gru-alpha/analysis/fig.png", "exists": True}]
    assert all(i["exists"] for i in r["inputs"])


def test_artifact_meta_v2(studies):
    a = by_id(build_catalog(studies), "01-gru-alpha")["artifacts"][0]["meta"]
    assert a["schema_version"] == 2 and a["kind"] == "producer"
    assert a["outputs"][0]["path"].endswith("summary.json")


def test_dependencies_are_relationships_not_citations(studies):
    deps = {(d["from"], d["to"], d["kind"]) for d in build_catalog(studies)["dependencies"]}
    assert ("02-disrnn-beta", "01-gru-alpha", "upstream") in deps
    assert ("02-disrnn-beta", "01-gru-alpha", "corrects") in deps
    # 02's README links to 01, but a citation is not a relationship (studies ADR 0002)
    assert not any(k == "citation" for _, _, k in deps)


def test_motivation_edges_from_the_study_cover(studies):
    readme = studies / "studies/03-gru-gamma/README.md"
    readme.parent.mkdir(parents=True)
    readme.write_text("""---
schema_version: 1
id: 03-gru-gamma
question: Does gamma follow from alpha and beta?
status: planned
wandb: {entity: AIND-disRNN, project: gamma}
motivated_by:
  - {study: 01-gru-alpha, report: r1, note: alpha saturates by D=100}
  - {study: 02-disrnn-beta, note: beta's verdict as a whole}
  - {issue: 23, note: a roadmap item asked for it}
---
# Study: gamma
""")
    git(studies, "add", "-A")
    git(studies, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "gamma")   # tracked files only
    cat = build_catalog(studies, validate=False)
    assert by_id(cat, "01-gru-alpha")["cover"]["motivated_by"] is None        # not declared
    mot = [d for d in cat["dependencies"] if d["kind"] == "motivation"]
    assert {(d["to"], d["to_report"], d["note"]) for d in mot} == {
        ("01-gru-alpha", "01-gru-alpha/r1", "alpha saturates by D=100"),
        ("02-disrnn-beta", None, "beta's verdict as a whole"),
        ("issue:23", None, "a roadmap item asked for it")}
    assert all(d["from"] == "03-gru-gamma" and d["report"] is None for d in mot)
    assert not list(Draft202012Validator(SCHEMA).iter_errors(cat))


def test_validator_output_is_embedded(studies):
    h = build_catalog(studies)["health"]
    assert h["ran"] and h["findings"][0]["check"] == "artifact-meta-v1"


def test_missing_validator_is_reported_not_fatal(tmp_path):
    root = make_studies(tmp_path / "s", checker=False)
    h = build_catalog(root)["health"]
    assert not h["ran"] and "check_provenance.py" in h["error"]


def test_cli_build(studies, tmp_path, capsys):
    out = tmp_path / "data" / "catalog.json"
    assert main(["build", "--studies", str(studies), "--out", str(out)]) == 0
    assert json.loads(out.read_text())["_meta"]["schema_version"] == 1
    assert "2 studies" in capsys.readouterr().out


def test_relative_studies_path(studies, monkeypatch):
    monkeypatch.chdir(studies.parent)
    assert build_catalog(studies.name)["health"]["ran"]


def test_cli_copies_figures(studies, tmp_path):
    out = tmp_path / "data" / "catalog.json"
    main(["build", "--studies", str(studies), "--out", str(out), "--no-validate"])
    assert (tmp_path / "data" / "files" / "studies/01-gru-alpha/analysis/fig.png").read_text() == "png"
def test_interactive_pages_are_catalogued_and_copied(studies, tmp_path):
    """A report's link to a tracked .html file ships with the site, so the page runs."""
    report = next(r for s in build_catalog(studies, validate=False)["studies"] for r in s["reports"]
                  if r["path"].endswith("r1-curve.md"))
    assert report["interactive"] == [{"path": "studies/01-gru-alpha/analysis/explainers/demo.html",
                                      "exists": True}]
    out = tmp_path / "data" / "catalog.json"
    main(["build", "--studies", str(studies), "--out", str(out), "--no-validate"])
    copied = tmp_path / "data" / "files" / "studies/01-gru-alpha/analysis/explainers/demo.html"
    assert copied.read_text() == "<html>demo</html>"


def test_dirty_checkout_is_refused_unless_allowed(studies):
    (studies / "studies/01-gru-alpha/analysis/reports/r2-new.md").write_text("# r2\n")
    with pytest.raises(DirtyCheckoutError):
        build_catalog(studies)
    cat = build_catalog(studies, allow_dirty=True)
    assert cat["_meta"]["studies_git_dirty"] is True


def test_checker_verdict_is_kept_whole(studies):
    h = build_catalog(studies)["health"]
    assert h["fixed"] == [] and h["baseline_grown"] == [] and h["exit_code"] == 0


def test_ignored_files_never_enter_the_catalog(studies):
    (studies / ".gitignore").write_text("drafts/\n*.local.md\n")
    import subprocess
    subprocess.run(["git", "-C", str(studies), "add", ".gitignore"], check=True)
    subprocess.run(["git", "-C", str(studies), "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "ignore"], check=True)
    (studies / "studies/01-gru-alpha/analysis/reports/r9-draft.local.md").write_text("# draft\n")
    (studies / "studies/01-gru-alpha/variants/base/launch_record/drafts").mkdir()
    (studies / "studies/01-gru-alpha/variants/base/launch_record/drafts/x.json").write_text("{}")
    cat = build_catalog(studies)          # clean: ignored files do not show in git status
    s = by_id(cat, "01-gru-alpha")
    assert [r["path"] for r in s["reports"]] == ["studies/01-gru-alpha/analysis/reports/r1-curve.md"]
    assert not any("drafts" in r["path"] for r in s["variants"][0]["launch_records"])


def test_number_links_unique_matches_only(studies):
    r = by_id(build_catalog(studies), "01-gru-alpha")["reports"][0]
    links = {l["text"]: l for l in r["result_blocks"][0]["number_links"]}
    assert links["0.7101"]["pointer"] == "/by_d/10"
    assert links["0.7154"]["artifact"] == "studies/01-gru-alpha/analysis/summary.json"
    assert links["0.7101"]["how"] == "inputs"


def test_number_links_skip_ambiguous_and_low_precision(studies):
    import json as _json, subprocess
    p = studies / "studies/01-gru-alpha/analysis/summary.json"
    d = _json.loads(p.read_text())
    d["dup"] = 0.7101                       # two leaves now round to 0.7101
    p.write_text(_json.dumps(d))
    rep = studies / "studies/01-gru-alpha/analysis/reports/r1-curve.md"
    rep.write_text(rep.read_text().replace("| alpha | 0.7101 | 0.7154 |", "| alpha | 0.7101 | 0.7154 | 0.71 |"))
    subprocess.run(["git", "-C", str(studies), "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qam", "x"], check=True)
    texts = {l["text"] for l in by_id(build_catalog(studies), "01-gru-alpha")["reports"][0]["result_blocks"][0]["number_links"]}
    assert texts == {"0.7154"}             # 0.7101 ambiguous, 0.71 has too few digits


def test_history_records_each_block_change(studies):
    import subprocess
    rep = studies / "studies/01-gru-alpha/analysis/reports/r1-curve.md"
    rep.write_text(rep.read_text().replace("0.7154", "0.7160"))
    subprocess.run(["git", "-C", str(studies), "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qam", "update r1"], check=True)
    rep.write_text(rep.read_text().replace("# r1 — the curve", "# r1 — the curve, retitled"))   # prose only
    subprocess.run(["git", "-C", str(studies), "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qam", "prose"], check=True)
    h = by_id(build_catalog(studies), "01-gru-alpha")["reports"][0]["history"]
    assert [v["subject"] for v in h] == ["update r1", "init"]
    assert "0.7160" in h[0]["blocks"]["result-1"] and "0.7154" in h[1]["blocks"]["result-1"]
def _commit(root, msg="x"):
    import subprocess
    subprocess.run(["git", "-C", str(root), "add", "-A"], check=True)
    subprocess.run(["git", "-C", str(root), "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", msg], check=True)


def test_nested_launch_note_beats_trigger_symptom(studies):
    p = studies / "studies/02-disrnn-beta/variants/old/launch_record/hpc.json"
    p.write_text(json.dumps({"kind": "rescue", "trigger": {"symptom": "wedged"},
                             "launch": {"note": "the original purpose"}}))
    _commit(studies)
    recs = by_id(build_catalog(studies), "02-disrnn-beta")["variants"][0]["launch_records"]
    assert next(r for r in recs if r["path"].endswith("hpc.json"))["note"] == "the original purpose"


def test_legacy_kind_is_freeze_or_unknown(studies):
    a = studies / "studies/02-disrnn-beta/analysis"
    (a / "frozen.json").write_text(json.dumps({"_meta": {"produced_by": "analysis/freeze_runs.py"}}))
    _commit(studies)
    arts = {x["path"].split("/")[-1]: x["meta"]["kind"] for x in by_id(build_catalog(studies), "02-disrnn-beta")["artifacts"]}
    assert arts["frozen.json"] == "freeze" and arts["old.json"] is None


def test_ignored_variant_dirs_are_skipped(studies):
    (studies / ".gitignore").write_text("scratch/\n")
    _commit(studies)
    (studies / "studies/01-gru-alpha/variants/scratch").mkdir()
    (studies / "studies/01-gru-alpha/variants/scratch/notes.md").write_text("# x\n")
    assert [v["name"] for v in by_id(build_catalog(studies), "01-gru-alpha")["variants"]] == ["base"]


def test_root_launch_records_are_kept(studies):
    (studies / "studies/02-disrnn-beta/heldout_rerun.json").write_text(json.dumps({
        "wandb_group": "rerun@20260623-004601", "experiment_id": "01KROOT", "dispatcher_commit": "e" * 40}))
    _commit(studies)
    cat = build_catalog(studies)
    root = by_id(cat, "02-disrnn-beta")["root_launch_records"]
    assert root[0]["revisions"] == {"dispatcher": "e" * 40}
    g = cat["wandb_groups"]["rerun@20260623-004601"]
    assert (g["study"], g["variant"]) == ("02-disrnn-beta", None)
    assert not any(a["path"].endswith("heldout_rerun.json") for a in by_id(cat, "02-disrnn-beta")["artifacts"])


def test_meta_json_outside_analysis_is_an_artifact(studies):
    (studies / "studies/02-disrnn-beta/reference").mkdir()
    (studies / "studies/02-disrnn-beta/reference/trained.json").write_text(json.dumps({"_meta": {"produced_by": "x.py"}}))
    (studies / "studies/02-disrnn-beta/reference/plain.json").write_text("{}")
    _commit(studies)
    paths = {a["path"] for a in by_id(build_catalog(studies), "02-disrnn-beta")["artifacts"]}
    assert "studies/02-disrnn-beta/reference/trained.json" in paths
    assert "studies/02-disrnn-beta/reference/plain.json" not in paths


def test_group_url_uses_the_launch_project(studies):
    d = studies / "studies/01-gru-alpha/variants/base/launch_record/smoke"
    d.mkdir()
    (d / "sweep_smoke.yaml").write_text("entity: AIND-disRNN\nproject: test\n")
    (d / "experiment_submitted.yaml").write_text("description: base@20261101-000000 smoke\n")
    _commit(studies)
    groups = build_catalog(studies)["wandb_groups"]
    assert groups["base@20261101-000000"]["url"] == "https://wandb.ai/AIND-disRNN/test/groups/base@20261101-000000"
    assert groups[GROUP]["url"].startswith("https://wandb.ai/AIND-disRNN/alpha/")


def test_legacy_wrapper_ref_group_suffix_and_slurm(studies):
    p = studies / "studies/02-disrnn-beta/variants/old/launch_record/slurm_job.json"
    p.write_text(json.dumps({"wandb_group": "old@20261024-060709-hpc", "slurm_job_id": 12345,
                             "wrapper_ref": "f" * 40, "dispatcher_ref": "main"}))
    _commit(studies)
    r = next(x for x in by_id(build_catalog(studies), "02-disrnn-beta")["variants"][0]["launch_records"]
             if x["path"].endswith("slurm_job.json"))
    assert r["wandb_groups"] == ["old@20261024-060709-hpc"]
    assert r["revisions"] == {"wrapper": "f" * 40}          # a branch ref stays unpinned
    assert r["job_refs"] == [{"type": "slurm_job", "id": "12345"}] and r["platform"] == "hpc"


def test_group_url_from_record_manifests(studies):
    v = studies / "studies/01-gru-alpha/variants/base"
    (v / "sweep_smoke.yaml").write_text("entity: AIND-disRNN\nproject: test\n")
    rec = json.loads((v / "launch_record/beaker.json").read_text())
    rec.update(wandb_group="base@20261102-000000", manifests=["sweep_smoke.yaml"])
    (v / "launch_record/smoke.json").write_text(json.dumps(rec))
    _commit(studies)
    url = build_catalog(studies)["wandb_groups"]["base@20261102-000000"]["url"]
    assert url == "https://wandb.ai/AIND-disRNN/test/groups/base@20261102-000000"


def test_cli_copies_readme_and_notes_images(studies, tmp_path):
    (studies / "studies/01-gru-alpha/schematic.png").write_text("s")
    readme = studies / "studies/01-gru-alpha/README.md"
    readme.write_text(readme.read_text() + "\n![schematic](schematic.png)\n")
    notes = studies / "studies/01-gru-alpha/variants/base/notes.md"
    (studies / "studies/01-gru-alpha/variants/base/n.png").write_text("n")
    notes.write_text("# base\n![n](n.png)\n")
    _commit(studies)
    out = tmp_path / "data" / "catalog.json"
    main(["build", "--studies", str(studies), "--out", str(out), "--no-validate"])
    files = tmp_path / "data" / "files" / "studies/01-gru-alpha"
    assert (files / "schematic.png").exists() and (files / "variants/base/n.png").exists()


def test_pre_split_dispatcher_sha_is_not_relabelled(studies):
    a = studies / "studies/02-disrnn-beta/analysis/presplit.json"
    a.write_text(json.dumps({"_meta": {"produced_by": "x.py", "dispatcher_git_sha": "9" * 40}}))
    _commit(studies)
    m = next(x for x in by_id(build_catalog(studies), "02-disrnn-beta")["artifacts"]
             if x["path"].endswith("presplit.json"))["meta"]
    assert m["studies_git_sha"] is None and m["dispatcher_git_sha"] == "9" * 40


def test_titled_images_are_found_and_copied(studies, tmp_path):
    rep = studies / "studies/01-gru-alpha/analysis/reports/r1-curve.md"
    (studies / "studies/01-gru-alpha/analysis/titled.png").write_text("t")
    rep.write_text(rep.read_text() + '\n![t](../titled.png "A title")\n')
    _commit(studies)
    out = tmp_path / "data" / "catalog.json"
    main(["build", "--studies", str(studies), "--out", str(out), "--no-validate"])
    assert (tmp_path / "data/files/studies/01-gru-alpha/analysis/titled.png").exists()


def test_history_follows_a_basename_rename(studies):
    import subprocess
    d = studies / "studies/01-gru-alpha/analysis/reports"
    subprocess.run(["git", "-C", str(studies), "mv", str(d / "r1-curve.md"), str(d / "r1-scaling.md")], check=True)
    (d / "INDEX.md").write_text("[r1](r1-scaling.md)\n")
    _commit(studies, "rename r1")
    rep = d / "r1-scaling.md"
    rep.write_text(rep.read_text().replace("0.7154", "0.7160"))
    _commit(studies, "update r1")
    r = by_id(build_catalog(studies), "01-gru-alpha")["reports"][0]
    assert [v["subject"] for v in r["history"]] == ["update r1", "init"]


def test_history_limit_counts_versions_not_commits(studies, monkeypatch):
    import bfm_atlas.catalog as cat_mod
    monkeypatch.setattr(cat_mod, "HISTORY_LIMIT", 2)
    rep = studies / "studies/01-gru-alpha/analysis/reports/r1-curve.md"
    rep.write_text(rep.read_text().replace("0.7154", "0.7160"))
    _commit(studies, "v2")
    for i in range(5):                                   # prose-only commits
        rep.write_text(rep.read_text() + f"\nnote {i}\n")
        _commit(studies, f"prose {i}")
    rep.write_text(rep.read_text().replace("0.7160", "0.7170"))
    _commit(studies, "v3")
    h = by_id(build_catalog(studies), "01-gru-alpha")["reports"][0]["history"]
    assert [v["subject"] for v in h] == ["v3", "v2"]      # v2 attributed to its own commit


def test_root_scalar_pointer_is_empty(tmp_path):
    from bfm_atlas.catalog import _leaves
    assert _leaves(0.7174) == [("", 0.7174)]


def test_number_tokens():
    from bfm_atlas.catalog import NUMBER
    assert NUMBER.findall("best 0.7101. Then 1,234.5678 and v0.71.3 and (0.7154, −0.0118)") == \
        ["0.7101", "0.7154", "−0.0118"]


def test_artifact_cited_twice_is_one_candidate(studies):
    rep = studies / "studies/01-gru-alpha/analysis/reports/r1-curve.md"
    rep.write_text(rep.read_text().replace("  data: analysis/summary.json", "  data: analysis/summary.json\n  summary: analysis/summary.json"))
    _commit(studies)
    texts = {l["text"] for l in by_id(build_catalog(studies), "01-gru-alpha")["reports"][0]["result_blocks"][0]["number_links"]}
    assert {"0.7101", "0.7154"} <= texts


def test_one_decimal_values_are_tokens():
    from bfm_atlas.catalog import NUMBER
    assert NUMBER.findall("cost 123.4 s") == ["123.4"]


def test_launch_data_image_and_recovered_provenance(studies):
    """Launch records pass `data`/`image` through; a run-provenance freeze attaches to its groups."""
    rec_path = next((studies / "studies/01-gru-alpha/variants/base/launch_record").glob("*.json"))
    rec = json.loads(rec_path.read_text())
    rec["data"] = {"source": "snapshot", "config": "mice_snapshot", "snapshot": "20260603",
                   "uri": "s3://x/snapshots/20260603/", "manifest_sha256": "e" * 64}
    rec["image"] = {"platform": "beaker", "name": "img", "id": "01KIMAGE"}
    rec_path.write_text(json.dumps(rec))
    freeze = studies / "studies/01-gru-alpha/analysis/provenance/run_provenance.json"
    freeze.parent.mkdir(parents=True)
    freeze.write_text(json.dumps({
        "_meta": {"schema_version": 2, "kind": "freeze", "produced_by": "../util/freeze_run_provenance.py",
                  "wandb_groups": [GROUP], "sources": [{"type": "wandb_run", "id": "e/p/r1"}]},
        "recovered_at_pt": "2026-10-25T16:20:00-07:00",
        "groups": {GROUP: {"project": "e/p", "n_runs": 3, "revisions": {"wrapper": {"a" * 40: 3}},
                           "data": [{"source": "live", "snapshot": None, "n_runs": 3}],
                           "image": [{"platform": "beaker", "id": "01KOLD", "n_runs": 3}], "unrecovered": {}}}}))
    git(studies, "add", "-A")
    git(studies, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "provenance")
    cat = build_catalog(studies, validate=False)
    r = next(x for s in cat["studies"] for v in s["variants"] for x in v["launch_records"] if x["path"].endswith(rec_path.name))
    assert (r["data"]["snapshot"], r["image"]["id"]) == ("20260603", "01KIMAGE")
    got = cat["wandb_groups"][GROUP]["recovered"]
    assert got["artifact"].endswith("analysis/provenance/run_provenance.json")
    assert (got["n_runs"], got["data"][0]["source"], got["image"][0]["id"]) == (3, "live", "01KOLD")
    assert not list(Draft202012Validator(SCHEMA).iter_errors(cat))


def test_malformed_run_provenance_does_not_break_the_build(studies):
    freeze = studies / "studies/01-gru-alpha/analysis/provenance/run_provenance.json"
    freeze.parent.mkdir(parents=True)
    freeze.write_text(json.dumps({"_meta": {"schema_version": 2, "kind": "freeze", "wandb_groups": [GROUP]},
                                  "groups": [GROUP]}))
    git(studies, "add", "-A")
    git(studies, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "bad freeze")
    assert build_catalog(studies, validate=False)["wandb_groups"][GROUP]["recovered"] is None



def test_study_and_report_tags_and_their_vocabulary(studies):
    (studies / "schemas").mkdir(exist_ok=True)
    (studies / "schemas/tags.yaml").write_text("""schema_version: 1
facets:
  model:
    label: Model
    values:
      gru: {label: GRU, description: Gated recurrent unit}
      cognitive/bh: {label: Cognitive › BH}
""")
    readme = studies / "studies/03-gru-gamma/README.md"
    readme.parent.mkdir(parents=True)
    readme.write_text("""---
schema_version: 1
id: 03-gru-gamma
question: Does gamma follow from alpha and beta?
status: planned
wandb: {entity: AIND-disRNN, project: gamma}
motivated_by: []
tags: {model: [gru, cognitive/bh], question: [scaling]}
---
# Study: gamma
""")
    git(studies, "add", "-A")
    git(studies, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "tags")
    cat = build_catalog(studies, validate=False)
    assert by_id(cat, "03-gru-gamma")["cover"]["tags"] == {"model": ["gru", "cognitive/bh"], "question": ["scaling"]}
    assert by_id(cat, "01-gru-alpha")["cover"]["tags"] is None                 # not declared
    assert cat["tags"]["model"]["values"]["gru"] == {"label": "GRU", "description": "Gated recurrent unit"}
    assert cat["tags"]["model"]["values"]["cognitive/bh"]["description"] is None
    assert list(Draft202012Validator(SCHEMA).iter_errors(cat)) == []


def test_an_untracked_vocabulary_is_not_read(studies):
    (studies / "schemas").mkdir(exist_ok=True)
    (studies / "schemas/tags.yaml").write_text("facets: {model: {label: Model, values: {gru: {label: GRU}}}}\n")
    assert build_catalog(studies, validate=False, allow_dirty=True)["tags"] is None


# --- About page: the framework model ------------------------------------------------------------
from bfm_atlas.framework import OBJECTS, SKILLS, FrameworkError  # noqa: E402


def add_framework_sources(root: Path, drop_term: str | None = None) -> None:
    """A CONTEXT.md defining every modelled term, the launch-record schema the field objects name,
    a schemas README, an ADR, and checker rule ids; committed."""
    terms = [o["term"] for o in OBJECTS.values() if "term" in o and o["term"] != drop_term]
    (root / "CONTEXT.md").write_text("# glossary\n\n## Language\n\n" + "".join(
        f"**{t}**:\nWhat {t.lower()} means.\n_Avoid_: something else\n\n" for t in terms))
    (root / "schemas").mkdir(exist_ok=True)
    (root / "schemas/launch-record.v2.schema.json").write_text(json.dumps({
        "required": ["kind", "manifests"], "properties": {
            "kind": {"description": "initial or an intervention"},
            "manifests": {"description": "Variant-relative paths of the submitted manifests."},
            "revisions": {"description": "Commit per repository."},
            "image": {"description": "The environment the code ran in."},
            "data": {"description": "What the runs trained and were evaluated on."}}}))
    (root / "schemas/provenance-baseline.json").write_text(json.dumps({"_comment": "x", "findings": ["a", "b"]}))
    (root / "schemas/README.md").write_text("| File | Governs |\n|---|---|\n"
                                           "| `launch-record.v2.schema.json` | `variants/<v>/launch_record/*.json` |\n")
    (root / "docs/adr").mkdir(parents=True, exist_ok=True)
    (root / "docs/adr/0001-one-launch.md").write_text("# One launch mints one group\n\nA launch mints one W&B group.\n\nMore.\n")
    (root / "scripts/check_provenance.py").write_text(
        (root / "scripts/check_provenance.py").read_text() + '\nRULES = ["record-manifest-missing", "report-upstream-stale"]\n')
    git(root, "add", "-A")
    git(root, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "framework sources")


def make_skills(root: Path) -> Path:
    for name, desc in (("study-conventions", "Organize studies."), ("my-new-skill", "Not yet classified.")):
        p = root / "pack/skills" / name / "SKILL.md"
        p.parent.mkdir(parents=True)
        p.write_text(f"---\nname: {name}\ndescription: {desc}\n---\n\n# {name}\n\n## Hard rules first\n\n1. x\n")
    git(root, "init", "-q")
    git(root, "add", "-A")
    git(root, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "skills")
    return root / "pack"


def test_framework_is_unavailable_without_a_context_file(studies):
    fw = build_catalog(studies, validate=False)["framework"]
    assert fw == {"available": False, "error": "the studies checkout has no CONTEXT.md"}


def test_framework_is_filled_in_from_the_sources(studies, tmp_path):
    add_framework_sources(studies)
    pack = make_skills(tmp_path / "dispatcher")
    cat = build_catalog(studies, validate=False, skills_dir=pack)
    fw = cat["framework"]
    objs = {o["id"]: o for o in fw["objects"]}
    assert set(objs) == set(OBJECTS)
    assert objs["launch"]["definition"] == "What launch means." and objs["launch"]["avoid"] == "something else"
    assert objs["data"]["kind"] == "field" and objs["data"]["definition"] == "What the runs trained and were evaluated on."
    assert objs["manifests"]["checks"] == ["record-manifest-missing"]       # by prefix, from the checker's source
    assert "report-upstream-stale" in objs["upstream"]["checks"]
    lr = next(s for s in fw["schemas"] if s["file"] == "launch-record.v2.schema.json")
    assert lr["governs"] == "`variants/<v>/launch_record/*.json`"
    assert {"name": "manifests", "required": True, "description": "Variant-relative paths of the submitted manifests."} in lr["fields"]
    assert next(s for s in fw["schemas"] if s["file"] == "provenance-baseline.json")["entries"] == 2
    assert fw["adrs"] == [{"path": "docs/adr/0001-one-launch.md", "title": "One launch mints one group",
                           "summary": "A launch mints one W&B group."}]
    skills = {s["name"]: s for s in fw["skills"]}
    assert skills["study-conventions"]["level"] == SKILLS["study-conventions"]["level"]
    assert skills["study-conventions"]["path"] == "pack/skills/study-conventions/SKILL.md"
    assert skills["study-conventions"]["headings"] == ["Hard rules first"]
    assert skills["my-new-skill"]["level"] is None                           # shown, marked unclassified
    sha = cat["_meta"]["dispatcher_git_sha"]
    assert sha and len(sha) == 40 and fw["sources"]["dispatcher"]["sha"] == sha
    assert list(Draft202012Validator(SCHEMA).iter_errors(cat)) == []


def test_framework_without_skills_says_so(studies):
    add_framework_sources(studies)
    cat = build_catalog(studies, validate=False)
    assert cat["framework"]["skills"] is None and "--skills" in cat["framework"]["skills_error"]
    assert cat["_meta"]["dispatcher_git_sha"] is None


def test_a_modelled_term_missing_from_context_fails_the_build(studies):
    add_framework_sources(studies, drop_term="Freeze")
    with pytest.raises(FrameworkError, match="Freeze"):
        build_catalog(studies, validate=False)


def test_cli_build_with_skills(studies, tmp_path, capsys):
    add_framework_sources(studies)
    pack = make_skills(tmp_path / "dispatcher")
    out = tmp_path / "data" / "catalog.json"
    assert main(["build", "--studies", str(studies), "--out", str(out), "--no-validate", "--skills", str(pack)]) == 0
    assert len(json.loads(out.read_text())["framework"]["skills"]) == 2


def test_skills_are_read_from_the_dispatcher_commit_only(studies, tmp_path):
    add_framework_sources(studies)
    pack = make_skills(tmp_path / "dispatcher")
    (pack / "skills/local-draft").mkdir()
    (pack / "skills/local-draft/SKILL.md").write_text("---\nname: local-draft\ndescription: untracked\n---\n")
    git(tmp_path / "dispatcher", "remote", "add", "origin", "git@github.com:Example/dispatcher.git")
    fw = build_catalog(studies, validate=False, skills_dir=pack)["framework"]
    assert "local-draft" not in {s["name"] for s in fw["skills"]}      # not in the recorded commit
    assert fw["sources"]["dispatcher"]["remote"] == "https://github.com/Example/dispatcher"
    assert fw["sources"]["dispatcher"]["dirty"] is True                  # and the checkout says so


@pytest.mark.parametrize("remote, url", [
    ("git@github.com:Org/repo.git", "https://github.com/Org/repo"),
    ("ssh://git@github.com/Org/repo.git", "https://github.com/Org/repo"),
    ("ssh://git@github.com:22/Org/repo", "https://github.com/Org/repo"),
    ("https://user:token@github.com/Org/repo.git", "https://github.com/Org/repo"),
    ("https://github.com/Org/repo", "https://github.com/Org/repo"),
    ("/local/path/repo", None),
    (None, None),
])
def test_remotes_become_web_urls(remote, url):
    from bfm_atlas.framework import web_url
    assert web_url(remote) == url


def test_a_locally_edited_skill_publishes_its_committed_text(studies, tmp_path):
    add_framework_sources(studies)
    pack = make_skills(tmp_path / "dispatcher")
    (pack / "skills/study-conventions/SKILL.md").write_text("---\nname: study-conventions\ndescription: local edit\n---\n")
    fw = build_catalog(studies, validate=False, skills_dir=pack)["framework"]
    skill = next(s for s in fw["skills"] if s["name"] == "study-conventions")
    assert skill["description"] == "Organize studies." and skill["headings"] == ["Hard rules first"]
    assert fw["sources"]["dispatcher"]["dirty"] is True
