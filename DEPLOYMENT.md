# BotAudit Deployment

The site is hosted via **Cloudflare Tunnel** pointed at a Node.js process running on Tyson's home Pi 5 (`mintcoke-pi`, reachable via Tailscale). The Mac setup below is kept as a fallback path. This is the only hosting option that meets all three constraints (free forever, no credit card, can run Playwright + Chromium).

## Day-to-day operations (Pi)

Reach the Pi via Tailscale: `ssh pi@mintcoke-pi` (Tailscale SSH handles auth).

```bash
# Restart the Node server
sudo systemctl restart botaudit-server

# Restart the tunnel
sudo systemctl restart cloudflared

# Tail logs
sudo journalctl -u botaudit-server -f
sudo journalctl -u cloudflared -f
# Server stdout/stderr files
tail -f /var/log/botaudit/server.log

# Pull new code (run from Mac)
rsync -avz --exclude='.git/' --exclude='node_modules/' --exclude='results/' \
  --exclude='outreach/results/' --exclude='*.log' --exclude='.env' \
  ~/code/personal/business/botaudit/ pi@mintcoke-pi:/home/pi/botaudit/ \
  && ssh pi@mintcoke-pi 'cd ~/botaudit && npm ci && sudo systemctl restart botaudit-server'
```

Tunnel UUID: `4aa94e92-23bb-4e9a-a7bf-322bfd97ceeb` (same UUID as Mac fallback — only one host at a time should run it, though multiple is supported with HA).

Files of note on the Pi:
- `/home/pi/botaudit/` — app
- `/home/pi/botaudit/.env.local` — secrets (gitignored, holds Stripe restricted key)
- `/etc/cloudflared/config.yml` + `/etc/cloudflared/4aa94e92-...json` — tunnel config (root-owned, system service path)
- `/etc/systemd/system/botaudit-server.service` — Node server unit
- `/etc/systemd/system/cloudflared.service` — tunnel unit (created by `cloudflared service install`)
- `/var/log/botaudit/` — server stdout/stderr

## Mac fallback path

If the Pi is offline (rare; it's a home device on UPS-grade reliability), bring the Mac back up:

```bash
launchctl load -w ~/Library/LaunchAgents/com.botaudit.cloudflared.plist
launchctl load -w ~/Library/LaunchAgents/com.botaudit.server.plist
```

Both run the same tunnel UUID, so DNS doesn't change. To return to Pi-only afterward:

```bash
launchctl unload -w ~/Library/LaunchAgents/com.botaudit.cloudflared.plist
launchctl unload -w ~/Library/LaunchAgents/com.botaudit.server.plist
```

---

## Original setup notes (for reference / starting over)

## Why this setup

- **Free forever, no card.** Cloudflare account signup needs no credit card. Domain stays on Porkbun (or moves to Cloudflare DNS — both work).
- **Real compute.** Playwright + headless Chromium needs ~1 GB RAM per audit. The Mac has plenty; the 512 MB free PaaS tiers (Render, Koyeb, etc.) OOM mid-run.
- **Custom domain.** Tunnel routes `botaudit.app` directly to localhost.
- **Tradeoff:** the site is up only when the Mac is awake. For 0–5 audits/week of light traffic, this is fine.

## One-time setup (Tyson runs this once)

### 1. Install cloudflared

```bash
brew install cloudflared
```

### 2. Authenticate with Cloudflare

```bash
cloudflared tunnel login
```

A browser window opens. Sign up / log in (no credit card). Pick `botaudit.app` from the zone list and authorize. This drops a cert at `~/.cloudflared/cert.pem`.

If `botaudit.app` isn't already on a Cloudflare zone:
- In the Cloudflare dashboard, click **Add a site**, enter `botaudit.app`, choose the **Free** plan.
- Cloudflare will give you two nameservers (e.g. `ada.ns.cloudflare.com`, `bob.ns.cloudflare.com`).
- Log into Porkbun → `botaudit.app` → **Authoritative Nameservers** → replace with the two Cloudflare nameservers.
- Wait 5–60 minutes for propagation. `dig NS botaudit.app +short` should return the Cloudflare ones.

### 3. Create the tunnel

```bash
cloudflared tunnel create botaudit
```

This prints a tunnel ID (UUID) and writes credentials to `~/.cloudflared/<UUID>.json`. Note the UUID.

### 4. Wire DNS to the tunnel

```bash
cloudflared tunnel route dns botaudit botaudit.app
cloudflared tunnel route dns botaudit www.botaudit.app
```

This creates CNAMEs in the Cloudflare DNS dashboard for `botaudit.app` and `www.botaudit.app` pointing at `<UUID>.cfargotunnel.com`.

### 5. Drop in the tunnel config

The repo has `.cloudflared-config.example.yml`. Copy it to `~/.cloudflared/config.yml` and fill in the tunnel UUID:

```bash
cp .cloudflared-config.example.yml ~/.cloudflared/config.yml
# then edit ~/.cloudflared/config.yml — replace TUNNEL_UUID with the ID from step 3
```

### 6. Install `cloudflared` as a launchd service so it runs on boot

```bash
sudo cloudflared service install
```

That registers a launchd plist that starts cloudflared at login. To check it:

```bash
sudo launchctl list | grep cloudflared
```

### 7. Set up the Node process

```bash
cd ~/code/personal/business/botaudit
cp .env.example .env.local         # then fill in real Stripe + email keys
npm ci
npx playwright install chromium    # already runs via postinstall, but confirm
```

### 8. Run the server as a launch agent so it stays up

The repo has `com.botaudit.server.plist` — copy it to `~/Library/LaunchAgents/` and load it:

```bash
cp com.botaudit.server.plist ~/Library/LaunchAgents/
launchctl load -w ~/Library/LaunchAgents/com.botaudit.server.plist
```

The plist runs `node server.js` with the working directory set to the repo, restarts on crash, and writes logs to `~/Library/Logs/botaudit/`.

### 9. Verify

```bash
curl -I https://botaudit.app                   # should return 200
curl -I https://botaudit.app/api/health        # should return JSON {ok:true,chromium:"working"}
```

## Day-to-day operations

### Restart the server

```bash
launchctl kickstart -k gui/$(id -u)/com.botaudit.server
```

### Tail the server logs

```bash
tail -f ~/Library/Logs/botaudit/server.log
```

### Update and redeploy

```bash
cd ~/code/personal/business/botaudit
git pull
npm ci
launchctl kickstart -k gui/$(id -u)/com.botaudit.server
```

### Stop everything

```bash
launchctl unload ~/Library/LaunchAgents/com.botaudit.server.plist
sudo launchctl unload /Library/LaunchDaemons/com.cloudflare.cloudflared.plist
```

## When the Mac sleeps

If the Mac sleeps, the tunnel goes dark and visitors get a Cloudflare error page (502). To prevent this:

- **Option A:** keep the Mac on AC power and disable sleep in System Settings → Battery → Power Adapter.
- **Option B:** run `caffeinate -d -s &` to keep the display awake (useful if the Mac is a dev box that you also use).
- **Option C:** move the workload to a cheap always-on device later (an old Mac mini or a Raspberry Pi 4 with 4 GB RAM both work).

## If something breaks

| Symptom | Likely cause | Fix |
|---|---|---|
| `botaudit.app` returns CF 502/521 | tunnel not running | `sudo launchctl list \| grep cloudflared` and `cloudflared tunnel info botaudit` |
| `botaudit.app` returns CF 1033 / "tunnel not found" | DNS not pointing at tunnel | re-run `cloudflared tunnel route dns botaudit botaudit.app` |
| 200 from CF, 502/error inside the page | Node server down | `launchctl list \| grep com.botaudit` then `launchctl kickstart -k …` |
| Playwright errors "browser not found" | Chromium dep missing | `npx playwright install chromium --with-deps` |
| Demo gate blocks first visitor | `req.ip` resolving to localhost | confirm `app.set('trust proxy', true)` in `server.js`, restart |

## Future option: split static + API

If always-on marketing matters more later, push `public/` to Cloudflare Pages (free, no CC, edge-cached) and tunnel only the `/api/*` endpoints to the Mac under `api.botaudit.app`. Marketing pages then stay up even when the Mac is off; only audits stop. This requires CORS + an `API_BASE` env var the frontend reads, both of which are easy to add when it's worth it.
