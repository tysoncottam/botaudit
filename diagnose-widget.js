'use strict'
// ─────────────────────────────────────────────────────────────────────────────
// diagnose-widget.js — Inspect a page to see how its chat widget is structured
//
// Usage:
//   node diagnose-widget.js <url>
//   HEADLESS=false node diagnose-widget.js <url>
// ─────────────────────────────────────────────────────────────────────────────

const { chromium } = require('playwright')

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function diagnose(url) {
  console.log(`\nDiagnosing: ${url}\n`)

  const browser = await chromium.launch({
    headless: process.env.HEADLESS !== 'false',
    args: ['--no-sandbox', '--disable-setuid-sandbox'],
  })
  const context = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    viewport: { width: 1280, height: 800 },
  })
  const page = await context.newPage()

  try {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 })
    console.log('Page loaded, waiting 6s for widgets to initialize...\n')
    await sleep(6000)

    // ── 1. Scripts — detect chat platform ───────────────────────────────────
    console.log('=== CHAT PLATFORM SCRIPTS ===')
    const chatScripts = await page.evaluate(() => {
      const scripts = [...document.querySelectorAll('script[src]')]
      const keywords = ['chat', 'widget', 'intercom', 'zendesk', 'zdassets', 'drift', 'crisp', 'hubspot', 'freshchat', 'tidio', 'livechat', 'tawk', 'olark', 'gorgias', 'messenger', 'support']
      return scripts
        .filter(s => keywords.some(k => s.src.toLowerCase().includes(k)))
        .map(s => s.src)
    })
    if (chatScripts.length === 0) console.log('  (none detected)')
    for (const src of chatScripts) console.log(`  ${src}`)

    // ── 2. Iframes ──────────────────────────────────────────────────────────
    console.log('\n=== IFRAMES ===')
    const iframes = await page.locator('iframe').all()
    if (iframes.length === 0) console.log('  (none)')
    for (const f of iframes) {
      const id    = await f.getAttribute('id').catch(() => '') || ''
      const name  = await f.getAttribute('name').catch(() => '') || ''
      const src   = await f.getAttribute('src').catch(() => '') || ''
      const title = await f.getAttribute('title').catch(() => '') || ''
      const vis   = await f.isVisible().catch(() => false)
      const box   = await f.boundingBox().catch(() => null)
      console.log(`  id="${id}" name="${name}" title="${title}" visible=${vis} box=${box ? `${box.width}x${box.height}@(${box.x},${box.y})` : 'null'}`)
      console.log(`    src=${src.slice(0, 120)}`)

      // Try to peek inside the iframe
      try {
        const frame = await f.contentFrame()
        if (frame) {
          const inputs = await frame.locator('textarea, [role="textbox"], input[type="text"], [contenteditable="true"]').count()
          const buttons = await frame.locator('button').count()
          console.log(`    contents: ${inputs} inputs, ${buttons} buttons`)
        } else {
          console.log(`    contents: (no frame handle - cross-origin?)`)
        }
      } catch (e) {
        console.log(`    contents: error - ${e.message.slice(0, 80)}`)
      }
    }

    // ── 3. Elements with chat-related attributes ────────────────────────────
    console.log('\n=== CHAT-RELATED ELEMENTS (top-level DOM) ===')
    const chatElements = await page.evaluate(() => {
      const keywords = ['chat', 'widget', 'intercom', 'zendesk', 'drift', 'crisp', 'hubspot', 'freshchat', 'tidio', 'livechat', 'tawk', 'olark', 'gorgias', 'messenger']
      const all = [...document.querySelectorAll('*')]
      const results = []
      for (const el of all) {
        const id = el.id || ''
        const cls = el.className && typeof el.className === 'string' ? el.className : ''
        const aria = el.getAttribute('aria-label') || ''
        const title = el.getAttribute('title') || ''
        const role = el.getAttribute('role') || ''
        const tag = el.tagName.toLowerCase()
        const combined = `${id} ${cls} ${aria} ${title}`.toLowerCase()
        if (keywords.some(k => combined.includes(k)) && tag !== 'script' && tag !== 'link' && tag !== 'style') {
          const rect = el.getBoundingClientRect()
          results.push({
            tag,
            id: id.slice(0, 60),
            class: cls.slice(0, 80),
            aria: aria.slice(0, 60),
            title: title.slice(0, 60),
            role,
            visible: rect.width > 0 && rect.height > 0,
            size: `${Math.round(rect.width)}x${Math.round(rect.height)}`,
            pos: `(${Math.round(rect.x)},${Math.round(rect.y)})`,
            hasShadow: !!el.shadowRoot,
            children: el.children.length,
          })
        }
      }
      return results.slice(0, 30)
    })
    if (chatElements.length === 0) console.log('  (none)')
    for (const el of chatElements) {
      console.log(`  <${el.tag}> id="${el.id}" class="${el.class}"`)
      console.log(`    aria="${el.aria}" title="${el.title}" role="${el.role}"`)
      console.log(`    visible=${el.visible} size=${el.size} pos=${el.pos} shadowRoot=${el.hasShadow} children=${el.children}`)
    }

    // ── 4. Shadow DOM roots ─────────────────────────────────────────────────
    console.log('\n=== SHADOW DOM ROOTS ===')
    const shadowHosts = await page.evaluate(() => {
      const all = [...document.querySelectorAll('*')]
      return all
        .filter(el => el.shadowRoot)
        .map(el => ({
          tag: el.tagName.toLowerCase(),
          id: (el.id || '').slice(0, 60),
          class: (typeof el.className === 'string' ? el.className : '').slice(0, 80),
          childCount: el.shadowRoot.children.length,
          innerSnippet: el.shadowRoot.innerHTML.slice(0, 300),
        }))
        .slice(0, 10)
    })
    if (shadowHosts.length === 0) console.log('  (none)')
    for (const sh of shadowHosts) {
      console.log(`  <${sh.tag}> id="${sh.id}" class="${sh.class}" shadowChildren=${sh.childCount}`)
      console.log(`    snippet: ${sh.innerSnippet}`)
    }

    // ── 5. Visible overlays (high z-index fixed elements) ───────────────────
    console.log('\n=== VISIBLE OVERLAYS / MODALS ===')
    const overlays = await page.evaluate(() => {
      const all = [...document.querySelectorAll('*')]
      return all
        .filter(el => {
          const style = window.getComputedStyle(el)
          const z = parseInt(style.zIndex) || 0
          const rect = el.getBoundingClientRect()
          return z > 999 && rect.width > 200 && rect.height > 100 && style.position === 'fixed'
        })
        .map(el => ({
          tag: el.tagName.toLowerCase(),
          id: (el.id || '').slice(0, 60),
          class: (typeof el.className === 'string' ? el.className : '').slice(0, 80),
          zIndex: window.getComputedStyle(el).zIndex,
          rect: (() => { const r = el.getBoundingClientRect(); return `${Math.round(r.width)}x${Math.round(r.height)}@(${Math.round(r.x)},${Math.round(r.y)})` })(),
        }))
        .slice(0, 10)
    })
    if (overlays.length === 0) console.log('  (none)')
    for (const o of overlays) {
      console.log(`  <${o.tag}> id="${o.id}" class="${o.class}" z=${o.zIndex} rect=${o.rect}`)
    }

    // ── 6. Bottom-right corner elements (where chat widgets usually live) ───
    console.log('\n=== BOTTOM-RIGHT CORNER ELEMENTS (potential widget launchers) ===')
    const cornerEls = await page.evaluate(() => {
      const vw = window.innerWidth
      const vh = window.innerHeight
      const all = [...document.querySelectorAll('*')]
      return all
        .filter(el => {
          const rect = el.getBoundingClientRect()
          const style = window.getComputedStyle(el)
          return rect.right > vw - 150 && rect.bottom > vh - 150
            && rect.width > 20 && rect.width < 200 && rect.height > 20 && rect.height < 200
            && (style.position === 'fixed' || style.position === 'absolute')
            && style.display !== 'none' && style.visibility !== 'hidden'
        })
        .map(el => {
          const rect = el.getBoundingClientRect()
          return {
            tag: el.tagName.toLowerCase(),
            id: (el.id || '').slice(0, 60),
            class: (typeof el.className === 'string' ? el.className : '').slice(0, 80),
            aria: (el.getAttribute('aria-label') || '').slice(0, 60),
            size: `${Math.round(rect.width)}x${Math.round(rect.height)}`,
            pos: `(${Math.round(rect.x)},${Math.round(rect.y)})`,
            hasShadow: !!el.shadowRoot,
            zIndex: window.getComputedStyle(el).zIndex,
          }
        })
        .slice(0, 15)
    })
    if (cornerEls.length === 0) console.log('  (none)')
    for (const el of cornerEls) {
      console.log(`  <${el.tag}> id="${el.id}" class="${el.class}" aria="${el.aria}" z=${el.zIndex} size=${el.size} pos=${el.pos} shadow=${el.hasShadow}`)
    }

    console.log('\nDiagnosis complete\n')

  } catch (err) {
    console.error(`\nError: ${err.message}\n`)
  } finally {
    await context.close().catch(() => {})
    await browser.close().catch(() => {})
  }
}

const url = process.argv[2]
if (!url) {
  console.error('Usage: node diagnose-widget.js <url>')
  process.exit(1)
}
diagnose(url)
