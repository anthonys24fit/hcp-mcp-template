# Webhook Setup Guide

Configure your HouseCall Pro account to send webhooks to your MCP worker.

## What are webhooks?

Webhooks are real-time notifications from HCP when events happen (customer created, job completed, etc.). Your worker receives them at `/webhook` and can store, process, or forward them.

## Prerequisites

- Your worker is deployed and accessible at `https://your-worker.workers.dev/`
- (Recommended) A webhook secret for HMAC validation

## Step 1: Generate a webhook secret (optional but recommended)

A shared secret ensures that only HCP can POST to your `/webhook` endpoint.

```bash
# macOS/Linux
openssl rand -hex 32

# Windows PowerShell
-join ((1..32) | ForEach-Object { "{0:x2}" -f (Get-Random -Max 256) })
```

Example output: `a1b2c3d4e5f6g7h8i9j0k1l2m3n4o5p6q7r8s9t0u1v2w3x4y5z6a7b8c9d0e1f2`

Save this somewhere safe—you'll use it twice.

## Step 2: Add the secret to Cloudflare

1. **Cloudflare dashboard** → **Workers** → your worker → **Settings** → **Variables and Secrets**
2. Click **Add** under Secrets
   - Variable name: `HCP_WEBHOOK_SECRET`
   - Value: (paste the secret from Step 1)
3. **Save and Deploy**

Wait 30 seconds for the deploy.

## Step 3: Configure webhooks in HCP

1. **HouseCall Pro admin panel** → **Account Settings** → **Webhooks** (or **Integrations**)
2. Create a new webhook:
   - **URL:** `https://your-worker.workers.dev/webhook`
   - **Sign requests with HMAC:** Enabled (or **Use signature**)
   - **Secret:** (paste the same secret from Step 1)
3. **Select events to receive** — check whichever you care about:
   - Customer events (created, updated, deleted)
   - Job events (created, updated, dispatched, completed)
   - Appointment events (scheduled, rescheduled, completed)
   - etc.
4. **Save**

HCP will now POST every selected event to your worker.

## Step 4: Test the webhook

Trigger a test event in HCP (create a customer, change a job status, etc.). The webhook should POST to your worker.

### Verify in Cloudflare logs

1. **Cloudflare dashboard** → **Workers** → your worker → **Deployments** (or **Logs**)
2. Look for a `POST /webhook` request with status `200`

### Manual test (if you want to simulate)

```bash
# Generate an HMAC signature
SECRET="your-webhook-secret"
BODY='{"event":"customer.created","id":"123"}'
SIGNATURE=$(echo -n "$BODY" | openssl dgst -sha256 -hmac "$SECRET" -hex | sed 's/^.* //')

# POST to your worker
curl -X POST https://your-worker.workers.dev/webhook \
  -H "Content-Type: application/json" \
  -H "X-HCP-Signature: sha256=$SIGNATURE" \
  -d "$BODY"

# Should return: 200 OK
```

## Step 5 (Optional): Store webhook events in KV

If you want to keep a log of recent events for dashboards or auditing:

1. Follow [SETUP.md Step 7](SETUP.md#step-7-optional-add-kv-for-activity-storage) to create a KV namespace
2. Update `worker.js` to store events:

```js
async function handleWebhook(request, env) {
  const rawBody = await request.text();
  if (env.HCP_WEBHOOK_SECRET) {
    const valid = await validateSignature(env.HCP_WEBHOOK_SECRET, rawBody, request);
    if (!valid) return new Response("Unauthorized", { status: 401, headers: CORS });
  }
  let event;
  try {
    event = JSON.parse(rawBody);
  } catch {
    return new Response("Bad Request", { status: 400, headers: CORS });
  }

  // Store in KV if available
  if (env.HCP_ACTIVITY) {
    const id = crypto.randomUUID();
    const ts = Date.now();
    const key = `event:${ts}:${id}`;
    const value = JSON.stringify({
      id,
      ts,
      event_type: event.event || event.type || "unknown",
      payload: event,
    });
    // Non-blocking: store in background
    env.HCP_ACTIVITY.put(key, value, { expirationTtl: 604800 }); // 7 day TTL
  }

  return new Response("OK", { status: 200, headers: CORS });
}
```

3. Restart your worker after editing (push to main or redeploy in Cloudflare)
4. Query recent events:
   ```bash
   curl https://your-worker.workers.dev/activity?limit=50
   ```

## Webhook event types (HCP standard)

Common events you might subscribe to:

| Event | Fired when |
|-------|-----------|
| `customer.created` | New customer added |
| `customer.updated` | Customer info changes |
| `job.created` | New job created |
| `job.status_updated` | Job status changes |
| `job.dispatched` | Job assigned to technician |
| `appointment.scheduled` | Appointment booked |
| `appointment.completed` | Technician marks job done |
| `estimate.created` | Estimate generated |
| `estimate.approved` | Customer approves estimate |

See HCP's webhook docs for the full list.

## Troubleshooting

### Webhook POSTs fail (401)

- Verify `HCP_WEBHOOK_SECRET` is set in Cloudflare and matches HCP's setting
- Check HMAC calculation if testing manually
- Ensure the `/webhook` URL in HCP has no trailing slash

### No events arriving

- Confirm webhook is enabled in HCP settings
- Trigger a test event (create customer, update job)
- Check Cloudflare logs for incoming POSTs
- Verify the URL is exactly `https://your-worker.workers.dev/webhook`

### "Bad Request" responses

- Webhook payload isn't valid JSON—unlikely (HCP's fault)
- Your `handleWebhook()` function is throwing—add console logging to debug

### High KV usage

- By default, events expire after 7 days. Adjust `expirationTtl` in `handleWebhook()` if needed
- Only store events you actually use—webhook payload can be large

## Next steps

- **Monitor events:** Check `/activity` endpoint regularly
- **Add custom tools:** Point Claude at your worker and ask it to fetch recent events
- **Build a dashboard:** Render stored events as HTML (like the HCP worker example)
- **Forward to another system:** POST events to Slack, Zapier, or your own API

---

You're all set. Webhooks are now streaming to your worker.
