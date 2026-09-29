// Render docs/Auduio-Manual.html to docs/Auduio-Manual.pdf with headless Chromium (playwright)
import { chromium } from 'playwright-core';
import path from 'node:path'; import { fileURLToPath } from 'node:url';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'docs');
const browser = await chromium.launch({ executablePath: process.env.DAW_BROWSER || undefined });
const page = await browser.newPage();
await page.goto('file://' + path.join(root, 'Auduio-Manual.html'), { waitUntil: 'load' });
await page.pdf({ path: path.join(root, 'Auduio-Manual.pdf'), format: 'A4', printBackground: true, displayHeaderFooter: true,
  headerTemplate: '<span></span>',
  footerTemplate: '<div style="width:100%;font-size:8px;color:#777;padding:0 15mm;display:flex;justify-content:space-between;font-family:sans-serif"><span>Auduio User Manual</span><span><span class="pageNumber"></span> / <span class="totalPages"></span></span></div>',
  margin: { top: '16mm', bottom: '18mm', left: '15mm', right: '15mm' } });
await browser.close(); console.log('pdf written');
