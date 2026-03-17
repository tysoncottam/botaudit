# BotAudit — Claude Context

## Project Overview

BotAudit (botaudit.app) is a SaaS tool that automatically tests AI support bots. Users enter a URL, configure questions and run counts, pay once via Stripe, and get a detailed PDF audit report showing bot response consistency, errors, response times, and screenshots.

**Owner:** Tyson Cottam (tysoncottam@gmail.com), Utah-based
**GitHub:** tysoncottam/botaudit
**Hosting:** Railway (auto-deploys on push to main)
**Domain:** botaudit.app (Porkbun, ALIAS → Railway)

---

## Tech Stack

- **Backend:** Express.js (`server.js`), Node.js
- **Bot testing:** Playwright (`tester.js`) — supports 15+ platforms (see Supported Platforms below)
- **Frontend:** Vanilla HTML/CSS/JS (`public/index.html`, `public/app.js`, `public/style.css`)
- **Payments:** Stripe Checkout (one-time, no subscription)
- **Progress streaming:** Server-Sent Events (SSE)
- **PDF reports:** Playwright headless Chromium (`generate-report.js`)
- **Email:** Gmail SMTP via nodemailer
- **Analytics:** Google Analytics 4 (G-JQ6E8GS4DE)
- **Error monitoring:** Sentry (server: botaudit-server project, frontend: botaudit-frontend project)

---

## Supported Chat Platforms

The tester auto-detects and interacts with these chat widget platforms:

| Platform | Detection Method | Notes |
|---|---|---|
| Zendesk (classic) | `iframe#launcher` | Click launcher button in iframe |
| Zendesk Messaging | `div#launcher[role="button"]`, zdassets CDN | Newer widget variant |
| Sunshine Conversations | `iframe#web-messenger-container` | Zendesk-owned, navigates from help view to chat |
| Intercom | `intercom-launcher`, `intercom-frame` | Clicks Messages tab, then "Send us a message" for help-center layouts |
| Drift | `#drift-widget`, `iframe[title*="Drift"]` | 10s timeout for slow renders |
| Crisp | `[class*="crisp-client"]` | Direct button click |
| HubSpot | `#hubspot-messages-iframe-container` | Iframe-based launcher |
| Freshchat | `#fc_frame` | Iframe or button |
| Tidio | `#tidio-chat-iframe` | Iframe-based |
| LiveChat | `#chat-widget-container` | Button or iframe |
| Tawk.to | `#tawkchat-minified-iframe` | Iframe-based |
| Olark | `#olark-wrapper` | Direct button click |
| Zoom Contact Center | `#zoom-contactcenter-chat-root` | Shadow DOM widget, fills pre-chat form, re-clicks launcher if collapsed |
| Gorgias | `#gorgias-chat-container` | Iframe or div |
| Qualified | `iframe#q-messenger-frame` | Clicks routing buttons ("I need customer support") |
| Forethought | `iframe#forethought-chat` | Dismisses in-widget consent dialog |
| Ada | `iframe#ada-button-frame` → `iframe#ada-chat-frame` | Button frame opens chat frame |
| Generic | `[aria-label*="chat"]`, `[title*="chat"]`, etc. | Fallback for unknown platforms |

### Platform Detection Flow
1. Fast fingerprint scan (checks DOM markers, script URLs, iframe attributes)
2. Try detected platforms first (avoids 50s timeout cascade)
3. Fall back to generic selectors if no platform detected

### Key Tester Features
- **Overlay dismissal:** Cookie banners (OneTrust, CookieBot, Transcend, generic), Bounce Exchange popups (nuclear removal), high-z-index fixed overlays, promotional modals — all dismissed before widget interaction. Skips elements inside chat widgets.
- **In-widget consent:** Detects and dismisses terms/privacy dialogs inside chat iframes (e.g. Forethought "Just a heads-up" dialog).
- **Send button fallback:** If Enter doesn't submit (React controlled inputs), tries labeled send buttons then adjacent buttons.
- **Realistic input:** Uses `type()` instead of `fill()` for non-shadow-DOM inputs — triggers React/Vue event handlers.
- **Mid-conversation email:** Auto-fills `audit@botaudit.app` when bot asks for email after question is sent.
- **Screenshot on error:** Captures widget state even when no text input exists (routing-only bots like Qualified).
- **Verbose logging:** `[overlay]`, `[widget]`, `[input]`, `[send]`, `[email]`, `[zoom-cc]`, `[intercom]`, `[qualified]` prefixes for debugging.

---

## Key Files

| File | Purpose |
|---|---|
| `server.js` | Express server, Stripe checkout, SSE streaming, session management, file serving |
| `tester.js` | Playwright test engine — fresh browser context per run, text stability detection |
| `generate-report.js` | PDF report generator via headless Chromium |
| `default-questions.js` | 20 generic test questions across 6 categories |
| `Dockerfile` | node:22-slim with Playwright Chromium system deps for Railway |
| `public/index.html` | Main single-page app with GA4, Sentry, JSON-LD structured data |
| `public/app.js` | Frontend logic — SSE client, results rendering, share button, session recovery |
| `public/share.html` | Public read-only shareable results page at `/r/:configId` |
| `public/blog/` | SEO blog with 3 posts targeting Zendesk bot testing keywords |
| `diagnose-widget.js` | Diagnostic tool — inspects page DOM to identify chat widget structure |
| `test-all-single.js` | Smoke test — runs 1 question × 1 run on every target company |
| `outreach/run-outreach.js` | Cold outreach script — runs audits on target companies, generates email drafts + LinkedIn files |
| `outreach/targets.json` | 8 verified companies with confirmed chat widgets |
| `INFRASTRUCTURE-TEMPLATE.md` | Reusable infrastructure setup template for future projects |

---

## Pricing

- $0.75 per question per run (1×), $0.50 (3×), $0.40 (5×)
- +$0.25 per question for screenshots
- $10 minimum charge
- Free demo: 3 questions × 1 run (IP-restricted, one per network)

---

## Infrastructure

- **Railway project:** joyful-courtesy, auto-deploys on push to main
- **DNS:** Porkbun ALIAS → 98c78obl.up.railway.app
- **Email:** support@botaudit.app → tysoncottam@gmail.com (Porkbun forwarding)
- **Stripe:** Live keys in Railway environment variables
- **Google Search Console:** Verified via HTML file, sitemap submitted
- **Google Analytics:** GA4 property G-JQ6E8GS4DE, account 145224052
- **Sentry DSNs:**
  - Server: `https://ef91866ed864042f89a89d82f136cc68@o4511044528832512.ingest.us.sentry.io/4511044540235776`
  - Frontend: `https://ff2b83a4b05f68bd131cbde640449e93@o4511044528832512.ingest.us.sentry.io/4511044557275136`

---

## Session Architecture

Sessions are identified by a UUID `configId`. They live in memory during a run and are persisted to `results/{configId}/` on disk:
- `session-meta.json` — status, config
- `results.json` — full results
- `summary.json` — scorecard
- `partial-results.json` — written after each question completes
- `audit-report.pdf` — generated after completion
- `screenshots/` — one PNG per run per question

**Server restart recovery:** `/api/stream/:configId` restores sessions from disk before returning 404. Completed sessions send a `complete` SSE event; interrupted mid-run sessions send an `interrupted` event with partial results.

---

## PDF Report Generation

`generate-report.js` exports `generateReport({ config, results, summary, outputDir })`:
1. Builds a self-contained HTML string
2. Writes to `outputDir/report.html`
3. Launches headless Chromium, exports `outputDir/audit-report.pdf`

Called non-blocking after `event.type === 'complete'` in the SSE broadcast function.

---

## Cold Outreach Script

`outreach/run-outreach.js` — runs locally on Tyson's machine:
```bash
cd outreach
node run-outreach.js                    # all targets
node run-outreach.js nature             # single company (partial match)
node run-outreach.js --skip-done        # skip completed ones
HEADLESS=false node run-outreach.js     # visible browser for debugging
```

Outputs per company in `outreach/results/{slug}/`:
- `audit-report.pdf` — attach to cold email
- `email-draft.txt` — personalized email with findings baked in
- `linkedin.txt` — LinkedIn search URL + connection/follow-up message templates

### Current Target List (8 companies)
1. Nature's Sunshine — Zoom Contact Center (Utah-based)
2. Pluralsight — Qualified (Utah-based, routing-only widget)
3. Squarespace — Sunshine Conversations
4. Grammarly — Forethought
5. Calendly — Ada
6. Typeform — Zendesk
7. Angel — TBD
8. OpenAI — TBD

### Companies Removed (and why)
- HireVue — No visible chat widget on help center
- Freshdesk — No chat widget (just Twitter widget)
- Hotjar — Ada button exists but invisible (login-gated)
- Unbounce — No chat widget (just Zendesk help center)
- Zapier — No actual support bot
- Teachable — Intercom requires past conversation for Messages tab
- monday.com — Custom React microfrontend, no standard chat patterns

---

## SEO & Discoverability

- `public/robots.txt` — allows all crawlers, points to sitemap
- `public/sitemap.xml` — homepage + 4 blog URLs
- `public/llms.txt` — AI crawler description (ChatGPT, Perplexity, Claude)
- JSON-LD structured data in `index.html` — SoftwareApplication, FAQPage, WebSite schemas (lists all 15+ supported platforms)
- `public/blog/` — 3 SEO posts targeting "zendesk bot testing", "chatbot inconsistent answers", "chatbot audit checklist"
- Google Search Console verified, sitemap submitted March 2025

---

## Key Design Decisions

- **Fresh context per run:** Each question run gets a new browser context so the bot has no memory of prior questions.
- **Text stability detection:** Polls bot response text until it stops changing for N consecutive checks — handles variable response times gracefully.
- **Non-blocking PDF generation:** PDF export happens after results are broadcast so audit completion isn't delayed.
- **Shareable results:** Completed audits are accessible at `/r/:configId` — UUID is the access control (unguessable link).
- **No user accounts:** Sessions identified by configId only. Email collected for completion notifications but no login system.
- **type() over fill():** Playwright's `fill()` doesn't trigger React/Vue event handlers on controlled inputs. `type()` simulates real keystrokes.
- **Screenshot on error:** Always capture widget state — routing-only bots and failed interactions are still valuable audit findings.
- **Overlay dismissal order:** Cookie banners → Bounce Exchange → high-z-index nuclear → promotional modals. Chat widget elements are excluded from dismissal via parent selector checks.
