/**
 * HouseCall Pro MCP Worker
 *
 * A Cloudflare Worker that exposes the HouseCall Pro API as an MCP server
 * with webhook passthrough support.
 *
 * Routes:
 *   GET  /          — Health check
 *   GET  /mcp       — Server info
 *   POST /mcp       — MCP JSON-RPC (tools/list, tools/call, initialize, ping)
 *   POST /webhook   — Receive HCP webhooks (HMAC validated)
 *
 * Required env vars:
 *   HCP_API_KEY              — HouseCall Pro API token
 *
 * Optional env vars:
 *   HCP_WEBHOOK_SECRET       — HMAC-SHA256 signing secret from HCP
 */

const VERSION = "1.0.0";
const PROTOCOL_VERSION = "2025-03-26";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function qs(params = {}) {
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined || v === null || v === "") continue;
    if (Array.isArray(v)) {
      for (const item of v) q.append(k, String(item));
    } else {
      q.set(k, String(v));
    }
  }
  const s = q.toString();
  return s ? `?${s}` : "";
}

async function hcp(apiKey, method, path, body) {
  const res = await fetch(`https://api.housecallpro.com${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: body && Object.keys(body).length ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    data = { raw: text };
  }
  if (!res.ok) throw new Error(`HCP ${method} ${path} → ${res.status}: ${JSON.stringify(data)}`);
  return data;
}

async function validateSignature(secret, rawBody, request) {
  const sig = request.headers.get("X-HCP-Signature") ||
              request.headers.get("X-Housecall-Hmac-SHA256") ||
              request.headers.get("X-Webhook-Signature");
  if (!secret) return true;
  if (!sig) return false;
  try {
    const enc = new TextEncoder();
    const key = await crypto.subtle.importKey(
      "raw",
      enc.encode(secret),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["verify"]
    );
    const sigBytes = Uint8Array.from(
      sig.replace(/^sha256=/, "").match(/.{2}/g).map((b) => parseInt(b, 16))
    );
    return await crypto.subtle.verify("HMAC", key, sigBytes, enc.encode(rawBody));
  } catch {
    return false;
  }
}

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
  // Store in KV if you have it bound (optional), or just acknowledge
  return new Response("OK", { status: 200, headers: CORS });
}

// ---------------------------------------------------------------------------
// Tools
// ---------------------------------------------------------------------------

const TOOLS = [
  {
    name: "list_customers",
    description: "List or search customers",
    inputSchema: {
      type: "object",
      properties: {
        q: { type: "string" },
        page: { type: "number" },
        page_size: { type: "number" },
      },
    },
  },
  {
    name: "get_customer",
    description: "Get a customer by ID",
    inputSchema: {
      type: "object",
      required: ["customer_id"],
      properties: {
        customer_id: { type: "string" },
      },
    },
  },
  {
    name: "create_customer",
    description: "Create a new customer",
    inputSchema: {
      type: "object",
      required: ["first_name", "last_name"],
      properties: {
        first_name: { type: "string" },
        last_name: { type: "string" },
        email: { type: "string" },
        mobile_number: { type: "string" },
        company: { type: "string" },
        notes: { type: "string" },
      },
    },
  },
  {
    name: "list_jobs",
    description: "List or search jobs",
    inputSchema: {
      type: "object",
      properties: {
        page: { type: "number" },
        page_size: { type: "number" },
        work_status: { type: "array", items: { type: "string" } },
      },
    },
  },
  {
    name: "get_job",
    description: "Get a job by ID",
    inputSchema: {
      type: "object",
      required: ["job_id"],
      properties: {
        job_id: { type: "string" },
      },
    },
  },
  {
    name: "create_job",
    description: "Create a new job",
    inputSchema: {
      type: "object",
      required: ["customer_id"],
      properties: {
        customer_id: { type: "string" },
        address_id: { type: "string" },
        notes: { type: "string" },
        description: { type: "string" },
      },
    },
  },
];

async function callTool(name, args, apiKey) {
  const c = (method, path, body) => hcp(apiKey, method, path, body);
  switch (name) {
    case "list_customers":
      return c("GET", `/customers${qs(args)}`);
    case "get_customer": {
      const { customer_id, ...q } = args;
      return c("GET", `/customers/${customer_id}${qs(q)}`);
    }
    case "create_customer":
      return c("POST", `/customers`, args);
    case "list_jobs":
      return c("GET", `/jobs${qs(args)}`);
    case "get_job": {
      const { job_id, ...q } = args;
      return c("GET", `/jobs/${job_id}${qs(q)}`);
    }
    case "create_job":
      return c("POST", `/jobs`, args);
    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}

// ---------------------------------------------------------------------------
// MCP
// ---------------------------------------------------------------------------

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Accept",
};

function mcpJson(id, result) {
  return new Response(JSON.stringify({ jsonrpc: "2.0", id, result }), {
    headers: { "Content-Type": "application/json", ...CORS },
  });
}

function mcpErr(id, code, message) {
  return new Response(JSON.stringify({ jsonrpc: "2.0", id, error: { code, message } }), {
    headers: { "Content-Type": "application/json", ...CORS },
  });
}

async function handleMcp(request, env) {
  if (request.method === "GET") {
    return new Response(
      JSON.stringify({
        name: "housecall-pro",
        version: VERSION,
        protocolVersion: PROTOCOL_VERSION,
        tools: TOOLS.length,
      }),
      { headers: { "Content-Type": "application/json", ...CORS } }
    );
  }

  let msg;
  try {
    msg = await request.json();
  } catch {
    return mcpErr(null, -32700, "Parse error");
  }

  const { id, method, params } = msg;

  try {
    switch (method) {
      case "initialize":
        return mcpJson(id, {
          protocolVersion: PROTOCOL_VERSION,
          capabilities: { tools: {} },
          serverInfo: { name: "housecall-pro", version: VERSION },
        });
      case "notifications/initialized":
        return new Response(null, { status: 204, headers: CORS });
      case "ping":
        return mcpJson(id, {});
      case "tools/list":
        return mcpJson(id, { tools: TOOLS });
      case "tools/call": {
        const { name, arguments: args } = params;
        const result = await callTool(name, args || {}, env.HCP_API_KEY);
        return mcpJson(id, {
          content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
        });
      }
      default:
        return mcpErr(id, -32601, `Method not found: ${method}`);
    }
  } catch (err) {
    return mcpErr(id, -32000, err.message);
  }
}

// ---------------------------------------------------------------------------
// Fetch handler
// ---------------------------------------------------------------------------

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname;

    // CORS preflight
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: CORS });
    }

    // Health check
    if (request.method === "GET" && (path === "/" || path === "")) {
      return new Response(
        `HCP MCP Worker v${VERSION} — ${TOOLS.length} tools | /mcp | /webhook`,
        { status: 200, headers: { "Content-Type": "text/plain", ...CORS } }
      );
    }

    // MCP endpoint
    if (path === "/mcp") {
      return handleMcp(request, env);
    }

    // Webhook endpoint
    if (request.method === "POST" && path === "/webhook") {
      return handleWebhook(request, env);
    }

    return new Response("Not found", { status: 404, headers: CORS });
  },
};
