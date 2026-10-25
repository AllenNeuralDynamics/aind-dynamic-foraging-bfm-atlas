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
GROUP = re.compile(r"\b([A-Za-z0-9][\w.-]*@\d{8}-\d{6})\b")
FRONTMATTER = re.compile(r"\A---\n(.*?)\n---\n", re.S)
RESULT_BLOCK = re.compile(r"<!-- BEGIN ([\w.-]+) -->\n?(.*?)<!-- END \1 -->", re.S)
MD_IMAGE = re.compile(r"!\[([^\]]*)\]\(([^)\s]+)\)")
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
    return out


def _note(d: dict) -> str | None:
    """Why the launch exists: the launcher --note, a legacy `purpose`, or a trigger symptom."""
    for key in ("note", "purpose"):
        if isinstance(d.get(key), str):
            return d[key]
    t = d.get("trigger")
    if isinstance(t, dict) and isinstance(t.get("symptom"), str):
        return t["symptom"]
    return t if isinstance(t, str) else None


def _launch_record(path: Path, root: Path, variant: str) -> dict:
    rel = _rel(path, root)
    if path.suffix != ".json":
        text = path.read_text(errors="replace")
        return {"path": rel, "format": path.suffix.lstrip("."), "schema_version": None,
                "wandb_groups": sorted(set(GROUP.findall(text))), "sha256": _sha256(path)}
    d, err = _load_json(path)
    if err or not isinstance(d, dict):
        return {"path": rel, "format": "json", "schema_version": None,
                "error": err or "top level is not an object", "wandb_groups": [], "sha256": _sha256(path)}
    meta = d.get("_meta") if isinstance(d.get("_meta"), dict) else {}
    v2 = meta.get("schema_version") == 2
    groups = [d["wandb_group"]] if v2 and isinstance(d.get("wandb_group"), str) else sorted(_groups_in(d))
    job_refs = d.get("job_refs") if isinstance(d.get("job_refs"), list) else []
    if not job_refs and isinstance(d.get("experiment_id"), str):
        job_refs = [{"type": "beaker_experiment", "id": d["experiment_id"]}]
    return {
        "path": rel, "format": "json",
        "schema_version": 2 if v2 else 1,
        "kind": d.get("kind") or ("initial" if d.get("mode") else None),
        "platform": d.get("platform") or ("beaker" if "experiment_id" in d else None),
        "wandb_groups": groups,
        "own_group": any(g.split("@")[0] == variant for g in groups),
        "label": d.get("label"),
        "note": _note(d),
        "job_refs": [r for r in job_refs if isinstance(r, dict)],
        "experiment_url": d.get("experiment_url"),
        "revisions": _revisions(d),
        "time": d.get("created_utc") or d.get("submitted_at") or meta.get("produced_at_pt"),
        "n_tasks": d.get("n_tasks") if isinstance(d.get("n_tasks"), int) else None,
        "supersedes": d.get("supersedes") if isinstance(d.get("supersedes"), list) else [],
        "deviations": d.get("deviations") if isinstance(d.get("deviations"), dict) else {},
        "sha256": _sha256(path),
    }


# --- reports ------------------------------------------------------------------------------------
def _resolve(study_dir: Path, root: Path, item: str) -> tuple[str, bool]:
    """A frontmatter path: repo-relative when it starts with studies/, else study-relative."""
    target = (root / item) if item.startswith("studies/") else (study_dir / item)
    if target.exists():
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


def _report(path: Path, study_dir: Path, root: Path, study_ids: set[str]) -> dict:
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
                p, ok = _resolve(study_dir, root, item)
                inputs.append({"role": str(role), "path": p, "exists": ok})
    figures = []
    for alt, src in MD_IMAGE.findall(body):
        if "://" in src:
            continue
        target = (path.parent / src).resolve()
        try:
            figures.append({"alt": alt, "src": src, "path": target.relative_to(root.resolve()).as_posix(),
                            "exists": target.exists()})
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
        "metric": f.get("metric") if isinstance(f.get("metric"), str) else None,
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
        "kind": meta.get("kind") or "producer",
        "produced_by": meta.get("produced_by") or meta.get("producer"),
        "produced_at_pt": meta.get("produced_at_pt") or meta.get("recorded_at_pt"),
        "studies_git_sha": meta.get("studies_git_sha") or meta.get("dispatcher_git_sha"),
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
        return {"source": "frontmatter", "question": fm.get("question"), "status": fm.get("status"),
                "verdict": fm.get("verdict"), "superseded_by": fm.get("superseded_by"),
                "issues": fm.get("issues") or [],
                "wandb": {"entity": w.get("entity"), "project": w.get("project")} if w else None}
    q, proj = QUESTION.search(readme), WANDB_PROJECT.search(readme)
    return {"source": "readme", "question": " ".join(q.group(1).split()) if q else None,
            "status": None, "verdict": None, "superseded_by": None, "issues": [],
            "wandb": {"entity": proj.group(1), "project": proj.group(2)} if proj else None}


def _study(study_dir: Path, root: Path, study_ids: set[str]) -> dict:
    m = STUDY_DIR.match(study_dir.name)
    readme_path = study_dir / "README.md"
    text = readme_path.read_text(errors="replace") if readme_path.exists() else ""
    fm, body, _ = _frontmatter(text)
    h1 = H1.search(body)

    variants = []
    for vdir in sorted(p for p in (study_dir / "variants").glob("*") if p.is_dir() and p.name != "__pycache__"):
        notes = vdir / "notes.md"
        files = sorted(p for d in vdir.glob("launch_record*") if d.is_dir() for p in d.rglob("*")
                       if p.is_file() and p.suffix in (".json", ".yaml", ".yml"))
        records = [_launch_record(p, root, vdir.name) for p in files]
        own = sorted({g for r in records if r["format"] == "json" for g in r["wandb_groups"]
                      if g.split("@")[0] == vdir.name})
        variants.append({
            "name": vdir.name,
            "path": _rel(vdir, root),
            "notes": notes.read_text(errors="replace") if notes.exists() else None,
            "manifests": sorted(_rel(p, root) for p in vdir.glob("*.y*ml")),
            "launch_records": records,
            "wandb_groups": own or sorted({g for r in records for g in r["wandb_groups"]}),
        })

    rdir = study_dir / "analysis" / "reports"
    reports = [_report(p, study_dir, root, study_ids) for p in sorted(rdir.glob("*.md"), key=_report_order)
               if p.name != "INDEX.md"] if rdir.is_dir() else []
    index = rdir / "INDEX.md"
    analysis = study_dir / "analysis"
    tracked = set((_git(root, "ls-files", "--", _rel(analysis, root)) or "").splitlines()) if analysis.is_dir() else set()
    artifacts = [_artifact(p, root) for p in sorted(analysis.rglob("*.json"))
                 if _rel(p, root) in tracked] if analysis.is_dir() else []

    return {
        "id": study_dir.name,
        "number": int(m.group(1)) if m else None,
        "model": m.group(2) if m else None,
        "purpose": m.group(3) if m else None,
        "path": _rel(study_dir, root),
        "title": h1.group(1) if h1 else study_dir.name,
        "cover": _cover(fm, body),
        "readme": body,
        "reports_index": index.read_text(errors="replace") if index.exists() else None,
        "makefile_targets": _makefile_targets(study_dir / "Makefile"),
        "variants": variants,
        "reports": reports,
        "artifacts": artifacts,
        "cites": sorted({s for s in (_study_of(t, study_ids) for t in _link_targets(body, readme_path, root)) if s}
                        - {study_dir.name}),
    }


def _report_order(p: Path) -> tuple:
    m = REPORT_FILE.match(p.name)
    return (int(m.group(1)), p.name) if m else (10**6, p.name)


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
    return {"ran": True, "error": None, "findings": out.get("findings", []), "new": out.get("new", []),
            "baseline_size": out.get("baseline_size")}


# --- assembly -----------------------------------------------------------------------------------
def build_catalog(studies_root: Path | str, validate: bool = True) -> dict:
    """Catalog for a studies checkout (the repository root, containing ``studies/``)."""
    root = Path(studies_root).resolve()      # the checker runs with cwd=root
    dirs = sorted(p for p in (root / "studies").iterdir() if p.is_dir() and STUDY_DIR.match(p.name))
    ids = {p.name for p in dirs}
    studies = [_study(p, root, ids) for p in dirs]
    wandb = {s["id"]: s["cover"]["wandb"] for s in studies}

    groups: dict[str, dict] = {}

    def entry(g: str) -> dict:
        return groups.setdefault(g, {"group": g, "study": None, "variant": None, "url": None,
                                     "launch_records": [], "reports": [], "artifacts": []})

    for s in studies:
        for v in s["variants"]:
            for r in v["launch_records"]:
                for g in r["wandb_groups"]:
                    e = entry(g)
                    e["launch_records"].append(r["path"])
                    if g.split("@")[0] == v["name"] or e["variant"] is None:
                        e["study"], e["variant"] = s["id"], v["name"]
        for r in s["reports"]:
            for g in r["wandb_groups"]:
                entry(g)["reports"].append(r["path"])
        for a in s["artifacts"]:
            for g in (a["meta"] or {}).get("wandb_groups", []):
                entry(g)["artifacts"].append(a["path"])
    for g, e in groups.items():
        for k in ("launch_records", "reports", "artifacts"):
            e[k] = sorted(set(e[k]))
        w = wandb.get(e["study"]) if e["study"] else None
        if w and w.get("entity") and w.get("project"):
            e["url"] = f"https://wandb.ai/{w['entity']}/{w['project']}/groups/{g}"

    # Study dependencies: report `upstream` (solid) and plain links (citations, dashed).
    deps = []
    for s in studies:
        for r in s["reports"]:
            for u in r["upstream"]:
                if u.get("study") in ids and u["study"] != s["id"]:
                    deps.append({"from": s["id"], "to": u["study"], "kind": "upstream", "report": r["path"]})
            for c in r["corrects"]:
                if c.get("study") in ids:
                    deps.append({"from": s["id"], "to": c["study"], "kind": "corrects", "report": r["path"]})
            for t in r["cites"]:
                deps.append({"from": s["id"], "to": t, "kind": "citation", "report": r["path"]})
        for t in s["cites"]:
            deps.append({"from": s["id"], "to": t, "kind": "citation", "report": None})
    seen, dependencies = set(), []
    for d in deps:
        key = (d["from"], d["to"], d["kind"], d["report"])
        if key not in seen:
            seen.add(key)
            dependencies.append(d)

    sha = _git(root, "rev-parse", "HEAD")
    return {
        "_meta": {
            "schema_version": CATALOG_SCHEMA_VERSION,
            "built_at_pt": datetime.datetime.now(PT).isoformat(timespec="seconds"),
            "studies_git_sha": sha,
            "studies_git_dirty": None if sha is None else bool(_git(root, "status", "--porcelain", "--", "studies")),
            "studies_commit_time": _git(root, "log", "-1", "--format=%cI"),
            # never publish credentials embedded in a remote URL
            "studies_remote": re.sub(r"//[^@/]+@", "//", _git(root, "remote", "get-url", "origin") or "") or None,
        },
        "studies": studies,
        "wandb_groups": dict(sorted(groups.items())),
        "dependencies": dependencies,
        "health": run_validator(root) if validate else {"ran": False, "error": "skipped", "findings": []},
    }
