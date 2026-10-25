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
