# CAC Staff Racing 2026

Results website for the Calshot Activity Centre after-work sailing series.

**Live site:** [calshot-racing.pages.dev](https://calshot-racing.pages.dev)  
**Admin panel:** [calshot-racing.pages.dev/admin.html](https://calshot-racing.pages.dev/admin.html)

---

## What this is

A static results website backed by a Cloudflare Worker and R2 storage. Results are uploaded after each racing evening via the password-protected admin panel — no code changes required during the season.

---

## Repository contents

| File | Purpose |
|------|---------|
| `index.html` | The entire public website |
| `admin.html` | Password-protected admin panel |
| `SIs_2026.pdf` | Sailing Instructions — linked from the SI page |
| `worker.js` | Cloudflare Worker API (R2 read/write) |
| `wrangler.toml` | Worker configuration |

---

## Infrastructure

| Item | Value |
|------|-------|
| Hosting | Cloudflare Pages (this repo) |
| API | Cloudflare Worker — `calshot-racing-api` |
| Storage | Cloudflare R2 — `calshot-racing-results` bucket |
| Account | `31fed8a3586b986322ee1df1ef721c0e` |

---

## Deploying

### Website (index.html, admin.html, SIs_2026.pdf)

Push to this repo. Cloudflare Pages deploys automatically.

```bash
git add .
git commit -m "describe change"
git push
```

### Worker (worker.js)

The Worker is in a separate local directory (`C:\Projects\calshot-racing-api`) and must be deployed manually whenever `worker.js` changes:

```bash
wrangler deploy
```

> **Note:** Pushing `worker.js` to this repo does NOT deploy it. You must run `wrangler deploy` separately.

---

## Admin panel usage

1. Go to `calshot-racing.pages.dev/admin.html`
2. Enter the admin password (stored as a Cloudflare Worker secret — not in this repo)
3. Select year, result type and date, choose the Sailwave HTML export, preview and upload
4. For Sailwave-hosted results links, use the Sailwave Links section

Full workflow documentation is in the handover document.

---

## R2 file naming

The Worker enforces these key patterns — uploads with any other filename are rejected:

| Pattern | Example |
|---------|---------|
| `series[1-3]_YYYY.html` | `series1_2026.html` |
| `overall_YYYY.html` | `overall_2026.html` |
| `evening_YYYY-MM-DD.html` | `evening_2026-04-14.html` |
| `special_YYYY_NN.html` | `special_2026_01.html` |
| `SIs_YYYY.pdf` | `SIs_2026.pdf` |
| `sailwave_links.json` | Sailwave link map (auto-managed) |

---

## Local development

Serve `index.html` locally on port 8080 or 5500 — both are in the Worker's CORS allowlist:

```bash
# Using Python
python -m http.server 8080

# Or use VS Code Live Server (defaults to port 5500)
```

---

## Related project

The Calshot Solent Weather app is a separate project on the same Cloudflare account:  
[calshot-weather3.pages.dev](https://calshot-weather3.pages.dev) — repo: `tubby-dug/Calshot-app`

---

*Calshot Activity Centre — Hampshire County Council*
