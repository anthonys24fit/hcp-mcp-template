# Setup Guide: HCP MCP Worker

Step-by-step walkthrough of deploying this worker and configuring it for your HCP account.

## Prerequisites

- A HouseCall Pro account with API access
- A GitHub account
- A Cloudflare account (free tier is fine)

## Step 1: Fork the repo

1. Go to [this repo](https://github.com/YOUR_URL_HERE)
2. Click **Fork** in the top right
3. Choose your account as the fork destination
4. Clone your fork locally:
   ```bash
   git clone https://github.com/YOUR_USERNAME/hcp-mcp-template.git
   cd hcp-mcp-template
   ```

## Step 2: Create Cloudflare Worker with git-connect

1. **Cloudflare dashboard** → **Workers & Pages** → **Create Application**
2. Click **Deploy with Git**
3. **Connect a Repository**
   - Authorize GitHub
   - Select your fork: `YOUR_USERNAME/hcp-mcp-template`
   - Branch: `main`
   - Root directory: `.` (empty is fine)
   - Build command: (leave empty)
   - Deploy command: `npx wrangler deploy`
4. Click **Save and Deploy**

Cloudflare creates the worker and makes the first deploy. Takes ~2 minutes.

## Step 3: Get your HCP API key

1. **HouseCall Pro** → **Account Settings** → **API Tokens**
2. Create a new API token (or use an existing one)
3. Copy the token (you won't see it again)

## Step 4: Add secrets to Cloudflare

1. **Cloudflare dashboard** → **Workers** → **Settings** → **Variables and Secrets**
2. Under **Secrets**, click **Add**
   - Variable name: `HCP_API_KEY`
   - Value: (paste your HCP token)
3. Click **Save and Deploy**

Wait ~30 seconds for deployment.

## Step 5: Verify it works

```bash
curl https://your-worker.workers.dev/
```

You should see:
```
HCP MCP Worker v1.0.0 — 6 tools | /mcp | /webhook
```

## Step 6 (Optional): Add webhook support

If you want to receive HCP webhooks:

1. Generate a webhook secret (something long and random):
   ```bash
   # macOS/Linux
   openssl rand -hex 32
   # Windows PowerShell
   -join ((1..32) | ForEach-Object { "{0:x2}" -f (Get-Random -Max 256) })
   ```

2. In Cloudflare **Settings** → **Variables and Secrets** → **Add** another secret:
   - Variable name: `HCP_WEBHOOK_SECRET`
   - Value: (paste the random string)
3. Save & deploy

3. In HouseCall Pro **Account Settings** → **Webhooks**:
   - URL: `https://your-worker.workers.dev/webhook`
   - Sign requests with HMAC: enabled
   - Secret: (paste the same random string)
   - Select events to subscribe to
   - Save

4. Test: trigger any event in HCP (create customer, update job, etc.) and the webhook should POST to your worker

## Step 7 (Optional): Add KV for activity storage

If you want to store recent webhook events:

1. **Cloudflare dashboard** → **KV** → **Create Namespace** → name it `hcp-activity` → note the ID
2. In your repo, edit `wrangler.toml`:
   ```toml
   [[kv_namespaces]]
   binding = "HCP_ACTIVITY"
   id = "your-id-here"
   ```
3. In `worker.js`, uncomment the KV store code in `handleWebhook()` (see TODO comment)
4. Push to main:
   ```bash
   git add wrangler.toml worker.js
   git commit -m "Add KV for webhook storage"
   git push origin main
   ```

Cloudflare auto-deploys. Done.

## Step 8: Customize tools

See [CUSTOM_TOOLS.md](CUSTOM_TOOLS.md) to add more HCP tools.

## Troubleshooting

### "Unauthorized" on webhook POSTs

- Check that `HCP_WEBHOOK_SECRET` is set in Cloudflare and matches the secret in HCP
- Check that the webhook URL in HCP is exactly: `https://your-worker.workers.dev/webhook` (no trailing slash, no query params)

### API calls return 401

- Verify `HCP_API_KEY` is correct in Cloudflare
- Test it locally: `curl -H "Authorization: Bearer YOUR_TOKEN" https://api.housecallpro.com/customers` (should return a 200 with customer list or 400 if no params)

### Changes not deploying

- Confirm you pushed to `main` branch
- Check **Cloudflare Workers** → **Deployments** tab—if the deploy failed, click it to see the error
- Most common: `npx wrangler deploy` in the root directory fails if `wrangler.toml` is malformed (check TOML syntax)

## Next steps

- **Use with Claude:** Point Claude to `https://your-worker.workers.dev/mcp`
- **Add more tools:** [Custom tools guide](CUSTOM_TOOLS.md)
- **Monitor webhooks:** Add KV storage (Step 7 above) then query `/activity` endpoint

---

Done! Your worker is live and auto-deploys on every push to main.
