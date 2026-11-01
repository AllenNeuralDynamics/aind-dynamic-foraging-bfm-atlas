import json
from pathlib import Path

import pytest

from bfm_atlas.catalog import build_catalog
from bfm_atlas.leaderboard import S06, S10, S13, SERIES, LeaderboardError, build_leaderboard, nominal_d


def put(root: Path, rel: str, data) -> None:
    p = root / rel
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_text(data if isinstance(data, str) else json.dumps(data))


def reports(*keys, blocks=("result-1",)):
    return {k: {"path": f"studies/{k[0]}/analysis/reports/{k[1]}.md", "result_blocks": [{"name": b} for b in blocks]}
            for k in keys}


R4 = ("13-hb-subject-vs-gru-heldout", "r4")
R2 = ("06-disrnn-operating-point-at-scale", "r2")
R1_10 = ("10-gru-reservoir-ablation", "r1")


def test_nominal_d_is_nearest_on_a_log_scale():
    assert [nominal_d(d) for d in (10, 29, 99, 101, 301, 614)] == [10, 30, 100, 100, 300, 614]


def test_values_come_from_the_files_and_absent_files_are_listed(tmp_path):
    put(tmp_path, f"{S13}/r4_ladder.json", {"pooled": {"MLE": 0.71, "full HB": 0.72}})
    put(tmp_path, f"{S06}/grid.csv", "D,seed,beta,mult,heldout_ll,heldout_backfilled\n"
        "29,0,0.0003,1,0.70,False\n30,1,0.0003,1,0.72,False\n100,0,0.0003,1,0.73,True\n"
        "100,1,0.001,1,0.99,False\n300,0,0.0003,1,,False\n")
    lb = build_leaderboard(tmp_path, reports(R4, R2), lambda p: True)
    by = {s["id"]: s for s in lb["series"]}
    assert [(p["x"], p["mean"]) for p in by["hattori"]["points"]] == [("Hattori MLE", 0.71), ("Hattori HB", 0.72)]
    dis = by["disrnn-b3e-4"]["points"]       # backfilled, other-beta and empty rows are left out
    assert [(p["x"], p["n"]) for p in dis] == [(30, 2)]
    assert dis[0]["mean"] == pytest.approx(0.71) and dis[0]["sem"] == pytest.approx(0.01)
    assert dis[0]["block"] == {"study": R2[0], "report": "r2", "block": "result-1", "report_path": reports(R2)[R2]["path"]}
    assert by["hattori"]["points"][0]["sem"] is None
    assert "ctt" not in by and {m["series"] for m in lb["missing"]} >= {"ctt", "glmhmm-hurdle", "gru-h16"}


def test_points_follow_the_panel_order(tmp_path):
    cells = [{"D": d, "seed": 0, "likelihood": 0.7} for d in (300, 301)]
    put(tmp_path, f"{S10}/reference/study01-trained-gru.json", {"cells": cells})
    put(tmp_path, "studies/01-gru-scaling-law/analysis/nxd_scaling.json",
        {"seed_scalars": {f"N{h}_D{d}": [0.72, 0.73] for h in (16, 64, 128, 256, 512) for d in (10, 30, 100, 614)}})
    lb = build_leaderboard(tmp_path, reports(R1_10, ("01-gru-scaling-law", "r7"), blocks=("result-1", "result-7")),
                           lambda p: True)
    h128 = next(s for s in lb["series"] if s["id"] == "gru-h128")
    assert [p["x"] for p in h128["points"]] == [10, 30, 100, 300, 614]
    assert h128["points"][3]["n"] == 2


def test_drift_fails_the_build(tmp_path):
    put(tmp_path, f"{S13}/r4_ladder.json", {"pooled": {"MLE": 0.71}})          # "full HB" is gone
    with pytest.raises(LeaderboardError, match="full HB"):
        build_leaderboard(tmp_path, reports(R4), lambda p: True)
    put(tmp_path, f"{S13}/r4_ladder.json", {"pooled": {"MLE": 0.71, "full HB": 0.72}})
    with pytest.raises(LeaderboardError, match="no result-1"):
        build_leaderboard(tmp_path, reports(R4, blocks=("result-2",)), lambda p: True)


@pytest.mark.parametrize("bad", ["NaN", "inf"])
def test_a_non_finite_score_fails_the_build(tmp_path, bad):
    # json.dumps would write it as a bare NaN / Infinity token, which the browser rejects
    put(tmp_path, f"{S06}/grid.csv", f"D,beta,mult,heldout_ll,heldout_backfilled\n30,0.0003,1,{bad},False\n")
    with pytest.raises(LeaderboardError, match="finite"):
        build_leaderboard(tmp_path, reports(R2), lambda p: True)
    put(tmp_path, f"{S06}/grid.csv", "D,beta,mult,heldout_ll,heldout_backfilled\n30,0.0003,1,0.7,False\n")
    put(tmp_path, f"{S13}/r4_ladder.json", '{"pooled": {"MLE": NaN, "full HB": 0.72}}')
    with pytest.raises(LeaderboardError, match="finite"):
        build_leaderboard(tmp_path, reports(R2, R4), lambda p: True)


def test_an_untracked_file_counts_as_absent(tmp_path):
    put(tmp_path, f"{S13}/r4_ladder.json", {"pooled": {"MLE": 0.71, "full HB": 0.72}})
    lb = build_leaderboard(tmp_path, reports(R4), lambda p: False)
    assert lb["available"] is False and len(lb["missing"]) == sum(len(s["parts"]) for s in SERIES)


def test_the_fixture_catalog_lists_every_series_as_missing(studies):
    lb = build_catalog(studies)["leaderboard"]
    assert lb["available"] is False and lb["series"] == []
    assert {m["series"] for m in lb["missing"]} == {s["id"] for s in SERIES}
