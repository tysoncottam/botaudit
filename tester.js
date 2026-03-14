'use strict'
// ─────────────────────────────────────────────────────────────────────────────
// tester.js — Generalized Playwright-based support bot test engine
//
// Supports: Zendesk, Intercom, Drift, Crisp, HubSpot, Freshchat, Tidio,
//           LiveChat, and generic iframe/inline chat widgets
// ─────────────────────────────────────────────────────────────────────────────

const { chromium } = require('playwright')
const fs = require('fs')
const path = require('path')

const RESPONSE_TIMEOUT_MS = 50000
const STABILITY_WAIT_MS   = 3000
const DELAY_BETWEEN_RUNS  = 2500

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// ── Chat Widget Detection & Opening ──────────────────────────────────────────

async function openChatWidget(page) {
  const strategies = [
    // ── Widget already open / auto-embedded (e.g. OpenAI help) ──
    async () => {
      const chatInputSel = 'textarea, [role="textbox"], input[type="text"][placeholder*="message" i], input[type="text"][placeholder*="type" i], input[type="text"][placeholder*="ask" i], input[type="text"][placeholder*="email" i]'
      const iframeEls = await page.locator('iframe').all()
      for (const el of iframeEls) {
        try {
          const frame = await el.contentFrame()
          if (!frame) continue
          const input = frame.locator(chatInputSel).first()
          if ((await input.count()) > 0 && (await input.isVisible())) return 'already-open'
        } catch { /* continue */ }
      }
      throw new Error('not already open')
    },

    // ── Zendesk Chat / Support Widget (classic — iframe#launcher) ──
    async () => {
      await page.waitForSelector('iframe#launcher', { timeout: 8000 })
      const launcherEl = page.locator('iframe#launcher')
      const launcherFrame = await launcherEl.contentFrame()
      if (!launcherFrame) throw new Error('no launcher frame')
      const btn = launcherFrame.locator('button').first()
      await btn.waitFor({ state: 'visible', timeout: 5000 })
      await btn.click()
      await page.waitForSelector('iframe:not(#launcher)', { timeout: 10000 }).catch(() => null)
      await sleep(3000)
      return 'zendesk'
    },

    // ── Zendesk Messaging (newer widget — div launcher, zdassets CDN) ──
    async () => {
      const sel = '[data-testid*="launcher"][data-testid*="ZE"], [class*="ze-snippet-button"], div#launcher[role="button"], div#launcher button'
      await page.waitForSelector(sel, { timeout: 5000 })
      await page.locator(sel).first().click()
      await sleep(3000)
      return 'zendesk-messaging'
    },

    // ── Intercom ──
    async () => {
      const sel = '.intercom-launcher, [class*="intercom-launcher"], [data-intercom-target="open"], .intercom-app button'
      await page.waitForSelector(sel, { timeout: 4000 })
      await page.locator(sel).first().click()
      await sleep(2500)
      return 'intercom'
    },

    // ── Intercom via iframe ──
    async () => {
      const frame = page.frameLocator('iframe[name="intercom-launcher-frame"]')
      await frame.locator('button').first().waitFor({ timeout: 3000 })
      await frame.locator('button').first().click()
      await sleep(2500)
      return 'intercom-iframe'
    },

    // ── Drift ──
    async () => {
      await page.waitForSelector('#drift-widget, iframe[title*="Drift"], [data-testid="drift-widget"]', { timeout: 4000 })
      await page.locator('#drift-widget button, iframe[title*="Drift"]').first().click()
      await sleep(2500)
      return 'drift'
    },

    // ── Crisp ──
    async () => {
      await page.waitForSelector('[class*="crisp-client"], #crisp-chatbox', { timeout: 4000 })
      await page.locator('[class*="crisp-client"] button, .cc-unoo, [class*="cc-button"]').first().click()
      await sleep(2500)
      return 'crisp'
    },

    // ── HubSpot Messages ──
    async () => {
      const containerSel = '#hubspot-messages-iframe-container'
      await page.waitForSelector(containerSel, { timeout: 4000 })
      const frame = page.frameLocator(`${containerSel} iframe`)
      await frame.locator('#launcher-button, button[aria-label*="chat" i], button').first().waitFor({ timeout: 4000 })
      await frame.locator('#launcher-button, button[aria-label*="chat" i], button').first().click()
      await sleep(2500)
      return 'hubspot'
    },

    // ── Freshchat / Freshdesk ──
    async () => {
      await page.waitForSelector('#fc_frame, .freshchat-button, [id*="freshchat"]', { timeout: 4000 })
      const frameSel = '#fc_frame'
      if (await page.locator(frameSel).count() > 0) {
        const frame = page.frameLocator(frameSel)
        await frame.locator('button').first().click()
      } else {
        await page.locator('.freshchat-button').click()
      }
      await sleep(2500)
      return 'freshchat'
    },

    // ── Tidio ──
    async () => {
      await page.waitForSelector('#tidio-chat-iframe, tidio-chat-iframe', { timeout: 4000 })
      const frame = page.frameLocator('#tidio-chat-iframe, tidio-chat-iframe')
      await frame.locator('button').first().click()
      await sleep(2500)
      return 'tidio'
    },

    // ── LiveChat ──
    async () => {
      await page.waitForSelector('#chat-widget-container, iframe[title*="LiveChat"]', { timeout: 4000 })
      const el = page.locator('#chat-widget-container button, iframe[title*="LiveChat"]').first()
      await el.click()
      await sleep(2500)
      return 'livechat'
    },

    // ── Tawk.to ──
    async () => {
      await page.waitForSelector('iframe[title*="chat widget"], #tawkchat-minified-iframe', { timeout: 4000 })
      const frame = page.frameLocator('iframe[title*="chat widget"], #tawkchat-minified-iframe')
      await frame.locator('button, [class*="widget"]').first().click()
      await sleep(2500)
      return 'tawk'
    },

    // ── Olark ──
    async () => {
      await page.waitForSelector('#olark-wrapper, #habla_topbar_div, iframe#habla_beta_nobrand_persistent_iframe', { timeout: 3000 })
      await page.locator('#olark-wrapper button, #habla_topbar_div').first().click()
      await sleep(2500)
      return 'olark'
    },

    // ── Generic: aria-label / title / class patterns ──
    async () => {
      const candidates = [
        '[aria-label*="chat" i]',
        '[aria-label*="help" i]',
        '[aria-label*="support" i]',
        '[aria-label*="message" i]',
        '[title*="chat" i]',
        '[title*="support" i]',
        'button[class*="chat" i]',
        'button[class*="support" i]',
        'div[class*="chat-button" i]',
        'div[class*="chatbot" i]',
        'div[class*="chat-widget" i]',
        '[data-testid*="chat" i]',
        '[data-widget*="chat" i]',
      ]
      for (const sel of candidates) {
        try {
          const el = page.locator(sel).first()
          if ((await el.count()) > 0 && (await el.isVisible())) {
            await el.click()
            await sleep(2500)
            return `generic:${sel}`
          }
        } catch { /* continue */ }
      }
      throw new Error('no generic match')
    },
  ]

  for (let i = 0; i < strategies.length; i++) {
    try {
      const result = await strategies[i]()
      console.log(`  [widget] opened via strategy ${i} (${result})`)
      return result
    } catch { /* try next */ }
  }

  throw new Error(
    'Could not find or open a chat widget on this page. ' +
    'Supported platforms: Zendesk, Intercom, Drift, Crisp, HubSpot, Freshchat, Tidio, LiveChat, Tawk.to, Olark, and generic widgets. ' +
    'Make sure the chat widget is visible on the page you entered.'
  )
}

// ── Pre-chat Email Fill ───────────────────────────────────────────────────────

async function fillPreChatEmail(page, email, bodyLocator = null) {
  if (!email) return
  const emailSel = 'input[type="email"], input[name*="email" i], input[placeholder*="email" i]'
  const submitSel = 'button[type="submit"], button:has-text("Confirm"), button:has-text("Continue"), button:has-text("Start"), button:has-text("Submit"), button:has-text("Send")'

  async function tryFill(context) {
    try {
      const emailInput = context.locator(emailSel).first()
      if ((await emailInput.count()) === 0) return false
      await emailInput.fill(email)
      await sleep(500)
      const submitBtn = context.locator(submitSel).first()
      if ((await submitBtn.count()) > 0) {
        await submitBtn.click()
      } else {
        await emailInput.press('Enter')
      }
      await sleep(2000)
      return true
    } catch { return false }
  }

  // Try the chat body's own frame context first (where Intercom renders the email form)
  if (bodyLocator && await tryFill(bodyLocator)) return

  // Check all iframes
  const iframeEls = await page.locator('iframe').all()
  for (const el of iframeEls) {
    const id = await el.getAttribute('id').catch(() => '')
    if (id === 'launcher') continue
    try {
      const frame = await el.contentFrame()
      if (!frame) continue
      if (await tryFill(frame.locator('body'))) return
    } catch { /* continue */ }
  }

  // Check page-level
  await tryFill(page.locator('body'))
}

// ── Pre-chat Step Execution ───────────────────────────────────────────────────

async function executePreChatSteps(page, steps) {
  for (const stepText of steps) {
    // Search main page and all iframes for a button/element matching the text
    let clicked = false

    // Try main page first
    try {
      const el = page.locator(`button, [role="button"], a`).filter({ hasText: new RegExp(stepText, 'i') }).first()
      if ((await el.count()) > 0 && (await el.isVisible())) {
        await el.click()
        await sleep(1500)
        clicked = true
      }
    } catch { /* continue */ }

    // Try all iframes
    if (!clicked) {
      const iframeEls = await page.locator('iframe').all()
      for (const iframeEl of iframeEls) {
        try {
          const frame = await iframeEl.contentFrame()
          if (!frame) continue
          const el = frame.locator(`button, [role="button"], a`).filter({ hasText: new RegExp(stepText, 'i') }).first()
          if ((await el.count()) > 0 && (await el.isVisible())) {
            await el.click()
            await sleep(1500)
            clicked = true
            break
          }
        } catch { /* continue */ }
      }
    }

    if (!clicked) {
      console.warn(`  Pre-chat step: could not find button matching "${stepText}"`)
    }
  }
}

// ── Find the Chat Input ───────────────────────────────────────────────────────

async function getChatInputContext(page, maxWaitMs = 12000) {
  // Matches text inputs only — intentionally excludes email/tel/password/number
  // to prevent accidentally targeting hero sign-up forms
  const chatInputSel = [
    '[contenteditable="true"]',
    'textarea:not([readonly]):not([aria-hidden="true"])',
    'input[type="text"]:not([readonly]):not([aria-hidden="true"])',
    'input:not([type]):not([readonly]):not([aria-hidden="true"])',
  ].join(', ')

  const deadline = Date.now() + maxWaitMs

  while (Date.now() < deadline) {
    // ── Check all iframes (most chat widgets render in iframes) ──────────────
    const iframeEls = await page.locator('iframe').all()
    for (const el of iframeEls) {
      const id    = await el.getAttribute('id').catch(() => '')
      const title = await el.getAttribute('title').catch(() => '')
      if (id === 'launcher') continue
      try {
        const frame = await el.contentFrame()
        if (!frame) continue

        const inputCount = await frame.locator(chatInputSel).count()
        if (inputCount > 0) {
          return { frame, input: frame.locator(chatInputSel).last(), bodyLocator: frame.locator('body') }
        }

        // No input yet — widget may be showing a routing menu.
        // Auto-click the first visible button to advance past it.
        try {
          const btns = frame.locator('button, [role="button"]').filter({ visible: true })
          const btnCount = await btns.count()
          if (btnCount > 0 && btnCount <= 6) {
            await btns.first().click({ force: true, timeout: 2000 }).catch(() => {})
            await sleep(1200)
          }
        } catch { /* ignore routing click errors */ }
      } catch { /* cross-origin or detached — skip */ }
    }

    // ── Also check page-level chat containers (non-iframe widgets) ───────────
    const widgetContainers = [
      '[id*="chat"]:not(script)',
      '[class*="chat-widget"]',
      '[class*="chatbox"]',
      '[data-widget*="chat"]',
    ]
    for (const sel of widgetContainers) {
      try {
        const container = page.locator(sel).first()
        if ((await container.count()) === 0) continue
        const input = container.locator(chatInputSel).first()
        if ((await input.count()) > 0 && (await input.isVisible())) {
          return { frame: null, input, bodyLocator: page.locator('body') }
        }
        // Auto-click routing buttons within the widget container
        try {
          const btns = container.locator('button, [role="button"]').filter({ visible: true })
          const btnCount = await btns.count()
          if (btnCount > 0 && btnCount <= 6) {
            await btns.first().click({ force: true, timeout: 2000 }).catch(() => {})
            await sleep(1200)
          }
        } catch { /* ignore routing click errors */ }
      } catch { /* continue */ }
    }

    await sleep(600)
  }

  throw new Error(
    'Could not find the chat input field. The widget may require pre-chat steps (e.g. selecting a department). ' +
    'Try adding a Pre-chat step with the button text to click before the conversation starts.'
  )
}

// ── Send Message & Capture Response ──────────────────────────────────────────

async function sendMessageAndGetReply(page, message, preChatEmail = '') {
  const { input, bodyLocator } = await getChatInputContext(page)

  await input.waitFor({ state: 'attached', timeout: 5000 })
  await input.click({ force: true })
  await input.fill(message)

  // Snapshot text before sending
  const textBefore = await bodyLocator.innerText().catch(() => '')

  await input.press('Enter')
  await sleep(3000)

  // Wait for "typing" indicator (up to 12s)
  const typingDeadline = Date.now() + 12000
  while (Date.now() < typingDeadline) {
    await sleep(500)
    const t = await bodyLocator.innerText().catch(() => '')
    if (t.toLowerCase().includes('typing') || t.includes('...')) break
  }
  await sleep(1000)

  // Stability loop — wait until text stops changing for STABILITY_WAIT_MS
  let lastText = ''
  let stableAt = null
  let emailFilled = false
  let textLenAtEmailFill = 0
  const deadline = Date.now() + RESPONSE_TIMEOUT_MS

  while (Date.now() < deadline) {
    await sleep(800)
    const t = await bodyLocator.innerText().catch(() => '')

    // Mid-conversation email prompt — detect if bot is asking for email and fill it
    if (preChatEmail && !emailFilled) {
      const emailSel = 'input[type="email"], input[name*="email" i], input[placeholder*="email" i]'
      const emailTextTriggers = ['enter your email', 'email to continue', 'provide your email', 'your email address', 'enter email']
      const bodyMentionsEmail = emailTextTriggers.some(trigger => t.toLowerCase().includes(trigger))

      let emailVisible = false
      // Check bodyLocator frame first — the email form renders in the same frame as the chat
      try {
        const ei = bodyLocator.locator(emailSel).first()
        if ((await ei.count()) > 0) emailVisible = true
      } catch { /* ignore */ }

      if (!emailVisible) {
        try {
          const iframeEls = await page.locator('iframe').all()
          for (const iframeEl of iframeEls) {
            const frame = await iframeEl.contentFrame().catch(() => null)
            if (!frame) continue
            const ei = frame.locator(emailSel).first()
            if ((await ei.count()) > 0 && (await ei.isVisible())) { emailVisible = true; break }
          }
        } catch { /* ignore */ }
      }

      if (!emailVisible) {
        try {
          const ei = page.locator(emailSel).first()
          if ((await ei.count()) > 0 && (await ei.isVisible())) emailVisible = true
        } catch { /* ignore */ }
      }

      // Trigger fill if input found, or if text clearly signals email is needed and text has stabilized
      if (emailVisible || (bodyMentionsEmail && stableAt && Date.now() - stableAt > 1000)) {
        await fillPreChatEmail(page, preChatEmail, bodyLocator).catch(() => {})
        emailFilled = true
        textLenAtEmailFill = t.length
        stableAt = null
        lastText = t
        await sleep(3000)
        continue
      }
    }

    if (t.toLowerCase().includes('is typing')) {
      lastText = t
      stableAt = null
    } else if (t !== lastText) {
      lastText = t
      stableAt = null
    } else {
      if (!stableAt) stableAt = Date.now()
      // After email fill, don't break until text has grown meaningfully past the ACK (~80 chars)
      const waitingForRealResponse = emailFilled && t.length < textLenAtEmailFill + 80
      if (!waitingForRealResponse && Date.now() - stableAt >= STABILITY_WAIT_MS) break
    }
  }

  // ── Parse the bot's reply ─────────────────────────────────────────────────
  let reply = ''

  // Strategy 1: "Support Bot says:" / "Bot says:" / "[Name] says:" markers
  const sayMarkers = [
    'Support Bot says:', 'Bot says:', 'Agent says:',
    'Virtual Assistant says:', 'Assistant says:', 'Support says:',
  ]
  for (const marker of sayMarkers) {
    if (lastText.includes(marker)) {
      const beforeCount = textBefore.split(marker).length - 1
      const parts = lastText.split(marker)
      const newBlocks = parts.slice(beforeCount + 1)
      reply = newBlocks
        .map((block) =>
          block
            .split('\n')
            .map((l) => l.trim())
            .filter((l) => l && !l.match(/^(Just now|just now|\d+:\d+|Sent|Type a message|Yes|No|Did that answer|Was that information helpful|Send a message)$/))
            .join(' ')
            .trim()
        )
        .filter(Boolean)
        .join(' | ')
      if (reply) break
    }
  }

  // Strategy 2: New text that appeared after sending
  if (!reply) {
    const beforeLines = new Set(textBefore.split('\n').map((l) => l.trim()).filter(Boolean))
    const afterLines = lastText.split('\n').map((l) => l.trim()).filter(Boolean)
    const newLines = afterLines.filter(
      (l) =>
        !beforeLines.has(l) &&
        l.length > 8 &&
        !l.match(/^\d+:\d+$/) &&
        !l.match(/^(Just now|just now|Sent|Type a message|Yes|No|Send a message)$/) &&
        !l.toLowerCase().includes('is typing') &&
        l !== message
    )
    if (newLines.length > 0) {
      reply = newLines.join(' ').trim().substring(0, 3000)
    }
  }

  // Strategy 3: Everything after the user's message in the transcript
  if (!reply && lastText.includes(message)) {
    const afterMsg = lastText.slice(lastText.lastIndexOf(message) + message.length)
    reply = afterMsg
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => l && l.length > 8 && l !== message)
      .join(' ')
      .trim()
      .substring(0, 3000)
  }

  return reply || '(no response captured)'
}

// ── Main Test Runner ──────────────────────────────────────────────────────────

async function runTest(config, onProgress) {
  const {
    targetUrl,
    questions,
    runsPerQuestion = 3,
    takeScreenshots = true,
    outputDir,
    preChatSteps = [],
    preChatEmail = '',
  } = config

  const screenshotDir = outputDir ? path.join(outputDir, 'screenshots') : null
  if (takeScreenshots && screenshotDir) fs.mkdirSync(screenshotDir, { recursive: true })

  const total = questions.length * runsPerQuestion
  onProgress({ type: 'start', total, questions: questions.length, runs: runsPerQuestion })

  const browser = await chromium.launch({ headless: process.env.HEADLESS !== 'false' })
  const results = []
  let completed = 0

  try {
    for (let i = 0; i < questions.length; i++) {
      const { category, question, expectation } = questions[i]
      onProgress({ type: 'question_start', index: i, total: questions.length, category, question })

      const runs = []

      for (let run = 0; run < runsPerQuestion; run++) {
        onProgress({ type: 'run_start', questionIndex: i, run, runsPerQuestion })

        const context = await browser.newContext({
          userAgent:
            'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
          viewport: { width: 1280, height: 800 },
        })
        const page = await context.newPage()
        const startTime = Date.now()
        let response = null
        let error = null
        let screenshotPath = null
        let screenshotBase64 = null

        try {
          onProgress({ type: 'step', step: 'goto', url: targetUrl })
          await page.goto(targetUrl, { waitUntil: 'domcontentloaded', timeout: 30000 })
          await sleep(2500)

          // Debug: dump iframe names/IDs so we know what the page loaded
          const iframes = await page.locator('iframe').all()
          for (const f of iframes) {
            const id   = await f.getAttribute('id').catch(() => '')
            const name = await f.getAttribute('name').catch(() => '')
            const src  = await f.getAttribute('src').catch(() => '')
            onProgress({ type: 'debug', msg: `iframe id="${id}" name="${name}" src="${(src||'').slice(0,80)}"` })
          }

          onProgress({ type: 'step', step: 'opening_widget' })
          await openChatWidget(page)
          if (preChatEmail) {
            onProgress({ type: 'step', step: 'pre_chat_email' })
            await fillPreChatEmail(page, preChatEmail)
          }
          if (preChatSteps.length > 0) {
            onProgress({ type: 'step', step: 'pre_chat_steps' })
            await executePreChatSteps(page, preChatSteps)
          }
          onProgress({ type: 'step', step: 'sending_message', message: question })
          response = await sendMessageAndGetReply(page, question, preChatEmail)
          onProgress({ type: 'step', step: 'got_response', response })

          if (takeScreenshots && screenshotDir) {
            const filename = `q${String(i + 1).padStart(2, '0')}_run${run + 1}.png`
            screenshotPath = path.join('screenshots', filename)
            const fullPath = path.join(screenshotDir, filename)
            await page.screenshot({ path: fullPath, fullPage: false })
            const buf = fs.readFileSync(fullPath)
            screenshotBase64 = `data:image/png;base64,${buf.toString('base64')}`
          }
        } catch (err) {
          error = err.message
        }

        completed++

        const runResult = {
          response,
          error,
          responseTimeMs: Date.now() - startTime,
          screenshotPath,
          screenshotBase64,
          timestamp: new Date().toISOString(),
        }

        runs.push(runResult)
        onProgress({
          type: 'run_complete',
          questionIndex: i,
          run,
          response,
          error,
          responseTimeMs: runResult.responseTimeMs,
          screenshotBase64,
          completed,
          total,
        })

        await context.close()
        if (run < runsPerQuestion - 1) await sleep(DELAY_BETWEEN_RUNS)
      }

      const responses = runs.map((r) => r.response || '')
      const consistent = responses.every((r) => r === responses[0])

      const result = { category, question, expectation, runs, consistent }
      results.push(result)

      // Emit result data (strip base64 — screenshots already sent per run_complete)
      const runsForEvent = runs.map(({ screenshotBase64, ...rest }) => rest)
      onProgress({
        type: 'question_complete',
        questionIndex: i,
        consistent,
        totalQuestions: questions.length,
        result: { category, question, expectation, runs: runsForEvent, consistent },
      })
    }
  } finally {
    await browser.close()
  }

  // ── Save results to disk ──────────────────────────────────────────────────

  // JSON (strip base64 screenshots — those are in files already)
  const jsonResults = results.map((r) => ({
    ...r,
    runs: r.runs.map(({ screenshotBase64, ...rest }) => rest),
  }))
  if (outputDir) fs.writeFileSync(path.join(outputDir, 'results.json'), JSON.stringify(jsonResults, null, 2))

  // CSV
  const header = [
    '#', 'Category', 'Question', 'Expected Behavior',
    ...Array.from({ length: runsPerQuestion }, (_, i) => `Run ${i + 1} Response`),
    'Consistent?', 'Avg Response Time (s)',
  ]
  if (takeScreenshots) {
    header.push(...Array.from({ length: runsPerQuestion }, (_, i) => `Run ${i + 1} Screenshot`))
  }

  const rows = results.map((r, i) => {
    const resps = r.runs.map((run) => run.response || run.error || '(error)')
    const avgTime = (r.runs.reduce((s, run) => s + run.responseTimeMs, 0) / r.runs.length / 1000).toFixed(1)
    const row = [
      i + 1,
      `"${r.category}"`,
      `"${r.question.replace(/"/g, '""')}"`,
      `"${(r.expectation || '').replace(/"/g, '""')}"`,
      ...resps.map((resp) => `"${resp.replace(/"/g, '""')}"`),
      r.consistent ? 'Yes' : 'NO — INCONSISTENT',
      avgTime,
    ]
    if (takeScreenshots) {
      row.push(...r.runs.map((run) => `"${run.screenshotPath || ''}"`))
    }
    return row
  })

  const csv = [header, ...rows].map((r) => r.join(',')).join('\n')
  if (outputDir) fs.writeFileSync(path.join(outputDir, 'results.csv'), csv)

  // Summary
  const totalRuns   = results.length * runsPerQuestion
  const noResponses = results.reduce((s, r) => s + r.runs.filter(
    (run) => run.error || !run.response || run.response === '(no response captured)'
  ).length, 0)
  const summary = {
    totalQuestions: results.length,
    totalRuns,
    inconsistentAnswers: results.filter((r) => !r.consistent).length,
    errors: results.reduce((s, r) => s + r.runs.filter((run) => run.error).length, 0),
    noResponses,
    refundEligible: noResponses / totalRuns >= 0.5,
    avgResponseTimeMs:
      results.reduce((s, r) => s + r.runs.reduce((s2, run) => s2 + run.responseTimeMs, 0), 0) /
      totalRuns,
    completedAt: new Date().toISOString(),
  }
  if (outputDir) fs.writeFileSync(path.join(outputDir, 'summary.json'), JSON.stringify(summary, null, 2))

  onProgress({ type: 'complete', results, summary })
  return { results, summary }
}

// ── Bot reachability pre-flight check ────────────────────────────────────────
async function checkBot({ targetUrl, preChatSteps = [], preChatEmail = '' }) {
  const headless = process.env.HEADLESS !== 'false'
  const browser = await chromium.launch({ headless })
  const context = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    viewport: { width: 1280, height: 800 },
  })
  const page = await context.newPage()

  try {
    await page.goto(targetUrl, { waitUntil: 'domcontentloaded', timeout: 30000 })
    await sleep(4000)

    const strategy = await openChatWidget(page)
    await sleep(2000)

    // Specific named strategies (Zendesk, Intercom, etc.) are trusted as-is.
    // Generic strategies match too broadly (e.g. any "help" link), so we do
    // a quick 6s check for an actual chat input to confirm a widget is present.
    const isGeneric = strategy.startsWith('generic:')
    if (isGeneric) {
      // If there's a pre-chat email flow, complete it before checking for the chat input
      if (preChatEmail) {
        await fillPreChatEmail(page, preChatEmail)
        await sleep(2000)
      }

      // Also execute any pre-chat steps (button clicks to advance past menus)
      if (preChatSteps.length > 0) {
        await executePreChatSteps(page, preChatSteps)
        await sleep(1000)
      }

      const chatInputSel = 'textarea, [role="textbox"], input[type="text"], input[type="email"], input:not([type])'
      let inputFound = false
      for (const frame of page.frames()) {
        try {
          const count = await frame.locator(chatInputSel).count()
          if (count > 0) { inputFound = true; break }
        } catch { /* cross-origin — skip */ }
      }
      if (!inputFound) {
        const count = await page.locator(chatInputSel).count()
        inputFound = count > 0
      }
      // Fallback: detect cross-origin chat iframes by src/title/name attributes
      if (!inputFound) {
        const iframes = await page.locator('iframe').all()
        for (const iframe of iframes) {
          const src   = (await iframe.getAttribute('src').catch(() => ''))  || ''
          const title = (await iframe.getAttribute('title').catch(() => '')) || ''
          const name  = (await iframe.getAttribute('name').catch(() => ''))  || ''
          if (/chat|widget|intercom|zendesk|zdassets|support|messenger|crisp|drift|tidio/i.test(src + title + name)) {
            inputFound = true
            break
          }
        }
      }
      if (!inputFound) return { reachable: false, error: 'No chat widget input found' }
    }

    return { reachable: true, strategy }
  } catch (err) {
    return { reachable: false, error: err.message }
  } finally {
    await context.close().catch(() => {})
    await browser.close().catch(() => {})
  }
}

module.exports = { runTest, checkBot }
