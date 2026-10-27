"""Render the built site in Chromium and fail on JS errors or broken key views.

    python scripts/site_smoke.py site screenshots/
    python scripts/site_smoke.py https://allenneuraldynamics.github.io/aind-dynamic-foraging-bfm-atlas/ shots/

Serves <site> on a local port (or uses a deployed URL), opens the main views, saves a screenshot of each, and checks
that a report's result-block "Provenance" button opens the drawer and that nothing scrolls
sideways at phone width.
"""
import functools
import http.server
import json
import sys
import threading
import urllib.request
from pathlib import Path

from playwright.sync_api import sync_playwright

OPTIONAL_VIEWS = ("timeline", "about")   # visited when the nav shows them


def check_export(page, button, what, path, failures, sha):
    """Export SVG downloads a self-contained drawing stamped with the studies commit."""
    try:
        with page.expect_download(timeout=10000) as dl:
            page.locator(button).first.click()
        dl.value.save_as(str(path))
        svg = path.read_text()
        if not svg.startswith("<svg") or "var(--" in svg or f"studies {(sha or '')[:8]}" not in svg:
            failures.append(f"{what} export: not a self-contained SVG with the studies stamp")
    except Exception as e:
        failures.append(f"{what} export: no download ({type(e).__name__})")


def main(site: str, out: str) -> int:
    out = Path(out)
    out.mkdir(parents=True, exist_ok=True)
    httpd = None
    if site.startswith(("http://", "https://")):
        base = site if site.endswith("/") else site + "/"
        with urllib.request.urlopen(base + "data/catalog.json") as r:
            cat = json.loads(r.read())
    else:
        root = Path(site).resolve()
        handler = functools.partial(http.server.SimpleHTTPRequestHandler, directory=str(root))
        httpd = http.server.ThreadingHTTPServer(("127.0.0.1", 0), handler)
        threading.Thread(target=httpd.serve_forever, daemon=True).start()
        base = f"http://127.0.0.1:{httpd.server_port}/"
        cat = json.loads((root / "data" / "catalog.json").read_text())
    # prefer a report with click-a-number links, so that path is exercised too
    pairs = [(s, r) for s in cat["studies"] for r in s["reports"] if r["result_blocks"]]
    study, report = next(((s, r) for s, r in pairs
                          if any(b.get("number_links") for b in r["result_blocks"])), pairs[0])
    group = next(iter(cat["wandb_groups"]))
    # a lineage permalink for a block some producer declares (so most hops are filled), else any block
    declared = {o["path"] for s in cat["studies"] for a in s["artifacts"] for o in (a["meta"] or {}).get("outputs", [])}
    lin = next(((s, r, b["name"]) for s, r in pairs for b in r["result_blocks"] if f'{r["path"]}#{b["name"]}' in declared),
               (study, report, report["result_blocks"][0]["name"]))
    views = {"landing": "#/", "study": f"#/study/{study['id']}",
             "report": f"#/report/{study['id']}/{report['id']}", "health": "#/health",
             "group": f"#/group/{group}", "history": f"#/history/{study['id']}/{report['id']}",
             "lineage": f"#/lineage/{lin[0]['id']}/{lin[1]['id']}/{lin[2]}"}
    # Navigation to optional views is shown only once a module registers them; visit those.

    errors, failures = [], []
    with sync_playwright() as pw:
        browser = pw.chromium.launch()
        page = browser.new_page(viewport={"width": 1280, "height": 900})
        page.on("pageerror", lambda e: errors.append(str(e)))
        page.on("console", lambda m: errors.append(m.text) if m.type == "error" else None)
        page.goto(base)
        page.wait_for_function("window.Atlas && window.Atlas.S && window.Atlas.S.cat", timeout=20000)
        for view in OPTIONAL_VIEWS:
            if page.locator(f'.top nav a[data-view="{view}"]').is_visible():
                views[view] = f"#/{view}"
        for name, hash_ in views.items():
            page.goto(base + hash_)
            # the view has rendered once #main shows a heading (it says "Loading catalog…" before)
            try:
                page.wait_for_selector("#main h1", timeout=20000)
            except Exception:
                failures.append(f"{name}: no heading rendered")
            page.wait_for_timeout(300)
            for bad in ("Not found", "Could not load the catalog", "Rendering failed"):
                if page.locator("h1", has_text=bad).count():
                    failures.append(f"{name}: rendered '{bad}'")
            page.screenshot(path=str(out / f"{name}.png"))
        # study map: one node per study, a layer toggles its edges, selecting a study fills the panel
        page.goto(base + "#/")
        page.wait_for_selector("#study-map .node", timeout=20000)
        if page.locator("#study-map .node[data-id]:not(.issue)").count() != len(cat["studies"]):
            failures.append("study map: not one node per study")
        # a node's label is its whole name after the number; it draws one ring per model after the first
        for s in cat["studies"]:
            node = page.locator(f'#study-map .node[data-id="{s["id"]}"]')
            shown = " ".join(node.locator(".lbl").evaluate_all("els => els.map((e) => e.textContent)"))
            if shown != s["id"][3:].replace("-", " "):
                failures.append(f"study map: {s['id']} is labelled '{shown}'")
            own = s["cover"].get("tags")
            models = (own or {}).get("model") or ([s["model"]] if s.get("model") else [])
            if node.locator(".ring").count() != max(0, len(models) - 1):
                failures.append(f"study map: {s['id']} draws {node.locator('.ring').count()} rings for models {models}")
        up = page.locator('.layer[data-kind="upstream"]')
        before = up.get_attribute("aria-pressed")
        up.click()
        if up.get_attribute("aria-pressed") == before:
            failures.append("study map: the upstream layer did not toggle")
        up.click()
        page.locator("#study-map .node[data-id]:not(.issue)").first.click()
        if not page.locator("#map-panel", has_text="Motivated by").count():
            failures.append("study map: selecting a study did not fill the panel")
        page.screenshot(path=str(out / "map.png"))
        check_export(page, "#map-export", "study map", out / "map.svg", failures, sha=cat["_meta"]["studies_git_sha"])
        page.locator("#map-panel .panel-close").click()
        # a dragged study keeps part of the move once the forces settle (Drag hold), not springing back
        node = page.locator("#study-map .node[data-id]:not(.issue) .body").nth(1)
        page.wait_for_timeout(2500)
        node.scroll_into_view_if_needed()          # mouse events land only inside the viewport
        box, frame = node.bounding_box(), page.locator("#study-map").bounding_box()
        x0, y0 = box["x"] + box["width"] / 2, box["y"] + box["height"] / 2
        dx = 120 if x0 < frame["x"] + frame["width"] / 2 else -120          # toward the middle, away from the edge
        page.mouse.move(x0, y0)
        page.mouse.down()
        page.mouse.move(x0 + dx / 2, y0, steps=5)
        page.mouse.move(x0 + dx, y0, steps=5)
        # mid-drag the tooltip waits in the top-left corner of the map's visible part, below the sticky
        # header, not over the study; and stays there when the page scrolls
        def docked(when):
            tipbox, wrap = page.locator("#map .tip:not([hidden])").bounding_box(), page.locator("#map .map-wrap").bounding_box()
            header = page.locator("header.top").bounding_box()
            top = max(wrap["y"], header["y"] + header["height"], 0)
            if not tipbox or abs(tipbox["x"] - wrap["x"] - 8) > 2 or abs(tipbox["y"] - top - 8) > 2:
                failures.append(f"study map: {when}, the tooltip is not docked in the map's corner ({tipbox} in {wrap})")
        docked("mid-drag")
        page.mouse.up()
        page.wait_for_timeout(3500)
        box = node.bounding_box()
        kept = (box["x"] + box["width"] / 2 - x0) / dx
        if kept < 0.3:
            failures.append(f"study map: a dragged study kept only {kept:.0%} of the move")
        page.locator("#study-map .node[data-id]:not(.issue)").nth(2).focus()     # keyboard focus, then scroll
        page.evaluate("window.scrollBy(0, 200)")
        page.wait_for_timeout(300)
        docked("after scrolling with a study focused")
        page.locator("#study-map .node[data-id]:not(.issue)").nth(2).blur()
        # at phone width the header scrolls away: scrolled past the map's top, the tooltip stays on screen
        page.set_viewport_size({"width": 390, "height": 844})
        page.locator("#study-map .node[data-id]:not(.issue)").nth(2).focus()
        page.evaluate("window.scrollTo(0, document.querySelector('#map .map-wrap').getBoundingClientRect().top + scrollY + 120)")
        page.wait_for_timeout(300)
        docked("on a phone, scrolled past the map's top")
        page.locator("#study-map .node[data-id]:not(.issue)").nth(2).blur()
        page.set_viewport_size({"width": 1280, "height": 900})
        # islands cycle through the tag facets and off; a tag chip fades the studies it does not match
        btn = page.locator("#map-islands")
        labels = []
        for _ in range(len(cat.get("tags") or {"model": 0}) + 1):
            btn.click()
            labels.append(btn.inner_text())
        if not any(t.endswith("off") for t in labels):
            failures.append(f"study map: islands never turned off ({labels})")
        chip = page.locator(".tag-chip").first
        if chip.count():
            facet, value = chip.get_attribute("data-f"), chip.get_attribute("data-v")
            def carries(s):        # as the map does: study tags plus its reports', nested tags count for their parent,
                own = s["cover"].get("tags")   # and an untagged study falls back to the model in its name
                tags = ((own or {}).get(facet) or ([s["model"]] if own is None and facet == "model" and s.get("model") else [])) + [
                    t for r in s["reports"] for t in ((r.get("tags") or {}).get(facet) or [])]
                return any(t == value or t.startswith(value + "/") for t in tags)
            chip.click()
            page.wait_for_timeout(300)
            want = sum(not carries(s) for s in cat["studies"])
            got = page.locator("#study-map .node.dim:not(.issue)").count()
            if got != want:
                failures.append(f"study map: filtering on {facet}={value} faded {got} studies, expected {want}")
            reset = page.locator("#map-reset")
            reset.click()
            page.wait_for_timeout(300)
            if page.locator("#study-map .node.dim").count() or chip.get_attribute("aria-pressed") != "false" \
                    or not reset.is_disabled():
                failures.append("study map: Reset did not clear the tag filters")
        # the About page: one box per framework object, a selection fills the panel with its
        # definition, the porting prompts render with copy buttons, and the map exports
        fw = cat.get("framework") or {}
        if fw.get("available"):
            page.goto(base + "#/about")
            page.wait_for_selector("#fw-map .fw-node", timeout=20000)
            if page.locator("#fw-map .fw-node").count() != len(fw["objects"]):
                failures.append("about: not one box per framework object")
            first = fw["objects"][0]
            page.locator(f'#fw-map .fw-node[data-id="{first["id"]}"]').click()
            if (first.get("definition") or "")[:40] not in page.locator("#fw-panel").inner_text():
                failures.append("about: selecting an object did not show its definition")
            page.wait_for_selector("#porting pre .copy", timeout=20000)
            if page.locator("#porting pre .copy").count() < 7:
                failures.append("about: fewer than seven porting prompts with a copy button")
            if "{{" in page.locator("#porting").inner_text():
                failures.append("about: a porting prompt kept an unfilled {{placeholder}}")
            # pinned prompts when the dispatcher commit is recorded, and a warning when it is not
            pinned = bool(cat["_meta"].get("dispatcher_git_sha"))
            if pinned == bool(page.locator("#porting-unpinned").count()) or \
                    (pinned and "/blob/main/" in page.locator("#porting").inner_text()):
                failures.append("about: the porting prompts' dispatcher links are not pinned, or not flagged as unpinned")
            if fw.get("skills") and page.locator("#fw-skills .skill-card").count() != len(fw["skills"]):
                failures.append("about: not one card per skill")
            page.screenshot(path=str(out / "about.png"), full_page=True)
            check_export(page, "#fw-export", "framework map", out / "framework.svg", failures, sha=cat["_meta"]["studies_git_sha"])
        # the study page's local graph: the study in the middle, its neighbours on either side
        # a study's links to itself (an in-study correction) draw nothing, so pick one with another study
        cross = [d for d in cat["dependencies"] if d["from"] != d["to"]]
        linked = sorted({d["from"] for d in cross} | {d["to"] for d in cross})
        sid = next((s["id"] for s in cat["studies"] if s["id"] in linked), None)
        if sid:
            page.goto(base + f"#/study/{sid}")
            page.wait_for_selector("#local-map .node", timeout=20000)
            if page.locator("#local-map .node.focused").count() != 1 or page.locator("#local-map .edge").count() < 1:
                failures.append("local graph: the study or its links are missing")
            page.screenshot(path=str(out / "local.png"))
            check_export(page, "#local-export", "local graph", out / "local.svg", failures, sha=cat["_meta"]["studies_git_sha"])
        # every study's local graph holds each node whole, rings and full label included
        for other in linked:
            if other not in {s["id"] for s in cat["studies"]}:
                continue
            page.goto(base + f"#/study/{other}")
            page.wait_for_selector("#local-map .node", timeout=20000)
            out_of = page.evaluate("""() => { const svg = document.getElementById("local-map").getBoundingClientRect();
                return [...document.querySelectorAll("#local-map .node")].filter((n) => { const b = n.getBoundingClientRect();
                  return b.top < svg.top - 1 || b.bottom > svg.bottom + 1; }).map((n) => n.dataset.id); }""")
            if out_of:
                failures.append(f"local graph of {other}: {', '.join(out_of)} drawn outside the graph")
        page.goto(base + views["lineage"])
        page.wait_for_selector(".lineage .slot", timeout=20000)
        if page.locator(".lineage .slot").count() < 8:
            failures.append("lineage: fewer than eight hops rendered")
        # a step opens to its details and the address bar names it; .../<block>/<step> opens it
        step = page.locator('#lineage-full .slot[data-hop="analysis"]')
        step.locator(".slot-head").click()
        if step.locator(".slot-head").get_attribute("aria-expanded") != "true" or step.locator(".slot-detail").is_hidden():
            failures.append("lineage: a step did not open")
        if not page.evaluate("location.hash.endsWith('/analysis')"):
            failures.append("lineage: opening a step did not update the permalink")
        page.goto(base + views["lineage"] + "/data")
        page.wait_for_selector(".lineage .slot", timeout=20000)
        if page.locator('#lineage-full .slot[data-hop="data"] .slot-head').get_attribute("aria-expanded") != "true":
            failures.append("lineage: the step permalink did not open its step")
        page.locator("#lineage-full .lin-all").click()
        page.screenshot(path=str(out / "lineage-open.png"), full_page=True)
        check_export(page, ".lin-export", "lineage", out / "lineage.svg", failures, sha=cat["_meta"]["studies_git_sha"])
        page.goto(base + views["report"])
        page.wait_for_selector(".result-block button", timeout=20000)
        page.locator(".result-block button").first.click()
        page.wait_for_timeout(300)
        if page.locator("#drawer").is_hidden():
            failures.append("drawer did not open")
        elif not page.evaluate("document.activeElement && document.activeElement.id === 'drawer'"):
            failures.append("opening the drawer did not move focus into it")
        if not page.locator("#drawer .lineage .slot").count():
            failures.append("drawer: no lineage")
        page.screenshot(path=str(out / "drawer.png"))
        page.keyboard.press("Escape")
        if not page.evaluate("document.activeElement && document.activeElement.matches('.result-block button')"):
            failures.append("closing the drawer did not return focus to its button")
        page.keyboard.press("Escape")
        # A catalog match may sit in inline code or a link, which the page leaves undecorated, so
        # look for a report that actually renders a number link; if the catalog has matches but
        # no report renders one, decoration is broken.
        linked = [(s, r) for s, r in pairs if any(b.get("number_links") for b in r["result_blocks"])]
        rendered = False
        for s, r in linked[:15]:
            page.goto(base + f"#/report/{s['id']}/{r['id']}")
            page.wait_for_selector("#main h1", timeout=20000)
            if page.locator(".num-link").count():
                rendered = True
                page.locator(".num-link").first.click()
                page.wait_for_timeout(300)
                if not page.locator("#drawer", has_text="Matched by value").count():
                    failures.append("number link did not open its drawer")
                page.screenshot(path=str(out / "number.png"))
                break
        if linked and not rendered:
            failures.append("the catalog has number links but no report page renders one")
        for view in OPTIONAL_VIEWS:
            if view not in views:
                failures.append(f"{view}: navigation link hidden, so its view is not registered")
        page.set_viewport_size({"width": 390, "height": 844})
        for name in ("landing", "report", "lineage", "about"):
            page.goto(base + views[name])
            page.wait_for_timeout(800)
            if name == "lineage":      # every step open, so the details must fit too
                page.locator("#lineage-full .lin-all").click()
            page.screenshot(path=str(out / f"mobile-{name}.png"))
            if page.evaluate("document.documentElement.scrollWidth > window.innerWidth + 1"):
                failures.append(f"{name}: horizontal scroll at phone width")
        browser.close()
    if httpd:
        httpd.shutdown()
    for e in errors + failures:
        print("FAIL:", e)
    print(f"{len(views)} views rendered; {len(errors)} JS errors; {len(failures)} failures")
    return 1 if errors or failures else 0


if __name__ == "__main__":
    raise SystemExit(main(*sys.argv[1:3]))
