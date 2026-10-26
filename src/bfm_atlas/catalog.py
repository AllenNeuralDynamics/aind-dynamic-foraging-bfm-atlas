"""Compile a studies checkout into one provenance catalog.

The studies repo encodes a provenance graph through files whose shape is fixed by its
``schemas/`` directory:

    study README (frontmatter) -> variant -> launch_record/*.json -> analysis/*.json (_meta)
        -> analysis/reports/rN-<slug>.md (frontmatter, result blocks) -> figures

``build_catalog`` walks a checkout and assembles that graph, reading only committed files (no
W&B, no Beaker), so the catalog is a pure function of the studies SHA. Field names follow the
studies schemas; vocabulary follows the studies ``CONTEXT.md``.

Provenance *checking* is not done here. The studies repo's ``scripts/check_provenance.py`` is
the one implementation of the rules; the catalog embeds its ``--format json`` output so the
atlas shows exactly the findings that gate a studies PR.

Older files predate the schemas, so parsing is tolerant: a missing field is recorded as
missing, never guessed.
"""
from __future__ import annotations

import datetime
import hashlib
import json
import re
import subprocess
import sys
from pathlib import Path
from typing import Any
from zoneinfo import ZoneInfo

import yaml

CATALOG_SCHEMA_VERSION = 1
PT = ZoneInfo("America/Los_Angeles")

STUDY_DIR = re.compile(r"^(\d{2})-([a-z0-9]+)-(.+)$")
REPORT_FILE = re.compile(r"^r(\d+)-([a-z0-9-]+)\.md$")
FULL_SHA = re.compile(r"^[0-9a-f]{40}$")
# <variant>@<launch_id>; some legacy groups carry a suffix after the launch id ("...-hpc").
GROUP = re.compile(r"\b([A-Za-z0-9][\w.-]*@\d{8}-\d{6}(?:-[A-Za-z0-9]+)*)\b")
FRONTMATTER = re.compile(r"\A---\n(.*?)\n---\n", re.S)
RESULT_BLOCK = re.compile(r"<!-- BEGIN ([\w.-]+) -->\n?(.*?)<!-- END \1 -->", re.S)
# ![alt](src) or ![alt](<src> "optional title")
MD_IMAGE = re.compile(r"!\[([^\]]*)\]\(<?([^)\s>]+)>?(?:\s+[\"'(][^)]*)?\)")
MD_LINK = re.compile(r"(?<!!)\[[^\]]*\]\(([^)\s#]+)(?:#[^)]*)?\)")
WANDB_PROJECT = re.compile(r"https://wandb\.ai/([\w.-]+)/([\w.-]+)")
H1 = re.compile(r"^#\s+(.+?)\s*$", re.M)
QUESTION = re.compile(r"\*\*Question\.?\*\*\.?\s*(.+?)(?:\n\s*\n|\Z)", re.S)
REPOS = ("studies", "dispatcher", "wrapper", "foraging_models")
# Legacy launch-record keys per repo, newest first (mirrors studies/util/_meta.py).
LEGACY_SHA_KEYS = {
    "studies": ("studies_git_commit", "studies_commit"),
    "dispatcher": ("dispatcher_git_commit", "dispatcher_commit"),
    "wrapper": ("wrapper_git_commit", "wrapper_commit"),
    "foraging_models": ("foraging_models_git_commit", "foraging_models_commit"),
}


def _git(repo: Path, *args: str) -> str | None:
    try:
        out = subprocess.run(["git", "-C", str(repo), *args], capture_output=True, text=True,
                             check=True)
    except (OSError, subprocess.CalledProcessError):
        return None
    return out.stdout.strip() or None


def _sha256(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def _rel(path: Path, root: Path) -> str:
    return path.resolve().relative_to(root.resolve()).as_posix()


def _load_json(path: Path) -> tuple[Any, str | None]:
    try:
        return json.loads(path.read_text()), None
    except (OSError, UnicodeDecodeError, json.JSONDecodeError) as e:
        return None, f"{type(e).__name__}: {e}"


def _frontmatter(text: str) -> tuple[dict | None, str, str | None]:
    """(frontmatter or None, body, parse error)."""
    m = FRONTMATTER.match(text)
    if not m:
        return None, text, None
    try:
        fm = yaml.safe_load(m.group(1))
    except yaml.YAMLError as e:
        return None, text[m.end():], f"YAML error: {e}"
    return (fm if isinstance(fm, dict) else None), text[m.end():], None


def _groups_in(obj: Any) -> set[str]:
    """Every string that looks like a W&B group, anywhere in a parsed JSON value."""
    if isinstance(obj, str):
        return set(GROUP.findall(obj))
    if isinstance(obj, dict):
        return set().union(*(_groups_in(k) | _groups_in(v) for k, v in obj.items())) if obj else set()
    if isinstance(obj, list):
        return set().union(*(_groups_in(v) for v in obj)) if obj else set()
    return set()


def _jsonable(v: Any) -> Any:
    """YAML can produce dates; the catalog is JSON."""
    if isinstance(v, (datetime.date, datetime.datetime)):
        return v.isoformat()
    if isinstance(v, dict):
        return {str(k): _jsonable(x) for k, x in v.items()}
    if isinstance(v, list):
        return [_jsonable(x) for x in v]
    return v


# --- launch records ---------------------------------------------------------------------------
def _revisions(d: dict) -> dict[str, str]:
    """Repo -> SHA. v2 records carry `revisions`; older ones use per-repo keys."""
    out: dict[str, str] = {}
    rev = d.get("revisions")
    if isinstance(rev, dict):
        out.update({k: v for k, v in rev.items() if k in REPOS and isinstance(v, str)})
    launch = d.get("launch")
    if isinstance(launch, dict) and isinstance(launch.get("revisions"), dict):
        for repo, aliases in LEGACY_SHA_KEYS.items():
            for a in (repo, *aliases):
                v = launch["revisions"].get(a)
                if isinstance(v, str):
                    out.setdefault(repo, v)
    for repo, aliases in LEGACY_SHA_KEYS.items():
        for a in aliases:
            v = d.get(a)
            if isinstance(v, str):
                out.setdefault(repo, v)
        # `<repo>_ref` may be a branch; only a full SHA pins the code
        ref = d.get(f"{repo}_ref")
        if isinstance(ref, str) and FULL_SHA.fullmatch(ref):
            out.setdefault(repo, ref)
    return out


def _note(d: dict) -> str | None:
    """Why the launch exists: the launcher --note (top level, or a legacy record's nested
    `launch.note`), a legacy `purpose`, and only then an intervention's trigger symptom."""
    launch = d.get("launch") if isinstance(d.get("launch"), dict) else {}
    for v in (d.get("note"), launch.get("note"), d.get("purpose")):
        if isinstance(v, str):
            return v
    t = d.get("trigger")
    if isinstance(t, dict) and isinstance(t.get("symptom"), str):
        return t["symptom"]
    return t if isinstance(t, str) else None


def _wandb_project(d: Any) -> dict | None:
    """{entity, project} a record or W&B sweep manifest names for its runs, if any."""
    if not isinstance(d, dict):
        return None
    launch = d.get("launch") if isinstance(d.get("launch"), dict) else {}
    nested = launch.get("wandb") if isinstance(launch.get("wandb"), dict) else {}
    for ent, proj in ((d.get("wandb_entity"), d.get("wandb_project")), (nested.get("entity"), nested.get("project")),
                      (d.get("entity"), d.get("project"))):
        if isinstance(ent, str) and isinstance(proj, str):
            return {"entity": ent, "project": proj}
    return None


RUN_PROVENANCE = "/analysis/provenance/run_provenance.json"   # studies/util/freeze_run_provenance.py


def _launch_record(path: Path, root: Path, variant: str | None) -> dict:
    rel = _rel(path, root)
    if path.suffix != ".json":
        text = path.read_text(errors="replace")
        try:
            parsed = yaml.safe_load(text)
        except yaml.YAMLError:
            parsed = None
        return {"path": rel, "format": path.suffix.lstrip("."), "schema_version": None,
                "wandb_groups": sorted(set(GROUP.findall(text))), "wandb": _wandb_project(parsed),
                "sha256": _sha256(path)}
    d, err = _load_json(path)
    if err or not isinstance(d, dict):
        return {"path": rel, "format": "json", "schema_version": None,
                "error": err or "top level is not an object", "wandb_groups": [], "sha256": _sha256(path)}
    meta = d.get("_meta") if isinstance(d.get("_meta"), dict) else {}
    v2 = meta.get("schema_version") == 2
    # an explicit group name wins; scanning the record is the fallback for older shapes
    groups = [d["wandb_group"]] if isinstance(d.get("wandb_group"), str) else sorted(_groups_in(d))
    job_refs = d.get("job_refs") if isinstance(d.get("job_refs"), list) else []
    if not job_refs:
        for key, kind in (("experiment_id", "beaker_experiment"), ("sweep_id", "wandb_sweep"),
                          ("slurm_array_job_id", "slurm_array_job"), ("slurm_job_id", "slurm_job")):
            if isinstance(d.get(key), (str, int)) and not isinstance(d.get(key), bool):
                job_refs.append({"type": kind, "id": str(d[key])})
    platform = d.get("platform") or ("beaker" if "experiment_id" in d else
                                     "hpc" if {"slurm_job_id", "slurm_array_job_id", "sweep_id"} & d.keys() else None)
    return {
        "path": rel, "format": "json",
        "schema_version": 2 if v2 else 1,
        "kind": d.get("kind") or ("initial" if d.get("mode") else None),
        "platform": platform,
        "manifests": [m for m in d.get("manifests") or [] if isinstance(m, str)],
        "wandb_groups": groups,
        "own_group": any(g.split("@")[0] == variant for g in groups),
        "wandb": _wandb_project(d),
        "label": d.get("label"),
        "note": _note(d),
        "job_refs": [r for r in job_refs if isinstance(r, dict)],
        "experiment_url": d.get("experiment_url"),
        "revisions": _revisions(d),
        "time": d.get("created_utc") or d.get("submitted_at") or meta.get("produced_at_pt"),
        "n_tasks": d.get("n_tasks") if isinstance(d.get("n_tasks"), int) else None,
        "supersedes": d.get("supersedes") if isinstance(d.get("supersedes"), list) else [],
        "deviations": d.get("deviations") if isinstance(d.get("deviations"), dict) else {},
        # what the runs trained on and ran in, recorded at launch (studies#25)
        "data": d.get("data") if isinstance(d.get("data"), dict) else None,
        "image": d.get("image") if isinstance(d.get("image"), dict) else None,
        "sha256": _sha256(path),
    }


# --- reports ------------------------------------------------------------------------------------
def _resolve(study_dir: Path, root: Path, item: str, ok: "_Tracked") -> tuple[str, bool]:
    """A frontmatter path: repo-relative when it starts with studies/, else study-relative."""
    target = (root / item) if item.startswith("studies/") else (study_dir / item)
    if ok(target) or (target.is_dir() and ok.paths is not None
                      and any(x.startswith(_rel(target, root) + "/") for x in ok.paths)):
        return _rel(target, root), True
    return (item if item.startswith("studies/") else f"{_rel(study_dir, root)}/{item}"), False


def _link_targets(text: str, here: Path, root: Path) -> list[str]:
    """Repo-relative targets of the markdown file's relative links."""
    out = []
    for target in MD_LINK.findall(text):
        if "://" in target or target.startswith("mailto:"):
            continue
        try:
            out.append((here.parent / target).resolve().relative_to(root.resolve()).as_posix())
        except ValueError:
            continue
    return out


def _study_of(path: str, study_ids: set[str]) -> str | None:
    parts = path.split("/")
    return parts[1] if len(parts) >= 2 and parts[0] == "studies" and parts[1] in study_ids else None


def _report(path: Path, study_dir: Path, root: Path, study_ids: set[str], ok: "_Tracked") -> dict:
    text = path.read_text(errors="replace")
    fm, body, fm_error = _frontmatter(text)
    f = fm or {}
    m = REPORT_FILE.match(path.name)
    h1 = H1.search(body)
    inputs = []
    raw_inputs = f.get("inputs")
    for role, val in (raw_inputs.items() if isinstance(raw_inputs, dict) else
                      enumerate(raw_inputs) if isinstance(raw_inputs, list) else []):
        for item in val if isinstance(val, list) else [val]:
            if isinstance(item, str):
                p, exists = _resolve(study_dir, root, item, ok)
                inputs.append({"role": str(role), "path": p, "exists": exists})
    figures = []
    for alt, src in MD_IMAGE.findall(body):
        if "://" in src:
            continue
        target = (path.parent / src).resolve()
        try:
            figures.append({"alt": alt, "src": src, "path": target.relative_to(root.resolve()).as_posix(),
                            "exists": ok(target)})
        except ValueError:
            pass
    links = _link_targets(body, path, root)
    return {
        "path": _rel(path, root),
        "id": f.get("id") or (f"r{m.group(1)}" if m else path.stem),
        "slug": f.get("slug") or (m.group(2) if m else None),
        "title": h1.group(1) if h1 else path.stem,
        "status": f.get("status"),
        "authors": f.get("authors") if isinstance(f.get("authors"), list) else [],
        "issue": f.get("issue"),
        "has_frontmatter": fm is not None,
        "frontmatter_error": fm_error,
        "frontmatter": _jsonable(f),
        "wandb_groups": [g for g in f.get("wandb_groups") or [] if isinstance(g, str)],
        "inputs": inputs,
        "upstream": [u for u in f.get("upstream") or [] if isinstance(u, dict)],
        "corrects": [c for c in f.get("corrects") or [] if isinstance(c, dict)],
        "superseded_by": f.get("superseded_by") if isinstance(f.get("superseded_by"), dict) else None,
        "reproduce": f.get("reproduce") if isinstance(f.get("reproduce"), str) else None,
        "figures": figures,
        "result_blocks": [{"name": n, "markdown": b.strip("\n")} for n, b in RESULT_BLOCK.findall(body)],
        "cites": sorted({s for s in (_study_of(t, study_ids) for t in links) if s} - {study_dir.name}),
        "markdown": body,
        "sha256": _sha256(path),
    }


# --- analysis artifacts -------------------------------------------------------------------------
def _digests(v: Any) -> list[dict]:
    return [{"path": e["path"], "sha256": e.get("sha256")} for e in v or []
            if isinstance(e, dict) and isinstance(e.get("path"), str)]


def _artifact(path: Path, root: Path) -> dict:
    d, err = _load_json(path)
    meta = d.get("_meta") if isinstance(d, dict) and isinstance(d.get("_meta"), dict) else None
    entry: dict[str, Any] = {"path": _rel(path, root), "sha256": _sha256(path),
                             "bytes": path.stat().st_size, "parse_error": err, "meta": None}
    if meta is None:
        return entry
    groups = [g for g in meta.get("wandb_groups") or [] if isinstance(g, str)]
    if not groups and isinstance(meta.get("wandb_group"), str):
        groups = [meta["wandb_group"]]
    entry["meta"] = {
        "schema_version": 2 if meta.get("schema_version") == 2 else 1,
        # v1 _meta has no kind; recognise a freeze by its producer's name as the checker does,
        # and otherwise leave it unknown rather than guess "producer"
        "kind": meta.get("kind") if meta.get("kind") in ("producer", "freeze") else (
            "freeze" if str(meta.get("produced_by") or meta.get("producer") or "").split("/")[-1].startswith("freeze")
            else None),
        "produced_by": meta.get("produced_by") or meta.get("producer"),
        "produced_at_pt": meta.get("produced_at_pt") or meta.get("recorded_at_pt"),
        # Producers before the studies/dispatcher split recorded their checkout as
        # dispatcher_git_sha: keep each SHA with its own repository, never relabel it.
        "studies_git_sha": meta.get("studies_git_sha"),
        "dispatcher_git_sha": meta.get("dispatcher_git_sha"),
        "wrapper_git_sha": meta.get("wrapper_git_sha"),
        "wandb_groups": groups,
        "source_git_shas": {repo: meta[f"source_{repo}_git_shas"] for repo in REPOS
                            if isinstance(meta.get(f"source_{repo}_git_shas"), list)},
        "code": _digests(meta.get("code")),
        "inputs": _digests(meta.get("inputs")),
        "outputs": _digests(meta.get("outputs")),
        "sources": [s for s in meta.get("sources") or [] if isinstance(s, dict)],
        "provenance_findings": [x for x in meta.get("provenance_findings") or [] if isinstance(x, str)],
    }
    return entry


# --- studies ------------------------------------------------------------------------------------
def _makefile_targets(path: Path) -> list[str]:
    if not path.exists():
        return []
    lines = re.findall(r"^([A-Za-z0-9][\w.-]*(?:\s+[A-Za-z0-9][\w.-]*)*)\s*:(?!=)",
                       path.read_text(errors="replace"), re.M)
    return sorted({t for line in lines for t in line.split()})


def _cover(fm: dict | None, readme: str) -> dict:
    """Study cover from README frontmatter (schemas/study-frontmatter.v1), else parsed prose."""
    if fm is not None:
        w = fm.get("wandb") if isinstance(fm.get("wandb"), dict) else None
        motivated = fm.get("motivated_by") if isinstance(fm.get("motivated_by"), list) else None
        return {"source": "frontmatter", "question": fm.get("question"), "status": fm.get("status"),
                "verdict": fm.get("verdict"), "superseded_by": fm.get("superseded_by"),
                "issues": fm.get("issues") or [],
                # None: not declared (a pre-Motivation study); []: a root study
                "motivated_by": None if motivated is None else [m for m in motivated if isinstance(m, dict)],
                "wandb": {"entity": w.get("entity"), "project": w.get("project")} if w else None}
    q, proj = QUESTION.search(readme), WANDB_PROJECT.search(readme)
    return {"source": "readme", "question": " ".join(q.group(1).split()) if q else None,
            "status": None, "verdict": None, "superseded_by": None, "issues": [], "motivated_by": None,
            "wandb": {"entity": proj.group(1), "project": proj.group(2)} if proj else None}


class _Tracked:
    """Which files the catalog may read: those git tracks, or every file when there is no git.

    An ignored file never shows up in `git status`, so the clean-checkout guard cannot see it;
    reading only tracked paths keeps ignored drafts out of a catalog labelled with a commit.
    """

    def __init__(self, root: Path):
        self.root = root
        out = _git(root, "ls-files")
        self.paths = set(out.splitlines()) if out is not None else None

    def __call__(self, p: Path) -> bool:
        if not p.is_file():
            return False
        return self.paths is None or _rel(p, self.root) in self.paths

    def has_under(self, d: Path) -> bool:
        """Whether a directory holds any tracked file (an ignored directory does not)."""
        if self.paths is None:
            return d.is_dir()
        prefix = _rel(d, self.root) + "/"
        return any(x.startswith(prefix) for x in self.paths)


RECORD_KEYS = {"experiment_id", "dispatcher_commit", "sweep_id", "mode", "wandb_group", "job_refs"}


def _is_root_record(p: Path) -> bool:
    """A legacy launch record committed at a study root (study 01 has several)."""
    if p.suffix == ".json":
        d, err = _load_json(p)
        return not err and isinstance(d, dict) and "_meta" not in d and bool(RECORD_KEYS & d.keys())
    return p.suffix in (".yaml", ".yml") and bool(GROUP.search(p.read_text(errors="replace")))


def _study(study_dir: Path, root: Path, study_ids: set[str], ok: _Tracked) -> dict:
    m = STUDY_DIR.match(study_dir.name)
    readme_path = study_dir / "README.md"
    text = readme_path.read_text(errors="replace") if ok(readme_path) else ""
    fm, body, _ = _frontmatter(text)
    h1 = H1.search(body)

    variants = []
    for vdir in sorted(p for p in (study_dir / "variants").glob("*")
                       if p.is_dir() and p.name != "__pycache__" and ok.has_under(p)):
        notes = vdir / "notes.md"
        files = sorted(p for d in vdir.glob("launch_record*") if d.is_dir() for p in d.rglob("*")
                       if ok(p) and p.suffix in (".json", ".yaml", ".yml"))
        records = [_launch_record(p, root, vdir.name) for p in files]
        own = sorted({g for r in records if r["format"] == "json" for g in r["wandb_groups"]
                      if g.split("@")[0] == vdir.name})
        variants.append({
            "name": vdir.name,
            "path": _rel(vdir, root),
            "notes": notes.read_text(errors="replace") if ok(notes) else None,
            "manifests": sorted(_rel(p, root) for p in vdir.glob("*.y*ml") if ok(p)),
            "launch_records": records,
            "wandb_groups": own or sorted({g for r in records for g in r["wandb_groups"]}),
        })

    rdir = study_dir / "analysis" / "reports"
    reports = [_report(p, study_dir, root, study_ids, ok) for p in sorted(rdir.glob("*.md"), key=_report_order)
               if p.name != "INDEX.md" and ok(p)] if rdir.is_dir() else []
    index = rdir / "INDEX.md"
    # Legacy launch records misplaced at the study root still record launches; keep them, with
    # no variant, rather than lose their groups, Beaker IDs and commits.
    root_records = [_launch_record(p, root, None) for p in sorted(study_dir.iterdir())
                    if ok(p) and p.suffix in (".json", ".yaml", ".yml") and _is_root_record(p)]
    root_paths = {r["path"] for r in root_records}
    # Analysis artifacts: every tracked JSON under analysis/, plus tracked JSON elsewhere in the
    # study that carries a `_meta` block (e.g. reference/ inputs), never a launch record.
    artifacts = []
    for p in sorted(study_dir.rglob("*.json")):
        rel_parts = p.relative_to(study_dir).parts
        if not ok(p) or _rel(p, root) in root_paths or any(x.startswith("launch_record") for x in rel_parts):
            continue
        a = _artifact(p, root)
        if rel_parts[0] == "analysis" or a["meta"] is not None:
            artifacts.append(a)

    return {
        "id": study_dir.name,
        "number": int(m.group(1)) if m else None,
        "model": m.group(2) if m else None,
        "purpose": m.group(3) if m else None,
        "path": _rel(study_dir, root),
        "title": h1.group(1) if h1 else study_dir.name,
        "cover": _cover(fm, body),
        "readme": body,
        "reports_index": index.read_text(errors="replace") if ok(index) else None,
        "makefile_targets": _makefile_targets(study_dir / "Makefile") if ok(study_dir / "Makefile") else [],
        "variants": variants,
        "root_launch_records": root_records,
        "reports": reports,
        "artifacts": artifacts,
        "cites": sorted({s for s in (_study_of(t, study_ids) for t in _link_targets(body, readme_path, root)) if s}
                        - {study_dir.name}),
    }


def _report_order(p: Path) -> tuple:
    m = REPORT_FILE.match(p.name)
    return (int(m.group(1)), p.name) if m else (10**6, p.name)


# --- report history -----------------------------------------------------------------------------
HISTORY_LIMIT = 20


def _report_history(root: Path, rel: str) -> list[dict]:
    """Versions of a report's result blocks, newest first, one entry per commit that changed them.

    Built from `git log --follow --name-status`, which names the path each commit knew the file
    by, so versions before a rename (even one that changes the basename) are read. Prose-only
    commits are folded into the version they did not change, and the limit counts versions, so
    each stored SHA is the commit that introduced that version. A shallow clone yields fewer.
    """
    log = _git(root, "log", "--follow", "--name-status", "--format=%x1e%H%x1f%cI%x1f%s", "--", rel)
    out: list[dict] = []
    # _git() strips its output, and Python counts \x1e as whitespace, so the first separator may
    # be gone: split and drop empty chunks rather than skipping the first
    for chunk in (c for c in (log or "").split("\x1e") if c.strip()):
        lines = [x for x in chunk.splitlines() if x.strip()]
        sha, date, subject = lines[0].split("\x1f", 2)
        # "M\tpath", "A\tpath" or "R100\told\tnew": the last field is the path at this commit
        path = lines[1].split("\t")[-1] if len(lines) > 1 else rel
        text = _git(root, "show", f"{sha}:{path}")
        if text is None:
            continue
        blocks = {n: b.strip("\n") for n, b in RESULT_BLOCK.findall(text)}
        if out and out[-1]["blocks"] == blocks:
            out[-1].update(sha=sha, date=date, subject=subject)   # keep the commit that introduced it
            continue
        if len(out) == HISTORY_LIMIT:      # the oldest kept version is now complete
            break
        out.append({"sha": sha, "date": date, "subject": subject, "blocks": blocks})
    return out


# --- number links (click-a-number) -------------------------------------------------------------
# A displayed decimal (any number of places; "−" is the typographic minus) is linked to a JSON leaf only when exactly
# one leaf, across the JSON artifacts the block can be traced to, rounds to it at the displayed
# precision, and when that uniqueness is unlikely to be chance: the number must show at least
# MIN_SIG significant digits, and the searched leaves must be few next to 10**digits (a 2-digit
# "0.53" is unique in a 20k-leaf file by accident; a 4-digit "0.7174" in a 300-leaf summary is not).
MIN_SIG = 3
CHANCE = 0.05     # max expected chance matches: leaves / 10**significant_digits
# A whole decimal token: not the tail of a grouped number (1,234.5678) or of a dotted id, and
# allowed to end a sentence ("0.7101."). views.js uses the same pattern.
NUMBER = re.compile(r"(?<![\w.,])([-−]?\d+\.\d+)(?!\w|[.,]\d)")


def _leaves(obj: Any, pointer: str = "") -> list[tuple[str, float]]:
    """(JSON pointer, value) for every numeric leaf, skipping `_meta`."""
    if isinstance(obj, bool):
        return []
    if isinstance(obj, (int, float)):
        return [(pointer, float(obj))]          # "" is the JSON Pointer to the document root
    if isinstance(obj, dict):
        return [x for k, v in obj.items() if k != "_meta"
                for x in _leaves(v, f"{pointer}/{str(k).replace('~', '~0').replace('/', '~1')}")]
    if isinstance(obj, list):
        return [x for i, v in enumerate(obj) for x in _leaves(v, f"{pointer}/{i}")]
    return []


def _number_links(studies: list[dict], root: Path) -> None:
    """Attach `number_links` to every result block: displayed number -> the unique JSON leaf."""
    artifacts = {a["path"]: a for s in studies for a in s["artifacts"]}
    declared: dict[str, list[str]] = {}
    for a in artifacts.values():
        for o in (a["meta"] or {}).get("outputs", []):
            if "#" in o["path"]:
                declared.setdefault(o["path"], []).append(a["path"])
    leaf_cache: dict[str, list[tuple[str, float]]] = {}
    rounded: dict[tuple[str, int], dict[float, list[tuple[str, float]]]] = {}

    def leaves_of(p: str) -> list[tuple[str, float]]:
        if p not in leaf_cache:
            d, err = _load_json(root / p)
            leaf_cache[p] = [] if err else _leaves(d)
        return leaf_cache[p]

    def by_rounded(p: str, places: int) -> dict[float, list[tuple[str, float]]]:
        """Leaves of artifact p indexed by their value rounded to `places` (built once)."""
        key = (p, places)
        if key not in rounded:
            idx: dict[float, list[tuple[str, float]]] = {}
            for ptr, v in leaves_of(p):
                if v == v and abs(v) != float("inf"):          # skip NaN / inf
                    idx.setdefault(round(v, places), []).append((ptr, v))
            rounded[key] = idx
        return rounded[key]

    for s in studies:
        for r in s["reports"]:
            # an artifact cited under several roles is one candidate, not several
            inputs = list(dict.fromkeys(i["path"] for i in r["inputs"]
                                        if i["path"] in artifacts and i["path"].endswith(".json")))
            for b in r["result_blocks"]:
                sources = declared.get(f"{r['path']}#{b['name']}")
                how = "declared" if sources else "inputs"
                links = []
                cands = list(dict.fromkeys(sources or inputs))
                n_leaves = sum(len(leaves_of(p)) for p in cands)
                for text in sorted(set(NUMBER.findall(b["markdown"]))):
                    places = len(text.split(".")[1])
                    sig = len(text.replace("−", "").replace("-", "").replace(".", "").lstrip("0"))
                    if sig < MIN_SIG or n_leaves > CHANCE * 10 ** sig:
                        continue
                    want = float(text.replace("−", "-"))
                    hits = [(p, ptr, v) for p in cands for ptr, v in by_rounded(p, places).get(want, [])]
                    if len(hits) == 1:
                        p, ptr, v = hits[0]
                        links.append({"text": text, "artifact": p, "pointer": ptr, "value": v, "how": how})
                b["number_links"] = links


# --- validator ----------------------------------------------------------------------------------
def run_validator(root: Path, python: str = sys.executable) -> dict:
    """The studies checker's findings at this checkout (scripts/check_provenance.py --format json)."""
    root = root.resolve()
    script = root / "scripts" / "check_provenance.py"
    if not script.exists():
        return {"ran": False, "error": "scripts/check_provenance.py is not in this studies checkout",
                "findings": []}
    r = subprocess.run([python, str(script), "--format", "json"], cwd=root, capture_output=True, text=True)
    try:
        out = json.loads(r.stdout)
    except json.JSONDecodeError:
        return {"ran": False, "error": (r.stderr or r.stdout).strip()[-2000:] or f"exit {r.returncode}",
                "findings": []}
    # keep the checker's whole verdict (new, fixed, baseline_grown, ...), not just findings
    return {**out, "ran": True, "error": None, "exit_code": r.returncode,
            "findings": out.get("findings", [])}


# --- assembly -----------------------------------------------------------------------------------
class DirtyCheckoutError(RuntimeError):
    """The checkout differs from the commit the catalog would be labelled with."""


def build_catalog(studies_root: Path | str, validate: bool = True, allow_dirty: bool = False) -> dict:
    """Catalog for a studies checkout (the repository root, containing ``studies/``).

    The catalog is labelled with the checkout's HEAD, so by default the checkout must be
    clean: a modified or untracked file would put content in the catalog that the recorded
    SHA does not contain. ``allow_dirty`` builds anyway and records ``studies_git_dirty``.
    """
    root = Path(studies_root).resolve()      # the checker runs with cwd=root
    if not allow_dirty:
        if _git(root, "rev-parse", "HEAD") is None:
            raise DirtyCheckoutError(f"{root} is not a git checkout; pass allow_dirty to build anyway")
        status = _git(root, "status", "--porcelain", "--untracked-files=all")
        if status:
            raise DirtyCheckoutError(f"{root} has uncommitted or untracked files; commit or clean them "
                                     f"(or pass allow_dirty):\n{status[:2000]}")
    ok = _Tracked(root)
    dirs = sorted(p for p in (root / "studies").iterdir() if p.is_dir() and STUDY_DIR.match(p.name)
                  and (ok.paths is None or any(x.startswith(f"studies/{p.name}/") for x in ok.paths)))
    ids = {p.name for p in dirs}
    studies = [_study(p, root, ids, ok) for p in dirs]
    for s in studies:
        for r in s["reports"]:
            r["history"] = _report_history(root, r["path"])
    _number_links(studies, root)
    wandb = {s["id"]: s["cover"]["wandb"] for s in studies}

    groups: dict[str, dict] = {}

    def entry(g: str) -> dict:
        return groups.setdefault(g, {"group": g, "study": None, "variant": None, "url": None,
                                     "launch_records": [], "reports": [], "artifacts": [], "recovered": None})

    records: dict[str, dict] = {}
    for s in studies:
        owned = [(v["name"], r) for v in s["variants"] for r in v["launch_records"]]
        owned += [(None, r) for r in s["root_launch_records"]]
        for variant, r in owned:
            records[r["path"]] = r
            for g in r["wandb_groups"]:
                e = entry(g)
                e["launch_records"].append(r["path"])
                if e["study"] is None or (variant is not None and (g.split("@")[0] == variant or e["variant"] is None)):
                    e["study"], e["variant"] = s["id"], variant
        for r in s["reports"]:
            for g in r["wandb_groups"]:
                entry(g)["reports"].append(r["path"])
        for a in s["artifacts"]:
            for g in (a["meta"] or {}).get("wandb_groups", []):
                entry(g)["artifacts"].append(a["path"])
            # a run-provenance freeze recovers, after the fact, what a group's launches trained on
            # and ran in (studies#28); it stands in for launch records that predate those fields
            if a["path"].endswith(RUN_PROVENANCE) and (a["meta"] or {}).get("kind") == "freeze":
                body, err = _load_json(root / a["path"])
                groups_ = body.get("groups") if not err and isinstance(body, dict) else None
                for g, rec in groups_.items() if isinstance(groups_, dict) else []:   # other shapes: unavailable
                    if isinstance(rec, dict):
                        entry(g)["recovered"] = {"artifact": a["path"], "recovered_at_pt": body.get("recovered_at_pt"),
                                                 **{k: rec.get(k) for k in ("project", "n_runs", "data", "revisions",
                                                                            "image", "unrecovered")}}

    def manifest_project(r: dict) -> dict | None:
        """Project named by a v2 record's `manifests` (variant- or record-relative, tracked only)."""
        rec_dir = root / r["path"].rsplit("/", 1)[0]
        variant_dir = rec_dir
        while variant_dir.name and not variant_dir.name.startswith("launch_record"):
            variant_dir = variant_dir.parent
        for m in r.get("manifests") or []:
            for base in (variant_dir.parent, rec_dir):
                f = base / m
                if ok(f) and f.suffix in (".yaml", ".yml"):
                    try:
                        w = _wandb_project(yaml.safe_load(f.read_text()))
                    except yaml.YAMLError:
                        w = None
                    if w:
                        return w
        return None

    def project_for(e: dict) -> dict | None:
        """The W&B project a launch used: its records, the manifests they name, a sweep manifest
        beside them (a smoke launch may log to another project), and only then the study cover."""
        named = [records[p] for p in e["launch_records"]]
        dirs = {p.rsplit("/", 1)[0] for p in e["launch_records"]}
        beside = [r for r in records.values() if r["path"].rsplit("/", 1)[0] in dirs]
        for r in named:
            if r.get("wandb"):
                return r["wandb"]
        for r in named:
            w = manifest_project(r)
            if w:
                return w
        for r in beside:
            if r.get("wandb"):
                return r["wandb"]
        return wandb.get(e["study"]) if e["study"] else None

    for g, e in groups.items():
        for k in ("launch_records", "reports", "artifacts"):
            e[k] = sorted(set(e[k]))
        w = project_for(e)
        if w and w.get("entity") and w.get("project"):
            e["url"] = f"https://wandb.ai/{w['entity']}/{w['project']}/groups/{g}"

    # Relationships between studies (studies ADR 0002): motivation (why a study exists, from its
    # cover), upstream (a report uses another study's results), corrects and supersedes. A citation,
    # a plain link, is not a relationship and is not an edge. `report` is the declaring report (None
    # for a study's motivation); `to_report` is the target report key, `<study>/rN`, when named.
    deps = []
    edge = lambda f, t, kind, report, to_report=None, note=None: {
        "from": f, "to": t, "kind": kind, "report": report, "to_report": to_report, "note": note}
    for s in studies:
        for m in s["cover"].get("motivated_by") or []:
            if m.get("study") in ids:
                to = f"{m['study']}/{m['report']}" if m.get("report") else None
                deps.append(edge(s["id"], m["study"], "motivation", None, to, m.get("note")))
            elif "issue" in m:
                deps.append(edge(s["id"], f"issue:{m['issue']}", "motivation", None, None, m.get("note")))
        for r in s["reports"]:
            for u in r["upstream"]:
                if u.get("study") in ids and u["study"] != s["id"]:
                    to = f"{u['study']}/{u['report']}" if u.get("report") else None
                    deps.append(edge(s["id"], u["study"], "upstream", r["path"], to, u.get("note") or u.get("wandb_group")))
            for c in r["corrects"]:
                if c.get("study") in ids:
                    deps.append(edge(s["id"], c["study"], "corrects", r["path"], f"{c['study']}/{c.get('report')}", c.get("note")))
            sb = r.get("superseded_by")
            if sb and sb.get("study") in ids:
                deps.append(edge(sb["study"], s["id"], "supersedes", None, f"{s['id']}/{r['id']}"))
    seen, dependencies = set(), []
    for d in deps:
        key = (d["from"], d["to"], d["kind"], d["report"], d["to_report"])
        if key not in seen:
            seen.add(key)
            dependencies.append(d)

    sha = _git(root, "rev-parse", "HEAD")
    return {
        "_meta": {
            "schema_version": CATALOG_SCHEMA_VERSION,
            "built_at_pt": datetime.datetime.now(PT).isoformat(timespec="seconds"),
            "studies_git_sha": sha,
            "studies_git_dirty": None if sha is None else bool(_git(root, "status", "--porcelain", "--untracked-files=all")),
            "studies_commit_time": _git(root, "log", "-1", "--format=%cI"),
            # never publish credentials embedded in a remote URL
            "studies_remote": re.sub(r"//[^@/]+@", "//", _git(root, "remote", "get-url", "origin") or "") or None,
        },
        "studies": studies,
        "wandb_groups": dict(sorted(groups.items())),
        "dependencies": dependencies,
        "health": run_validator(root) if validate else {"ran": False, "error": "skipped", "findings": []},
    }


IMAGE_SUFFIXES = (".png", ".jpg", ".jpeg", ".gif", ".svg", ".webp")


def copy_figures(catalog: dict, studies_root: Path | str, dest: Path | str) -> int:
    """Copy every figure a report embeds (and every image a v2 producer declares) to dest/<path>.

    The site serves them from data/files/<repo path>, so report markdown renders unchanged.
    """
    import shutil

    root, dest = Path(studies_root).resolve(), Path(dest)
    ok = _Tracked(root)
    paths = {f["path"] for s in catalog["studies"] for r in s["reports"] for f in r["figures"] if f["exists"]}
    # the app also renders study READMEs and variant notes, so their images ship too
    docs = [(f"{s['path']}/README.md", s["readme"]) for s in catalog["studies"]]
    docs += [(f"{v['path']}/notes.md", v["notes"]) for s in catalog["studies"] for v in s["variants"] if v["notes"]]
    for doc, text in docs:
        for _, src in MD_IMAGE.findall(text or ""):
            if "://" not in src:
                try:
                    paths.add(((root / doc).parent / src).resolve().relative_to(root).as_posix())
                except ValueError:
                    pass
    paths |= {o["path"] for s in catalog["studies"] for a in s["artifacts"] if a["meta"]
              for o in a["meta"]["outputs"] if o["path"].lower().endswith(IMAGE_SUFFIXES)}
    n = 0
    for p in sorted(paths):
        src = root / p
        if ok(src):
            (dest / p).parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(src, dest / p)
            n += 1
    return n
