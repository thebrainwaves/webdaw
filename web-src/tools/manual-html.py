# Build docs/Auduio-Manual.html from docs/Auduio-Manual.md (print-ready; tools/manual-pdf.mjs turns it into the PDF)
import markdown, pathlib, re
root = pathlib.Path(__file__).resolve().parent.parent / 'docs'
md = (root / 'Auduio-Manual.md').read_text(encoding='utf-8')
body = markdown.markdown(md, extensions=['meta', 'tables', 'toc', 'sane_lists', 'attr_list'], extension_configs={'toc': {'toc_depth': '2-2'}})
# each top-level section starts on a new page
body = re.sub(r'<h2', '<h2 class="brk"', body)
css = """
@page { size: A4; margin: 16mm 15mm 18mm; }
* { box-sizing: border-box; }
body { font-family: 'DejaVu Sans', 'Liberation Sans', Arial, sans-serif; font-size: 11.5pt; line-height: 1.55; color: #1c1826; margin: 0; }
h1 { font-size: 30pt; color: #5b2a9e; margin: 0 0 4mm; letter-spacing: -0.5px; border-bottom: 3px solid #d7263d; padding-bottom: 3mm; }
h2 { font-size: 19pt; color: #5b2a9e; margin: 0 0 3mm; padding-bottom: 1.5mm; border-bottom: 2px solid #e7dcf7; }
h2.brk { page-break-before: always; }
h3 { font-size: 13.5pt; color: #b21e33; margin: 5mm 0 2mm; page-break-after: avoid; }
p, li { orphans: 3; widows: 3; }
img { max-width: 100%; max-height: 118mm; display: block; margin: 3mm auto; border: 1px solid #d9cfe8; border-radius: 6px; box-shadow: 0 1px 4px rgba(60,20,110,.15); page-break-inside: avoid; }
p:has(> img) { text-align: center; page-break-inside: avoid; }
table { border-collapse: collapse; width: 100%; margin: 3mm 0; font-size: 10.5pt; page-break-inside: auto; }
tr { page-break-inside: avoid; }
th { background: #5b2a9e; color: #fff; text-align: left; padding: 2mm 2.5mm; }
td { border-bottom: 1px solid #e3dbef; padding: 1.8mm 2.5mm; vertical-align: top; }
tr:nth-child(even) td { background: #faf7fe; }
code, kbd { font-family: 'DejaVu Sans Mono', monospace; background: #f1ebfa; padding: 0 1.2mm; border-radius: 3px; font-size: 10pt; }
blockquote { margin: 3mm 0; padding: 2mm 4mm; border-left: 4px solid #d7263d; background: #fdf3f5; }
strong { color: #2a1847; }
.toc ul { list-style: none; padding-left: 4mm; } .toc > ul { padding-left: 0; }
.toc a { color: #1c1826; text-decoration: none; }
a { color: #5b2a9e; }
"""
html = f"""<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Auduio User Manual</title><style>{css}</style></head><body>{body}</body></html>"""
(root / 'Auduio-Manual.html').write_text(html, encoding='utf-8')
print('ok', len(html))
