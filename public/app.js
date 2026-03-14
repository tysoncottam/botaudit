'use strict'
// ─────────────────────────────────────────────────────────────────────────────
// app.js — BotAudit frontend
// ─────────────────────────────────────────────────────────────────────────────

// ── Pricing (must match server.js constants) ──────────────────────────────────
const PRICE_PER_RUN_1X       = 0.75
const PRICE_PER_RUN_3X       = 0.50
const PRICE_PER_RUN_5X       = 0.40
const PRICE_SCREENSHOT_PER_Q = 0.25
const MINIMUM_CHARGE         = 10.00

function getPricePerRun(runs) {
  if (runs >= 5) return PRICE_PER_RUN_5X
  if (runs >= 3) return PRICE_PER_RUN_3X
  return PRICE_PER_RUN_1X
}

// ── State ─────────────────────────────────────────────────────────────────────
let appConfig       = {}
let customQuestions = []
let defaultQCount   = 20
let activeConfigId  = null
let sseSource       = null
let isDemoMode        = false   // user-facing free demo toggle
let uploadedQuestions = []      // questions parsed from file upload
let manualQuestions   = []      // questions entered manually
let activeUploadTab   = 'file'  // 'file' | 'manual'
let preChatSteps      = []      // ordered button-click steps before each question
let preChatEmail      = ''      // test email to enter when bot asks for one

// ── Live feed pagination ──────────────────────────────────────────────────────
const FEED_PAGE_SIZE = 10
let feedItems      = []   // { className, html, id }
let feedPage       = 0
let feedAutoFollow = true  // auto-advance to last page while test runs

// ── Session persistence (localStorage) ───────────────────────────────────────
const SESSION_KEY = 'botaudit_session'

function saveSession(configId, targetUrl) {
  localStorage.setItem(SESSION_KEY, JSON.stringify({ configId, targetUrl, savedAt: Date.now() }))
}

function loadSession() {
  try {
    const raw = localStorage.getItem(SESSION_KEY)
    if (!raw) return null
    const s = JSON.parse(raw)
    // Expire after 48 hours
    if (Date.now() - s.savedAt > 48 * 60 * 60 * 1000) { clearSession(); return null }
    return s
  } catch { return null }
}

function clearSession() {
  localStorage.removeItem(SESSION_KEY)
}

// ── Bot pre-flight check ───────────────────────────────────────────────────────
let botCheckState = 'idle'   // 'idle' | 'checking' | 'ok' | 'error'
let botCheckToken = 0

function setBotCheckStatus(state, text) {
  botCheckState = state
  const wrap    = $('bot-check-status')
  const spinner = $('bot-check-spinner')
  const label   = $('bot-check-text')

  if (state === 'idle') {
    wrap.classList.add('hidden')
    return
  }
  wrap.classList.remove('hidden', 'checking', 'ok', 'error')
  wrap.classList.add(state)
  spinner.classList.toggle('hidden', state !== 'checking')
  label.textContent = text
  updatePrice() // re-evaluate pay button disabled state
}

async function triggerBotCheck() {
  const url = normalizeUrl($('target-url').value)
  if (!url || !isValidUrl(url)) {
    setBotCheckStatus('idle', '')
    return
  }
  const token = ++botCheckToken
  setBotCheckStatus('checking', 'Checking for your bot…')
  try {
    const res  = await fetch('/api/check-bot', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ targetUrl: url, preChatSteps, preChatEmail }),
    })
    if (token !== botCheckToken) return  // stale — URL changed
    const data = await res.json()
    if (data.reachable) {
      setBotCheckStatus('ok', '✓ Bot found')
    } else {
      setBotCheckStatus('error', '✕ No bot found at this URL')
    }
  } catch {
    if (token !== botCheckToken) return
    setBotCheckStatus('idle', '')  // network error — don't block
  }
}

function retryWithNewUrl() {
  // For demo tests: reset the IP lock so they get another free try
  if (isDemoMode) {
    fetch('/api/demo-reset', { method: 'POST' }).catch(() => {})
  }
  // Hide results, scroll back to form
  $('results-section').classList.add('hidden')
  $('refund-notice').classList.add('hidden')
  $('configure-section').scrollIntoView({ behavior: 'smooth' })
  // Clear URL field and focus it
  setTimeout(() => {
    $('target-url').value = ''
    $('target-url').focus()
  }, 400)
}

// ETA tracking
let etaTestStart        = null
let etaCompletedRuns    = 0
let etaTotalRuns        = 0
let partialQCompleted   = 0   // questions (not runs) completed so far

// ── DOM references ────────────────────────────────────────────────────────────
const $ = (id) => document.getElementById(id)

// ── Boot ──────────────────────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', async () => {
  await loadConfig()
  bindEvents()
  updatePrice()
  // Order matters: Stripe return takes priority, then stored session
  if (!checkReturnFromStripe()) {
    await checkStoredSession()
  }
})

async function loadConfig() {
  try {
    const res = await fetch('/api/config')
    appConfig = await res.json()
    defaultQCount = appConfig.defaultQuestionCount || 20

    if (appConfig.demoAvailable === false) {
      // Hide the "Try 3 free questions" radio option if demo already used from this IP
      const demoRadio = document.querySelector('input[name="question-source"][value="demo"]')
      if (demoRadio) demoRadio.closest('.radio-card').classList.add('hidden')
    }
  } catch (e) {
    console.warn('Could not load config', e)
  }
}

// ── Event bindings ────────────────────────────────────────────────────────────
function bindEvents() {
  $('target-url').addEventListener('blur', () => {
    const url = normalizeUrl($('target-url').value)
    if (url && !isValidUrl(url)) {
      $('target-url').classList.add('error')
      $('url-error').classList.remove('hidden')
    } else {
      $('target-url').classList.remove('error')
      $('url-error').classList.add('hidden')
      triggerBotCheck()
    }
  })
  $('target-url').addEventListener('input', () => {
    // Reset check state when URL changes so button won't use stale result
    if (botCheckState === 'ok' || botCheckState === 'error' || botCheckState === 'checking') {
      setBotCheckStatus('idle', '')
    }
    updatePrice()
  })

  document.querySelectorAll('input[name="question-source"]').forEach((el) => {
    el.addEventListener('change', () => {
      isDemoMode = el.value === 'demo'
      if (isDemoMode) {
        document.querySelector('input[name="runs"][value="1"]').checked = true
      } else {
        document.querySelector('input[name="runs"][value="3"]').checked = true
      }
      const showUpload = ['custom', 'both'].includes(el.value)
      $('upload-section').classList.toggle('hidden', !showUpload)
      updatePrice()
    })
  })

  document.querySelectorAll('input[name="runs"]').forEach((el) => {
    el.addEventListener('change', () => {
      if (isDemoMode && el.value !== '1') {
        // Exit demo mode — switch back to default 20 questions
        document.querySelector('input[name="question-source"][value="default"]').checked = true
        isDemoMode = false
        $('upload-section').classList.add('hidden')
      }
      updatePrice()
    })
  })

  $('screenshot-toggle').addEventListener('change', updatePrice)
  $('pay-btn').addEventListener('click', handlePayClick)
  $('download-btn').addEventListener('click', handleDownload)
  $('partial-download-btn').addEventListener('click', handlePartialDownload)
  $('feed-prev').addEventListener('click', () => {
    if (feedPage > 0) { feedPage--; feedAutoFollow = false; renderFeedPage() }
  })
  $('feed-next').addEventListener('click', () => {
    const totalPages = Math.ceil(feedItems.length / FEED_PAGE_SIZE)
    if (feedPage < totalPages - 1) {
      feedPage++
      feedAutoFollow = (feedPage === totalPages - 1)
      renderFeedPage()
    }
  })

  bindUpload()
  bindPreChat()
}

function bindPreChat() {
  $('prechat-master-toggle').addEventListener('change', (e) => {
    $('prechat-steps-wrap').classList.toggle('hidden', !e.target.checked)
    if (!e.target.checked) {
      // Reset everything when master toggle is turned off
      $('prechat-email-enabled').checked = false
      $('prechat-email-row').classList.add('hidden')
      $('prechat-steps-enabled').checked = false
      $('prechat-steps-body').classList.add('hidden')
      preChatEmail = ''; $('prechat-email-input').value = ''
      preChatSteps = []; renderPreChatSteps()
    }
  })

  $('prechat-email-enabled').addEventListener('change', (e) => {
    $('prechat-email-row').classList.toggle('hidden', !e.target.checked)
    if (!e.target.checked) { preChatEmail = ''; $('prechat-email-input').value = '' }
  })

  $('prechat-email-input').addEventListener('input', (e) => {
    preChatEmail = e.target.value.trim()
  })

  $('prechat-steps-enabled').addEventListener('change', (e) => {
    $('prechat-steps-body').classList.toggle('hidden', !e.target.checked)
    if (!e.target.checked) { preChatSteps = []; renderPreChatSteps() }
  })

  $('prechat-add-btn').addEventListener('click', addPreChatStep)
  $('prechat-step-input').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); addPreChatStep() }
  })
}

function addPreChatStep() {
  const input = $('prechat-step-input')
  const text = input.value.trim()
  if (!text) return
  preChatSteps.push(text)
  input.value = ''
  renderPreChatSteps()
}

function removePreChatStep(index) {
  preChatSteps.splice(index, 1)
  renderPreChatSteps()
}

function renderPreChatSteps() {
  const list = $('prechat-steps-list')
  if (preChatSteps.length === 0) { list.innerHTML = ''; return }
  list.innerHTML = preChatSteps.map((step, i) => `
    <div class="prechat-step-item">
      <span class="prechat-step-num">Step ${i + 1}</span>
      <span class="prechat-step-text">Click "${step}"</span>
      <button class="prechat-step-remove" onclick="removePreChatStep(${i})" title="Remove">×</button>
    </div>
  `).join('')
}

function bindUpload() {
  const drop  = $('upload-drop')
  const input = $('file-input')

  $('upload-link').addEventListener('click', (e) => { e.preventDefault(); input.click() })
  drop.addEventListener('click', () => input.click())
  input.addEventListener('change', () => { if (input.files[0]) processUpload(input.files[0]) })
  drop.addEventListener('dragover', (e) => { e.preventDefault(); drop.classList.add('drag-over') })
  drop.addEventListener('dragleave', () => drop.classList.remove('drag-over'))
  drop.addEventListener('drop', (e) => {
    e.preventDefault()
    drop.classList.remove('drag-over')
    if (e.dataTransfer.files[0]) processUpload(e.dataTransfer.files[0])
  })

  // Upload tab switching
  $('tab-file').addEventListener('click', () => switchUploadTab('file'))
  $('tab-manual').addEventListener('click', () => switchUploadTab('manual'))

  // Manual question entry
  $('manual-add-btn').addEventListener('click', addManualQuestion)
  $('manual-question-input').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); addManualQuestion() }
  })

  // Template download
  $('download-template').addEventListener('click', (e) => {
    e.preventDefault()
    const lines = [
      'How do I cancel my subscription?',
      'I was charged twice — can I get a refund?',
      'I need to speak to a real person right now.',
      'How do I update my billing information?',
      'Can you delete my account and all my data?',
      'My login stopped working after the last update.',
      'Why was I charged after I cancelled?',
    ].join('\n')
    const blob = new Blob([lines], { type: 'text/plain' })
    const a = document.createElement('a')
    a.href = URL.createObjectURL(blob)
    a.download = 'botaudit-questions-template.txt'
    a.click()
    setTimeout(() => URL.revokeObjectURL(a.href), 5000)
  })
}

async function processUpload(file) {
  const formData = new FormData()
  formData.append('file', file)
  showUploadStatus('Parsing file...', '')
  try {
    const res  = await fetch('/api/upload-questions', { method: 'POST', body: formData })
    const data = await res.json()
    if (!res.ok) { showUploadStatus(data.error || 'Upload failed', 'error'); return }
    uploadedQuestions = data.questions
    customQuestions = uploadedQuestions
    showUploadStatus(`✓ ${data.questions.length} question${data.questions.length !== 1 ? 's' : ''} loaded from ${file.name}`, 'success')
    updatePrice()
  } catch (e) {
    showUploadStatus('Upload failed: ' + e.message, 'error')
  }
}

function showUploadStatus(msg, type) {
  const el = $('upload-status')
  el.textContent = msg
  el.className = 'upload-status' + (type ? ' ' + type : '')
  el.classList.remove('hidden')
}

function switchUploadTab(tab) {
  activeUploadTab = tab
  $('tab-file').classList.toggle('active', tab === 'file')
  $('tab-manual').classList.toggle('active', tab === 'manual')
  $('panel-file').classList.toggle('hidden', tab !== 'file')
  $('panel-manual').classList.toggle('hidden', tab !== 'manual')
  customQuestions = tab === 'file' ? uploadedQuestions : [...manualQuestions]
  updatePrice()
}

function addManualQuestion() {
  const input = $('manual-question-input')
  const q = input.value.trim()
  if (!q) return
  manualQuestions.push(q)
  input.value = ''
  input.focus()
  customQuestions = [...manualQuestions]
  renderManualQuestions()
  updatePrice()
}

function removeManualQuestion(index) {
  manualQuestions.splice(index, 1)
  customQuestions = [...manualQuestions]
  renderManualQuestions()
  updatePrice()
}

function renderManualQuestions() {
  const list = $('manual-questions-list')
  if (manualQuestions.length === 0) {
    list.innerHTML = ''
    return
  }
  list.innerHTML = manualQuestions.map((q, i) => `
    <div class="manual-q-item">
      <span class="manual-q-num">${i + 1}.</span>
      <span class="manual-q-text">${escHtml(q)}</span>
      <button class="manual-q-remove" onclick="removeManualQuestion(${i})" title="Remove">✕</button>
    </div>
  `).join('') + `<div class="manual-q-count">${manualQuestions.length} question${manualQuestions.length !== 1 ? 's' : ''} added</div>`
}


// ── Price calculation ─────────────────────────────────────────────────────────
function normalizeUrl(raw) {
  const s = raw.trim()
  if (!s) return s
  if (/^https?:\/\//i.test(s)) return s
  return 'https://' + s
}

function getFormValues() {
  const url    = normalizeUrl($('target-url').value)
  const source = document.querySelector('input[name="question-source"]:checked')?.value || 'default'
  const runs   = parseInt(document.querySelector('input[name="runs"]:checked')?.value || '3')
  const shots  = $('screenshot-toggle').checked
  const email  = $('notify-email').value.trim()

  let numQ = 0
  if (source === 'demo') numQ = 3
  else if (source === 'default') numQ = defaultQCount
  else if (source === 'custom') numQ = customQuestions.length
  else numQ = defaultQCount + customQuestions.length

  const pricePerRun = getPricePerRun(runs)
  return { url, source, runs, shots, numQ, email, pricePerRun }
}

function fmt(n) { return '$' + n.toFixed(2) }

function updatePrice() {
  const { url, source, runs, shots, numQ, pricePerRun } = getFormValues()
  const lineItems = $('price-line-items')

  if (isDemoMode) {
    lineItems.innerHTML = `
      <div class="price-line">
        <span>3 questions × 1 run</span>
        <span class="free-label">Free</span>
      </div>
      <div class="price-line">
        <span>Screenshots (3 questions)</span>
        <span class="free-label">Free</span>
      </div>
      <div class="price-divider"></div>
      <div class="price-line price-total">
        <span>Total</span>
        <span class="free-label">Free</span>
      </div>
    `
    $('screenshot-price-label').textContent = ''

    const btn = $('pay-btn')
    if (!url || botCheckState === 'idle') {
      btn.disabled = true; $('pay-btn-text').textContent = 'Enter a URL to start demo'
    } else if (!isValidUrl(url)) {
      btn.disabled = true; $('pay-btn-text').textContent = 'Enter a valid URL'
    } else if (botCheckState === 'checking') {
      btn.disabled = true; $('pay-btn-text').textContent = 'Checking your bot…'
    } else if (botCheckState === 'error') {
      btn.disabled = true; $('pay-btn-text').textContent = 'No bot found — try a different URL'
    } else {
      btn.disabled = false; $('pay-btn-text').textContent = 'Start Free Demo'
    }
    return
  }

  // Normal paid flow
  lineItems.innerHTML = `
    <div class="price-line">
      <span id="price-q-label">${numQ} question${numQ !== 1 ? 's' : ''} × ${runs} run${runs !== 1 ? 's' : ''}</span>
      <span id="price-q-value">${fmt(numQ * runs * pricePerRun)}</span>
    </div>
    <div class="price-line" id="screenshot-price-line" style="${shots ? '' : 'display:none'}">
      <span>Screenshots (${numQ} question${numQ !== 1 ? 's' : ''})</span>
      <span id="price-ss-value">${fmt(shots ? numQ * PRICE_SCREENSHOT_PER_Q : 0)}</span>
    </div>
    <div class="price-divider"></div>
    <div class="price-line price-total">
      <span>Total</span>
      <span id="price-total">${fmt(Math.max(numQ * runs * pricePerRun + (shots ? numQ * PRICE_SCREENSHOT_PER_Q : 0), MINIMUM_CHARGE))}${(numQ * runs * pricePerRun + (shots ? numQ * PRICE_SCREENSHOT_PER_Q : 0)) < MINIMUM_CHARGE ? ' (min)' : ''}</span>
    </div>
  `
  $('screenshot-price-label').textContent = `+${fmt(PRICE_SCREENSHOT_PER_Q)} per question`

  const ssItem = $('screenshot-included-item')
  if (ssItem) {
    ssItem.classList.toggle('included-off', !shots)
    ssItem.querySelector('.included-icon').textContent = shots ? '✓' : '✕'
  }

  const total = Math.max(numQ * runs * pricePerRun + (shots ? numQ * PRICE_SCREENSHOT_PER_Q : 0), MINIMUM_CHARGE)
  const btn = $('pay-btn')
  let btnText = ''
  if (!url || botCheckState === 'idle') {
    btn.disabled = true; btnText = 'Enter a URL to continue'
  } else if (!isValidUrl(url)) {
    btn.disabled = true; btnText = 'Enter a valid URL'
  } else if (botCheckState === 'checking') {
    btn.disabled = true; btnText = 'Checking your bot…'
  } else if (botCheckState === 'error') {
    btn.disabled = true; btnText = 'No bot found — try a different URL'
  } else if (source !== 'default' && customQuestions.length === 0) {
    btn.disabled = true; btnText = 'Add questions to continue'
  } else if (numQ === 0) {
    btn.disabled = true; btnText = 'No questions selected'
  } else {
    btn.disabled = false; btnText = `Proceed to Payment — ${fmt(total)}`
  }
  $('pay-btn-text').textContent = btnText
}

function isValidUrl(str) {
  try {
    const u = new URL(str)
    return u.hostname.includes('.')
  } catch { return false }
}

// ── Payment flow ──────────────────────────────────────────────────────────────
async function handlePayClick() {
  const { url, source, runs, shots, numQ, email } = getFormValues()
  if (!url || !isValidUrl(url)) {
    $('target-url').focus()
    $('target-url').classList.add('error')
    $('url-error').classList.remove('hidden')
    setTimeout(() => {
      $('target-url').classList.remove('error')
      $('url-error').classList.add('hidden')
    }, 4000)
    return
  }
  $('url-error').classList.add('hidden')
  if (!isDemoMode && numQ === 0) return

  // Clear any previous session before starting a new one
  clearSession()
  $('resume-banner').classList.add('hidden')

  const btn = $('pay-btn')
  btn.disabled = true
  $('pay-btn-text').textContent = isDemoMode ? 'Starting demo...' : 'Setting up...'

  // Free demo path — skip questions assembly and Stripe entirely
  if (isDemoMode) {
    try {
      const res  = await fetch('/api/demo', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ targetUrl: url, preChatSteps, preChatEmail }),
      })
      const data = await res.json()
      if (!res.ok) {
        if (data.error === 'demo_used') {
          const demoRadio = document.querySelector('input[name="question-source"][value="demo"]')
          if (demoRadio) demoRadio.closest('.radio-card').classList.add('hidden')
          document.querySelector('input[name="question-source"][value="default"]').checked = true
          isDemoMode = false
          updatePrice()
          showToast('The free demo has already been used from this network.', true)
        } else {
          showToast(data.message || 'Demo start failed', true)
          btn.disabled = false
          updatePrice()
        }
        return
      }
      activeConfigId = data.configId
      startTest(activeConfigId, null)
    } catch (e) {
      showToast('Network error: ' + e.message, true)
      btn.disabled = false
      updatePrice()
    }
    return
  }

  // Paid path
  let questions = []
  if (source === 'default' || source === 'both') {
    try {
      const res  = await fetch('/api/default-questions')
      questions  = questions.concat(await res.json())
    } catch (e) { showToast('Failed to load default questions', true); btn.disabled = false; updatePrice(); return }
  }
  if ((source === 'custom' || source === 'both') && customQuestions.length > 0) {
    questions = questions.concat(customQuestions)
  }

  try {
    const res  = await fetch('/api/checkout', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ targetUrl: url, questions, runsPerQuestion: runs, takeScreenshots: shots, notifyEmail: email, preChatSteps, preChatEmail }),
    })
    const data = await res.json()
    if (!res.ok) { showToast(data.error || 'Checkout failed', true); btn.disabled = false; updatePrice(); return }

    window.location = data.checkoutUrl
  } catch (e) {
    showToast('Network error: ' + e.message, true)
    btn.disabled = false
    updatePrice()
  }
}

// ── Return from Stripe ────────────────────────────────────────────────────────
function checkReturnFromStripe() {
  const params    = new URLSearchParams(window.location.search)
  const sessionId = params.get('session_id')
  const configId  = params.get('config_id')
  if (sessionId && configId) {
    window.history.replaceState({}, '', '/')
    activeConfigId = configId
    startTest(configId, sessionId)
    return true
  }
  return false
}

// ── Restore previous session from localStorage ────────────────────────────────
async function checkStoredSession() {
  const stored = loadSession()
  if (!stored) return

  try {
    const res  = await fetch(`/api/results/${stored.configId}`)
    if (!res.ok) { clearSession(); return }
    const data = await res.json()

    if (data.status === 'complete') {
      showResumeBanner(stored, 'complete', data)
    } else if (data.status === 'running') {
      showResumeBanner(stored, 'running', null)
    } else {
      clearSession()
    }
  } catch {
    // Server unreachable — show banner anyway so user knows
    showResumeBanner(stored, 'unknown', null)
  }
}

function showResumeBanner(stored, status, data) {
  const banner = $('resume-banner')
  const label  = $('resume-status-label')
  const urlEl  = $('resume-url-label')

  urlEl.textContent = stored.targetUrl

  if (status === 'complete') {
    label.textContent = '✓ Previous audit completed —'
  } else if (status === 'running') {
    label.textContent = '⏳ Test still in progress —'
  } else {
    label.textContent = 'Previous test found —'
  }

  banner.classList.remove('hidden')

  $('resume-btn').onclick = () => {
    banner.classList.add('hidden')
    activeConfigId = stored.configId

    if (status === 'complete' && data) {
      // Show results directly without reconnecting to SSE
      showSection('progress')
      showSection('results')
      renderResults(data.results, data.summary)
      scrollTo('results-section')
    } else {
      // Reconnect to SSE — server will replay buffered events
      startTest(stored.configId, null)
    }
  }

  $('resume-dismiss').onclick = () => {
    clearSession()
    banner.classList.add('hidden')
  }
}

// ── Start test & SSE ──────────────────────────────────────────────────────────
function startTest(configId, stripeSessionId) {
  etaTestStart      = null
  etaCompletedRuns  = 0
  etaTotalRuns      = 0
  partialQCompleted = 0

  showSection('progress')
  scrollTo('progress-section')
  clearFeed()
  addFeedItem('Connecting to test runner...', 'feed-waiting')

  // Persist session so page refresh can resume
  const targetUrl = $('target-url').value.trim()
  saveSession(configId, targetUrl)

  // Set up preview panel
  if (targetUrl) initPreviewPanel(targetUrl)

  const url = `/api/stream/${configId}` + (stripeSessionId ? `?session_id=${stripeSessionId}` : '')
  sseSource = new EventSource(url)

  sseSource.onmessage = (e) => {
    let event
    try { event = JSON.parse(e.data) } catch { return }
    handleSSEEvent(event)
  }

  sseSource.onerror = () => {
    addFeedItem('Connection lost — attempting to reconnect...', 'feed-error')
  }
}

// ── Preview panel ─────────────────────────────────────────────────────────────
function initPreviewPanel(targetUrl) {
  $('preview-url-bar').textContent = targetUrl

  const iframe  = $('preview-iframe')
  const blocked = $('preview-blocked')

  iframe.src = targetUrl

  // Detect iframe blocking after 5s — browsers silently block X-Frame-Options
  setTimeout(() => {
    try {
      const doc = iframe.contentDocument
      if (!doc || !doc.body || doc.body.innerHTML === '') {
        // Blocked: hide the entire iframe section, screenshots will fill the panel
        $('preview-iframe-wrap').classList.add('hidden')
      }
    } catch {
      // Cross-origin error means it actually loaded fine — leave visible
    }
  }, 5000)
}

function updatePreviewScreenshot(base64) {
  if (!base64) return
  const img   = $('preview-screenshot')
  const empty = $('preview-screenshot-empty')
  img.src = base64
  img.classList.remove('hidden')
  empty.classList.add('hidden')
}

// ── ETA calculation ───────────────────────────────────────────────────────────
function updateETA(completed, total) {
  if (!etaTestStart || completed === 0) return
  const elapsed    = Date.now() - etaTestStart
  const avgPerRun  = elapsed / completed
  const remaining  = Math.max(0, (total - completed) * avgPerRun)
  const mins       = Math.floor(remaining / 60000)
  const secs       = Math.floor((remaining % 60000) / 1000)
  const etaEl      = $('progress-eta')
  if (completed >= total) {
    etaEl.textContent = ''
  } else if (mins > 0) {
    etaEl.textContent = `~${mins}m ${secs}s remaining`
  } else {
    etaEl.textContent = secs > 0 ? `~${secs}s remaining` : ''
  }
}

// ── Partial download ─────────────────────────────────────────────────────────
function updatePartialDownloadBar(completedQ, totalQ) {
  if (completedQ === 0) return
  const bar = $('partial-download-bar')
  bar.classList.remove('hidden')
  $('partial-download-label').textContent =
    `${completedQ} of ${totalQ} questions completed — still testing ${totalQ - completedQ} more`
}

function handlePartialDownload() {
  if (!activeConfigId) return
  window.open(`/api/download-partial/${activeConfigId}`, '_blank')
}

// ── SSE event handler ─────────────────────────────────────────────────────────
function handleSSEEvent(event) {
  switch (event.type) {

    case 'start':
      clearFeed()
      etaTestStart  = Date.now()
      etaTotalRuns  = event.total
      addFeedItem(
        `Starting: ${event.questions} questions × ${event.runs} run${event.runs !== 1 ? 's' : ''} = ${event.total} total tests`,
        'feed-waiting'
      )
      updateProgressBar(0, event.total)
      break

    case 'attached':
      addFeedItem(event.message || 'Reconnected — test in progress', 'feed-waiting')
      break

    case 'question_start': {
      addFeedItemHTML(
        `<span class="cat-badge">${escHtml(event.category)}</span>Q${event.index + 1}: ${escHtml(event.question)}`,
        'feed-question',
        `feed-q-${event.index}`
      )
      $('progress-subtitle').textContent = `Testing: "${event.question.substring(0, 60)}${event.question.length > 60 ? '...' : ''}"`
      break
    }

    case 'run_start':
      addFeedItem(
        `  → Run ${event.run + 1} of ${event.runsPerQuestion}...`,
        'feed-run',
        `feed-run-${event.questionIndex}-${event.run}`
      )

      break

    case 'run_complete': {
      const itemId = `feed-run-${event.questionIndex}-${event.run}`
      const timeStr = (event.responseTimeMs / 1000).toFixed(1) + 's'
      if (event.error) {
        updateFeedItem(
          itemId,
          `  → Run ${event.run + 1}: <strong>ERROR</strong> — ${escHtml(event.error)} <span class="time-badge">${timeStr}</span>`,
          'error'
        )
      } else {
        const truncated = (event.response || '').substring(0, 120)
        let html =
          `  → Run ${event.run + 1}: <span class="time-badge">${timeStr}</span>` +
          `<div class="response-text">${escHtml(truncated)}${(event.response || '').length > 120 ? '...' : ''}</div>`
        if (event.screenshotBase64) {
          html += `<img class="feed-thumb" src="${event.screenshotBase64}" alt="screenshot" onclick="showLightbox('${event.screenshotBase64}')" loading="lazy">`
        }
        updateFeedItem(itemId, html, 'success')
      }

      // Update the live preview panel with the latest screenshot
      if (event.screenshotBase64) updatePreviewScreenshot(event.screenshotBase64)

      etaCompletedRuns = event.completed
      updateProgressBar(event.completed, event.total)
      updateETA(event.completed, event.total)

      break
    }

    case 'question_complete': {
      partialQCompleted++
      const qItem = feedItems.find(i => i.id === `feed-q-${event.questionIndex}`)
      if (qItem) {
        const icon = event.consistent ? '✓' : '⚠️'
        const tag  = event.consistent ? '' : ' <span style="color:#f59e0b;font-size:11px;">INCONSISTENT</span>'
        qItem.html = `<span style="margin-right:6px">${icon}</span>` + qItem.html + tag
        renderFeedPage()
      }
      // Update partial download bar
      updatePartialDownloadBar(partialQCompleted, event.totalQuestions || partialQCompleted)
      break
    }

    case 'complete':
      sseSource && sseSource.close()
      // Session is now safely on disk — update localStorage so resume banner shows "completed"
      saveSession(activeConfigId, $('target-url').value.trim() || '')
      // Stop spinner
      const spinner = $('test-spinner')
      if (spinner) spinner.style.display = 'none'
      $('progress-eta').textContent = 'Complete!'
      $('partial-download-bar').classList.add('hidden')

      renderResults(event.results, event.summary)

      if (event.summary?.refundEligible) {
        addFeedItem('⚠ Most questions got no response — the bot may not have been reached. See the notice below.', 'feed-error')
        $('refund-notice').classList.remove('hidden')
        // Show refund contact only for paid tests
        $('refund-notice-paid-msg').classList.toggle('hidden', isDemoMode)
        if (isDemoMode) {
          $('refund-notice-msg').textContent = 'This usually means the page doesn\'t have a chat widget. Since this was a free test, feel free to try again with a different URL — no charge.'
        }
      } else {
        addFeedItem('✓ Test complete! See results below.', 'feed-complete-msg')
      }

      setTimeout(() => scrollTo('results-section'), 800)
      break

    case 'fatal_error':
      sseSource && sseSource.close()
      const sp = $('test-spinner')
      if (sp) sp.style.display = 'none'
      addFeedItem('Fatal error: ' + (event.error || 'Unknown error'), 'feed-error')
      showToast('Test failed: ' + event.error, true)
      break
  }
}

function updateProgressBar(completed, total) {
  const pct = total > 0 ? Math.round((completed / total) * 100) : 0
  $('progress-bar').style.width = pct + '%'
  $('progress-count').textContent = `${completed} / ${total} runs completed`
  $('progress-pct').textContent = pct + '%'
}

function clearFeed() {
  feedItems = []
  feedPage = 0
  feedAutoFollow = true
  renderFeedPage()
}

function addFeedItem(text, className, id) {
  feedItems.push({ className: 'feed-item ' + (className || ''), html: escHtml(text), id: id || null })
  if (feedAutoFollow) feedPage = Math.floor((feedItems.length - 1) / FEED_PAGE_SIZE)
  renderFeedPage()
}

function addFeedItemHTML(html, className, id) {
  feedItems.push({ className: 'feed-item ' + (className || ''), html, id: id || null })
  if (feedAutoFollow) feedPage = Math.floor((feedItems.length - 1) / FEED_PAGE_SIZE)
  renderFeedPage()
}

function updateFeedItem(id, html, extraClass) {
  const item = feedItems.find(i => i.id === id)
  if (!item) return
  item.html = html
  if (extraClass) item.className = item.className.replace(/ (error|success)$/, '') + ' ' + extraClass
  renderFeedPage()
}

function renderFeedPage() {
  const totalPages = Math.max(1, Math.ceil(feedItems.length / FEED_PAGE_SIZE))
  feedPage = Math.min(feedPage, totalPages - 1)

  const start = feedPage * FEED_PAGE_SIZE
  const container = $('live-feed-items')
  container.innerHTML = ''

  feedItems.slice(start, start + FEED_PAGE_SIZE).forEach(item => {
    const el = document.createElement('div')
    el.className = item.className
    if (item.id) el.id = item.id
    el.innerHTML = item.html
    container.appendChild(el)
  })

  // Show/hide pagination controls
  const pag = $('feed-pagination')
  if (!pag) return
  if (totalPages <= 1) {
    pag.classList.add('hidden')
    return
  }
  pag.classList.remove('hidden')
  $('feed-prev').disabled = feedPage === 0
  $('feed-next').disabled = feedPage >= totalPages - 1
  $('feed-page-info').textContent = `Page ${feedPage + 1} of ${totalPages}`
}


// ── Results rendering ─────────────────────────────────────────────────────────
function renderResults(results, summary) {
  showSection('results')

  if (summary) {
    $('sum-total').textContent        = summary.totalRuns
    $('sum-inconsistent').textContent = summary.inconsistentAnswers
    $('sum-errors').textContent       = summary.errors
    $('sum-avgtime').textContent      = (summary.avgResponseTimeMs / 1000).toFixed(1) + 's'
    $('results-timestamp').textContent = 'Completed at ' + new Date(summary.completedAt).toLocaleString()

    if (summary.inconsistentAnswers === 0) {
      $('sum-inconsistent-card').className  = 'summary-card'
      $('sum-inconsistent-card').style.borderColor = '#86efac'
      $('sum-inconsistent-card').style.background  = '#f0fdf4'
    }
    if (summary.errors === 0) {
      $('sum-errors-card').className  = 'summary-card'
      $('sum-errors-card').style.borderColor = '#86efac'
      $('sum-errors-card').style.background  = '#f0fdf4'
    }
  }

  const list = $('results-list')
  list.innerHTML = ''
  if (!results || results.length === 0) {
    list.innerHTML = '<p style="text-align:center;color:#64748b">No results to display.</p>'
    return
  }

  results.forEach((result, i) => {
    const hasError    = result.runs.some((r) => r.error)
    const consistent  = result.consistent
    const cardClass   = hasError ? 'has-error' : !consistent ? 'inconsistent' : ''
    const statusText  = hasError ? 'error' : consistent ? 'consistent' : 'inconsistent'
    const statusLabel = hasError ? 'Error' : consistent ? 'Consistent' : 'Inconsistent'

    const card = document.createElement('div')
    card.className = `result-card ${cardClass}`
    card.innerHTML = `
      <div class="result-card-header" onclick="toggleCard(this)">
        <div class="result-num">${i + 1}</div>
        <div class="result-question-wrap">
          <div class="result-category">${escHtml(result.category)}</div>
          <div class="result-question">${escHtml(result.question)}</div>
        </div>
        <div class="result-status">
          <span class="status-pill ${statusText}">${statusLabel}</span>
          <span class="result-chevron">›</span>
        </div>
      </div>
      <div class="result-card-body">
        ${result.expectation ? `<div class="result-expectation"><strong>Expected behavior</strong>${escHtml(result.expectation)}</div>` : ''}
        <div class="run-list">
          ${result.runs.map((run, r) => `
            <div class="run-item">
              <div class="run-item-header">
                <span class="run-item-label">Run ${r + 1}</span>
                <span class="run-item-time">${(run.responseTimeMs / 1000).toFixed(1)}s</span>
              </div>
              ${run.error
                ? `<div class="run-error">⚠ ${escHtml(run.error)}</div>`
                : `<div class="run-response">${escHtml(run.response || '(no response captured)')}</div>`}
              ${screenshotHtml(run, r)}
            </div>
          `).join('')}
        </div>
      </div>
    `
    list.appendChild(card)
  })
}

function screenshotHtml(run, r) {
  if (run.screenshotBase64) {
    // Inline base64 (from SSE stream, in memory)
    return `<div class="run-screenshot"><img src="${run.screenshotBase64}" alt="Screenshot run ${r + 1}" onclick="showLightbox('${run.screenshotBase64}')" loading="lazy"></div>`
  }
  if (run.screenshotPath) {
    // Load from server (e.g. after page refresh)
    const filename = run.screenshotPath.split('/').pop()
    const src = `/api/screenshots/${activeConfigId}/${encodeURIComponent(filename)}`
    return `<div class="run-screenshot"><img src="${src}" alt="Screenshot run ${r + 1}" onclick="showLightbox(this.src)" loading="lazy"></div>`
  }
  return ''
}

function toggleCard(header) {
  header.closest('.result-card').classList.toggle('open')
}

// ── Downloads ─────────────────────────────────────────────────────────────────
function handleDownload() {
  if (!activeConfigId) return
  window.location = `/api/download/${activeConfigId}`
}

// ── Lightbox ──────────────────────────────────────────────────────────────────
function showLightbox(src) {
  const box = document.createElement('div')
  box.className = 'lightbox'
  box.onclick   = () => box.remove()
  const img = document.createElement('img')
  img.src = src
  box.appendChild(img)
  document.body.appendChild(box)
}

// ── Helpers ───────────────────────────────────────────────────────────────────
function showSection(name) {
  if (name === 'progress') $('progress-section').classList.remove('hidden')
  if (name === 'results')  $('results-section').classList.remove('hidden')
}

function scrollTo(id) {
  const el = $(id)
  if (el) el.scrollIntoView({ behavior: 'smooth', block: 'start' })
}

function escHtml(str) {
  if (!str) return ''
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;')
}

function showToast(msg, isError) {
  const toast = $('toast')
  $('toast-msg').textContent = msg
  toast.className = 'toast' + (isError ? ' error' : '')
  toast.classList.remove('hidden')
  setTimeout(hideToast, 6000)
}

function hideToast() { $('toast').classList.add('hidden') }

// Expose globals for inline onclick handlers
window.toggleCard          = toggleCard
window.showLightbox        = showLightbox
window.hideToast           = hideToast
window.removeManualQuestion = removeManualQuestion
