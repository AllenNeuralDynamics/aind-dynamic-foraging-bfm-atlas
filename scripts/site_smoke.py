"""Render the built site in Chromium and fail on JS errors or broken key views.

    python scripts/site_smoke.py site screenshots/

Serves <site> on a local port, opens the main views, saves a screenshot of each, and checks
that a report's result-block "Provenance" button opens the drawer and that nothing scrolls
sideways at phone width.
"""
import functools
import http.server
import json
import sys
import threading
from pathlib import Path

from playwright.sync_api import sync_playwright



def main(site: str, out: str) -> int:
    site, out = Path(site).resolve(), Path(out)
    out.mkdir(parents=True, exist_ok=True)
    handler = functools.partial(http.server.SimpleHTTPRequestHandler, directory=str(site))
    httpd = http.server.ThreadingHTTPServer(("127.0.0.1", 0), handler)
    threading.Thread(target=httpd.serve_forever, daemon=True).start()
    base = f"http://127.0.0.1:{httpd.server_port}/"

    cat = json.loads((site / "data" / "catalog.json").read_text())
    # prefer a report with click-a-number links, so that path is exercised too
    pairs = [(s, r) for s in cat["studies"] for r in s["reports"] if r["result_blocks"]]
    study, report = next(((s, r) for s, r in pairs
                          if any(b.get("number_links") for b in r["result_blocks"])), pairs[0])
    group = next(iter(cat["wandb_groups"]))
    views = {"landing": "#/", "study": f"#/study/{study['id']}",
             "report": f"#/report/{study['id']}/{report['id']}", "health": "#/health",
             "group": f"#/group/{group}"}
    views.update({k: f"#/{k}" for k in ("timeline", "graph", "leaderboard")})
    views["history"] = f"#/history/{study['id']}/{report['id']}"

    errors, failures = [], []
    with sync_playwright() as pw:
        browser = pw.chromium.launch()
        page = browser.new_page(viewport={"width": 1280, "height": 900})
        page.on("pageerror", lambda e: errors.append(str(e)))
        page.on("console", lambda m: errors.append(m.text) if m.type == "error" else None)
        for name, hash_ in views.items():
            page.goto(base + hash_)
            page.wait_for_timeout(800)
            if page.locator("h1", has_text="Not found").count():
                failures.append(f"{name}: rendered 'Not found'")
            page.screenshot(path=str(out / f"{name}.png"))
        page.goto(base + views["report"])
        page.wait_for_timeout(800)
        page.locator(".result-block button").first.click()
        page.wait_for_timeout(300)
        if page.locator("#drawer").is_hidden():
            failures.append("drawer did not open")
        page.screenshot(path=str(out / "drawer.png"))
        if any(b.get("number_links") for b in report["result_blocks"]):
            page.locator("#drawer .drawer-close").click()
            page.locator(".num-link").first.click()
            page.wait_for_timeout(300)
            if not page.locator("#drawer", has_text="Matched by value").count():
                failures.append("number link did not open its drawer")
            page.screenshot(path=str(out / "number.png"))
        page.set_viewport_size({"width": 390, "height": 844})
        for name in ("landing", "report"):
            page.goto(base + views[name])
            page.wait_for_timeout(800)
            page.screenshot(path=str(out / f"mobile-{name}.png"))
            if page.evaluate("document.documentElement.scrollWidth > window.innerWidth + 1"):
                failures.append(f"{name}: horizontal scroll at phone width")
        browser.close()
    httpd.shutdown()
    for e in errors + failures:
        print("FAIL:", e)
    print(f"{len(views)} views rendered; {len(errors)} JS errors; {len(failures)} failures")
    return 1 if errors or failures else 0


if __name__ == "__main__":
    raise SystemExit(main(*sys.argv[1:3]))
