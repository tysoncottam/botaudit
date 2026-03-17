'use strict'
// ─────────────────────────────────────────────────────────────────────────────
// test-all-single.js — Run 1 question × 1 run on every target company
//
// Usage:
//   node test-all-single.js
//   HEADLESS=false node test-all-single.js
// ─────────────────────────────────────────────────────────────────────────────

const path = require('path')
const fs = require('fs')
const { runTest } = require('./tester')
const targets = require('./outreach/targets.json')

const QUESTION = {
  category: 'Billing',
  question: 'What is your refund policy?',
  expectation: 'Should explain refund process',
}

function slug(company) {
  return company.toLowerCase().replace(/[^a-z0-9]/g, '-').replace(/-+/g, '-')
}

async function testCompany(target, index) {
  const companySlug = slug(target.company)
  const outDir = path.join(__dirname, 'outreach', 'results', companySlug + '-single')
  fs.mkdirSync(outDir, { recursive: true })

  console.log(`\n${'═'.repeat(60)}`)
  console.log(`  [${index + 1}/${targets.length}] ${target.company}`)
  console.log(`  ${target.supportUrl}`)
  console.log(`  Platform: ${target.chatPlatform}`)
  console.log(`${'═'.repeat(60)}`)

  try {
    const { results, summary } = await runTest(
      {
        targetUrl: target.supportUrl,
        questions: [QUESTION],
        runsPerQuestion: 1,
        takeScreenshots: true,
        outputDir: outDir,
      },
      (event) => {
        if (event.type === 'step') {
          const labels = {
            goto: 'loading page...',
            opening_widget: 'finding widget...',
            sending_message: 'sending msg...',
            got_response: 'got response...',
          }
          if (labels[event.step]) process.stdout.write(`  ${labels[event.step]}`)
        } else if (event.type === 'run_complete') {
          console.log(event.error ? `  ERR: ${event.error}` : '  OK')
        }
      }
    )

    const response = results[0]?.runs[0]?.response || '(no response)'
    const error = results[0]?.runs[0]?.error || null

    // Save a summary file for easy review
    const report = {
      company: target.company,
      url: target.supportUrl,
      platform: target.chatPlatform,
      question: QUESTION.question,
      response: response,
      error: error,
      responseTimeMs: results[0]?.runs[0]?.responseTimeMs || null,
      timestamp: new Date().toISOString(),
    }
    fs.writeFileSync(path.join(outDir, 'single-test.json'), JSON.stringify(report, null, 2))

    // Print result
    if (error) {
      console.log(`  RESULT: ERROR — ${error}`)
    } else {
      console.log(`  RESULT: ${response.slice(0, 150)}${response.length > 150 ? '...' : ''}`)
      console.log(`  Response time: ${results[0]?.runs[0]?.responseTimeMs}ms`)
    }

    return { company: target.company, status: error ? 'ERROR' : 'OK', error }
  } catch (err) {
    console.log(`  FAILED: ${err.message}`)
    fs.writeFileSync(path.join(outDir, 'single-test.json'), JSON.stringify({
      company: target.company,
      url: target.supportUrl,
      platform: target.chatPlatform,
      question: QUESTION.question,
      error: err.message,
      timestamp: new Date().toISOString(),
    }, null, 2))
    return { company: target.company, status: 'FAILED', error: err.message }
  }
}

async function main() {
  console.log('BotAudit — Single Question Test (all targets)')
  console.log(`Question: "${QUESTION.question}"`)
  console.log(`${targets.length} companies\n`)

  const results = []
  for (let i = 0; i < targets.length; i++) {
    results.push(await testCompany(targets[i], i))
  }

  // Print scorecard
  console.log(`\n${'═'.repeat(60)}`)
  console.log('  SCORECARD')
  console.log(`${'═'.repeat(60)}`)
  const ok = results.filter(r => r.status === 'OK')
  const errors = results.filter(r => r.status !== 'OK')
  for (const r of results) {
    const icon = r.status === 'OK' ? '✓' : '✗'
    console.log(`  ${icon} ${r.company} — ${r.status}${r.error ? ` (${r.error.slice(0, 60)})` : ''}`)
  }
  console.log(`\n  ${ok.length} passed, ${errors.length} failed`)
  console.log(`  Results saved to: outreach/results/<company>-single/`)
}

main().catch(err => { console.error(err); process.exit(1) })
