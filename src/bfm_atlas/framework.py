"""The framework behind the studies repo, for the atlas About page.

Two kinds of content, kept apart:

- **Editorial** (this module): which objects the framework has, how they connect, the stage of
  the run lifecycle each belongs to, and how general each skill is. No file in the studies or
  dispatcher repos states these, so they are written here, keyed by the studies ``CONTEXT.md``
  terms and schema fields.
- **Derived** (read at build time): each term's definition, each schema's fields, the ADRs,
  the checker's rule ids, and each skill's description. Nothing here restates them.

The model is checked against the sources: a modelled term missing from ``CONTEXT.md``, or a
modelled field missing from its schema, raises ``FrameworkError`` and fails the build, so the
page cannot drift from the files it describes. A checkout without ``CONTEXT.md`` (an older
studies commit) yields an unavailable framework rather than an error.
"""
from __future__ import annotations

import json
import re
import subprocess
from pathlib import Path

import yaml

FRONTMATTER = re.compile(r"\A---\n(.*?)\n---\n", re.S)
TERM = re.compile(r"^\*\*(?P<term>[^*]+)\*\*:\s*\n(?P<body>.*?)(?=^\*\*[^*]+\*\*:\s*$|^#|\Z)", re.S | re.M)
CHECK_ID = re.compile(r"[\"']((?:study|variant|record|report|artifact|tag|makefile)-[a-z0-9]+(?:-[a-z0-9]+)*)[\"']")
SCHEMA_ROW = re.compile(r"^\|\s*`([^`]+)`\s*\|\s*(.+?)\s*\|\s*$", re.M)
H1 = re.compile(r"^#\s+(.+?)\s*$", re.M)


class FrameworkError(RuntimeError):
    """The editorial model names a term or field its source no longer has."""


# ---------------------------------------------------------------- editorial model
STAGES = [
    ("plan", "Plan", "Ask one question; split it into variants."),
    ("launch", "Launch", "Submit to Beaker or SLURM; record exactly what went out."),
    ("track", "Track", "Every run of a launch lands in one W&B group."),
    ("freeze", "Freeze", "Copy what the analysis needs from W&B into the repo, by digest."),
    ("analyse", "Analyse", "Producers compute artifacts from committed files only."),
    ("report", "Report", "Reports hold regenerated numbers and declare what they use."),
    ("check", "Check", "One checker enforces the rules in CI; old debt may only shrink."),
]

# Each object is a CONTEXT.md `term` or a schema `field` (file, property), drawn in its
# lifecycle `stage` in this order, top to bottom. `schema` names the file that shapes it,
# `checks` the checker-rule id prefixes about it, and `note` stands in for a field whose schema
# gives no description.
OBJECTS = {
    "motivation": dict(label="Motivation", stage="plan", term="Motivation", checks=["study-motivation-"]),
    "tag": dict(label="Tag", stage="plan", term="Tag", schema="tags.yaml", checks=["tag-", "study-tag-"]),
    "study": dict(label="Study", stage="plan", term="Study", schema="study-frontmatter.v1.schema.json",
                  checks=["study-", "makefile-"]),
    "variant": dict(label="Variant", stage="plan", term="Variant", schema="layout.yaml", checks=["variant-"]),
    "launch": dict(label="Launch", stage="launch", term="Launch"),
    "intervention": dict(label="Intervention", stage="launch", term="Intervention", checks=["record-orphan-"]),
    "launch-record": dict(label="Launch record", stage="launch", term="Launch record",
                          schema="launch-record.v2.schema.json", checks=["record-"]),
    "manifests": dict(label="Launch manifests", stage="launch", field=("launch-record.v2.schema.json", "manifests"),
                      checks=["record-manifest-"]),
    "commits": dict(label="Code commits", stage="launch", field=("launch-record.v2.schema.json", "revisions"),
                    note="The full commit SHA of every repository the launch ran from."),
    "image": dict(label="Image", stage="launch", field=("launch-record.v2.schema.json", "image"),
                  checks=["record-image-"]),
    "data": dict(label="Data snapshot", stage="launch", field=("launch-record.v2.schema.json", "data"),
                 checks=["record-data-"]),
    "wandb-group": dict(label="W&B group", stage="track", term="W&B group", checks=["record-group-", "report-group-",
                                                                                     "artifact-group-"]),
    "freeze": dict(label="Freeze", stage="freeze", term="Freeze", checks=["study-environment-"]),
    "frozen-input": dict(label="Frozen input", stage="freeze", term="Frozen input", checks=["artifact-input-"]),
    "producer": dict(label="Producer", stage="analyse", term="Producer", checks=["artifact-stale-code"]),
    "analysis-artifact": dict(label="Analysis artifact", stage="analyse", term="Analysis artifact",
                              schema="meta.v2.schema.json", checks=["artifact-"]),
    "input-digest": dict(label="Input digest", stage="analyse", term="Input digest", checks=["artifact-stale-input"]),
    "report": dict(label="Report", stage="report", term="Report", schema="report-frontmatter.v1.schema.json",
                   checks=["report-"]),
    "result-block": dict(label="Result block", stage="report", term="Result block",
                         checks=["report-no-result-", "artifact-stale-output"]),
    "upstream": dict(label="Upstream", stage="report", term="Upstream", checks=["report-upstream-"]),
    "correction": dict(label="Correction", stage="report", term="Correction"),
    "lineage": dict(label="Lineage", stage="check", term="Lineage"),
    "baseline": dict(label="Provenance baseline", stage="check", term="Provenance baseline",
                     schema="provenance-baseline.json"),
}

# (from, to, what the arrow says)
EDGES = [
    ("motivation", "study", "motivates"),
    ("tag", "study", "classifies"),
    ("study", "variant", "compares"),
    ("variant", "launch", "is submitted as"),
    ("launch", "launch-record", "writes"),
    ("intervention", "launch-record", "writes"),
    ("intervention", "launch", "acts on"),
    ("launch-record", "manifests", "records"),
    ("launch-record", "commits", "records"),
    ("launch-record", "image", "records"),
    ("launch-record", "data", "records"),
    ("launch", "wandb-group", "mints one"),
    ("intervention", "wandb-group", "joins"),
    ("wandb-group", "freeze", "is read by"),
    ("freeze", "frozen-input", "writes"),
    ("frozen-input", "producer", "is read by"),
    ("producer", "analysis-artifact", "writes"),
    ("analysis-artifact", "input-digest", "records"),
    ("producer", "result-block", "regenerates"),
    ("report", "result-block", "holds"),
    ("report", "upstream", "declares"),
    ("report", "correction", "declares"),
    ("lineage", "result-block", "starts at"),
    ("baseline", "analysis-artifact", "ratchets"),
]

# How general each skill is, judged from its body; what to swap when porting; what it governs.
# level: "general" (the pattern carries over as is), "site" (general, with site specifics to
# swap) or "project" (this project's code only).
SKILLS = {
    "study-conventions": dict(level="general", objects=["study", "variant", "launch", "intervention", "launch-record",
                                                        "wandb-group"],
                              swap="Study naming (NN-{model}-{purpose}) and the scaffolder commands."),
    "posthoc-reporting": dict(level="general", objects=["freeze", "frozen-input", "producer", "analysis-artifact",
                                                        "input-digest", "report", "result-block", "upstream", "correction"],
                              swap="The cross-study readers (studies/util/cross_study.py) and the W&B sandbox route."),
    "beaker-launch": dict(level="site", objects=["launch", "intervention", "launch-record", "image", "manifests"],
                          swap="The AI Hub cluster allowlist, workspace, conda env and GPU-bundle sizes."),
    "hpc-launch": dict(level="site", objects=["launch", "intervention", "launch-record", "manifests"],
                       swap="The Allen SLURM partitions, QOS caps, login-node rule and conda envs."),
    "issue-tracking": dict(level="site", objects=[],
                           swap="The project-board and field ids, and the Copilot bot id."),
    "git-session-isolation": dict(level="site", objects=["commits"],
                                  swap="The sandbox workaround; the origin-is-truth provenance rule carries over."),
    "codebase-map": dict(level="project", objects=[], swap="Write your own map of your repositories."),
    "wrapper-runtime": dict(level="project", objects=["wandb-group"],
                            swap="This project's training runtime; document yours the same way."),
}


# ---------------------------------------------------------------- readers
def _git(repo: Path, *args: str) -> str | None:
    try:
        out = subprocess.run(["git", "-C", str(repo), *args], capture_output=True, text=True, check=True)
    except (OSError, subprocess.CalledProcessError):
        return None
    return out.stdout.strip() or None


def vocabulary(text: str) -> dict:
    """CONTEXT.md `**Term**:` blocks: term -> {definition, avoid}."""
    out = {}
    for m in TERM.finditer(text):
        body = " ".join(m["body"].split())
        avoid = re.search(r"_Avoid_:\s*(.+)$", body)
        definition = body[:avoid.start()].strip() if avoid else body
        out[m["term"].strip()] = {"definition": definition, "avoid": avoid[1].strip() if avoid else None}
    return out


def _schema(path: Path, rel: str, governs: str | None) -> dict:
    """A schema file's fields: JSON Schema properties, or a YAML file's top-level keys."""
    out = {"file": path.name, "path": rel, "governs": governs, "fields": [], "required": []}
    try:
        if path.suffix == ".json":
            body = json.loads(path.read_text())
            if "properties" in body:
                req = set(body.get("required") or [])
                out["required"] = sorted(req)
                out["fields"] = [{"name": k, "required": k in req,
                                  "description": v.get("description") if isinstance(v, dict) else None}
                                 for k, v in (body.get("properties") or {}).items()]
            else:       # the provenance baseline: known findings, as a list or under a key
                items = body if isinstance(body, list) else next((v for v in body.values() if isinstance(v, list)), []) \
                    if isinstance(body, dict) else []
                out["entries"] = len(items)
        else:
            body = yaml.safe_load(path.read_text()) or {}
            out["fields"] = [{"name": str(k), "required": False, "description": None} for k in body if k != "schema_version"]
        out["schema_version"] = body.get("schema_version") if isinstance(body, dict) else None
    except (OSError, ValueError, yaml.YAMLError) as e:
        out["error"] = f"{type(e).__name__}: {e}"
    return out


def _adrs(root: Path, ok) -> list:
    out = []
    for p in sorted((root / "docs" / "adr").glob("*.md")):
        if ok is not None and not ok(p):
            continue
        text = p.read_text()
        title = H1.search(text)
        body = H1.sub("", text, count=1).strip().split("\n\n")[0]
        out.append({"path": str(p.relative_to(root)), "title": title[1] if title else p.stem,
                    "summary": " ".join(body.split())})
    return out


def web_url(remote: str | None) -> str | None:
    """A git remote as the repository's web address: credentials dropped, an SSH form
    (``git@host:org/repo``, ``ssh://git@host/org/repo``) turned into https, no ``.git``."""
    if not remote:
        return None
    url = re.sub(r"//[^@/]+@", "//", remote.strip())
    url = re.sub(r"^ssh://(?:[^@/]+@)?([^/:]+)(?::\d+)?/", r"https://\1/", url)
    url = re.sub(r"^[^@/:]+@([^/:]+):", r"https://\1/", url)
    url = re.sub(r"\.git/?$", "", url)
    return url if url.startswith(("https://", "http://")) else None


def _skills(skills_dir: Path) -> dict:
    """The dispatcher's skills pack: every SKILL.md's frontmatter and sections, read from the
    commit it records (``git show HEAD:...``), so a local edit, draft or ignored file never
    reaches a catalog stamped with that SHA. Outside a git checkout, the files as they are."""
    pack = skills_dir / "skills" if (skills_dir / "skills").is_dir() else skills_dir
    top = _git(pack, "rev-parse", "--show-toplevel")
    if top:
        rel = pack.resolve().relative_to(Path(top).resolve()).as_posix()
        names = (_git(Path(top), "ls-tree", "-r", "--name-only", "HEAD", "--", rel) or "").splitlines()
        files = [(p, _git(Path(top), "show", f"HEAD:{p}") or "", Path(p).parent.name) for p in sorted(names)
                 if re.fullmatch(rf"{re.escape(rel)}/[^/]+/SKILL\.md" if rel != "." else r"[^/]+/SKILL\.md", p)]
    else:
        files = [(None, f.read_text(), f.parent.name) for f in sorted(pack.glob("*/SKILL.md"))]
    found = {}
    for path, text, folder in files:
        m = FRONTMATTER.match(text + "\n")
        try:
            fm = yaml.safe_load(m[1]) if m else {}
        except yaml.YAMLError:
            fm = {}
        name = str((fm or {}).get("name") or folder)
        found[name] = {"name": name, "description": (fm or {}).get("description"), "path": path,
                       "headings": re.findall(r"^## (.+?)\s*$", text, re.M)}
    return {"root": top, "sha": _git(pack, "rev-parse", "HEAD") if top else None,
            "dirty": bool(_git(pack, "status", "--porcelain", "--", ".")) if top else None,
            "remote": web_url(_git(pack, "remote", "get-url", "origin")) if top else None,
            "skills": found}


# ---------------------------------------------------------------- assembly
def build_framework(studies_root: Path | str, ok=None, skills_dir: Path | str | None = None) -> dict:
    """The About page's model of the framework, filled in from the studies checkout and, when
    ``skills_dir`` is given, the dispatcher's skills pack. ``ok`` (a ``_Tracked``) keeps
    untracked files out of a catalog stamped with a commit."""
    root = Path(studies_root).resolve()
    seen = lambda p: p.is_file() and (ok is None or ok(p))
    context = root / "CONTEXT.md"
    if not seen(context):
        return {"available": False, "error": "the studies checkout has no CONTEXT.md"}
    vocab = vocabulary(context.read_text())

    readme = root / "schemas" / "README.md"
    governs = dict(SCHEMA_ROW.findall(readme.read_text())) if seen(readme) else {}
    schemas = {p.name: _schema(p, str(p.relative_to(root)), governs.get(p.name))
               for p in sorted((root / "schemas").glob("*")) if seen(p) and p.suffix in (".json", ".yaml", ".yml")}
    checker = root / "scripts" / "check_provenance.py"
    checks = sorted(set(CHECK_ID.findall(checker.read_text()))) if seen(checker) else []

    objects = []
    for oid, o in OBJECTS.items():
        item = {"id": oid, "label": o["label"], "stage": o["stage"], "schema": o.get("schema")}
        if "term" in o:
            if o["term"] not in vocab:
                raise FrameworkError(f"About-page object {oid!r} names CONTEXT.md term {o['term']!r}, which "
                                     f"CONTEXT.md no longer defines; update OBJECTS in framework.py")
            item.update(kind="term", term=o["term"], editorial=False, **vocab[o["term"]])
        else:
            file, prop = o["field"]
            fields = {f["name"]: f for f in schemas.get(file, {}).get("fields", [])}
            if prop not in fields:
                raise FrameworkError(f"About-page object {oid!r} names field {prop!r} of {file}, which the "
                                     f"schema no longer has; update OBJECTS in framework.py")
            # a field's text is its schema description; only a field without one falls back to a note here
            described = fields[prop]["description"]
            item.update(kind="field", term=None, field=f"{file}#{prop}", definition=described or o.get("note"),
                        avoid=None, schema=file, editorial=not described)
        if item["schema"] and item["schema"] not in schemas:
            item["schema"] = None
        item["checks"] = [c for c in checks if any(c.startswith(p) for p in o.get("checks", []))]
        objects.append(item)

    skills, skills_error, dispatcher = None, None, None
    if skills_dir is not None:
        pack = _skills(Path(skills_dir).resolve())
        if not pack["skills"]:
            skills_error = f"no SKILL.md under {skills_dir}"
        else:
            dispatcher = {"sha": pack["sha"], "dirty": pack["dirty"], "remote": pack["remote"]}
            skills = []
            for name, s in pack["skills"].items():
                ed = SKILLS.get(name, {})
                skills.append({**s, "level": ed.get("level"), "objects": [x for x in ed.get("objects", []) if x in OBJECTS],
                               "swap": ed.get("swap")})
    else:
        skills_error = "skills not included in this build (bfm-atlas build --skills)"

    return {
        "available": True,
        "sources": {"studies_git_sha": _git(root, "rev-parse", "HEAD"), "dispatcher": dispatcher},
        "stages": [{"id": i, "label": l, "summary": s} for i, l, s in STAGES],
        "objects": objects,
        "edges": [{"from": a, "to": b, "label": t} for a, b, t in EDGES],
        "vocabulary": vocab,
        "schemas": list(schemas.values()),
        "adrs": _adrs(root, ok),
        "checks": checks,
        "skills": skills,
        "skills_error": skills_error,
    }
