# HouseCall Pro MCP Worker

A **plug-and-play Cloudflare Worker** that exposes the HouseCall Pro API as an MCP (Model Context Protocol) server. Point Claude or any MCP client to this worker and get instant access to 6+ HCP tools—or customize it with your own.

**Auto-deploys on push** via Cloudflare Workers Builds (git-connect). No manual paste-to-dashboard steps.

## Features

- ✅ **MCP-compliant** — works with Claude, LLMs, and any MCP client
- ✅ **6+ core tools** — list/create customers & jobs (easily extensible)
- ✅ **Webhook receiver** — validates HMAC-SHA256, ready to store events
- ✅ **Auto-deploy** — push to main → live in ~30-60s
- ✅ **Zero infrastructure** — runs on Cloudflare's free tier

## Quick Start

### 1. Fork this repo to your GitHub account

```bash
# Clone your fork
git clone https://github.com/YOUR_USERNAME/hcp-mcp-template.git
cd hcp-mcp-template
```

### 2. Connect to Cloudflare

In Cloudflare dashboard:

1. **Workers & Pages** → **Create** → **Import a Repository**
2. Select your forked repo
   - Branch: `main`
   - Root directory: `.` (or leave empty)
   - Build command: (leave empty)
   - Deploy command: `npx wrangler deploy`
3. Create the worker

### 3. Add your HCP API key

In Cloudflare **Settings** → **Variables and Secrets**:

1. **Secret**: `HCP_API_KEY` = your HouseCall Pro API token
2. (Optional) **Secret**: `HCP_WEBHOOK_SECRET` = HMAC signing secret from HCP webhook config

Save & deploy.

### 4. Verify

```bash
curl https://your-worker.workers.dev/
# → "HCP MCP Worker v1.0.0 — 6 tools | /mcp | /webhook"
```

## Routes

| Endpoint | Method | Purpose |
|----------|--------|---------|
| `/` | GET | Health check |
| `/mcp` | GET | Server info (MCP metadata) |
| `/mcp` | POST | MCP JSON-RPC (tools/list, tools/call) |
| `/webhook` | POST | Receive HCP webhooks |

## Tools

Out of the box, you get:

- `list_customers` — search customers
- `get_customer` — fetch one customer
- `create_customer` — add a new customer
- `list_jobs` — search jobs
- `get_job` — fetch one job
- `create_job` — create a new job

## Add Custom Tools

See [examples/CUSTOM_TOOLS.md](examples/CUSTOM_TOOLS.md) for step-by-step instructions.

**TL;DR:**
1. Add tool definition to `TOOLS` array in `worker.js`
2. Add handler to `callTool()` switch statement
3. Push to main
4. Done—auto-deployed + available in `/mcp` response

## Webhook Setup

See [examples/WEBHOOK_SETUP.md](examples/WEBHOOK_SETUP.md) for HCP configuration.

### Quick version

1. In HCP admin panel → Webhooks → add URL: `https://your-worker.workers.dev/webhook?key=YOUR_SECRET`
2. Set `HCP_WEBHOOK_SECRET` in Cloudflare (above)
3. Webhook will validate HMAC and call your handler

To store events, add KV binding (see [examples/SETUP.md](examples/SETUP.md#optional-add-kv-for-activity-storage)).

## Deployments

**Push to main → live in ~30 seconds**

```bash
git push origin main
```

Cloudflare watches your repo. When `worker.js` or `wrangler.toml` changes, it auto-builds and deploys.

### Rollback

Cloudflare dashboard → Workers → your worker → **Deployments** → click "Rollback to this deployment"

## Customization

- **Add more tools?** [Custom tools guide](examples/CUSTOM_TOOLS.md)
- **Store webhook events?** [KV setup](examples/SETUP.md#optional-add-kv-for-activity-storage)
- **Change routes?** Edit the fetch handler in `worker.js`

## Environment Variables

| Name | Required | Example |
|------|----------|---------|
| `HCP_API_KEY` | yes | (from HCP account settings) |
| `HCP_WEBHOOK_SECRET` | no | (from HCP webhook config; set if you want HMAC validation) |

Both are **Secrets** in Cloudflare dashboard—never in `wrangler.toml`.

## Testing

### Without a real HCP account

Use the `worker.js` in mock mode (add a `TEST_MODE` env var and mock the `hcp()` function to return fake data).

### With a real account

```bash
# List customers
curl -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","method":"tools/call","id":1,"params":{"name":"list_customers","arguments":{}}}' \
  https://your-worker.workers.dev/mcp

# Full MCP handshake
curl -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","method":"initialize","id":1,"params":{}}' \
  https://your-worker.workers.dev/mcp
```

## Using with Claude

Point Claude to your worker URL when setting up an MCP server:

1. In Claude Code or other MCP clients, add server: `https://your-worker.workers.dev/mcp`
2. Claude auto-fetches tools from `/mcp GET`
3. Calls are routed via `/mcp POST`

## Limits & Pricing

- **Free tier:** Up to 100k requests/day, auto-scales
- **API calls:** Each tool call = 1 HCP API request (check your HCP plan)
- **Webhooks:** Unlimited (Cloudflare → your worker is free)

## License

MIT. Build whatever you want.

## Questions?

This is a template. Fork, customize, and deploy. When you add tools or features, consider contributing examples back!

---

**Version:** 1.0.0  
**Updated:** 2026-05-10
