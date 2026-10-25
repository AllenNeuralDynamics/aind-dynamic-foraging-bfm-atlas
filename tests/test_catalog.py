import json
from pathlib import Path

from jsonschema import Draft202012Validator

import pytest

from bfm_atlas.catalog import DirtyCheckoutError, build_catalog
from bfm_atlas.cli import main
from conftest import GROUP, SHA, make_studies

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


def test_dependencies_upstream_corrects_citation(studies):
    deps = {(d["from"], d["to"], d["kind"]) for d in build_catalog(studies)["dependencies"]}
    assert ("02-disrnn-beta", "01-gru-alpha", "upstream") in deps
    assert ("02-disrnn-beta", "01-gru-alpha", "corrects") in deps
    assert ("02-disrnn-beta", "01-gru-alpha", "citation") in deps


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
