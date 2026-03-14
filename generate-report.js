'use strict'
// generate-report.js
// Takes test results + config and produces a styled PDF audit report.
// Usage: generateReport({ config, results, summary, outputDir })

const { chromium } = require('playwright')
const { pathToFileURL } = require('url')
const path = require('path')
const fs = require('fs')

// ── HTML builder ──────────────────────────────────────────────────────────────

function buildHtml({ config, results, summary, outputDir }) {
  const date = new Date().toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' })
  const targetUrl = config.targetUrl || ''
  const hostname = (() => { try { return new URL(targetUrl).hostname } catch { return targetUrl } })()
  const totalRuns = summary.totalRuns || (results.length * config.runsPerQuestion)
  const inconsistent = summary.inconsistentAnswers || 0
  const errors = summary.errors ?? summary.totalErrors ?? 0
  const avgSec = summary.avgResponseTimeMs ? (summary.avgResponseTimeMs / 1000).toFixed(1) : '—'

  // Group results by category
  const byCategory = {}
  for (const r of results) {
    const cat = r.category || 'Uncategorized'
    if (!byCategory[cat]) byCategory[cat] = []
    byCategory[cat].push(r)
  }

  // Build category rows
  const categoryRows = Object.entries(byCategory).map(([cat, qs]) => {
    const inconsistentInCat = qs.filter(q => {
      const resps = q.runs.map(r => r.response || '')
      return !resps.every(r => r === resps[0])
    }).length
    const errorInCat = qs.reduce((s, q) => s + q.runs.filter(r => r.error).length, 0)
    const statusClass = errorInCat > 0 ? 'status-fail' : inconsistentInCat > 0 ? 'status-warn' : 'status-pass'
    const statusText = errorInCat > 0 ? `${errorInCat} error${errorInCat !== 1 ? 's' : ''}` : inconsistentInCat > 0 ? `${inconsistentInCat} inconsistent` : 'Consistent'
    return `
      <tr>
        <td><strong>${esc(cat)}</strong></td>
        <td>${qs.length}</td>
        <td class="${statusClass}">${statusText}</td>
      </tr>`
  }).join('')

  // Build question detail cards
  const questionCards = results.map((r, i) => {
    const resps = r.runs.map(run => run.response || '')
    const allSame = resps.every(resp => resp === resps[0])
    const hasError = r.runs.some(run => run.error)
    const cardClass = hasError ? 'critical' : !allSame ? 'warning' : 'info'
    const badgeText = hasError ? 'Error' : !allSame ? 'Inconsistent' : 'Consistent'

    const runBlocks = r.runs.map((run, j) => {
      const text = run.error ? `ERROR: ${run.error}` : (run.response || '(no response captured)')
      const timeS = run.responseTimeMs ? (run.responseTimeMs / 1000).toFixed(1) + 's' : ''
      return `<div class="run-block"><span class="run-label">Run ${j + 1}${timeS ? ' · ' + timeS : ''}</span><div class="run-text">${esc(text)}</div></div>`
    }).join('')

    const screenshotBlock = (() => {
      if (!outputDir) return ''
      const firstRunWithScreenshot = r.runs.find(run => run.screenshotPath && fs.existsSync(path.join(outputDir, run.screenshotPath)))
      if (!firstRunWithScreenshot) return ''
      const absPath = path.join(outputDir, firstRunWithScreenshot.screenshotPath)
      return `<img class="card-screenshot" src="${pathToFileURL(absPath).href}">`
    })()

    return `
    <div class="question-card ${cardClass}">
      <div class="card-left">
        <div class="card-header">
          <span class="badge ${cardClass}">${badgeText}</span>
          <span class="card-cat">${esc(r.category || 'Uncategorized')}</span>
        </div>
        <div class="card-question">${esc(r.question)}</div>
        ${r.expectation ? `<div class="card-expectation">Expected: ${esc(r.expectation)}</div>` : ''}
        <div class="card-runs">${runBlocks}</div>
      </div>
      ${screenshotBlock}
    </div>`
  }).join('\n')

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<title>Support Bot Audit — ${esc(hostname)}</title>
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body {
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Helvetica, Arial, sans-serif;
    font-size: 13px;
    line-height: 1.6;
    color: #1a1a1a;
    background: #fff;
    padding: 28px 36px;
    max-width: 960px;
    margin: 0 auto;
  }

  /* ── HEADER ── */
  .cover {
    border-bottom: 3px solid #1a1a1a;
    padding-bottom: 20px;
    margin-bottom: 28px;
  }
  .cover-label {
    font-size: 11px;
    font-weight: 700;
    letter-spacing: 0.12em;
    text-transform: uppercase;
    color: #888;
    margin-bottom: 8px;
  }
  .cover h1 {
    font-size: 26px;
    font-weight: 800;
    line-height: 1.2;
    margin-bottom: 6px;
  }
  .cover-meta {
    font-size: 12px;
    color: #555;
    margin-top: 10px;
  }
  .cover-meta strong { color: #1a1a1a; }

  /* ── SECTION HEADINGS ── */
  h2 {
    font-size: 14px;
    font-weight: 800;
    text-transform: uppercase;
    letter-spacing: 0.08em;
    border-bottom: 2px solid #1a1a1a;
    padding-bottom: 5px;
    margin: 28px 0 14px;
  }

  /* ── SCORECARD ── */
  .scorecard {
    display: grid;
    grid-template-columns: repeat(5, 1fr);
    gap: 10px;
    margin: 14px 0 20px;
  }
  .score-box {
    border: 2px solid #e0e0e0;
    border-radius: 8px;
    padding: 10px 12px;
    text-align: center;
  }
  .score-box .num {
    font-size: 24px;
    font-weight: 900;
    line-height: 1;
    margin-bottom: 4px;
  }
  .score-box .label {
    font-size: 9px;
    font-weight: 600;
    letter-spacing: 0.07em;
    text-transform: uppercase;
    color: #666;
  }
  .score-box.blue  { border-color: #0057b7; }  .score-box.blue .num  { color: #0057b7; }
  .score-box.red   { border-color: #c8102e; }  .score-box.red .num   { color: #c8102e; }
  .score-box.amber { border-color: #e07b00; }  .score-box.amber .num { color: #e07b00; }
  .score-box.green { border-color: #1a7f3c; }  .score-box.green .num { color: #1a7f3c; }
  .score-box.dark  { border-color: #1a1a1a; }  .score-box.dark .num  { color: #1a1a1a; }

  /* ── SUMMARY TABLE ── */
  table {
    width: 100%;
    border-collapse: collapse;
    margin: 12px 0 20px;
    font-size: 12px;
  }
  th {
    background: #1a1a1a;
    color: #fff;
    font-weight: 700;
    text-transform: uppercase;
    letter-spacing: 0.06em;
    font-size: 10px;
    padding: 7px 12px;
    text-align: left;
  }
  td {
    padding: 7px 12px;
    border-bottom: 1px solid #e8e8e8;
    vertical-align: top;
  }
  tr:last-child td { border-bottom: none; }
  tr:nth-child(even) td { background: #f9f9f9; }
  .status-pass { color: #1a7f3c; font-weight: 700; }
  .status-fail { color: #c8102e; font-weight: 700; }
  .status-warn { color: #e07b00; font-weight: 700; }

  /* ── QUESTION CARDS ── */
  .question-card {
    border-left: 4px solid #ccc;
    padding: 12px 14px;
    margin: 10px 0;
    background: #fafafa;
    border-radius: 0 6px 6px 0;
    display: flex;
    gap: 14px;
    align-items: flex-start;
    page-break-inside: avoid;
  }
  .question-card.critical { border-left-color: #c8102e; background: #fff5f5; }
  .question-card.warning  { border-left-color: #e07b00; background: #fffbf0; }
  .question-card.info     { border-left-color: #0057b7; background: #f0f5ff; }

  .card-left { flex: 1; min-width: 0; }

  .card-header {
    display: flex;
    align-items: center;
    gap: 8px;
    margin-bottom: 4px;
  }
  .badge {
    font-size: 10px;
    font-weight: 700;
    letter-spacing: 0.05em;
    text-transform: uppercase;
    padding: 2px 7px;
    border-radius: 3px;
    color: #fff;
    flex-shrink: 0;
  }
  .badge.critical { background: #c8102e; }
  .badge.warning  { background: #e07b00; }
  .badge.info     { background: #0057b7; }

  .card-cat {
    font-size: 11px;
    font-weight: 600;
    color: #666;
    text-transform: uppercase;
    letter-spacing: 0.06em;
  }

  .card-question {
    font-weight: 700;
    font-size: 13px;
    margin-bottom: 4px;
  }

  .card-expectation {
    font-size: 11px;
    color: #888;
    margin-bottom: 8px;
    font-style: italic;
  }

  .run-block {
    margin-top: 6px;
    font-size: 11.5px;
  }
  .run-label {
    font-size: 10px;
    font-weight: 700;
    text-transform: uppercase;
    letter-spacing: 0.05em;
    color: #999;
  }
  .run-text {
    background: rgba(0,0,0,0.05);
    border-radius: 4px;
    padding: 5px 8px;
    margin-top: 2px;
    color: #333;
    white-space: pre-wrap;
    word-break: break-word;
  }

  .card-screenshot {
    flex-shrink: 0;
    width: 200px;
    border-radius: 6px;
    border: 1px solid #ddd;
    display: block;
  }

  /* ── FOOTER ── */
  .footer {
    margin-top: 40px;
    padding-top: 14px;
    border-top: 1px solid #ddd;
    font-size: 11px;
    color: #888;
    text-align: center;
  }

  @media print {
    h2 { page-break-after: avoid; }
    .question-card { page-break-inside: avoid; }
    .scorecard { page-break-inside: avoid; }
  }
</style>
</head>
<body>

<div class="cover">
  <div class="cover-label">Automated Audit Report</div>
  <h1>${esc(hostname)}</h1>
  <div class="cover-meta">
    <strong>Date:</strong> ${date} &nbsp;|&nbsp;
    <strong>URL:</strong> ${esc(targetUrl)} &nbsp;|&nbsp;
    <strong>Method:</strong> Playwright browser automation<br>
    <strong>Questions:</strong> ${results.length} × ${config.runsPerQuestion} runs = ${totalRuns} total interactions
  </div>
</div>

<h2>At a Glance</h2>
<div class="scorecard">
  <div class="score-box blue">
    <div class="num">${results.length}</div>
    <div class="label">Questions<br>Tested</div>
  </div>
  <div class="score-box dark">
    <div class="num">${totalRuns}</div>
    <div class="label">Total<br>Runs</div>
  </div>
  <div class="score-box ${inconsistent > 0 ? 'amber' : 'green'}">
    <div class="num">${inconsistent}</div>
    <div class="label">Inconsistent<br>Answers</div>
  </div>
  <div class="score-box ${errors > 0 ? 'red' : 'green'}">
    <div class="num">${errors}</div>
    <div class="label">Errors<br>Captured</div>
  </div>
  <div class="score-box blue">
    <div class="num">${avgSec}s</div>
    <div class="label">Avg Response<br>Time</div>
  </div>
</div>

<h2>Results by Category</h2>
<table>
  <thead>
    <tr>
      <th>Category</th>
      <th>Questions</th>
      <th>Status</th>
    </tr>
  </thead>
  <tbody>
    ${categoryRows}
  </tbody>
</table>

<h2>Question-by-Question Results</h2>
${questionCards}

<div class="footer">
  Support Bot Audit — ${esc(hostname)} &nbsp;|&nbsp; ${date}
</div>

</body>
</html>`
}

function esc(str) {
  return String(str || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

// ── PDF generator ─────────────────────────────────────────────────────────────

async function generateReport({ config, results, summary, outputDir }) {
  const html = buildHtml({ config, results, summary, outputDir })

  // Write HTML to disk (also useful for debugging)
  const htmlPath = path.join(outputDir, 'report.html')
  fs.writeFileSync(htmlPath, html)

  const pdfPath = path.join(outputDir, 'audit-report.pdf')

  const browser = await chromium.launch()
  try {
    const page = await browser.newPage()
    await page.goto(pathToFileURL(htmlPath).href, { waitUntil: 'networkidle' })
    await page.pdf({
      path: pdfPath,
      format: 'Letter',
      margin: { top: '0.3in', bottom: '0.3in', left: '0.3in', right: '0.3in' },
      printBackground: true,
    })
  } finally {
    await browser.close()
  }

  return pdfPath
}

module.exports = { generateReport }
