'use strict'
// ─────────────────────────────────────────────────────────────────────────────
// tester.js — Generalized Playwright-based support bot test engine
//
// Supports: Zendesk, Intercom, Drift, Crisp, HubSpot, Freshchat, Tidio,
//           LiveChat, Tawk.to, Olark, Zoom Contact Center, Gorgias,
//           and generic iframe/inline chat widgets
// ─────────────────────────────────────────────────────────────────────────────

const { chromium } = require('playwright')
const fs = require('fs')
const path = require('path')
const { classifyConsistency } = require('./similarity')
const { scoreQuestion } = require('./quality-scorer')

const RESPONSE_TIMEOUT_MS = 50000
const STABILITY_WAIT_MS   = 3000
const DELAY_BETWEEN_RUNS  = 2500

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// ── Dismiss Overlays (cookie banners, popups, modals) ───────────────────────

async function dismissOverlays(page) {
  // ── Phase 1: Cookie banners ──────────────────────────────────────────────
  // Try specific IDs first (most reliable), then text-based selectors
  const cookieSelectors = [
    '#onetrust-accept-btn-handler',
    '#onetrust-reject-all-handler',
    '#CybotCookiebotDialogBodyLevelButtonLevelOptinAllowAll',
    '[data-testid="cookie-accept"]',
    '[class*="cookie"] button',
    '[id*="cookie"] button',
    '[class*="consent"] button',
    '[id*="consent"] button',
    'button:has-text("Accept All")',
    'button:has-text("Accept Cookies")',
    'button:has-text("Allow All")',
    'button:has-text("Reject All")',
    'button:has-text("Got It")',
    'button:has-text("I Agree")',
    'a:has-text("Accept All")',
  ]

  for (const sel of cookieSelectors) {
    try {
      const el = page.locator(sel).first()
      if ((await el.count()) > 0 && (await el.isVisible({ timeout: 500 }))) {
        console.log(`  [overlay] dismissed cookie banner via: ${sel}`)
        await el.click({ timeout: 2000 })
        await sleep(500)
        break
      }
    } catch { /* continue */ }
  }

  // ── Phase 2: Bounce Exchange / marketing popups (covers full page) ─────
  // These use extreme z-index values and shroud/matte overlays
  try {
    const bxClose = await page.evaluate(() => {
      // Bounce Exchange close buttons inside their popups
      const closeBtn = document.querySelector('.bx-slab .bx-close, [class*="bx-close"], .bx-row .bx-button[data-click="close"]')
      if (closeBtn) { closeBtn.click(); return true }
      // Nuclear option: remove the shroud AND slab entirely
      let removed = false
      for (const sel of ['.bx-shroud', '.bx-slab', '.bx-matte']) {
        document.querySelectorAll(sel).forEach(el => { el.remove(); removed = true })
      }
      return removed
    })
    if (bxClose) { console.log('  [overlay] removed Bounce Exchange popup/shroud'); await sleep(500) }
  } catch { /* continue */ }

  // ── Phase 2b: Nuclear — remove any non-chat fixed element with extreme z-index ──
  // Some sites layer multiple overlays; this catches anything still blocking
  try {
    const nuked = await page.evaluate(() => {
      const chatKeywords = /chat|intercom|zendesk|livesdk|drift|crisp|hubspot|freshchat|tidio|tawk|olark|gorgias/i
      const removed = []
      for (const el of document.querySelectorAll('*')) {
        const style = window.getComputedStyle(el)
        const z = parseInt(style.zIndex) || 0
        if (z < 100000 || style.position !== 'fixed') continue
        const id = el.id || ''
        const cls = typeof el.className === 'string' ? el.className : ''
        if (chatKeywords.test(id + ' ' + cls)) continue
        const rect = el.getBoundingClientRect()
        // Only remove large overlays (full-page or near-full-page)
        if (rect.width > 400 && rect.height > 300) {
          removed.push(`<${el.tagName.toLowerCase()}> id="${id}" class="${cls.slice(0, 40)}" z=${z}`)
          el.remove()
        }
      }
      return removed
    })
    if (nuked.length > 0) console.log(`  [overlay] nuked ${nuked.length} high-z overlay(s): ${nuked.join(', ')}`)
  } catch { /* continue */ }

  // ── Phase 3: Promotional modals / popups ───────────────────────────────
  const modalCloseSelectors = [
    '[aria-label="Close" i]',
    '[aria-label="Dismiss" i]',
    'button[class*="close" i]',
    'button[class*="dismiss" i]',
    '[class*="modal"] button[class*="close" i]',
    '[class*="popup"] button[class*="close" i]',
    '[class*="overlay"] button[class*="close" i]',
    '[class*="modal"] [aria-label="Close" i]',
    'a:has-text("Decline Offer")',
    'a:has-text("No Thanks")',
    'a:has-text("No thanks")',
    'button:has-text("No Thanks")',
    'button:has-text("No thanks")',
    'button:has-text("Decline Offer")',
    'button:has-text("Close")',
  ]

  for (const sel of modalCloseSelectors) {
    try {
      const el = page.locator(sel).first()
      if ((await el.count()) > 0 && (await el.isVisible({ timeout: 500 }))) {
        // Make sure this isn't a chat widget button
        const parent = await el.evaluate(node => {
          const p = node.closest('[id*="chat" i], [class*="chat" i], [id*="intercom" i], [class*="intercom" i], [id*="zendesk" i], [class*="livesdk" i], [id*="ada-" i], [id*="forethought" i], [id*="qualified" i], [class*="ada-" i]')
          return p ? true : false
        }).catch(() => false)
        if (parent) { console.log(`  [overlay] skipped modal close (inside chat widget): ${sel}`); continue }

        console.log(`  [overlay] dismissed modal via: ${sel}`)
        await el.click({ timeout: 2000 })
        await sleep(500)
        break
      }
    } catch { /* continue */ }
  }
}

// ── Chat Widget Detection & Opening ──────────────────────────────────────────

async function openChatWidget(page, preChatEmail) {
  // ── Fast fingerprint: detect which platform is present ──────────────────
  // This avoids the ~50s sequential timeout cascade of trying every platform
  const detected = await page.evaluate(() => {
    const html = document.documentElement.innerHTML
    const scripts = [...document.querySelectorAll('script[src]')].map(s => s.src).join(' ')
    const iframes = [...document.querySelectorAll('iframe')]
    const iframeSrcs = iframes.map(f => (f.src || '') + (f.id || '') + (f.name || '') + (f.title || '')).join(' ')
    const all = (html + ' ' + scripts + ' ' + iframeSrcs).toLowerCase()

    // Check DOM presence of known markers
    const markers = {
      'zendesk':        !!document.querySelector('iframe#launcher') || all.includes('zdassets'),
      'zendesk-msg':    !!document.querySelector('[data-testid*="launcher"][data-testid*="ZE"], div#launcher[role="button"]'),
      'intercom':       all.includes('intercom') || !!document.querySelector('.intercom-launcher, iframe[name="intercom-launcher-frame"]'),
      'drift':          all.includes('drift') || !!document.querySelector('#drift-widget'),
      'crisp':          all.includes('crisp') || !!document.querySelector('[class*="crisp-client"]'),
      'hubspot':        !!document.querySelector('#hubspot-messages-iframe-container'),
      'freshchat':      all.includes('freshchat') || !!document.querySelector('#fc_frame'),
      'tidio':          all.includes('tidio') || !!document.querySelector('#tidio-chat-iframe'),
      'livechat':       all.includes('livechatinc') || !!document.querySelector('#chat-widget-container'),
      'tawk':           all.includes('tawk') || !!document.querySelector('#tawkchat-minified-iframe'),
      'olark':          all.includes('olark') || !!document.querySelector('#olark-wrapper'),
      'zoom-cc':        all.includes('zoom.us') || !!document.querySelector('#zoom-contactcenter-chat-root'),
      'gorgias':        all.includes('gorgias') || !!document.querySelector('[id*="gorgias"]'),
      'qualified':      !!document.querySelector('iframe#q-messenger-frame, iframe[title*="Qualified"]'),
      'forethought':    all.includes('forethought') || !!document.querySelector('iframe#forethought-chat'),
      'ada':            all.includes('ada.support') || !!document.querySelector('iframe#ada-chat-frame, iframe#ada-button-frame, iframe[id*="ada-"]'),
    }
    return Object.entries(markers).filter(([, v]) => v).map(([k]) => k)
  })

  console.log(`  [widget] detected platforms: ${detected.length ? detected.join(', ') : 'none — trying generic'}`)

  // ── Build strategy list: detected platforms first, then generic ────────
  const allStrategies = {
    // ── Widget already open / auto-embedded (e.g. OpenAI help) ──
    'already-open': async () => {
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
    'zendesk': async () => {
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
    'zendesk-msg': async () => {
      const sel = '[data-testid*="launcher"][data-testid*="ZE"], [class*="ze-snippet-button"], div#launcher[role="button"], div#launcher button'
      await page.waitForSelector(sel, { timeout: 5000 })
      await page.locator(sel).first().click()
      await sleep(3000)
      return 'zendesk-messaging'
    },

    // ── Intercom ──
    'intercom': async () => {
      // Try direct selector first, then iframe launcher
      const sel = '.intercom-launcher, [class*="intercom-launcher"], [data-intercom-target="open"], .intercom-app button'
      const directCount = await page.locator(sel).count()
      if (directCount > 0) {
        await page.locator(sel).first().click()
        await sleep(3000)
        if (page.isClosed()) throw new Error('Intercom navigated away from page')
      } else {
        // Try the launcher iframe
        const launcherFrame = page.frameLocator('iframe[name="intercom-launcher-frame"]')
        try {
          await launcherFrame.locator('button').first().waitFor({ timeout: 5000 })
          await launcherFrame.locator('button').first().click()
          await sleep(3000)
        } catch {
          // Try the Intercom messenger iframe directly (pre-opened)
          const messengerFrame = page.frameLocator('iframe[name="intercom-messenger-frame"]')
          try {
            const count = await messengerFrame.locator('button, textarea, [contenteditable]').count()
            if (count > 0) return 'intercom-messenger'
          } catch { /* continue */ }
          throw new Error('Intercom launcher not found')
        }
      }

      // After opening, Intercom often shows a help center / home view first
      // Navigate to the chat/compose view by clicking "Messages" tab then "Send us a message"

      // Wait for the Intercom frame to expand from 1x1 (tracker) to full messenger size
      const messengerSel = 'iframe[name="intercom-messenger-frame"], iframe[id="intercom-frame"], iframe[title*="Intercom" i], iframe[name*="intercom" i]'
      const expandDeadline = Date.now() + 8000
      let intercomExpanded = false
      while (Date.now() < expandDeadline) {
        const iframes = await page.locator(messengerSel).all()
        for (const f of iframes) {
          const box = await f.boundingBox().catch(() => null)
          if (box && box.width > 100 && box.height > 100) {
            console.log(`  [intercom] messenger frame expanded: ${Math.round(box.width)}x${Math.round(box.height)}`)
            intercomExpanded = true
            break
          }
        }
        if (intercomExpanded) break
        await sleep(500)
      }
      await sleep(1000)

      // Use frameLocator (works with cross-origin iframes) instead of contentFrame
      const msgFrame = page.frameLocator(messengerSel)

      // Step 1: Click "Messages" tab in the bottom navigation
      const tabSelectors = [
        '[aria-label="Messages" i]',
        'button:has-text("Messages")',
        'a:has-text("Messages")',
        '[data-testid*="messages"]',
      ]
      let navigated = false
      for (const tabSel of tabSelectors) {
        try {
          const tab = msgFrame.locator(tabSel).first()
          if ((await tab.count()) > 0 && (await tab.isVisible())) {
            console.log(`  [intercom] clicking Messages tab: ${tabSel}`)
            await tab.click({ timeout: 3000 })
            await sleep(2000)
            navigated = true
            break
          }
        } catch { /* continue */ }
      }
      if (!navigated) console.log('  [intercom] no Messages tab found — may already be on chat view')

      // Step 2: Click "Send us a message" / compose / new conversation button
      const chatNavSelectors = [
        'a:has-text("Send us a message")',
        'a:has-text("Send a message")',
        'button:has-text("Send us a message")',
        'button:has-text("Send a message")',
        'button:has-text("Chat with us")',
        'button:has-text("New conversation")',
        'button:has-text("Start a conversation")',
        '[aria-label*="new conversation" i]',
        '[aria-label*="compose" i]',
        '[aria-label*="write a message" i]',
        '[data-testid*="new-conversation"]',
        '[data-testid*="compose"]',
      ]
      for (const navSel of chatNavSelectors) {
        try {
          const btn = msgFrame.locator(navSel).first()
          if ((await btn.count()) > 0 && (await btn.isVisible())) {
            console.log(`  [intercom] navigating to chat via: ${navSel}`)
            await btn.click({ timeout: 3000 })
            await sleep(2000)
            break
          }
        } catch { /* continue */ }
      }
      return 'intercom'
    },

    // ── Drift ──
    'drift': async () => {
      // Drift can be slow to render — give it up to 10s
      const driftSel = '#drift-widget, iframe[title*="Drift" i], [data-testid="drift-widget"], #drift-frame, .drift-widget-controller'
      await page.waitForSelector(driftSel, { timeout: 10000 })
      // Try clicking the iframe controller first, then fallback to buttons
      const iframe = page.locator('iframe[title*="Drift" i], #drift-frame').first()
      if ((await iframe.count()) > 0 && (await iframe.isVisible())) {
        const frame = await iframe.contentFrame()
        if (frame) {
          const btn = frame.locator('button, [role="button"]').first()
          if ((await btn.count()) > 0) {
            await btn.click({ timeout: 3000 })
            await sleep(2500)
            return 'drift-iframe'
          }
        }
      }
      await page.locator('#drift-widget button, .drift-widget-controller button').first().click()
      await sleep(2500)
      return 'drift'
    },

    // ── Crisp ──
    'crisp': async () => {
      await page.waitForSelector('[class*="crisp-client"], #crisp-chatbox', { timeout: 4000 })
      await page.locator('[class*="crisp-client"] button, .cc-unoo, [class*="cc-button"]').first().click()
      await sleep(2500)
      return 'crisp'
    },

    // ── HubSpot Messages ──
    'hubspot': async () => {
      const containerSel = '#hubspot-messages-iframe-container'
      await page.waitForSelector(containerSel, { timeout: 4000 })
      const frame = page.frameLocator(`${containerSel} iframe`)
      await frame.locator('#launcher-button, button[aria-label*="chat" i], button').first().waitFor({ timeout: 4000 })
      await frame.locator('#launcher-button, button[aria-label*="chat" i], button').first().click()
      await sleep(2500)
      return 'hubspot'
    },

    // ── Freshchat / Freshdesk ──
    'freshchat': async () => {
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
    'tidio': async () => {
      await page.waitForSelector('#tidio-chat-iframe, tidio-chat-iframe', { timeout: 4000 })
      const frame = page.frameLocator('#tidio-chat-iframe, tidio-chat-iframe')
      await frame.locator('button').first().click()
      await sleep(2500)
      return 'tidio'
    },

    // ── LiveChat ──
    'livechat': async () => {
      await page.waitForSelector('#chat-widget-container, iframe[title*="LiveChat"]', { timeout: 4000 })
      const el = page.locator('#chat-widget-container button, iframe[title*="LiveChat"]').first()
      await el.click()
      await sleep(2500)
      return 'livechat'
    },

    // ── Tawk.to ──
    'tawk': async () => {
      await page.waitForSelector('iframe[title*="chat widget"], #tawkchat-minified-iframe', { timeout: 4000 })
      const frame = page.frameLocator('iframe[title*="chat widget"], #tawkchat-minified-iframe')
      await frame.locator('button, [class*="widget"]').first().click()
      await sleep(2500)
      return 'tawk'
    },

    // ── Olark ──
    'olark': async () => {
      await page.waitForSelector('#olark-wrapper, #habla_topbar_div, iframe#habla_beta_nobrand_persistent_iframe', { timeout: 3000 })
      await page.locator('#olark-wrapper button, #habla_topbar_div').first().click()
      await sleep(2500)
      return 'olark'
    },

    // ── Zoom Contact Center (Shadow DOM widget) ──
    'zoom-cc': async () => {
      // Root container loads early but is hidden (0px) — use 'attached' not 'visible'
      await page.waitForSelector('#zoom-contactcenter-chat-root', { state: 'attached', timeout: 4000 })
      // Wait for the invitation button to render — it lives at page level, not in shadow DOM
      // Must use Playwright .click() (real mouse event), not DOM .click() (synthetic event)
      const launcherSel = '.livesdk__invitation, [aria-label="Open chat dialog"]'
      const launcherDeadline = Date.now() + 8000
      let clicked = false
      while (Date.now() < launcherDeadline) {
        try {
          const btn = page.locator(launcherSel).first()
          if ((await btn.count()) > 0 && (await btn.isVisible())) {
            await btn.click({ timeout: 2000 })
            clicked = true
            break
          }
        } catch { /* not ready yet */ }
        await sleep(500)
      }
      if (!clicked) throw new Error('Zoom CC launcher not clickable')
      await sleep(3000)

      // Fill the pre-chat form (lives in shadow DOM) with test values
      // Wait up to 5s for the form to render in the shadow DOM
      const formDeadline = Date.now() + 5000
      let formFound = false
      while (Date.now() < formDeadline) {
        formFound = await page.evaluate(() => {
          for (const el of document.querySelectorAll('*')) {
            if (!el.shadowRoot) continue
            if (el.shadowRoot.querySelector('input[placeholder*="First Name" i], .livesdk__welcome-button')) return true
          }
          return false
        })
        if (formFound) break
        await sleep(500)
      }

      if (formFound) {
        console.log('  [zoom-cc] filling pre-chat form...')
        await page.evaluate((email) => {
          function fillShadowInput(placeholder, value) {
            for (const el of document.querySelectorAll('*')) {
              if (!el.shadowRoot) continue
              const input = el.shadowRoot.querySelector(`input[placeholder*="${placeholder}" i]`)
              if (input) {
                const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set
                setter.call(input, value)
                input.dispatchEvent(new Event('input', { bubbles: true }))
                input.dispatchEvent(new Event('change', { bubbles: true }))
                return true
              }
            }
            return false
          }
          fillShadowInput('First Name', 'Test')
          fillShadowInput('Last Name', 'Audit')
          fillShadowInput('Email', email || 'audit@botaudit.app')
        }, preChatEmail || 'audit@botaudit.app')
        await sleep(500)

        // Select language dropdown (custom role="select" input)
        await page.evaluate(() => {
          for (const el of document.querySelectorAll('*')) {
            if (!el.shadowRoot) continue
            const input = el.shadowRoot.querySelector('input[placeholder*="Language" i], input[role="select"]')
            if (input) { input.click(); return }
          }
        })
        await sleep(800)
        await page.evaluate(() => {
          for (const el of document.querySelectorAll('*')) {
            if (!el.shadowRoot) continue
            const option = el.shadowRoot.querySelector('.zmsdk__select-card-item')
            if (option) { option.click(); return }
          }
        })
        await sleep(800)

        // Click the submit button
        await page.evaluate(() => {
          for (const el of document.querySelectorAll('*')) {
            if (!el.shadowRoot) continue
            const btn = el.shadowRoot.querySelector('.livesdk__welcome-button')
            if (btn && !btn.disabled) { btn.click(); return }
          }
        })
        await sleep(4000)
        console.log('  [zoom-cc] pre-chat form submitted')
      } else {
        console.log('  [zoom-cc] no pre-chat form detected, proceeding directly')
      }

      // Verify the chat textarea is actually visible (not 0x0 / collapsed)
      // If the window collapsed after form submit, re-click the launcher to expand it
      const inputVisible = await page.evaluate(() => {
        for (const host of document.querySelectorAll('*')) {
          if (!host.shadowRoot) continue
          const ta = host.shadowRoot.querySelector('textarea[placeholder*="message" i], textarea')
          if (ta) {
            const rect = ta.getBoundingClientRect()
            return rect.width > 0 && rect.height > 0
          }
        }
        return false
      })

      if (!inputVisible) {
        console.log('  [zoom-cc] chat window collapsed after form submit — re-clicking launcher')
        const launcherSel2 = '.livesdk__invitation, [aria-label="Open chat dialog"], .livesdk__Draggable'
        const reopenDeadline = Date.now() + 6000
        while (Date.now() < reopenDeadline) {
          try {
            const btn = page.locator(launcherSel2).first()
            if ((await btn.count()) > 0 && (await btn.isVisible())) {
              await btn.click({ timeout: 2000 })
              console.log('  [zoom-cc] re-clicked launcher')
              await sleep(3000)
              break
            }
          } catch { /* not ready */ }
          await sleep(500)
        }

        // Check again — the window might need the chat SDK to fully initialize
        const inputNow = await page.evaluate(() => {
          for (const host of document.querySelectorAll('*')) {
            if (!host.shadowRoot) continue
            const ta = host.shadowRoot.querySelector('textarea[placeholder*="message" i], textarea')
            if (ta) {
              const rect = ta.getBoundingClientRect()
              return { w: rect.width, h: rect.height, ph: ta.placeholder }
            }
          }
          return null
        })
        console.log(`  [zoom-cc] textarea after reopen: ${inputNow ? `${inputNow.w}x${inputNow.h} placeholder="${inputNow.ph}"` : 'not found'}`)
      } else {
        console.log('  [zoom-cc] chat textarea is visible')
      }

      return 'zoom-contactcenter'
    },

    // ── Gorgias ──
    'gorgias': async () => {
      const gorgiasBtn = '#gorgias-chat-container, [id*="gorgias"], [class*="gorgias"]'
      await page.waitForSelector(gorgiasBtn, { timeout: 4000 })
      const el = page.locator(gorgiasBtn).first()
      const tagName = await el.evaluate(n => n.tagName.toLowerCase()).catch(() => '')
      if (tagName === 'iframe') {
        const frame = page.frameLocator(gorgiasBtn)
        await frame.locator('button').first().click({ timeout: 3000 })
      } else {
        await el.click()
      }
      await sleep(2500)
      return 'gorgias'
    },

    // ── Qualified ──
    'qualified': async () => {
      const sel = 'iframe#q-messenger-frame, iframe[title*="Qualified"]'
      await page.waitForSelector(sel, { state: 'visible', timeout: 8000 })
      const frame = page.frameLocator(sel)

      // Qualified often shows routing buttons first ("I need customer support", etc.)
      // Click through support/help routing options to reach the chat input
      const routingSelectors = [
        'button:has-text("customer support")',
        'button:has-text("support")',
        'button:has-text("help")',
        'button:has-text("question")',
        'a:has-text("customer support")',
        'a:has-text("support")',
        'a:has-text("help")',
      ]
      try {
        for (const routeSel of routingSelectors) {
          const btn = frame.locator(routeSel).first()
          if ((await btn.count()) > 0 && (await btn.isVisible())) {
            console.log(`  [qualified] clicking routing option: ${routeSel}`)
            await btn.click({ timeout: 3000 })
            await sleep(3000)
            break
          }
        }
      } catch { /* cross-origin — proceed anyway */ }

      // Check if there's now a text input
      try {
        const inputCount = await frame.locator('textarea, input[type="text"], [contenteditable="true"]').count()
        if (inputCount > 0) {
          console.log('  [qualified] chat input found after routing')
          return 'qualified'
        }
      } catch { /* cross-origin */ }

      // If still no input, click the messenger iframe to activate it
      await page.locator(sel).first().click()
      await sleep(2500)
      return 'qualified'
    },

    // ── Forethought AI ──
    'forethought': async () => {
      const sel = 'iframe#forethought-chat, iframe[title*="Virtual Assistant"]'
      await page.waitForSelector(sel, { state: 'visible', timeout: 8000 })
      // Forethought widget is usually already visible — check for input inside
      const frame = page.frameLocator(sel)
      try {
        // Look for a text input or a "Ask a question" button
        const input = frame.locator('textarea, input[type="text"], [contenteditable="true"]')
        if ((await input.count()) > 0) {
          console.log('  [forethought] widget already has input')
          return 'forethought'
        }
        // Try clicking the widget to expand it
        const btn = frame.locator('button, [role="button"]').first()
        if ((await btn.count()) > 0) {
          await btn.click({ timeout: 3000 })
          await sleep(2000)
        }
      } catch { /* cross-origin */ }
      return 'forethought'
    },

    // ── Ada ──
    'ada': async () => {
      const btnFrameSel = 'iframe#ada-button-frame, iframe[title*="Chat Button" i]'
      const chatFrameSel = 'iframe#ada-chat-frame, iframe[title*="ada-chat" i]'

      // Check if chat frame is already open (e.g. from generic strategy click)
      try {
        const chatVisible = await page.locator(chatFrameSel).first().isVisible().catch(() => false)
        if (chatVisible) {
          console.log('  [ada] chat frame already open')
          return 'ada'
        }
      } catch { /* continue */ }

      // Try clicking the Ada button frame to open the chat
      try {
        await page.waitForSelector(btnFrameSel, { timeout: 8000 })
        const btnFrame = page.frameLocator(btnFrameSel)
        const btn = btnFrame.locator('button, [role="button"]').first()
        await btn.waitFor({ state: 'visible', timeout: 5000 })
        await btn.click({ timeout: 3000 })
        console.log('  [ada] clicked button frame')
        await sleep(3000)
        // Wait for chat frame
        await page.waitForSelector(chatFrameSel, { state: 'visible', timeout: 10000 })
        console.log('  [ada] chat frame opened')
        return 'ada'
      } catch (e) {
        console.log(`  [ada] button frame approach failed: ${e.message.slice(0, 60)}`)
      }

      // Fallback: try clicking page-level Ada elements (some sites render a launcher outside iframes)
      try {
        const launcher = page.locator('[class*="ada-embed"], [id*="ada-"] button, [title*="chat" i]').first()
        if ((await launcher.count()) > 0 && (await launcher.isVisible())) {
          await launcher.click()
          await sleep(3000)
          await page.waitForSelector(chatFrameSel, { state: 'visible', timeout: 8000 })
          console.log('  [ada] chat frame opened via page-level launcher')
          return 'ada'
        }
      } catch { /* continue */ }

      // Last fallback: check if chat frame appeared anyway
      try {
        await page.waitForSelector(chatFrameSel, { state: 'visible', timeout: 5000 })
        return 'ada'
      } catch { /* no ada chat */ }
      throw new Error('Ada widget not clickable')
    },
  }

  // ── Generic fallback (always tried last) ──────────────────────────────
  async function genericStrategy() {
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
  }

  // ── Run: always try already-open first, then detected platforms, then generic ──
  const tryOrder = ['already-open', ...detected]
  for (const name of tryOrder) {
    const fn = allStrategies[name]
    if (!fn) continue
    try {
      const result = await fn()
      console.log(`  [widget] opened via ${name} (${result})`)
      return result
    } catch { /* try next */ }
  }

  // Try generic fallback
  try {
    const result = await genericStrategy()
    console.log(`  [widget] opened via generic (${result})`)
    return result
  } catch { /* no match */ }

  throw new Error(
    'Could not find or open a chat widget on this page. ' +
    'Supported platforms: Zendesk, Intercom, Drift, Crisp, HubSpot, Freshchat, Tidio, LiveChat, Tawk.to, Olark, Zoom Contact Center, Gorgias, Qualified, Forethought, Ada, and generic widgets. ' +
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
      // type() simulates real keystrokes so React/Vue controlled inputs see the
      // change events that fill() bypasses. Click + clear first so we don't append
      // to a pre-populated field.
      await emailInput.click()
      await emailInput.fill('')
      await emailInput.type(email, { delay: 15 })
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
  let loopCount = 0

  while (Date.now() < deadline) {
    loopCount++
    if (loopCount === 1 || loopCount % 5 === 0) {
      console.log(`  [input] searching... (attempt ${loopCount}, ${Math.round((deadline - Date.now()) / 1000)}s left)`)
    }

    // ── Dismiss in-widget consent dialogs (terms, privacy notices, GDPR) ────
    // These appear inside chat widget iframes and block the input until dismissed
    if (loopCount <= 3) {
      const consentSelectors = [
        'button:has-text("Ok")',
        'button:has-text("OK")',
        'button:has-text("Accept")',
        'button:has-text("I agree")',
        'button:has-text("Got it")',
        'button:has-text("Continue")',
        'button:has-text("Agree")',
        'button:has-text("Dismiss")',
        '[aria-label="Dismiss" i]',
        '[aria-label="Close" i]',
      ]
      // Check all iframes for consent dialogs
      const iframeEls = await page.locator('iframe').all()
      for (const iframeEl of iframeEls) {
        try {
          const frame = await iframeEl.contentFrame()
          if (!frame) continue
          const bodyText = await frame.locator('body').innerText().catch(() => '')
          // Only try consent buttons if the frame mentions privacy/terms/consent
          if (!/privacy|terms|consent|monitor|retain|heads-up|cookie/i.test(bodyText)) continue
          for (const cSel of consentSelectors) {
            try {
              const btn = frame.locator(cSel).first()
              if ((await btn.count()) > 0 && (await btn.isVisible())) {
                console.log(`  [input] dismissed in-widget consent dialog: ${cSel}`)
                await btn.click({ timeout: 2000 })
                await sleep(1500)
                break
              }
            } catch { /* continue */ }
          }
        } catch { /* continue */ }
      }
    }

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
          // Check if input is actually visible (not behind a routing/help view)
          const lastInput = frame.locator(chatInputSel).last()
          const isVisible = await lastInput.isVisible().catch(() => false)
          if (isVisible) {
            console.log(`  [input] found in iframe id="${id}" title="${title}" (${inputCount} inputs, visible)`)
            return { frame, input: lastInput, bodyLocator: frame.locator('body') }
          }
          // Input exists but hidden — try clicking "Send a message", "Chat", or routing buttons to reveal it
          console.log(`  [input] found in iframe id="${id}" but not visible — trying to navigate to chat view`)
          const chatNavSelectors = [
            'button:has-text("Send us a message")',
            'button:has-text("Send a message")',
            'button:has-text("Chat with us")',
            'button:has-text("Chat")',
            'button:has-text("New conversation")',
            'button:has-text("Start a conversation")',
            'a:has-text("Send us a message")',
            'a:has-text("Send a message")',
            'a:has-text("Chat with us")',
            '[aria-label*="new conversation" i]',
            '[aria-label*="send a message" i]',
            '[data-testid*="new-conversation"]',
          ]
          for (const navSel of chatNavSelectors) {
            try {
              const navBtn = frame.locator(navSel).first()
              if ((await navBtn.count()) > 0 && (await navBtn.isVisible())) {
                console.log(`  [input] clicking chat nav: ${navSel}`)
                await navBtn.click({ timeout: 3000 })
                await sleep(2000)
                break
              }
            } catch { /* continue */ }
          }
          // Re-check if input is now visible
          const nowVisible = await lastInput.isVisible().catch(() => false)
          if (nowVisible) {
            console.log(`  [input] input now visible after navigation`)
            return { frame, input: lastInput, bodyLocator: frame.locator('body') }
          }
        }

        // No visible input — widget may be showing a routing menu.
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

    // ── Check page-level chat containers (non-iframe widgets) ──────────────
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
          console.log(`  [input] found in page-level container: ${sel}`)
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

    // ── Check Shadow DOM roots (Zoom Contact Center, custom widgets) ─────
    try {
      const shadowInput = await page.evaluateHandle((inputSelectors) => {
        // Skip pre-chat form fields (name/email) — look for message inputs only
        const preChatPlaceholders = /first name|last name|email|phone|language/i
        for (const host of document.querySelectorAll('*')) {
          if (!host.shadowRoot) continue
          const inputs = host.shadowRoot.querySelectorAll(inputSelectors)
          for (const input of inputs) {
            const ph = (input.placeholder || '').toLowerCase()
            if (preChatPlaceholders.test(ph)) continue
            const rect = input.getBoundingClientRect()
            if (rect.width > 0 && rect.height > 0) return input
          }
          // Also check nested shadow roots one level deep
          for (const inner of host.shadowRoot.querySelectorAll('*')) {
            if (!inner.shadowRoot) continue
            const nested = inner.shadowRoot.querySelectorAll(inputSelectors)
            for (const input of nested) {
              const ph = (input.placeholder || '').toLowerCase()
              if (preChatPlaceholders.test(ph)) continue
              const rect = input.getBoundingClientRect()
              if (rect.width > 0 && rect.height > 0) return input
            }
          }
        }
        return null
      }, chatInputSel)

      const asElement = shadowInput.asElement()
      if (asElement) {
        console.log('  [input] found in shadow DOM')
        return {
          frame: null,
          input: asElement,
          bodyLocator: page.locator('body'),
          shadowDom: true,
        }
      }
    } catch { /* no shadow DOM inputs */ }

    // Log what shadow DOM contains on first pass (helps debug)
    if (loopCount === 1) {
      try {
        const shadowInfo = await page.evaluate((inputSel) => {
          const results = []
          for (const host of document.querySelectorAll('*')) {
            if (!host.shadowRoot) continue
            const tag = host.tagName.toLowerCase()
            const id = host.id || ''
            const cls = (typeof host.className === 'string' ? host.className : '').slice(0, 50)
            const allInputs = host.shadowRoot.querySelectorAll(inputSel)
            const inputInfo = [...allInputs].map(i => {
              const rect = i.getBoundingClientRect()
              return `${i.tagName.toLowerCase()}[placeholder="${i.placeholder || ''}"] ${Math.round(rect.width)}x${Math.round(rect.height)}`
            })
            if (inputInfo.length > 0) {
              results.push(`<${tag}> id="${id}" class="${cls}": ${inputInfo.join(', ')}`)
            }
          }
          return results
        }, chatInputSel)
        if (shadowInfo.length > 0) console.log(`  [input] shadow DOM inputs (pre-chat filtered): ${shadowInfo.join(' | ')}`)
      } catch { /* ignore */ }
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
  const ctx = await getChatInputContext(page)
  const { input, bodyLocator, shadowDom } = ctx

  // Helper to read text — for shadow DOM widgets, read from shadow roots
  async function getBodyText() {
    if (shadowDom) {
      return page.evaluate(() => {
        for (const el of document.querySelectorAll('*')) {
          if (!el.shadowRoot) continue
          const container = el.shadowRoot.querySelector('[class*="chat-sdk-window"], [class*="message-list"], [class*="livesdk"]')
          if (container) return container.innerText || ''
        }
        return document.body.innerText || ''
      }).catch(() => '')
    }
    return bodyLocator.innerText().catch(() => '')
  }

  // For shadow DOM elements (ElementHandle), use different interaction methods
  if (shadowDom) {
    await input.click({ force: true }).catch(() => {})
    await input.fill(message).catch(async () => {
      // Fallback: use native setter + events
      await page.evaluate(({ el, msg }) => {
        const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set
          || Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set
        setter.call(el, msg)
        el.dispatchEvent(new Event('input', { bubbles: true }))
        el.dispatchEvent(new Event('change', { bubbles: true }))
      }, { el: input, msg: message })
    })
  } else {
    await input.waitFor({ state: 'attached', timeout: 5000 })
    await input.click({ force: true })
    // Use type() instead of fill() — fill() doesn't trigger React/Vue event handlers
    // which causes controlled inputs (Ada, Intercom, etc.) to ignore the value
    await input.fill('')  // clear first
    await input.type(message, { delay: 15 })
  }

  // Snapshot text before sending
  const textBefore = await getBodyText()

  await input.press('Enter')
  await sleep(1500)

  // Check if text changed — if not, Enter didn't submit. Try clicking a send button.
  const textAfterEnter = await getBodyText()
  if (textAfterEnter === textBefore) {
    console.log('  [send] Enter did not submit — looking for send button')
    const sendBtnSelectors = [
      'button[aria-label*="send" i]',
      'button[aria-label*="submit" i]',
      'button[title*="send" i]',
      'button[type="submit"]',
      'button[class*="send" i]',
      'button[class*="submit" i]',
      '[data-testid*="send" i]',
      '[data-testid*="submit" i]',
    ]

    // Helper: try to find and click a send button in a given context
    async function trySendButton(searchCtx, label) {
      // First try explicit send-labeled buttons
      for (const sel of sendBtnSelectors) {
        try {
          const btn = searchCtx.locator(sel).first()
          if ((await btn.count()) > 0 && (await btn.isVisible().catch(() => true))) {
            await btn.click({ force: true, timeout: 2000 })
            console.log(`  [send] clicked send button (${label}): ${sel}`)
            return true
          }
        } catch { /* continue */ }
      }
      // Fallback: find any button near/after the textarea (send buttons are usually adjacent)
      try {
        const nearbyBtn = searchCtx.locator('textarea ~ button, textarea + button, [class*="input"] button, [class*="footer"] button, [class*="composer"] button').first()
        if ((await nearbyBtn.count()) > 0 && (await nearbyBtn.isVisible().catch(() => true))) {
          await nearbyBtn.click({ force: true, timeout: 2000 })
          console.log(`  [send] clicked adjacent button (${label})`)
          return true
        }
      } catch { /* continue */ }
      return false
    }

    // Try in the same frame/context as the input
    const searchCtx = ctx.frame ? ctx.frame : page
    let sent = await trySendButton(searchCtx, 'input context')

    // Fallback: try all iframes for a send button
    if (!sent) {
      const iframeEls = await page.locator('iframe').all()
      for (const iframeEl of iframeEls) {
        if (sent) break
        try {
          const frame = await iframeEl.contentFrame()
          if (!frame) continue
          sent = await trySendButton(frame, 'iframe')
        } catch { /* continue */ }
      }
    }
    if (!sent) console.log('  [send] no send button found — relying on Enter')
  }
  await sleep(2000)

  // Wait for "typing" indicator (up to 12s)
  const typingDeadline = Date.now() + 12000
  while (Date.now() < typingDeadline) {
    await sleep(500)
    const t = await getBodyText()
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
    const t = await getBodyText()

    // Mid-conversation email prompt — detect if bot is asking for email and fill it
    // Use provided email or default to audit@botaudit.app
    const emailToUse = preChatEmail || 'audit@botaudit.app'
    if (!emailFilled) {
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
        console.log(`  [email] bot asked for email — filling ${emailToUse}`)
        await fillPreChatEmail(page, emailToUse, bodyLocator).catch(() => {})
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

  const browser = await chromium.launch({ headless: process.env.HEADLESS !== 'false', args: ['--no-sandbox', '--disable-setuid-sandbox'] })
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
          await sleep(3000)

          // Dismiss cookie banners and promotional popups before interacting
          await dismissOverlays(page)
          // Extra wait after overlay dismissal — some widgets (Qualified, etc.)
          // only load after consent is given or overlays are cleared
          await sleep(2000)

          // Debug: dump iframe names/IDs so we know what the page loaded
          const iframes = await page.locator('iframe').all()
          for (const f of iframes) {
            const id   = await f.getAttribute('id').catch(() => '')
            const name = await f.getAttribute('name').catch(() => '')
            const src  = await f.getAttribute('src').catch(() => '')
            onProgress({ type: 'debug', msg: `iframe id="${id}" name="${name}" src="${(src||'').slice(0,80)}"` })
          }

          onProgress({ type: 'step', step: 'opening_widget' })
          await openChatWidget(page, preChatEmail)
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

        } catch (err) {
          error = err.message
        }

        // Always take a screenshot (even on error) — captures widget state for routing-only bots
        if (takeScreenshots && screenshotDir) {
          try {
            const filename = `q${String(i + 1).padStart(2, '0')}_run${run + 1}.png`
            screenshotPath = path.join('screenshots', filename)
            const fullPath = path.join(screenshotDir, filename)
            // Capture once into a buffer, then both write to disk and base64-encode
            // (avoids a redundant sync re-read of the file we just wrote).
            const buf = await page.screenshot({ fullPage: false })
            fs.writeFileSync(fullPath, buf)
            screenshotBase64 = `data:image/png;base64,${buf.toString('base64')}`
          } catch { /* page may be closed */ }
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

      // Semantic similarity classification (replaces binary === check)
      const similarity = classifyConsistency(responses)
      const consistent = similarity.classification === 'identical' || similarity.classification === 'semantically_equivalent'

      // Quality scoring for each run's response
      const quality = scoreQuestion(question, expectation, runs)

      const result = { category, question, expectation, runs, consistent, similarity, quality }
      results.push(result)

      // Emit result data (strip base64 — screenshots already sent per run_complete)
      const runsForEvent = runs.map(({ screenshotBase64, ...rest }) => rest)
      onProgress({
        type: 'question_complete',
        questionIndex: i,
        consistent,
        similarity,
        quality,
        totalQuestions: questions.length,
        result: { category, question, expectation, runs: runsForEvent, consistent, similarity, quality },
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

  // Similarity breakdown
  const identical = results.filter(r => r.similarity && r.similarity.classification === 'identical').length
  const equivalent = results.filter(r => r.similarity && r.similarity.classification === 'semantically_equivalent').length
  const partiallySimilar = results.filter(r => r.similarity && r.similarity.classification === 'partially_similar').length
  const contradictory = results.filter(r => r.similarity && r.similarity.classification === 'contradictory').length

  // Quality averages
  const qualityScores = results.filter(r => r.quality && r.quality.average > 0).map(r => r.quality.average)
  const avgQualityScore = qualityScores.length > 0
    ? Math.round(qualityScores.reduce((a, b) => a + b, 0) / qualityScores.length * 10) / 10
    : 0

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
    // Semantic similarity breakdown
    identical,
    semanticallyEquivalent: equivalent,
    partiallySimilar,
    contradictory,
    // Quality metrics
    avgQualityScore,
    deflections: results.filter(r => r.quality && r.quality.scores.some(s => s.rating === 'deflected')).length,
    failures: results.filter(r => r.quality && r.quality.scores.some(s => s.rating === 'failed')).length,
    completedAt: new Date().toISOString(),
  }
  if (outputDir) fs.writeFileSync(path.join(outputDir, 'summary.json'), JSON.stringify(summary, null, 2))

  onProgress({ type: 'complete', results, summary })
  return { results, summary }
}

// ── Bot reachability pre-flight check ────────────────────────────────────────
async function checkBot({ targetUrl, preChatSteps = [], preChatEmail = '' }) {
  const headless = process.env.HEADLESS !== 'false'
  const browser = await chromium.launch({ headless, args: ['--no-sandbox', '--disable-setuid-sandbox'] })
  // Create context/page inside the try so the finally cleanup still runs if
  // newContext / newPage throw (otherwise the browser would leak).
  let context = null
  let page = null
  try {
    context = await browser.newContext({
      userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      viewport: { width: 1280, height: 800 },
    })
    page = await context.newPage()

    await page.goto(targetUrl, { waitUntil: 'domcontentloaded', timeout: 30000 })
    await sleep(4000)

    // Dismiss cookie banners and promotional popups before interacting
    await dismissOverlays(page)

    const strategy = await openChatWidget(page, preChatEmail)
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
    if (context) await context.close().catch(() => {})
    await browser.close().catch(() => {})
  }
}

module.exports = { runTest, checkBot }
