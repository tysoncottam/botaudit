# Web Project Infrastructure Template

Use this file as a CLAUDE.md reference (or include it in a new project's CLAUDE.md) so Claude understands the standard infrastructure stack and can set everything up consistently.

---

## Owner

**Tyson Cottam** (tysoncottam@gmail.com), Utah-based

---

## Standard Stack

| Layer | Service | Notes |
|-------|---------|-------|
| **Domain** | Porkbun | ALIAS record to Railway |
| **Email forwarding** | Porkbun | support@domain.com → tysoncottam@gmail.com |
| **Hosting** | Railway | Auto-deploy on push to main |
| **Backend** | Express.js (Node.js) | Vanilla — no Next.js/Nuxt unless needed |
| **Frontend** | Vanilla HTML/CSS/JS | No framework unless the project requires one |
| **Payments** | Stripe Checkout | One-time payments preferred, subscriptions when needed |
| **Analytics** | Google Analytics 4 | gtag.js async snippet |
| **SEO** | Google Search Console | HTML file verification, sitemap submitted |
| **Error monitoring** | Sentry | Separate projects for frontend + backend |
| **Email sending** | Gmail SMTP via nodemailer | App Password, not regular password |
| **PDF generation** | Playwright headless Chromium | If project needs it |

---

## Setup Checklist for a New Project

### 1. Domain (Porkbun)

- Register domain at porkbun.com
- Add ALIAS record pointing to `{project-slug}.up.railway.app`
- Set up email forwarding: `support@newdomain.com` → `tysoncottam@gmail.com`
- SSL is handled automatically by Railway

### 2. Hosting (Railway)

- Create new project at railway.app
- Connect GitHub repo for auto-deploy on push to main
- Add custom domain in Railway settings
- Set environment variables (see Environment Variables section below)

**Dockerfile pattern:**
```dockerfile
FROM node:22-slim
WORKDIR /app
RUN apt-get update
COPY package*.json ./
RUN npm ci
RUN rm -rf /var/lib/apt/lists/*
COPY . .
CMD ["node", "server.js"]
```

If using Playwright/Chromium, add to package.json scripts:
```json
"postinstall": "npx playwright install chromium --with-deps"
```

### 3. Google Analytics 4

- Create a new GA4 property at analytics.google.com
- Get the Measurement ID (format: `G-XXXXXXXXXX`)
- Add this snippet to `<head>` of every HTML page:

```html
<script async src="https://www.googletagmanager.com/gtag/js?id=G-XXXXXXXXXX"></script>
<script>
  window.dataLayer = window.dataLayer || [];
  function gtag(){dataLayer.push(arguments);}
  gtag('js', new Date());
  gtag('config', 'G-XXXXXXXXXX');
</script>
```

### 4. Google Search Console

- Go to search.google.com/search-console
- Add property for the new domain
- Verify via HTML file method — download the file and place it in `public/`
- Create and submit `public/sitemap.xml`:

```xml
<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <url>
    <loc>https://yourdomain.com/</loc>
    <lastmod>2025-01-01</lastmod>
    <changefreq>weekly</changefreq>
    <priority>1.0</priority>
  </url>
  <!-- Add more URLs as pages are created -->
</urlset>
```

- Create `public/robots.txt`:
```
User-agent: *
Allow: /
Sitemap: https://yourdomain.com/sitemap.xml
```

### 5. Sentry (Error Monitoring)

- Create a **Sentry organization** (or use existing: o4511044528832512)
- Create **two projects** per app: one for frontend, one for backend

**Frontend (add to `<head>`):**
```html
<script src="https://browser.sentry-cdn.com/10.43.0/bundle.min.js" crossorigin="anonymous"></script>
<script>
  Sentry.init({
    dsn: 'https://YOUR_FRONTEND_DSN',
    tracesSampleRate: 0.2,
  });
</script>
```

**Backend (top of server.js):**
```js
const Sentry = require('@sentry/node')
Sentry.init({
  dsn: 'https://YOUR_BACKEND_DSN',
  environment: process.env.NODE_ENV || 'production',
  tracesSampleRate: 0.2,
})

// After all routes:
Sentry.setupExpressErrorHandler(app)
```

### 6. Stripe

- Create products/prices in Stripe Dashboard
- Use Stripe Checkout for payment flow (redirect, not embedded)
- Store keys in Railway environment variables — never in code

```js
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY)

// Checkout session pattern:
const session = await stripe.checkout.sessions.create({
  payment_method_types: ['card'],
  mode: 'payment',  // or 'subscription'
  line_items: [{ price_data: { ... }, quantity: 1 }],
  success_url: `${BASE_URL}/?session_id={CHECKOUT_SESSION_ID}`,
  cancel_url: `${BASE_URL}/`,
  metadata: { /* custom data to link back to your session */ },
})
```

### 7. Email (nodemailer + Gmail SMTP)

- Use a Gmail App Password (not regular password)
- Generate at myaccount.google.com → Security → 2-Step Verification → App Passwords

```js
const nodemailer = require('nodemailer')
const transporter = nodemailer.createTransport({
  host: process.env.EMAIL_HOST || 'smtp.gmail.com',
  port: parseInt(process.env.EMAIL_PORT || '587'),
  secure: process.env.EMAIL_SECURE === 'true',
  auth: {
    user: process.env.EMAIL_USER,
    pass: process.env.EMAIL_PASS,
  },
})
```

### 8. SEO Extras

**JSON-LD structured data** — add to `<head>` for rich search results:
```html
<script type="application/ld+json">
{
  "@context": "https://schema.org",
  "@type": "WebSite",
  "name": "Your App Name",
  "url": "https://yourdomain.com"
}
</script>
```

**Open Graph + Twitter meta tags:**
```html
<meta property="og:title" content="Your App Name">
<meta property="og:description" content="One-line description">
<meta property="og:type" content="website">
<meta property="og:url" content="https://yourdomain.com">
<meta name="twitter:card" content="summary_large_image">
```

**AI crawler file** — create `public/llms.txt` describing what the app does for ChatGPT/Perplexity/Claude crawlers.

---

## Environment Variables Template

Copy this to `.env` for local development or set in Railway dashboard for production:

```bash
# Required
PORT=3000
BASE_URL=https://yourdomain.com
NODE_ENV=production

# Stripe
STRIPE_SECRET_KEY=sk_live_...
STRIPE_PUBLISHABLE_KEY=pk_live_...

# Email (optional — app should work without it)
EMAIL_HOST=smtp.gmail.com
EMAIL_PORT=587
EMAIL_SECURE=false
EMAIL_USER=you@gmail.com
EMAIL_PASS=your-app-password
EMAIL_FROM=YourApp <you@gmail.com>
ADMIN_EMAIL=tysoncottam@gmail.com

# Admin
ADMIN_KEY=random-secret-for-admin-endpoints
```

---

## Standard package.json Dependencies

```json
{
  "dependencies": {
    "express": "^4.19.2",
    "dotenv": "^16.4.5",
    "stripe": "^16.12.0",
    "uuid": "^10.0.0",
    "@sentry/node": "^10.43.0",
    "nodemailer": "^6.9.14"
  },
  "scripts": {
    "start": "node server.js",
    "dev": "node --watch server.js"
  }
}
```

Add as needed:
- `archiver` — ZIP file generation
- `multer` — file upload handling
- `playwright` — browser automation / PDF generation

---

## Project Structure Pattern

```
/
├── server.js              # Express app + all API routes
├── package.json
├── Dockerfile
├── .env                   # (gitignored) Local secrets
├── .env.example           # Template for env vars
├── .gitignore
├── CLAUDE.md              # Project context for Claude
├── public/
│   ├── index.html         # Main page (GA4 + Sentry in <head>)
│   ├── app.js             # Frontend logic
│   ├── style.css
│   ├── robots.txt
│   ├── sitemap.xml
│   ├── llms.txt
│   └── google-*.html      # Search Console verification
└── results/               # (gitignored) Runtime data
```

