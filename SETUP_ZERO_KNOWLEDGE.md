# Setup Guide — Zero Knowledge Required

This guide is designed for Claude to teach you. You should have Claude open in another window, pointing to this file. Claude will walk you through each step.

## What You're Building

You're setting up a bridge between Claude and your HouseCall Pro account. At the end, you'll have a URL that you can give Claude, and Claude will be able to read your customer list, create jobs, manage estimates, and do anything else in HCP—all through conversation.

**You will need:**
- A GitHub account (we'll create one if you don't have it)
- A Cloudflare account (we'll create one if you don't have it)
- Your HouseCall Pro API key (we'll show you where to find it)
- About 20 minutes

---

## Step 1: Create a GitHub Account (If You Don't Have One)

**What is GitHub?** GitHub is a place to store code. We're using it so that every time you push a button, your worker automatically updates.

**Do this:**
1. Go to https://github.com/signup
2. Enter your email, create a password, choose a username
3. Click "Create account"
4. Verify your email (GitHub will send you an email with a link)
5. You now have a GitHub account

**Expected outcome:** You're signed in to GitHub and can see a feed of activity.

---

## Step 2: Fork This Repository

**What does "fork" mean?** Forking means making your own copy of this code so you can customize it.

**Do this:**
1. Go to https://github.com/kjricciardiacauth/hcp-mcp-template
2. Click the **"Fork"** button in the top right
3. Click **"Create fork"** (accept all defaults)
4. Wait for it to finish

**Expected outcome:** You're now on a page that says `YOUR_USERNAME/hcp-mcp-template` (not kjricciardiacauth's copy).

---

## Step 3: Create a Cloudflare Account (If You Don't Have One)

**What is Cloudflare?** Cloudflare is a service that runs your code (called a "worker"). Think of it as a tiny computer that listens for requests.

**Do this:**
1. Go to https://dash.cloudflare.com/sign-up
2. Enter your email, create a password
3. Click "Create account"
4. Verify your email
5. You now have a Cloudflare account

**Expected outcome:** You're signed into Cloudflare and see a dashboard.

---

## Step 4: Create Two KV Namespaces

**What are KV namespaces?** They're tiny databases inside Cloudflare. This worker needs two: one to store webhook activity, one to store your access tokens.

**Do this:**

1. **In Cloudflare dashboard**, look for **"KV"** in the left sidebar (under "Storage & Databases")
2. Click **"Create namespace"**
3. Name it `hcp-activity` → click **"Add"**
4. **Copy the ID** that appears next to it — it looks like `a1b2c3d4e5f67890abcdef1234567890`. Paste it somewhere safe.
5. Click **"Create namespace"** again
6. Name it `hcp-tokens` → click **"Add"**
7. **Copy that ID too** — paste it somewhere safe

**Now update wrangler.toml in your fork:**

1. Go to your fork on GitHub (`YOUR_USERNAME/hcp-mcp-template`)
2. Click `wrangler.toml` → click the pencil icon to edit
3. Find these two lines:
   ```
   id = "YOUR_ACTIVITY_KV_ID"
   ```
   and
   ```
   id = "YOUR_MCP_TOKENS_KV_ID"
   ```
4. Replace each placeholder with the real ID you copied above
5. Scroll down and click **"Commit changes"**

**Expected outcome:** `wrangler.toml` now has your real KV namespace IDs.

---

## Step 5: Connect GitHub to Cloudflare (Auto-Deploy)

**What we're doing:** We're telling Cloudflare to watch your GitHub fork. Every time you push a change, Cloudflare automatically deploys it.

**Do this:**

1. **In Cloudflare dashboard**, go to **"Workers & Pages"** (on the left sidebar)
2. Click **"Create"** (top right)
3. Click **"Deploy with Git"**
4. Click **"Connect a Repository"**
5. Click **"Authorize GitHub"** and sign in with your GitHub account
6. Find your fork: search for "hcp-mcp-template" and select `YOUR_USERNAME/hcp-mcp-template`
7. Leave everything else as default:
   - Branch: `main`
   - Root directory: `.` (just a dot)
   - Build command: (leave empty)
   - Deploy command: `npx wrangler deploy`
8. Click **"Save and Deploy"**
9. Wait ~2 minutes for the first deploy

**Expected outcome:** You see a URL like `hcp-mcp-template.YOUR_ACCOUNT.workers.dev`. Copy this URL—you'll need it later.

---

## Step 6: Get Your HouseCall Pro API Key

**What is an API key?** It's a secret password that lets the worker talk to HouseCall Pro on your behalf.

**Do this:**

1. Log into your HouseCall Pro account
2. Go to **Account Settings** → **API Tokens** (or **Integrations**)
3. Click **"Create a new API token"** (or "Generate token")
4. Copy the token (it won't show again, so don't lose it)
5. Paste it somewhere safe temporarily (like a text file)

**Expected outcome:** You have a long string that looks like `eyJhbGc...` (it's a token).

---

## Step 7: Add Your API Key to Cloudflare

**What we're doing:** We're telling your worker the secret API key so it can talk to HouseCall Pro.

**Do this:**

1. **In Cloudflare**, go to **"Workers"** (left sidebar)
2. Click on your worker name
3. Go to **"Settings"** → **"Variables and Secrets"**
4. Under **"Secrets"**, click **"Add"**
5. Enter:
   - **Variable name:** `HCP_API_KEY`
   - **Value:** (paste your token from Step 6)
6. Click **"Save and Deploy"**
7. Wait ~30 seconds

**Expected outcome:** You see "HCP_API_KEY" listed under Secrets.

---

## Step 8: Create Your First MCP Access Token

**What we're doing:** This worker requires a token to use. You'll create one now and use it when connecting Claude.

**Do this:**

1. **In Cloudflare**, go to **"KV"** (left sidebar)
2. Click on your `hcp-tokens` namespace
3. Click **"Add entry"**
4. Enter:
   - **Key:** make up any string — this IS your token, e.g. `my-hcp-token-2026`
   - **Value:** `{"name":"Your Name","tier":"write"}`
5. Click **"Add entry"**

**Expected outcome:** You see your token key listed in the namespace.

> **Tip:** You can create multiple tokens — one for each person or tool that connects. Give each a different key and name. To revoke access, just delete the entry.

---

## Step 9: Test Your Worker

**What we're doing:** Making sure everything works before we connect Claude.

**Do this:**

1. Open a new browser tab
2. Paste your worker URL (from Step 5) into the address bar and press Enter
3. You should see:
   ```
   HouseCall Pro MCP Worker v3.3.1 — 93 tools | /mcp | /webhook | /activity | /dashboard
   ```

**If you see that:** Success! Go to Step 10.

**If you get an error:**
- Wait 30 seconds and refresh
- Check that `HCP_API_KEY` is in Cloudflare Secrets (Step 7)
- Check that both KV namespace IDs are in `wrangler.toml` (Step 4)
- Ask Claude for help with the error message

---

## Step 10: Connect Claude to Your Worker

**What we're doing:** Telling Claude where your worker is so it can call HCP tools.

**Do this:**

1. In Claude (on claude.ai or Claude Code), look for **"MCP Servers"** or **"Connectors"**
2. Click **"Add Server"** or **"Add Connector"**
3. Select **"Enter custom URL"**
4. Paste your worker URL **with your token appended:**
   ```
   https://YOUR_WORKER_URL/mcp?token=my-hcp-token-2026
   ```
   (use the token key you created in Step 8)
5. Give it a name: "HCP" or "HouseCall Pro"
6. Click **"Connect"**

**Expected outcome:** Claude shows "Connected" and you can see a list of tools (customers, jobs, estimates, etc.).

---

## Step 11: Start Using It

Now you can talk to Claude like this:

- "Show me all my customers"
- "Create a new customer named John Smith with email john@example.com"
- "List all jobs from today"
- "What's the status of job XYZ?"
- "Create an estimate for customer ABC"

Claude will call your worker, which calls HouseCall Pro, and brings the results back to you.

---

## Troubleshooting

### "Unauthorized" on MCP calls
- Make sure your MCP URL includes `?token=YOUR_TOKEN` (Step 10)
- Check that the token key exists in the `hcp-tokens` KV namespace (Step 8)
- Check that the KV value is exactly `{"name":"...","tier":"write"}` — valid JSON, no typos

### "Unauthorized" on HCP API calls
- Check that `HCP_API_KEY` is saved in Cloudflare (Step 7)
- Check that you copied the entire token (no extra spaces)
- Re-copy your token from HouseCall Pro and update it in Cloudflare

### Worker returns 404
- Wait a few minutes after "Save and Deploy"—it's still deploying
- Refresh the page

### Claude says "Tool not found"
- Make sure you pasted the `/mcp` at the end of your URL
- Example: `https://hcp-mcp-template-abc123.workers.dev/mcp`

### "Cannot connect to worker"
- Make sure your worker URL is public (it should be by default)
- Ask Claude to help you test the URL directly in a browser

---

## Next Steps (Optional)

Once you're comfortable:
- **Add webhooks** (see `WEBHOOK_SETUP.md`) to get real-time HCP events
- **Customize tools** (see `CUSTOM_TOOLS.md`) to add your own API calls
- **Add KV storage** to store activity logs

---

## You're Done!

Your worker is live, Claude can access it, and you're ready to manage HouseCall Pro entirely through conversation with Claude.

If you get stuck, point Claude at this guide and the error message—Claude can help you debug.
