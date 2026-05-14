# Setup Guide: HCP MCP Worker

Step-by-step walkthrough for deploying this worker and configuring it for your HCP account.

## Prerequisites

- A HouseCall Pro account with API access
- A GitHub account
- A Cloudflare account (free tier is fine)

---

## Step 1: Fork the repo

1. Go to [kjricciardiacauth/hcp-mcp-template](https://github.com/kjricciardiacauth/hcp-mcp-template)
2. Click **Fork** → **Create fork**
3. Clone your fork locally:
   ```bash
   git clone https://github.com/YOUR_USERNAME/hcp-mcp-template.git
   cd hcp-mcp-template
   ```

---

## Step 2: Create KV namespaces

This worker requires two KV namespaces. Create them in Cloudflare **before** deploying.

1. **Cloudflare dashboard** → **KV** (under Storage & Databases) → **Create namespace**
2. Create `hcp-activity` → copy the **ID**
3. Create `hcp-tokens` → copy the **ID**

Edit `wrangler.toml` in your fork and replace the placeholder IDs:

```toml
[[kv_namespaces]]
binding = "ACTIVITY_KV"
id = "paste-your-activity-kv-id-here"

[[kv_namespaces]]
binding = "MCP_TOKENS"
id = "paste-your-tokens-kv-id-here"
```

Commit and push:

```bash
git add wrangler.toml
git commit -m "Add KV namespace IDs"
git push origin main
```

> **Why wrangler.toml?** Cloudflare Workers Builds treats this file as the source of truth for bindings. Anything only set in the dashboard gets wiped on the next deploy. Secrets are safe — Wrangler never wipes secrets.

---

## Step 3: Deploy with git-connect

1. **Cloudflare dashboard** → **Workers & Pages** → **Create** → **Deploy with Git**
2. **Connect a Repository**
   - Authorize GitHub
   - Select your fork: `YOUR_USERNAME/hcp-mcp-template`
   - Branch: `main`
   - Root directory: `.`
   - Build command: (leave empty)
   - Deploy command: `npx wrangler deploy`
3. Click **Save and Deploy**

Takes ~2 minutes for the first deploy.

---

## Step 4: Add secrets

**Cloudflare dashboard** → your worker → **Settings** → **Variables and Secrets** → **Add**:

| Secret | Required | Notes |
|---|---|---|
| `HCP_API_KEY` | **Yes** | From HCP Account Settings → API Tokens |
| `HCP_WEBHOOK_SECRET` | No | HMAC signing secret; set if you want to validate incoming HCP webhooks |
| `ZAPIER_URL` | No | Zapier catch hook URL; if set, all incoming HCP webhooks are forwarded there |

Save & deploy after adding secrets.

---

## Step 5: Create your first access token

All `/mcp` requests require a token. Tokens live in the `hcp-tokens` KV namespace.

1. **Cloudflare dashboard** → **KV** → click `hcp-tokens`
2. Click **Add entry**
3. **Key:** any string you choose — this is the token (e.g. `my-secret-token-abc123`)
4. **Value:** `{"name":"Your Name","tier":"write"}`
5. Click **Add entry**

**Tiers:**

| Tier | Access |
|---|---|
| `write` | Full access — all 93 tools |
| `read` | Read-only — list and get tools only; write/delete tools are blocked |

To add more users: repeat with a different key. To revoke: delete the entry.

---

## Step 6: Verify

```bash
curl https://your-worker.workers.dev/
# → "HouseCall Pro MCP Worker v3.3.1 — 93 tools | /mcp | /webhook | /activity | /dashboard"
```

Test MCP with your token:

```bash
curl -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","method":"tools/list","id":1,"params":{}}' \
  "https://your-worker.workers.dev/mcp?token=YOUR_TOKEN"
```

---

## Step 7: Connect Claude

Add to Claude Code or any MCP client:

```
https://your-worker.workers.dev/mcp?token=YOUR_TOKEN
```

Or pass the token as a header instead:

```
Authorization: Bearer YOUR_TOKEN
```

---

## Step 8 (Optional): Set up webhooks

See [WEBHOOK_SETUP.md](WEBHOOK_SETUP.md) for full instructions.

Quick version:

1. In HCP admin → **Account Settings** → **Webhooks**
2. URL: `https://your-worker.workers.dev/webhook`
3. Enable HMAC signing; use the same secret you set as `HCP_WEBHOOK_SECRET`
4. Select events to subscribe to

Received events are stored in `ACTIVITY_KV` (48h TTL) and viewable at `/activity`.

---

## Troubleshooting

### MCP returns 401

- Make sure your URL includes `?token=YOUR_TOKEN`
- Confirm the token key exists in the `hcp-tokens` KV namespace
- Confirm the KV value is valid JSON: `{"name":"...","tier":"write"}`

### HCP API calls return 401

- Verify `HCP_API_KEY` is set correctly in Cloudflare Secrets
- Test directly: `curl -H "Authorization: Bearer YOUR_HCP_KEY" https://api.housecallpro.com/customers`

### Worker crashes on deploy

- Confirm both KV namespace IDs are real (not placeholder strings) in `wrangler.toml`
- Check **Workers** → **Deployments** tab for the error

### Changes not deploying

- Confirm you pushed to `main` branch
- Check **Cloudflare Workers** → **Deployments** tab — if the deploy failed, click it to see the error

---

## Next steps

- **Add custom tools:** [CUSTOM_TOOLS.md](CUSTOM_TOOLS.md)
- **Monitor webhooks:** Query `/activity` after setting up webhook subscriptions
- **Dispatch dashboard:** Open `/dashboard` in a browser for a live job board
