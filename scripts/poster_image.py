"""Render the poster PDF to the JPEG the home page and the poster view show (site/poster/).

    pip install pymupdf
    python scripts/poster_image.py <poster.pdf> site/poster/sfn2026.jpg

The PDF itself stays out of this repository and off the site (.gitignore).

One page, at 100 dpi: sharp enough to read a panel zoomed to the screen, small enough (~2.4 MB) to load on a
phone. The panel rectangles in site/home.js are in the PDF's points, so they do not depend on this resolution.
"""
import sys

import pymupdf

pdf, out = sys.argv[1:3]
page = pymupdf.open(pdf)[0]
page.get_pixmap(dpi=100).save(out, jpg_quality=82)
print(f"{out}: {page.rect.width:.0f} x {page.rect.height:.0f} pt")
