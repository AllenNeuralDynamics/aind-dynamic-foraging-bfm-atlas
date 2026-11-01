"""The leaderboard (#/leaderboard): every model family's held-out choice likelihood on one axis.

An editorial spec, like framework.py: which series to draw, where each value lives in a committed
studies file, and which report result block publishes it. No number is typed here; the build reads
each one from the studies checkout, so the chart is a pure function of the studies SHA.

A series whose source file is absent (e.g. a report still on an open PR) is left out and listed in
`missing`; a file that exists but no longer holds the value fails the build, as schema drift.
"""
from __future__ import annotations

import csv
import json
import math
from pathlib import Path
from typing import Any, Callable

D_NOMINAL = (10, 30, 100, 300, 614)
H_GRID = (16, 64, 128, 256, 512)

S01 = "studies/01-gru-scaling-law/analysis"
S06 = "studies/06-disrnn-operating-point-at-scale/analysis"
S10 = "studies/10-gru-reservoir-ablation"
S13 = "studies/13-hb-subject-vs-gru-heldout/analysis"
S14 = "studies/14-glmhmm-vs-gru-heldout/analysis"

METRIC = ("Choice likelihood on held-out mice (149 mice never trained on; geometric-mean probability "
          "of the mouse's left/right choice)")

# x categories per panel, left to right; the site lays them out
PANELS = [
    {"id": "cognitive", "label": "Cognitive models (MLE / HB)",
     "groups": [{"label": "CTT", "x": ["CTT MLE", "CTT HB"]}, {"label": "Hattori", "x": ["Hattori MLE", "Hattori HB"]}]},
    {"id": "glmhmm", "label": "GLM-HMM (hurdle), states K", "x": list(range(1, 11))},
    {"id": "disrnn", "label": "disRNN, training mice D", "x": [30, 100, 300, 614]},
    {"id": "gru", "label": "GRU, hidden size H, training mice D", "x": list(D_NOMINAL)},
]


class LeaderboardError(ValueError):
    """A source file exists but no longer holds what the spec reads from it."""


def nominal_d(d: float) -> int:
    """The nominal D a realized training-mouse count belongs to (nearest on a log scale)."""
    return min(D_NOMINAL, key=lambda x: abs(math.log(x) - math.log(float(d))))


def _pointer(doc: Any, pointer: str, path: str) -> Any:
    cur = doc
    for raw in pointer.split("/")[1:]:
        key = raw.replace("~1", "/").replace("~0", "~")
        try:
            cur = cur[int(key)] if isinstance(cur, list) else cur[key]
        except (KeyError, IndexError, ValueError, TypeError):
            raise LeaderboardError(f"{path}: no value at {pointer}") from None
    return cur


def _values(v: Any, path: str, where: str) -> list[float]:
    vs = v if isinstance(v, list) else [v]
    if not all(isinstance(x, (int, float)) and not isinstance(x, bool) and math.isfinite(x) for x in vs):
        raise LeaderboardError(f"{path}: {where} is not a finite number or a list of them")
    return [float(x) for x in vs]


def _block(study: str, report: str, block: str) -> dict:
    return {"study": study, "report": report, "block": block}


# ------------------------------------------------------------------ readers
# Each returns [(x, values, source pointer or filter)] for one series from one file.
def json_scalar(pointer: str, x: Any) -> Callable:
    def read(doc, path):
        return [(x, _values(_pointer(doc, pointer, path), path, pointer), pointer)]
    return read


def json_by_x(template: str, xs: list) -> Callable:
    """One value (or seed list) per x, at `template` with {x} filled in; empty lists are skipped."""
    def read(doc, path):
        out = []
        for x in xs:
            ptr = template.format(x=x)
            vs = _values(_pointer(doc, ptr, path), path, ptr)
            if vs:
                out.append((x, vs, ptr))
        return out
    return read


def json_rows_by_d(pointer: str, d_key: str, value_key: str, xs: list, where: dict | None = None) -> Callable:
    """Rows of a list at `pointer`, grouped by nominal D; `value_key` is a number or a seed list."""
    def read(doc, path):
        rows = _pointer(doc, pointer, path)
        if not isinstance(rows, list):
            raise LeaderboardError(f"{path}: {pointer} is not a list")
        by_x: dict[int, list[float]] = {}
        for i, r in enumerate(rows):
            if not isinstance(r, dict) or d_key not in r or value_key not in r:
                raise LeaderboardError(f"{path}: {pointer}/{i} lacks {d_key} or {value_key}")
            x = nominal_d(r[d_key])
            if x in xs:
                by_x.setdefault(x, []).extend(_values(r[value_key], path, f"{pointer}/{i}/{value_key}"))
        return [(x, by_x[x], f"{pointer}[*].{value_key}, {d_key} → nominal {x}") for x in xs if x in by_x]
    return read


def csv_by_d(value: str, where: dict[str, Callable[[str], bool]], xs: list, describe: str) -> Callable:
    """Rows passing every `where` test, grouped by nominal D; rows with an empty `value` are skipped."""
    def read(rows, path):
        missing = {value, "D", *where} - set(rows[0] if rows else {})
        if missing:
            raise LeaderboardError(f"{path}: no column(s) {sorted(missing)}")
        by_x: dict[int, list[float]] = {}
        for r in rows:
            if all(test(r[c]) for c, test in where.items()) and r[value] != "":
                x = nominal_d(float(r["D"]))
                if x in xs:
                    by_x.setdefault(x, []).extend(_values(float(r[value]), path, f"{value} = {r[value]!r}"))
        return [(x, by_x[x], f"{describe}, D → nominal {x}") for x in xs if x in by_x]
    return read


def eq(v: float) -> Callable[[str], bool]:
    return lambda s: s != "" and math.isclose(float(s), v)


def false(s: str) -> bool:
    return s.strip().lower() in ("false", "0", "")


# ------------------------------------------------------------------ the spec
# id, panel, legend label, then one or more parts: (file, reader, result block, description).
SERIES = [
    {"id": "ctt", "panel": "cognitive", "label": "CTT (compare-to-threshold)", "parts": [
        (f"{S01}/rl_baseline.json", json_scalar("/models/ctt/pooled_likelihood_trial_weighted", "CTT MLE"),
         _block("01-gru-scaling-law", "r8", "result-8"),
         "Best cognitive model, fitted per mouse by maximum likelihood (MLE); pooled over trials."),
        (f"{S13}/r6_ctt_ladder.json", json_scalar("/pooled/full HB", "CTT HB"),
         _block("13-hb-subject-vs-gru-heldout", "r6", "result-1"),
         "CTT fitted by full hierarchical Bayes (HB): mice share a population prior; pooled over trials."),
    ]},
    {"id": "hattori", "panel": "cognitive", "label": "Hattori (asymmetric Q-learning)", "parts": [
        (f"{S13}/r4_ladder.json", json_scalar("/pooled/MLE", "Hattori MLE"),
         _block("13-hb-subject-vs-gru-heldout", "r4", "result-1"),
         "Hattori model fitted per mouse by maximum likelihood (MLE); pooled over trials."),
        (f"{S13}/r4_ladder.json", json_scalar("/pooled/full HB", "Hattori HB"),
         _block("13-hb-subject-vs-gru-heldout", "r4", "result-1"),
         "Hattori model fitted by full hierarchical Bayes (HB); pooled over trials."),
    ]},
    {"id": "glmhmm-hurdle", "panel": "glmhmm", "label": "GLM-HMM (hurdle emission)", "parts": [
        (f"{S14}/r1_round_1.json", json_by_x("/scores/hurdle/{x}/LR_engaged", list(range(1, 11))),
         _block("14-glmhmm-vs-gru-heldout", "r1", "result-1"),
         "GLM-HMM with K hidden states, refitted per held-out mouse; left vs right on engaged trials. One seed."),
    ]},
    {"id": "disrnn-b3e-4", "panel": "disrnn", "label": "disRNN, β = 3e-4 (operating point)", "parts": [
        (f"{S06}/grid.csv", csv_by_d("heldout_ll", {"mult": eq(1), "beta": eq(3e-4), "heldout_backfilled": false},
                                     [30, 100, 300, 614], "rows mult = 1, beta = 3e-4, not backfilled"),
         _block("06-disrnn-operating-point-at-scale", "r2", "result-1"),
         "disRNN at study 06's tuned bottleneck penalty β = 3e-4, trained on D mice (seeds with a back-filled "
         "held-out score are left out)."),
    ]},
    {"id": "disrnn-b1e-4", "panel": "disrnn", "label": "disRNN, β = 1e-4 (best tested)", "parts": [
        (f"{S06}/grid_wave2.csv", csv_by_d("heldout_ll", {"mult": eq(1), "beta": eq(1e-4)},
                                           [30, 100, 300, 614], "rows mult = 1, beta = 1e-4"),
         _block("06-disrnn-operating-point-at-scale", "r3", "result-1"),
         "disRNN at the lower penalty β = 1e-4 that study 06's edge extension found best, trained on D mice."),
    ]},
    *[{"id": f"gru-h{h}", "panel": "gru", "label": f"GRU H = {h}", "h": h, "parts": [
        (f"{S01}/nxd_scaling.json", json_by_x(f"/seed_scalars/N{h}_D{{x}}", [10, 30, 100, 614]),
         _block("01-gru-scaling-law", "r7", "result-7"),
         f"Fully trained GRU with {h} hidden units, trained on D mice (study 01's N × D grid)."),
        *([(f"{S10}/reference/study01-trained-gru.json", json_rows_by_d("/cells", "D", "likelihood", [300]),
            _block("10-gru-reservoir-ablation", "r1", "result-1"),
            "Fully trained GRU, H = 128, D ≈ 300: study 01's v2 D-scan runs, as study 10 freezes them for "
            "its trained-GRU reference.")] if h == 128 else []),
    ]} for h in H_GRID],
    {"id": "gru-reservoir", "panel": "gru", "label": "GRU H = 128, reservoir only (random core frozen)", "h": 128, "parts": [
        (f"{S10}/analysis/reservoir_analysis.json",
         json_rows_by_d("/scaling_curve", "nominal_D", "reservoir_values", list(D_NOMINAL)),
         _block("10-gru-reservoir-ablation", "r1", "result-1"),
         "GRU whose recurrent core stays at its random initialization; only the subject embeddings and the "
         "readout are trained."),
    ]},
]


def _load(path: Path) -> Any:
    if path.suffix == ".csv":
        with path.open(newline="") as f:
            return list(csv.DictReader(f))
    return json.loads(path.read_text())


def _stats(vs: list[float]) -> tuple[float, float | None]:
    n = len(vs)
    mean = sum(vs) / n
    if n < 2:
        return mean, None
    return mean, math.sqrt(sum((v - mean) ** 2 for v in vs) / (n - 1) / n)


def build_leaderboard(root: Path, reports: dict[tuple[str, str], dict], tracked: Callable[[Path], bool]) -> dict:
    """catalog.leaderboard for a studies checkout.

    `reports` maps (study id, report id) to the catalog's report, so each point's block is checked to
    exist; `tracked` says whether a file is committed (an untracked file is treated as absent).
    """
    series, missing, cache = [], [], {}
    for spec in SERIES:
        points = []
        for path, read, block, description in spec["parts"]:
            p = root / path
            if not (p.is_file() and tracked(p)):
                missing.append({"series": spec["id"], "label": spec["label"], "path": path, "block": block})
                continue
            r = reports.get((block["study"], block["report"]))
            if r is None or block["block"] not in {b["name"] for b in r["result_blocks"]}:
                raise LeaderboardError(f"{spec['id']}: {path} is committed but "
                                       f"{block['study']}/{block['report']} has no {block['block']}")
            if path not in cache:
                cache[path] = _load(p)
            got = read(cache[path], path)
            if not got:
                raise LeaderboardError(f"{spec['id']}: no values in {path}")
            for x, vs, where in got:
                mean, sem = _stats(vs)
                points.append({"x": x, "values": vs, "mean": mean, "sem": sem, "n": len(vs),
                               "source": {"path": path, "where": where},
                               "block": {**block, "report_path": r["path"]}, "description": description})
        if points:
            panel = next(p for p in PANELS if p["id"] == spec["panel"])
            order = [x for g in panel.get("groups", [panel]) for x in g["x"]]
            points.sort(key=lambda pt: order.index(pt["x"]))
            series.append({k: spec[k] for k in ("id", "panel", "label", "h") if k in spec} | {"points": points})
    return {"available": bool(series), "metric": METRIC, "panels": PANELS, "series": series, "missing": missing}
