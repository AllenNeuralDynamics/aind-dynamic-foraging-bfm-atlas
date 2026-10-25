"""A small studies-shaped git repository for catalog tests."""
import json
import subprocess
import textwrap
from pathlib import Path

import pytest

SHA = "a" * 40
GROUP = "base@20261024-101500"

FAKE_CHECKER = textwrap.dedent("""\
    import json, sys
    json.dump({"findings": [{"level": "warn", "check": "artifact-meta-v1",
                             "path": "studies/02-disrnn-beta/analysis/old.json", "item": "",
                             "message": "_meta is v1", "key": "k", "fix": "migrate"}],
               "new": [], "fixed": [], "baseline_grown": [], "baseline_size": 1}, sys.stdout)
    sys.exit(0)
    """)


def write(root: Path, rel: str, text: str) -> None:
    p = root / rel
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_text(text)


def git(root: Path, *args: str) -> None:
    subprocess.run(["git", "-C", str(root), *args], check=True, capture_output=True)


def make_studies(root: Path, checker: bool = True) -> Path:
    a = "studies/01-gru-alpha"
    write(root, f"{a}/README.md", textwrap.dedent("""\
        ---
        schema_version: 1
        id: 01-gru-alpha
        question: Does alpha scale with mice?
        status: complete
        wandb: {entity: AIND-disRNN, project: alpha}
        verdict: Yes, and it saturates.
        ---
        # Study: alpha
        """))
    write(root, f"{a}/variants/base/notes.md", "# base\n")
    write(root, f"{a}/variants/base/sweep.yaml", "name: base\n")
    write(root, f"{a}/variants/base/launch_record/beaker.json", json.dumps({
        "_meta": {"schema_version": 2, "produced_by": "launch_beaker_resumable.py",
                  "produced_at_pt": "2026-10-24T10:15:00-07:00"},
        "kind": "initial", "platform": "beaker", "wandb_group": GROUP, "label": "base",
        "note": "baseline launch for alpha", "n_tasks": 3,
        "job_refs": [{"type": "beaker_experiment", "id": "01KEXAMPLE"}],
        "revisions": {"studies": SHA, "dispatcher": "b" * 40, "wrapper": "c" * 40},
        "manifests": ["sweep.yaml"]}))
    write(root, f"{a}/variants/base/launch_record/experiment_submitted.yaml",
          f"description: {GROUP} submitted\n")
    write(root, f"{a}/analysis/fig.png", "png")
    write(root, f"{a}/analysis/summary.json", json.dumps({
        "_meta": {"schema_version": 2, "kind": "producer", "produced_by": "analysis/produce.py",
                  "produced_at_pt": "2026-10-24T11:00:00-07:00", "studies_git_sha": SHA,
                  "wandb_groups": [GROUP],
                  "code": [{"path": f"{a}/analysis/produce.py", "sha256": "1" * 64}],
                  "inputs": [{"path": f"{a}/analysis/grid.csv", "sha256": "2" * 64}],
                  "outputs": [{"path": f"{a}/analysis/summary.json", "sha256": "3" * 64}]},
        "by_d": {"10": 0.7101, "614": 0.7154}}))
    write(root, f"{a}/analysis/reports/INDEX.md", "[r1](r1-curve.md)\n")
    write(root, f"{a}/analysis/reports/r1-curve.md", textwrap.dedent(f"""\
        ---
        schema_version: 1
        id: r1
        slug: curve
        status: live
        authors: [han]
        wandb_groups: [{GROUP}]
        inputs:
          data: analysis/summary.json
          figure: analysis/fig.png
        reproduce: make -C {a} r1
        ---
        # r1 — the curve

        ![curve](../fig.png)

        <!-- BEGIN result-1 -->
        | D | 10 | 614 |
        |---|---|---|
        | alpha | 0.7101 | 0.7154 |
        <!-- END result-1 -->
        """))
    b = "studies/02-disrnn-beta"
    write(root, f"{b}/README.md", textwrap.dedent("""\
        # Study: beta

        *W&B project [`beta`](https://wandb.ai/AIND-disRNN/beta).*

        **Question.** Does beta match
        alpha?

        Builds on [alpha](../01-gru-alpha/README.md).
        """))
    write(root, f"{b}/variants/old/notes.md", "# old\n")
    write(root, f"{b}/variants/old/launch_record/beaker_resumable.json", json.dumps({
        "mode": "resumable-grid", "experiment_id": "01KOLD", "dispatcher_commit": "d" * 40,
        "created_utc": "2026-07-13T07:34:38+00:00", "n_tasks": 2}))
    write(root, f"{b}/analysis/old.json", json.dumps({"_meta": {"produced_by": "x.py",
                                                               "wandb_groups": ["old@20260713-003428"]}}))
    write(root, f"{b}/analysis/reports/r1-compare.md", textwrap.dedent("""\
        ---
        id: r1
        slug: compare
        status: live
        authors: [han]
        wandb_groups: []
        inputs: {data: analysis/old.json}
        upstream: [{study: 01-gru-alpha, report: r1}]
        corrects: [{study: 01-gru-alpha, report: r1, note: saturation is later}]
        reproduce: make -C studies/02-disrnn-beta r1
        ---
        # r1 — compare

        See [alpha r1](../../../01-gru-alpha/analysis/reports/r1-curve.md).
        """))
    if checker:
        write(root, "scripts/check_provenance.py", FAKE_CHECKER)
    git(root, "init", "-q")
    git(root, "remote", "add", "origin", "https://user:secret@github.com/example/studies.git")
    git(root, "add", "-A")
    git(root, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "init")
    return root


@pytest.fixture
def studies(tmp_path: Path) -> Path:
    return make_studies(tmp_path / "studies")
