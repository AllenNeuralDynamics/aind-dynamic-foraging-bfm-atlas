"""bfm-atlas command line: build the catalog from a studies checkout."""
from __future__ import annotations

import argparse
import json
from collections import Counter
from pathlib import Path

from .catalog import build_catalog, copy_figures


def main(argv: list[str] | None = None) -> int:
    p = argparse.ArgumentParser(prog="bfm-atlas")
    sub = p.add_subparsers(dest="cmd", required=True)
    b = sub.add_parser("build", help="write catalog.json from a studies checkout")
    b.add_argument("--studies", type=Path, required=True, help="studies repository checkout")
    b.add_argument("--out", type=Path, default=Path("site/data/catalog.json"))
    b.add_argument("--no-validate", action="store_true",
                   help="skip running the studies checker (findings are then absent)")
    b.add_argument("--no-figures", action="store_true",
                   help="do not copy report figures to <out dir>/files/")
    b.add_argument("--allow-dirty", action="store_true",
                   help="build from a checkout with local changes (recorded as studies_git_dirty)")
    b.add_argument("--skills", type=Path, default=None,
                   help="the dispatcher's skills pack (aind-behavior-foundation-model-skills/), for the About page")
    args = p.parse_args(argv)

    catalog = build_catalog(args.studies, validate=not args.no_validate, allow_dirty=args.allow_dirty,
                            skills_dir=args.skills)
    args.out.parent.mkdir(parents=True, exist_ok=True)
    args.out.write_text(json.dumps(catalog, ensure_ascii=False, separators=(",", ":")))
    figures = 0 if args.no_figures else copy_figures(catalog, args.studies, args.out.parent / "files")
    h = catalog["health"]
    levels = dict(Counter(f.get("level") for f in h["findings"]))
    print(f"wrote {args.out}: {len(catalog['studies'])} studies @ "
          f"{(catalog['_meta']['studies_git_sha'] or 'unknown')[:12]}, "
          f"{args.out.stat().st_size // 1024} KiB, {figures} figures; checker "
          + (f"{levels}" if h["ran"] else f"not run ({h['error']})"))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
