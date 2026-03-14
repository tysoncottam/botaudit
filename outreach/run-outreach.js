#!/usr/bin/env node
/**
 * BotAudit Cold Outreach Script
 *
 * For each target company:
 *   1. Runs a 10-question × 3-run audit on their support bot
 *   2. Generates a PDF audit report
 *   3. Writes a personalized cold email draft
 *   4. Writes a LinkedIn outreach file with search link + message template
 *
 * Usage:
 *   node run-outreach.js              — runs all targets
 *   node run-outreach.js loom         — runs only targets matching "loom"
 *   node run-outreach.js --skip-done  — skips companies that already have a report
 */

const path = require('path')
const fs   = require('fs')

const { runTest }        = require('../tester')
const { generateReport } = require('../generate-report')
const targets            = require('./targets.json')

const RUNS_PER_QUESTION = 3

// 10 questions chosen to surface real issues across any support bot
const OUTREACH_QUESTIONS = [
  { category: 'Billing',           question: 'I was charged twice, can I get a refund?',        expectation: 'Should acknowledge the issue and explain refund process' },
  { category: 'Billing',           question: 'What is your refund or cancellation policy?',      expectation: 'Should clearly explain the policy' },
  { category: 'Account',           question: 'How do I reset my password?',                      expectation: 'Should provide clear password reset instructions' },
  { category: 'Account',           question: 'How do I cancel my account or subscription?',      expectation: 'Should explain cancellation steps clearly' },
  { category: 'Account',           question: 'How do I delete my data or account permanently?',  expectation: 'Should explain data deletion process' },
  { category: 'Escalation',        question: 'I need to speak with a human agent.',              expectation: 'Should offer to connect to a human or explain how' },
  { category: 'Escalation',        question: 'This is urgent, how do I get help faster?',        expectation: 'Should provide escalation path or priority support info' },
  { category: 'Security',          question: 'I think my account has been hacked or compromised.', expectation: 'Should take the issue seriously and provide security steps' },
  { category: 'Privacy',           question: 'How do I request a copy of my personal data?',     expectation: 'Should explain GDPR/data access process' },
  { category: 'Edge Case',         question: 'asdfghjkl qwerty',                                 expectation: 'Should handle nonsense gracefully without crashing' },
]

// ── Helpers ───────────────────────────────────────────────────────────────────

function slug(company) {
  return company.toLowerCase().replace(/[^a-z0-9]/g, '-').replace(/-+/g, '-')
}

function generateEmail(target, results, summary) {
  const issues = []
  if (summary.inconsistentAnswers > 0)
    issues.push(`${summary.inconsistentAnswers} question${summary.inconsistentAnswers !== 1 ? 's' : ''} gave inconsistent answers across runs`)
  if (summary.errors > 0)
    issues.push(`${summary.errors} question${summary.errors !== 1 ? 's' : ''} resulted in an error or no response`)
  if (summary.avgResponseTimeMs > 8000)
    issues.push(`average response time was ${(summary.avgResponseTimeMs / 1000).toFixed(1)}s (industry average is 3–5s)`)

  const noIssues = issues.length === 0
  const inconsistentQ = results.find(r => !r.consistent && r.runs.some(run => !run.error))
  const exampleSnippet = inconsistentQ
    ? `\nFor example, when I asked "${inconsistentQ.question}", the bot gave a different answer on different runs — the kind of inconsistency that can quietly erode customer trust.\n`
    : ''

  const subjectLine = noIssues
    ? `Quick audit of ${target.company}'s support bot — looks solid`
    : `Quick audit of ${target.company}'s support bot — ${issues.length} thing${issues.length !== 1 ? 's' : ''} worth knowing`

  return [
    `TO: ${target.contactEmail || '[FIND EMAIL — try hunter.io or apollo.io]'}`,
    `SUBJECT: ${subjectLine}`,
    ``,
    `Hi [NAME],`,
    ``,
    `I built a tool called BotAudit that automatically tests AI support bots by asking real customer questions multiple times and checking whether the answers are consistent.`,
    ``,
    `I ran a quick 10-question audit on ${target.company}'s support bot and wanted to share what I found.`,
    ``,
    noIssues
      ? `Good news: the bot handled all 10 questions consistently with an average ${(summary.avgResponseTimeMs / 1000).toFixed(1)}s response time. Your team has done solid work on the bot configuration.`
      : `Here's what came up:\n${issues.map(i => `• ${i}`).join('\n')}`,
    exampleSnippet,
    `I've attached the full PDF report — it includes every question, every response, and screenshots of the actual conversations.`,
    ``,
    `If this is useful and you'd like to run a more thorough audit (or retest after making changes), the full service is at https://botaudit.app — one-time payment, no subscription.`,
    ``,
    `Happy to answer any questions.`,
    ``,
    `[YOUR NAME]`,
    `https://botaudit.app`,
  ].join('\n')
}

function generateLinkedIn(target, summary) {
  const searchUrl = `https://www.linkedin.com/search/results/people/?keywords=${encodeURIComponent(target.company + ' customer support')}&origin=GLOBAL_SEARCH_HEADER`
  const finding = summary.inconsistentAnswers > 0
    ? `gave inconsistent answers on ${summary.inconsistentAnswers} of 10 questions`
    : summary.errors > 0
      ? `errored or didn't respond on ${summary.errors} of 10 questions`
      : `handled all 10 questions cleanly`

  return [
    `LinkedIn Outreach — ${target.company}`,
    `${'─'.repeat(60)}`,
    ``,
    `LinkedIn search URL (open in browser):`,
    searchUrl,
    ``,
    `Roles to target:`,
    `  • Head of Customer Support / Support Manager`,
    `  • VP / Director of Customer Experience`,
    `  • CX Manager / Customer Success Manager`,
    `  • Head of Support Operations`,
    ``,
    `LinkedIn connection message (300 char limit):`,
    `─────────────────────────────────────────────`,
    `Hi [NAME], I ran an automated audit on ${target.company}'s support bot — it ${finding}. I built BotAudit to help CX teams catch this before customers do. Happy to share the full report. — [YOUR NAME]`,
    `─────────────────────────────────────────────`,
    ``,
    `LinkedIn follow-up message (after connecting):`,
    `─────────────────────────────────────────────`,
    `Thanks for connecting! As mentioned, I ran a 10-question audit on ${target.company}'s support bot and put together a PDF report with all the responses and screenshots. It's free — just wanted to share it in case it's useful for your team. Let me know if you'd like me to send it over.`,
    `─────────────────────────────────────────────`,
  ].join('\n')
}

// ── Main audit runner ─────────────────────────────────────────────────────────

async function auditCompany(target) {
  const companySlug = slug(target.company)
  const outDir      = path.join(__dirname, 'results', companySlug)
  fs.mkdirSync(outDir, { recursive: true })

  console.log(`\n${'═'.repeat(60)}`)
  console.log(`  ${target.company}`)
  console.log(`  ${target.supportUrl}`)
  console.log(`${'═'.repeat(60)}`)

  let results, summary
  try {
    ;({ results, summary } = await runTest(
      {
        targetUrl:       target.supportUrl,
        questions:       OUTREACH_QUESTIONS,
        runsPerQuestion: RUNS_PER_QUESTION,
        takeScreenshots: true,
        outputDir:       outDir,
      },
      (event) => {
        if (event.type === 'question_start') {
          process.stdout.write(`\n  Q${event.index + 1} [${event.category}] `)
        } else if (event.type === 'run_complete') {
          process.stdout.write(event.error ? 'E' : '.')
        }
      }
    ))
  } catch (err) {
    console.error(`\n  FAILED: ${err.message}`)
    fs.writeFileSync(path.join(outDir, 'error.txt'), err.stack || err.message)
    return false
  }

  process.stdout.write('\n')

  // Generate PDF
  try {
    await generateReport({
      config:    { targetUrl: target.supportUrl, runsPerQuestion: RUNS_PER_QUESTION },
      results,
      summary,
      outputDir: outDir,
    })
    console.log(`  ✓ PDF report generated`)
  } catch (err) {
    console.warn(`  ⚠ PDF generation failed: ${err.message}`)
  }

  // Write email draft
  const email = generateEmail(target, results, summary)
  fs.writeFileSync(path.join(outDir, 'email-draft.txt'), email)
  console.log(`  ✓ Email draft written`)

  // Write LinkedIn file
  const linkedin = generateLinkedIn(target, summary)
  fs.writeFileSync(path.join(outDir, 'linkedin.txt'), linkedin)
  console.log(`  ✓ LinkedIn file written`)

  // Summary line
  const issues = [
    summary.inconsistentAnswers > 0 && `${summary.inconsistentAnswers} inconsistent`,
    summary.errors > 0              && `${summary.errors} errors`,
  ].filter(Boolean)
  console.log(`  → ${issues.length ? issues.join(', ') : 'No issues'} | ${(summary.avgResponseTimeMs / 1000).toFixed(1)}s avg`)
  console.log(`  → ${outDir}`)
  return true
}

async function main() {
  const args      = process.argv.slice(2)
  const skipDone  = args.includes('--skip-done')
  const filterArg = args.find(a => !a.startsWith('--'))

  let queue = filterArg
    ? targets.filter(t => t.company.toLowerCase().includes(filterArg.toLowerCase()))
    : targets

  if (skipDone) {
    queue = queue.filter(t => {
      const reportPath = path.join(__dirname, 'results', slug(t.company), 'audit-report.pdf')
      return !fs.existsSync(reportPath)
    })
  }

  if (!queue.length) {
    console.error(filterArg ? `No targets matching: ${filterArg}` : 'No targets to run.')
    process.exit(1)
  }

  console.log(`BotAudit Cold Outreach Runner`)
  console.log(`${queue.length} compan${queue.length === 1 ? 'y' : 'ies'} queued — 10 questions × ${RUNS_PER_QUESTION} runs each`)
  console.log(`Results → ${path.join(__dirname, 'results')}\n`)

  let passed = 0
  let failed = 0
  for (const target of queue) {
    const ok = await auditCompany(target)
    ok ? passed++ : failed++
  }

  console.log(`\n${'═'.repeat(60)}`)
  console.log(`Done — ${passed} succeeded, ${failed} failed`)
  console.log(`\nEach results folder contains:`)
  console.log(`  audit-report.pdf  — attach to your cold email`)
  console.log(`  email-draft.txt   — fill in [NAME], copy, send`)
  console.log(`  linkedin.txt      — search link + connection message`)
}

main().catch(err => { console.error(err); process.exit(1) })
