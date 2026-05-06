'use strict'
// generate-report.js
// Takes test results + config and produces a styled PDF audit report.
// Usage: generateReport({ config, results, summary, outputDir })

const { chromium } = require('playwright')
const { pathToFileURL } = require('url')
const path = require('path')
const fs = require('fs')
const { computeGrades } = require('./grader')

// ── HTML builder ──────────────────────────────────────────────────────────────

function buildHtml({ config, results, summary, outputDir }) {
  config = config || {}
  results = Array.isArray(results) ? results : []
  summary = summary || {}

  const date = new Date().toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' })
  const targetUrl = config.targetUrl || ''
  const hostname = (() => {
    try { return new URL(targetUrl).hostname || targetUrl }
    catch { return targetUrl || '(unknown target)' }
  })()
  const runsPerQuestion = Number(config.runsPerQuestion) > 0 ? Number(config.runsPerQuestion) : 1
  const totalRuns = summary.totalRuns || (results.length * runsPerQuestion)
  const errors = summary.errors ?? 0
  const avgSec = summary.avgResponseTimeMs ? (summary.avgResponseTimeMs / 1000).toFixed(1) : '—'

  // Compute grades
  const grades = computeGrades(results, summary)

  // Build category bar chart rows
  const categoryEntries = Object.entries(grades.categoryGrades || {})
  const categoryBars = categoryEntries.map(([cat, g]) => `
    <div class="bar-row">
      <span class="bar-label">${esc(cat)}</span>
      <div class="bar-track">
        <div class="bar-fill" style="width: ${Math.max(0, Math.min(100, Number(g.score) || 0))}%; background: ${g.color};">${esc(g.grade)} (${esc(g.score)})</div>
      </div>
    </div>
  `).join('')

  // Build recommendation cards
  const recs = Array.isArray(grades.recommendations) ? grades.recommendations : []
  const recommendationCards = recs.map(rec => {
    const priority = (rec.priority || 'low').toLowerCase()
    const color = priority === 'high' ? '#c8102e' : priority === 'medium' ? '#e07b00' : '#0057b7'
    return `
    <div class="rec-card" style="border-left-color: ${color};">
      <span class="rec-priority" style="color: ${color};">${esc(priority.toUpperCase())}</span>
      <strong>${esc(rec.title || '')}</strong>
      <p>${esc(rec.text || '')}</p>
    </div>`
  }).join('')

  // Similarity breakdown numbers
  const identical = summary.identical || 0
  const equivalent = summary.semanticallyEquivalent || 0
  const variable = summary.partiallySimilar || 0
  const contradictory = summary.contradictory || 0

  // Build question detail cards
  const questionCards = results.map((r) => {
    const runs = Array.isArray(r.runs) ? r.runs : []
    const hasError = runs.some(run => run && run.error)

    // Determine badge from similarity classification
    let badgeText, cardClass
    if (hasError) {
      badgeText = 'Error'; cardClass = 'critical'
    } else if (r.similarity) {
      const cls = r.similarity.classification
      if (cls === 'identical') { badgeText = 'Identical'; cardClass = 'info' }
      else if (cls === 'semantically_equivalent') { badgeText = 'Equivalent'; cardClass = 'success' }
      else if (cls === 'partially_similar') { badgeText = 'Variable'; cardClass = 'warning' }
      else if (cls === 'contradictory') { badgeText = 'Contradictory'; cardClass = 'critical' }
      else { badgeText = r.consistent ? 'Consistent' : 'Inconsistent'; cardClass = r.consistent ? 'info' : 'warning' }
    } else {
      badgeText = r.consistent ? 'Consistent' : 'Inconsistent'
      cardClass = r.consistent ? 'info' : 'warning'
    }

    // Quality badge
    const qAvg = r.quality && Number.isFinite(r.quality.average) ? r.quality.average : 0
    const qualityBadge = qAvg > 0
      ? `<span class="quality-badge" style="background: ${qAvg >= 3.5 ? '#1a7f3c' : qAvg >= 2.5 ? '#e07b00' : '#c8102e'};">${qAvg.toFixed(1)}/5</span>`
      : ''

    // Quality flags
    const qScores = r.quality && Array.isArray(r.quality.scores) ? r.quality.scores : []
    const flagSet = [...new Set(qScores.flatMap(s => Array.isArray(s.flags) ? s.flags : []))]
    const flagChips = flagSet.map(f => {
      const label = String(f).replace(/_/g, ' ')
      const chipColor = f === 'deflection' ? '#c8102e' : f === 'escalation_offered' ? '#e07b00' : '#1a7f3c'
      return `<span class="flag-chip" style="color: ${chipColor}; border-color: ${chipColor};">${esc(label)}</span>`
    }).join('')

    const runBlocks = runs.map((run, j) => {
      const text = run.error ? `ERROR: ${run.error}` : (run.response || '(no response captured)')
      const timeS = run.responseTimeMs ? (run.responseTimeMs / 1000).toFixed(1) + 's' : ''
      return `<div class="run-block"><span class="run-label">Run ${j + 1}${timeS ? ' · ' + timeS : ''}</span><div class="run-text">${esc(text)}</div></div>`
    }).join('')

    const screenshotBlock = (() => {
      if (!outputDir) return ''
      const firstRunWithScreenshot = runs.find(run =>
        run && run.screenshotPath && fs.existsSync(path.join(outputDir, run.screenshotPath))
      )
      if (!firstRunWithScreenshot) return ''
      const absPath = path.join(outputDir, firstRunWithScreenshot.screenshotPath)
      const altText = `Screenshot of bot response to: ${(r.question || '').slice(0, 80)}`
      return `<img class="card-screenshot" src="${esc(pathToFileURL(absPath).href)}" alt="${esc(altText)}">`
    })()

    return `
    <div class="question-card ${cardClass}">
      <div class="card-left">
        <div class="card-header">
          <span class="badge ${cardClass}">${badgeText}</span>
          ${qualityBadge}
          <span class="card-cat">${esc(r.category || 'Uncategorized')}</span>
        </div>
        <div class="card-question">${esc(r.question)}</div>
        ${r.expectation ? `<div class="card-expectation">Expected: ${esc(r.expectation)}</div>` : ''}
        ${flagChips ? `<div class="card-flags">${flagChips}</div>` : ''}
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
    display: flex;
    justify-content: space-between;
    align-items: flex-start;
  }
  .cover-left { flex: 1; }
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

  .grade-badge {
    flex-shrink: 0;
    width: 90px;
    height: 90px;
    border-radius: 50%;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    color: #fff;
    margin-left: 20px;
  }
  .grade-badge .grade-letter {
    font-size: 36px;
    font-weight: 900;
    line-height: 1;
  }
  .grade-badge .grade-score {
    font-size: 11px;
    font-weight: 600;
    opacity: 0.9;
  }

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

  /* ── EXECUTIVE SUMMARY ── */
  .exec-summary {
    background: #f8f9fa;
    border-radius: 8px;
    padding: 16px 20px;
    margin: 14px 0 20px;
    font-size: 13px;
    line-height: 1.7;
    color: #333;
  }

  /* ── RECOMMENDATIONS ── */
  .rec-card {
    border-left: 4px solid #ccc;
    padding: 10px 14px;
    margin: 8px 0;
    background: #fafafa;
    border-radius: 0 6px 6px 0;
    page-break-inside: avoid;
  }
  .rec-card p { margin-top: 4px; font-size: 12px; color: #444; }
  .rec-priority {
    font-size: 10px;
    font-weight: 800;
    letter-spacing: 0.08em;
    margin-right: 8px;
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

  /* ── BAR CHART ── */
  .bar-row { display: flex; align-items: center; margin: 6px 0; }
  .bar-label { width: 110px; font-size: 12px; font-weight: 600; flex-shrink: 0; }
  .bar-track { flex: 1; background: #eee; border-radius: 4px; height: 24px; }
  .bar-fill {
    height: 100%;
    border-radius: 4px;
    color: #fff;
    font-size: 11px;
    font-weight: 700;
    display: flex;
    align-items: center;
    padding: 0 10px;
    min-width: 60px;
  }

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
  .question-card.success  { border-left-color: #1a7f3c; background: #f0faf0; }

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
  .badge.success  { background: #1a7f3c; }

  .quality-badge {
    font-size: 10px;
    font-weight: 700;
    padding: 2px 6px;
    border-radius: 3px;
    color: #fff;
    flex-shrink: 0;
  }

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
    margin-bottom: 6px;
    font-style: italic;
  }

  .card-flags { margin-bottom: 6px; }
  .flag-chip {
    font-size: 10px;
    font-weight: 600;
    border: 1px solid;
    padding: 1px 6px;
    border-radius: 3px;
    margin-right: 4px;
    text-transform: capitalize;
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

  /* ── METHODOLOGY ── */
  .methodology {
    font-size: 11px;
    color: #666;
    line-height: 1.7;
    margin-top: 14px;
  }
  .methodology strong { color: #444; }

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
    .rec-card { page-break-inside: avoid; }
  }
</style>
</head>
<body>

<!-- ── COVER ── -->
<div class="cover">
  <div class="cover-left">
    <div class="cover-label">BotAudit — Automated Audit Report</div>
    <h1>${esc(hostname)}</h1>
    <div class="cover-meta">
      <strong>Date:</strong> ${date} &nbsp;|&nbsp;
      <strong>URL:</strong> ${esc(targetUrl)}<br>
      <strong>Method:</strong> Playwright browser automation &nbsp;|&nbsp;
      <strong>Questions:</strong> ${results.length} × ${runsPerQuestion} runs = ${totalRuns} total interactions
    </div>
  </div>
  <div class="grade-badge" style="background: ${grades.overallColor};">
    <div class="grade-letter">${grades.overallGrade}</div>
    <div class="grade-score">${grades.overallScore}/100</div>
  </div>
</div>

<!-- ── EXECUTIVE SUMMARY ── -->
<h2>Executive Summary</h2>
<div class="exec-summary">
  ${esc(grades.executiveSummary)}
</div>

${recs.length > 0 ? `
<h2>Top Recommendations</h2>
${recommendationCards}
` : ''}

<!-- ── SCORECARD ── -->
<h2>At a Glance</h2>
<div class="scorecard">
  <div class="score-box blue">
    <div class="num">${results.length}</div>
    <div class="label">Questions<br>Tested</div>
  </div>
  <div class="score-box green">
    <div class="num">${identical + equivalent}</div>
    <div class="label">Consistent<br>Answers</div>
  </div>
  <div class="score-box ${variable + contradictory > 0 ? 'amber' : 'green'}">
    <div class="num">${variable + contradictory}</div>
    <div class="label">Variable /<br>Contradictory</div>
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

<!-- ── CATEGORY BREAKDOWN ── -->
${categoryEntries.length > 0 ? `<h2>Performance by Category</h2>
${categoryBars}` : ''}

<!-- ── QUESTION DETAILS ── -->
${results.length > 0 ? `<h2>Question-by-Question Results</h2>
${questionCards}` : ''}

<!-- ── METHODOLOGY ── -->
<h2>Methodology</h2>
<div class="methodology">
  <strong>How this audit works:</strong> Each question was sent to the live chat widget ${runsPerQuestion} time${runsPerQuestion > 1 ? 's' : ''} using a real browser (Playwright). Each run used a fresh browser session — no conversation history carried over — to test whether the bot gives consistent answers to the same question asked independently.<br><br>
  <strong>Consistency scoring:</strong> Responses are compared using semantic similarity analysis (token-based cosine similarity), not exact string matching. This means responses that convey the same information with different wording are correctly classified as "Equivalent" rather than "Inconsistent."<br><br>
  <strong>Quality scoring:</strong> Each response is evaluated on a 1-5 scale based on topic relevance, actionable guidance, empathy, and whether the bot provided specific steps or just deflected to a help page.<br><br>
  <strong>Grading:</strong> The overall grade (A-F) is computed from consistency (40%), response quality (40%), and reliability (20%). Category grades use the same formula applied to questions within each category.
</div>

<div class="footer">
  BotAudit — ${esc(hostname)} &nbsp;|&nbsp; ${date} &nbsp;|&nbsp; botaudit.app
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

  const browser = await chromium.launch({ args: ['--no-sandbox', '--disable-setuid-sandbox'] })
  try {
    const page = await browser.newPage()
    // Local file URL — `load` is sufficient and faster than `networkidle`
    // (no remote requests are made; embedded screenshots are file:// URIs).
    await page.goto(pathToFileURL(htmlPath).href, { waitUntil: 'load' })
    await page.emulateMedia({ media: 'print' })
    await page.pdf({
      path: pdfPath,
      format: 'Letter',
      margin: { top: '0.3in', bottom: '0.3in', left: '0.3in', right: '0.3in' },
      printBackground: true,
      preferCSSPageSize: false,
    })
  } finally {
    await browser.close()
  }

  return pdfPath
}

module.exports = { generateReport }
