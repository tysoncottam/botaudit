# Support Bot Web — Claude Context

## Project Overview

This is an Express.js web server that runs automated support bot audits against any URL that uses a Zendesk Messaging chat widget. Users configure a target URL and test questions, run the audit, and download results as a ZIP or PDF report.

---

## PDF Report Generation

### What was added

A module called `generate-report.js` was added to this project. It takes structured test results and generates a polished Letter-format PDF audit report using Playwright's headless Chromium.

### How it works

1. `buildHtml()` takes `{ config, results, summary }` and produces a fully self-contained HTML string with embedded CSS.
2. The HTML is written to `outputDir/report.html` (useful for debugging).
3. Playwright launches headless Chromium, loads the HTML as a `file://` URL, and exports a PDF to `outputDir/audit-report.pdf`.

### Data shapes expected

```js
// config
{
  targetUrl: 'https://support.example.com',
  runsPerQuestion: 3,
}

// summary
{
  totalRuns: 30,
  inconsistentAnswers: 2,
  errors: 1,           // field name from tester.js (generate-report.js accepts both errors and totalErrors)
  avgResponseTimeMs: 4200,
}

// results — array of question result objects
[
  {
    question: 'How do I reset my password?',
    category: 'Account',          // optional, defaults to 'Uncategorized'
    expectation: 'Should provide reset link',  // optional
    runs: [
      {
        response: 'Click Forgot Password on the login page.',
        responseTimeMs: 3800,
        error: null,               // string if errored, null/undefined otherwise
        screenshotPath: '/abs/path/to/screenshot.png',  // optional
      },
      // ... one entry per run
    ],
  },
  // ... one entry per question
]
```

### Report sections

- **Cover header** — hostname, date, URL, method, total interactions
- **At a Glance scorecard** — 5 boxes: Questions Tested, Total Runs, Inconsistent Answers, Errors, Avg Response Time
- **Results by Category** — table showing question count and pass/warn/fail per category
- **Question-by-Question Results** — cards color-coded blue (consistent), amber (inconsistent), red (error); each card shows all run responses and an optional screenshot

### How it's wired into server.js

In the `broadcast()` function, when `event.type === 'complete'` is received, `generateReport` is called non-blocking:

```js
const outputDir = path.join(__dirname, 'results', configId)
generateReport({ config: session.config, results: event.results, summary: event.summary, outputDir })
  .then(() => console.log(`  PDF report generated for ${configId}`))
  .catch((err) => console.warn(`  PDF generation failed for ${configId}: ${err.message}`))
```

The PDF is also included in:
- The partial file download list (`audit-report.pdf`)
- The full ZIP download bundle

### Dependencies

Playwright is already used for browser automation in this project. The `generate-report.js` module requires the Chromium browser to be installed:

```bash
npx playwright install chromium
```

---

## Audit Tester Architecture

- `tester.js` — Playwright-based bot tester. Opens fresh browser context per question run to prevent conversation memory bleed. Interacts with the Zendesk Messaging widget iframe (`#launcher`). Detects response completion via text stability (polling until content stops changing).
- `server.js` — Express server with SSE streaming for real-time progress updates to the frontend. Manages audit sessions by `configId`. Serves results as ZIP downloads.
- `generate-report.js` — PDF report generator (described above).

---

## Key Design Decisions

- **Fresh context per run**: Each question run gets a new browser context so the bot has no memory of prior questions. This tests consistency in isolation.
- **Text stability detection**: Rather than waiting for a fixed timeout, the tester polls the bot's response text until it stops changing for N consecutive checks. This handles variable response times gracefully.
- **Non-blocking PDF generation**: PDF export happens after results are broadcast to the client so the audit completion response isn't delayed.
