/**
 * HouseCall Pro MCP Worker v3.3.1
 * Documented API only (93 tools) + Webhook receiver + Activity feed + Dashboard v2.5
 *
 * v3.3.1: Inline PNG icon using correct MCP spec 2025-11-25 format — mimeType,
 *         sizes as array, image/png data URI. Prior attempt used wrong field names.
 *
 * v3.3.0: Token-based auth + read/write tiers. Every /mcp request requires
 *         ?token=<token> in the URL. Tokens stored in MCP_TOKENS KV as
 *         JSON: {"name":"...","tier":"read"|"write"}. Read-tier tokens see
 *         and can call only readOnlyHint:true tools. Write-tier tokens have
 *         full access. Manage tokens via Cloudflare KV dashboard (MCP_TOKENS).
 *         Token URL format: .../mcp?token=<your-token>
 *
 * v3.2.0: Expose undocumented HCP API params discovered via empirical probing.
 *         list_events gains sort_by (start_time|name) + sort_direction — use
 *         sort_by=start_time&sort_direction=desc + fetch_all + start_time_min/max
 *         for reliable date-scoped event queries (replaces broken client-only filter).
 *         list_customers gains sort_by (created_at confirmed). Description updated
 *         to reflect actual sort support.
 *
 * v3.1.0: Strip assigned_employees[].permissions from all responses (cuts response
 *         size ~40%, removes page_size ceiling on list_jobs). Normalize pricebook
 *         pagination shape (data/total_count/total_pages_count → items/total_items/
 *         total_pages to match all other list tools). Add start_time_min/max filter
 *         to list_events (client-side; HCP API has no date params). Remove dead
 *         get_application tool (404s — requires Application API Key). Replace
 *         preview_invoice with a helpful error (returns 254KB HTML blob — use
 *         get_invoice_by_uuid for structured data).
 *
 * v3.0.0: fetch_all pagination (10 list tools), schema fixes (update_job_schedule
 *         param names start_time/end_time/arrival_window_in_minutes/notify/notify_pro/
 *         dispatched_employees; lock_jobs starting_at/ending_at; create_job address_id
 *         required + schedule sub-properties + invoice_number), list_jobs gains
 *         location_ids + sort_by, list tools gain fetch_all boolean.
 *
 * v2.9.2: list_invoices schema — add 6 missing spec params: due_at_min/max,
 *         amount_due_min/max, payment_method (array enum), sort_by (enum).
 *
 * v2.9.1: Add cents descriptions to all money fields (unit_price, unit_cost).
 *
 * v2.9.0: MCP quality pass — fix server version strings, correct tool error shape
 *         (isError:true instead of JSON-RPC error for HCP API failures), enrich input
 *         schemas with enums (work_status, sort_direction, invoice status, pipeline
 *         resource_type) and ISO 8601 descriptions on all datetime fields.
 *
 * v2.8.1: Fix v2.8.0 audit errors. Remove get_invoice (no spec path GET /invoices/{id}).
 *         Restore lock_job (spec has POST /jobs/{job_id}/lock — was incorrectly dropped).
 *
 * v2.8.0: Remove 8 undocumented/non-functional tools. Fix convert_lead method POST→PUT.
 *         Removed: list_customer_memberships, get_employee, list_scheduled_events,
 *         list_service_plans, update_job, update_estimate, update_franchise_info, lock_job.
 *
 * v2.7.1: Revert update_franchise_info path back to /company/franchise_info.
 * v2.7.0: Fix list_scheduled_events path (/scheduled_events → /calendar/scheduled_events).
 *
 * v2.6.0: Reorganized TOOLS into read/write groups by resource.
 *         Added MCP annotations (readOnlyHint, destructiveHint) for
 *         proper grouping in the Claude.ai connector configure UI.
 *
 * v2.5.1 (repo): Read ZAPIER_URL from env var instead of hardcoding it. Set
 *                `ZAPIER_URL` as a Cloudflare Worker secret before deploying;
 *                if unset, Zapier forwarding is skipped silently.
 *
 * v2.5: Free-tier KV optimization (no plan upgrade):
 *   1. Edge cache /activity response (Cloudflare Cache API, 50s TTL).
 *   2. Dashboard polling 15s → 60s.
 *   3. Dashboard fetches ?limit=50 instead of 200.
 *   4. Pause polling when the browser tab is hidden.
 *
 * v2.4: Mobile Chrome fixes — try/catch around Notification API and AudioContext.
 */

// ZAPIER_URL: read from env var. If unset, Zapier forwarding is skipped.

function qs(params = {}) {
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined || v === null || v === "") continue;
    if (Array.isArray(v)) { for (const item of v) q.append(`${k}[]`, String(item)); }
    else { q.set(k, String(v)); }
  }
  const s = q.toString();
  return s ? `?${s}` : "";
}

async function hcp(apiKey, method, path, body) {
  const res = await fetch(`https://api.housecallpro.com${path}`, {
    method,
    headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json", Accept: "application/json" },
    body: body && Object.keys(body).length ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let data;
  try { data = JSON.parse(text); } catch { data = { raw: text }; }
  if (!res.ok) throw new Error(`HCP ${method} ${path} → ${res.status}: ${JSON.stringify(data)}`);
  return data;
}

function stripPermissions(obj) {
  if (!obj || typeof obj !== "object") return obj;
  if (Array.isArray(obj)) return obj.map(stripPermissions);
  const out = {};
  for (const [k, v] of Object.entries(obj)) {
    if (k === "permissions") continue;
    out[k] = stripPermissions(v);
  }
  return out;
}

function normalizePricebookPage(data) {
  if (!data || typeof data !== "object" || !("total_count" in data)) return data;
  const { total_count, total_pages_count, data: items, ...rest } = data;
  return { ...rest, items: items ?? [], total_items: total_count, total_pages: total_pages_count };
}

async function validateSignature(secret, rawBody, request) {
  const sig = request.headers.get("X-HCP-Signature") || request.headers.get("X-Housecall-Hmac-SHA256") || request.headers.get("X-Webhook-Signature");
  if (!secret) return true;
  if (!sig) return false;
  try {
    const enc = new TextEncoder();
    const key = await crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["verify"]);
    const sigBytes = Uint8Array.from(sig.replace(/^sha256=/, "").match(/.{2}/g).map(b => parseInt(b, 16)));
    return await crypto.subtle.verify("HMAC", key, sigBytes, enc.encode(rawBody));
  } catch { return false; }
}

async function handleWebhook(request, env, ctx) {
  const rawBody = await request.text();
  if (env.HCP_WEBHOOK_SECRET) {
    const valid = await validateSignature(env.HCP_WEBHOOK_SECRET, rawBody, request);
    if (!valid) return new Response("Unauthorized", { status: 401, headers: CORS });
  }
  let event;
  try { event = JSON.parse(rawBody); } catch { return new Response("Bad Request", { status: 400, headers: CORS }); }
  const id = crypto.randomUUID();
  const ts = Date.now();
  const stored = { id, ts, received_at: new Date(ts).toISOString(), event_type: event.event || event.type || event.eventType || "unknown", payload: event };
  const tasks = [env.ACTIVITY_KV.put(`event:${ts}:${id}`, JSON.stringify(stored), { expirationTtl: 172800 })];
  if (env.ZAPIER_URL) {
    tasks.push(fetch(env.ZAPIER_URL, { method: "POST", headers: { "Content-Type": "application/json", "User-Agent": "HCP-Webhook-Forwarder/1.0" }, body: rawBody }));
  }
  ctx.waitUntil(Promise.allSettled(tasks));
  return new Response("OK", { status: 200, headers: CORS });
}

async function handleActivity(request, env, ctx) {
  const cache = caches.default;
  const cacheKey = new Request(request.url, { method: "GET" });
  const cached = await cache.match(cacheKey);
  if (cached) return cached;

  const url = new URL(request.url);
  const limit = parseInt(url.searchParams.get("limit") || "200");
  try {
    const listed = await env.ACTIVITY_KV.list({ prefix: "event:", limit: 1000 });
    const keys = listed.keys.reverse().slice(0, limit);
    const events = await Promise.all(keys.map(async (k) => {
      const val = await env.ACTIVITY_KV.get(k.name);
      try { return JSON.parse(val); } catch { return null; }
    }));
    const filtered = events.filter(Boolean);
    const response = new Response(JSON.stringify({ events: filtered, count: filtered.length }), {
      headers: { "Content-Type": "application/json", "Cache-Control": "public, max-age=50", ...CORS },
    });
    ctx.waitUntil(cache.put(cacheKey, response.clone()));
    return response;
  } catch (e) {
    return new Response(JSON.stringify({ error: e.message }), { status: 500, headers: { "Content-Type": "application/json", ...CORS } });
  }
}

const READ    = { readOnlyHint: true };
const WRITE   = { readOnlyHint: false };
const DESTROY = { readOnlyHint: false, destructiveHint: true };

const TOOLS = [

  // ════════════════════════════════════════════════════════════════════════════
  // READ
  // ════════════════════════════════════════════════════════════════════════════

  // ── Customers ─────────────────────────────────────────────────────────────
  { name: "list_customers",                    annotations: READ,    description: "List or search customers",                                   inputSchema: { type: "object", properties: { q: { type: "string" }, page: { type: "number" }, page_size: { type: "number" }, sort_by: { type: "string", enum: ["created_at"], description: "Undocumented — confirmed working" }, sort_direction: { type: "string", enum: ["asc","desc"] }, expand: { type: "string" }, fetch_all: { type: "boolean", description: "Auto-fetch all pages (max 20 pages / ~2000 records). Use page+page_size for larger datasets." } } } },
  { name: "get_customer",                      annotations: READ,    description: "Get a customer by ID",                                       inputSchema: { type: "object", required: ["customer_id"], properties: { customer_id: { type: "string" }, expand: { type: "string" } } } },
  { name: "list_customer_addresses",           annotations: READ,    description: "List all addresses for a customer",                          inputSchema: { type: "object", required: ["customer_id"], properties: { customer_id: { type: "string" } } } },
  { name: "get_customer_address",              annotations: READ,    description: "Get a specific address for a customer",                      inputSchema: { type: "object", required: ["customer_id","address_id"], properties: { customer_id: { type: "string" }, address_id: { type: "string" } } } },
  // ── Employees ─────────────────────────────────────────────────────────────
  { name: "list_employees",                    annotations: READ,    description: "List all employees and technicians",                         inputSchema: { type: "object", properties: { page: { type: "number" }, page_size: { type: "number" }, fetch_all: { type: "boolean", description: "Auto-fetch all pages (max 20 pages / ~2000 records)." } } } },

  // ── Jobs ──────────────────────────────────────────────────────────────────
  { name: "list_jobs",                         annotations: READ,    description: "List or search jobs",                                        inputSchema: { type: "object", properties: { page: { type: "number" }, page_size: { type: "number" }, work_status: { type: "array", items: { type: "string", enum: ["unscheduled","scheduled","in_progress","completed","canceled"] } }, scheduled_start_min: { type: "string", description: "ISO 8601 datetime, e.g. 2025-01-15T09:00:00Z" }, scheduled_start_max: { type: "string", description: "ISO 8601 datetime, e.g. 2025-01-15T17:00:00Z" }, customer_id: { type: "string" }, employee_ids: { type: "array", items: { type: "string" } }, location_ids: { type: "array", items: { type: "string" }, description: "Filter by location IDs (multi-location companies)" }, sort_by: { type: "string", enum: ["created_at","updated_at","invoice_number","id","description","work_status"] }, sort_direction: { type: "string", enum: ["asc","desc"] }, expand: { type: "array", items: { type: "string", enum: ["attachments","appointments"] } }, fetch_all: { type: "boolean", description: "Auto-fetch all pages (max 20 pages / ~2000 records). Use page+page_size for larger datasets." } } } },
  { name: "get_job",                           annotations: READ,    description: "Get a job by ID",                                            inputSchema: { type: "object", required: ["job_id"], properties: { job_id: { type: "string" }, expand: { type: "string" } } } },
  { name: "list_job_appointments",             annotations: READ,    description: "List appointments for a job",                                inputSchema: { type: "object", required: ["job_id"], properties: { job_id: { type: "string" } } } },
  { name: "list_job_line_items",               annotations: READ,    description: "List all line items for a job",                              inputSchema: { type: "object", required: ["job_id"], properties: { job_id: { type: "string" } } } },
  { name: "list_job_input_materials",          annotations: READ,    description: "List all input materials for a job",                         inputSchema: { type: "object", required: ["job_id"], properties: { job_id: { type: "string" } } } },
  { name: "list_job_invoices",                 annotations: READ,    description: "List invoices for a job",                                    inputSchema: { type: "object", required: ["job_id"], properties: { job_id: { type: "string" } } } },

  // ── Estimates ─────────────────────────────────────────────────────────────
  { name: "list_estimates",                    annotations: READ,    description: "List or search estimates",                                   inputSchema: { type: "object", properties: { page: { type: "number" }, page_size: { type: "number" }, customer_id: { type: "string" }, work_status: { type: "array", items: { type: "string", enum: ["unscheduled","scheduled","in_progress","completed","canceled"] } }, sort_direction: { type: "string", enum: ["asc","desc"] }, fetch_all: { type: "boolean", description: "Auto-fetch all pages (max 20 pages / ~2000 records). Use page+page_size for larger datasets." } } } },
  { name: "get_estimate",                      annotations: READ,    description: "Get an estimate by ID",                                      inputSchema: { type: "object", required: ["estimate_id"], properties: { estimate_id: { type: "string" } } } },
  { name: "list_estimate_option_line_items",   annotations: READ,    description: "List line items for an estimate option",                     inputSchema: { type: "object", required: ["estimate_id","option_id"], properties: { estimate_id: { type: "string" }, option_id: { type: "string" } } } },

  // ── Invoices ──────────────────────────────────────────────────────────────
  { name: "list_invoices",                     annotations: READ,    description: "List invoices account-wide",                                 inputSchema: { type: "object", properties: { page: { type: "number" }, page_size: { type: "number" }, status: { type: "array", items: { type: "string", enum: ["open","pending_payment","paid","voided","uncollectible","canceled"] } }, customer_uuid: { type: "string" }, created_at_min: { type: "string", description: "ISO 8601 datetime, e.g. 2025-01-15T00:00:00Z" }, created_at_max: { type: "string", description: "ISO 8601 datetime, e.g. 2025-01-15T23:59:59Z" }, paid_at_min: { type: "string", description: "ISO 8601 datetime, e.g. 2025-01-15T00:00:00Z" }, paid_at_max: { type: "string", description: "ISO 8601 datetime, e.g. 2025-01-15T23:59:59Z" }, due_at_min: { type: "string", description: "ISO 8601 datetime, e.g. 2025-01-15T00:00:00Z" }, due_at_max: { type: "string", description: "ISO 8601 datetime, e.g. 2025-01-15T23:59:59Z" }, amount_due_min: { type: "number", description: "Minimum amount due in cents" }, amount_due_max: { type: "number", description: "Maximum amount due in cents" }, payment_method: { type: "array", items: { type: "string", enum: ["consumer_financing","credit_card","ach","external","mobile_check_deposit"] } }, sort_by: { type: "string", enum: ["amount","created_at","due_amount","due_at","invoice_number","paid_at","sent_at","status","updated_at"] }, sort_direction: { type: "string", enum: ["asc","desc"] }, fetch_all: { type: "boolean", description: "Auto-fetch all pages (max 20 pages / ~2000 records). Use page+page_size for larger datasets." } } } },
  { name: "get_invoice_by_uuid",               annotations: READ,    description: "Get an invoice by UUID",                                     inputSchema: { type: "object", required: ["uuid"], properties: { uuid: { type: "string" } } } },
  { name: "preview_invoice",                   annotations: READ,    description: "DEPRECATED — returns raw HTML blob, not structured data. Use get_invoice_by_uuid instead.", inputSchema: { type: "object", required: ["uuid"], properties: { uuid: { type: "string" } } } },

  // ── Leads ─────────────────────────────────────────────────────────────────
  { name: "list_leads",                        annotations: READ,    description: "List or search leads",                                       inputSchema: { type: "object", properties: { page: { type: "number" }, page_size: { type: "number" }, status: { type: "string", enum: ["open","won","lost"] }, customer_id: { type: "string" }, lead_source: { type: "string" }, sort_direction: { type: "string", enum: ["asc","desc"] }, fetch_all: { type: "boolean", description: "Auto-fetch all pages (max 20 pages / ~2000 records). Use page+page_size for larger datasets." } } } },
  { name: "get_lead",                          annotations: READ,    description: "Get a lead by ID",                                           inputSchema: { type: "object", required: ["lead_id"], properties: { lead_id: { type: "string" } } } },
  { name: "list_lead_line_items",              annotations: READ,    description: "List line items for a lead",                                 inputSchema: { type: "object", required: ["lead_id"], properties: { lead_id: { type: "string" } } } },

  // ── Lead Sources ──────────────────────────────────────────────────────────
  { name: "list_lead_sources",                 annotations: READ,    description: "List all lead sources",                                      inputSchema: { type: "object", properties: { q: { type: "string" }, page: { type: "number" } } } },

  // ── Tags ──────────────────────────────────────────────────────────────────
  { name: "list_tags",                         annotations: READ,    description: "List all tags",                                              inputSchema: { type: "object", properties: { page: { type: "number" }, page_size: { type: "number" }, fetch_all: { type: "boolean", description: "Auto-fetch all pages (max 20 pages / ~2000 records)." } } } },

  // ── Job Types ─────────────────────────────────────────────────────────────
  { name: "list_job_types",                    annotations: READ,    description: "List job type categories",                                   inputSchema: { type: "object", properties: { name: { type: "string" } } } },

  // ── Pricebook ─────────────────────────────────────────────────────────────
  { name: "list_pricebook_services",           annotations: READ,    description: "List pricebook services",                                    inputSchema: { type: "object", properties: { page: { type: "number" }, q: { type: "string" }, fetch_all: { type: "boolean", description: "Auto-fetch all pages (max 20 pages / ~2000 records)." } } } },
  { name: "list_pricebook_materials",          annotations: READ,    description: "List pricebook materials",                                   inputSchema: { type: "object", properties: { page: { type: "number" }, material_category_uuid: { type: "string", description: "Required for filtering by category. Call list_material_categories first." }, fetch_all: { type: "boolean", description: "Auto-fetch all pages (max 20 pages / ~2000 records)." } } } },
  { name: "list_material_categories",          annotations: READ,    description: "List material categories",                                   inputSchema: { type: "object", properties: { page: { type: "number" } } } },
  { name: "list_price_forms",                  annotations: READ,    description: "List price forms",                                           inputSchema: { type: "object", properties: {} } },
  { name: "get_price_form",                    annotations: READ,    description: "Get a price form by UUID",                                   inputSchema: { type: "object", required: ["uuid"], properties: { uuid: { type: "string" } } } },

  // ── Events & Schedule ─────────────────────────────────────────────────────
  { name: "list_events",                       annotations: READ,    description: "List calendar events. HCP API sorts by created_at by default; use sort_by=start_time&sort_direction=desc + fetch_all + start_time_min/max to surface upcoming/today events (desc sort puts future events first so they land within the fetch_all window). start_time_min/max are client-side filters applied after fetch.", inputSchema: { type: "object", properties: { page: { type: "number" }, page_size: { type: "number" }, sort_by: { type: "string", enum: ["start_time","name"], description: "Undocumented — confirmed working. Use start_time+desc to get upcoming events first." }, sort_direction: { type: "string", enum: ["asc","desc"] }, start_time_min: { type: "string", description: "ISO 8601 datetime — client-side filter, e.g. 2025-01-15T00:00:00Z" }, start_time_max: { type: "string", description: "ISO 8601 datetime — client-side filter, e.g. 2025-01-15T23:59:59Z" }, fetch_all: { type: "boolean", description: "Auto-fetch all pages (max 20 pages / ~2000 records). Combine with sort_by=start_time&sort_direction=desc for date-scoped results." } } } },
  { name: "get_event",                         annotations: READ,    description: "Get a calendar event by ID",                                 inputSchema: { type: "object", required: ["event_id"], properties: { event_id: { type: "string" } } } },
  { name: "get_schedule_availability",         annotations: READ,    description: "Get company schedule availability",                          inputSchema: { type: "object", properties: {} } },
  { name: "get_booking_windows",               annotations: READ,    description: "Get available booking windows",                              inputSchema: { type: "object", properties: { show_for_days: { type: "number" }, start_date: { type: "string", description: "Date in YYYY-MM-DD format, e.g. 2025-01-15" }, employee_ids: { type: "array", items: { type: "string" } } } } },

  // ── Dispatch ──────────────────────────────────────────────────────────────
  { name: "list_routes",                       annotations: READ,    description: "List dispatch routes",                                       inputSchema: { type: "object", properties: { date: { type: "string", description: "Date in YYYY-MM-DD format, e.g. 2025-01-15" }, page: { type: "number" } } } },
  { name: "list_service_zones",                annotations: READ,    description: "List service zones",                                         inputSchema: { type: "object", properties: { page: { type: "number" }, zip_code: { type: "string" } } } },

  // ── Pipeline ──────────────────────────────────────────────────────────────
  { name: "list_pipeline_statuses",            annotations: READ,    description: "List pipeline statuses",                                     inputSchema: { type: "object", required: ["resource_type"], properties: { resource_type: { type: "string", enum: ["lead","job","estimate"], description: "Resource type to retrieve pipeline statuses for" }, page: { type: "number" } } } },

  // ── Company ───────────────────────────────────────────────────────────────
  { name: "get_company",                       annotations: READ,    description: "Get company account information",                            inputSchema: { type: "object", properties: {} } },

  // ── Checklists ────────────────────────────────────────────────────────────
  { name: "list_checklists",                   annotations: READ,    description: "List checklists for jobs or estimates",                      inputSchema: { type: "object", properties: { page: { type: "number" }, job_uuids: { type: "array", items: { type: "string" } } } } },




  // ════════════════════════════════════════════════════════════════════════════
  // WRITE
  // ════════════════════════════════════════════════════════════════════════════

  // ── Customers ─────────────────────────────────────────────────────────────
  { name: "create_customer",                   annotations: WRITE,   description: "Create a new customer",                                      inputSchema: { type: "object", required: ["first_name","last_name"], properties: { first_name: { type: "string" }, last_name: { type: "string" }, email: { type: "string" }, mobile_number: { type: "string" }, home_number: { type: "string" }, work_number: { type: "string" }, company: { type: "string" }, notifications_enabled: { type: "boolean" }, lead_source: { type: "string" }, notes: { type: "string" } } } },
  { name: "update_customer",                   annotations: WRITE,   description: "Update a customer",                                          inputSchema: { type: "object", required: ["customer_id"], properties: { customer_id: { type: "string" }, first_name: { type: "string" }, last_name: { type: "string" }, email: { type: "string" }, mobile_number: { type: "string" }, company: { type: "string" }, notifications_enabled: { type: "boolean" }, lead_source: { type: "string" }, notes: { type: "string" } } } },
  { name: "create_customer_address",           annotations: WRITE,   description: "Add a service address to a customer",                        inputSchema: { type: "object", required: ["customer_id","street","city","state","zip"], properties: { customer_id: { type: "string" }, street: { type: "string" }, street_line_2: { type: "string" }, city: { type: "string" }, state: { type: "string" }, zip: { type: "string" }, country: { type: "string" } } } },

  // ── Jobs ──────────────────────────────────────────────────────────────────
  { name: "create_job",                        annotations: WRITE,   description: "Create a new job",                                           inputSchema: { type: "object", required: ["customer_id","address_id"], properties: { customer_id: { type: "string" }, address_id: { type: "string" }, invoice_number: { type: "number" }, notes: { type: "string" }, lead_source: { type: "string" }, job_type_id: { type: "string" }, tags: { type: "array", items: { type: "string" } }, assigned_employee_ids: { type: "array", items: { type: "string" } }, schedule: { type: "object", description: "Optional schedule at creation time", properties: { scheduled_start: { type: "string", description: "ISO 8601, e.g. 2025-01-15T09:00:00" }, scheduled_end: { type: "string", description: "ISO 8601, e.g. 2025-01-15T11:00:00" }, arrival_window: { type: "number", description: "Arrival window in minutes" }, anytime: { type: "boolean" } } } } } },
  { name: "dispatch_job",                      annotations: WRITE,   description: "Dispatch a job to specific employees",                       inputSchema: { type: "object", required: ["job_id","employee_ids"], properties: { job_id: { type: "string" }, employee_ids: { type: "array", items: { type: "string" } } } } },
  { name: "lock_job",                          annotations: WRITE,   description: "Lock a single job",                                          inputSchema: { type: "object", required: ["job_id"], properties: { job_id: { type: "string" } } } },
  { name: "lock_jobs",                         annotations: WRITE,   description: "Lock all completed or scheduled jobs within a time range",   inputSchema: { type: "object", required: ["starting_at","ending_at"], properties: { starting_at: { type: "string", description: "ISO 8601 datetime, e.g. 2025-01-01T00:00:00Z" }, ending_at: { type: "string", description: "ISO 8601 datetime, e.g. 2025-03-31T23:59:59Z" } } } },
  { name: "update_job_schedule",               annotations: WRITE,   description: "Update the schedule for a job. notify/notify_pro fire immediately at scheduling time, not at job completion.", inputSchema: { type: "object", required: ["job_id","start_time"], properties: { job_id: { type: "string" }, start_time: { type: "string", description: "ISO 8601 datetime, e.g. 2025-01-15T09:00:00" }, end_time: { type: "string", description: "ISO 8601 datetime, e.g. 2025-01-15T11:00:00" }, arrival_window_in_minutes: { type: "number", description: "Arrival window in minutes, e.g. 30, 60, 120" }, notify: { type: "boolean", description: "Send booking confirmation SMS/email to customer immediately" }, notify_pro: { type: "boolean", description: "Send booking confirmation to assigned employee immediately" }, dispatched_employees: { type: "array", items: { type: "object", properties: { employee_id: { type: "string" } } }, description: "Employees to dispatch to this job" } } } },
  { name: "delete_job_schedule",               annotations: DESTROY, description: "Remove the schedule from a job",                             inputSchema: { type: "object", required: ["job_id"], properties: { job_id: { type: "string" } } } },
  { name: "create_job_appointment",            annotations: WRITE,   description: "Schedule an appointment for a job",                          inputSchema: { type: "object", required: ["job_id","scheduled_start","scheduled_end"], properties: { job_id: { type: "string" }, scheduled_start: { type: "string", description: "ISO 8601 datetime, e.g. 2025-01-15T09:00:00Z" }, scheduled_end: { type: "string", description: "ISO 8601 datetime, e.g. 2025-01-15T11:00:00Z" }, arrival_window_minutes: { type: "number" }, assigned_employee_ids: { type: "array", items: { type: "string" } }, dispatcher_note: { type: "string" }, notify_customer: { type: "boolean" } } } },
  { name: "update_job_appointment",            annotations: WRITE,   description: "Update a job appointment",                                   inputSchema: { type: "object", required: ["job_id","appointment_id"], properties: { job_id: { type: "string" }, appointment_id: { type: "string" }, scheduled_start: { type: "string", description: "ISO 8601 datetime, e.g. 2025-01-15T09:00:00Z" }, scheduled_end: { type: "string", description: "ISO 8601 datetime, e.g. 2025-01-15T11:00:00Z" }, assigned_employee_ids: { type: "array", items: { type: "string" } }, notify_customer: { type: "boolean" } } } },
  { name: "delete_job_appointment",            annotations: DESTROY, description: "Delete a job appointment",                                   inputSchema: { type: "object", required: ["job_id","appointment_id"], properties: { job_id: { type: "string" }, appointment_id: { type: "string" }, notify_customer: { type: "boolean" } } } },
  { name: "create_job_note",                   annotations: WRITE,   description: "Add a note to a job",                                        inputSchema: { type: "object", required: ["job_id","content"], properties: { job_id: { type: "string" }, content: { type: "string" } } } },
  { name: "delete_job_note",                   annotations: DESTROY, description: "Delete a note from a job",                                   inputSchema: { type: "object", required: ["job_id","note_id"], properties: { job_id: { type: "string" }, note_id: { type: "string" } } } },
  { name: "add_job_tag",                       annotations: WRITE,   description: "Add a tag to a job",                                         inputSchema: { type: "object", required: ["job_id","tag"], properties: { job_id: { type: "string" }, tag: { type: "string" } } } },
  { name: "delete_job_tag",                    annotations: DESTROY, description: "Remove a tag from a job",                                    inputSchema: { type: "object", required: ["job_id","tag_id"], properties: { job_id: { type: "string" }, tag_id: { type: "string" } } } },
  { name: "create_job_link",                   annotations: WRITE,   description: "Add a link to a job",                                        inputSchema: { type: "object", required: ["job_id","url"], properties: { job_id: { type: "string" }, url: { type: "string" }, name: { type: "string" } } } },
  { name: "create_job_attachment",             annotations: WRITE,   description: "Attach a file URL to a job",                                 inputSchema: { type: "object", required: ["job_id","url"], properties: { job_id: { type: "string" }, url: { type: "string" }, name: { type: "string" } } } },
  { name: "create_job_line_item",              annotations: WRITE,   description: "Add a line item to a job",                                   inputSchema: { type: "object", required: ["job_id","name","unit_price"], properties: { job_id: { type: "string" }, name: { type: "string" }, unit_price: { type: "number", description: "Price in cents, e.g. 15000 = $150.00" }, quantity: { type: "number" }, unit_cost: { type: "number", description: "Cost in cents, e.g. 5000 = $50.00" }, taxable: { type: "boolean" } } } },
  { name: "update_job_line_item",              annotations: WRITE,   description: "Update a single line item on a job",                         inputSchema: { type: "object", required: ["job_id","line_item_id"], properties: { job_id: { type: "string" }, line_item_id: { type: "string" }, name: { type: "string" }, unit_price: { type: "number", description: "Price in cents, e.g. 15000 = $150.00" }, quantity: { type: "number" } } } },
  { name: "delete_job_line_item",              annotations: DESTROY, description: "Delete a line item from a job",                              inputSchema: { type: "object", required: ["job_id","line_item_id"], properties: { job_id: { type: "string" }, line_item_id: { type: "string" } } } },
  { name: "bulk_update_job_line_items",        annotations: WRITE,   description: "Bulk update all line items on a job",                        inputSchema: { type: "object", required: ["job_id","line_items"], properties: { job_id: { type: "string" }, line_items: { type: "array", items: { type: "object" } } } } },
  { name: "bulk_update_job_input_materials",   annotations: WRITE,   description: "Bulk update input materials for a job",                      inputSchema: { type: "object", required: ["job_id","materials"], properties: { job_id: { type: "string" }, materials: { type: "array", items: { type: "object" } } } } },

  // ── Estimates ─────────────────────────────────────────────────────────────
  { name: "create_estimate",                   annotations: WRITE,   description: "Create a new estimate",                                      inputSchema: { type: "object", required: ["customer_id"], properties: { customer_id: { type: "string" }, address_id: { type: "string" }, notes: { type: "string" }, lead_source: { type: "string" }, assigned_employee_ids: { type: "array", items: { type: "string" } } } } },
  { name: "approve_estimate_options",          annotations: WRITE,   description: "Approve estimate options",                                   inputSchema: { type: "object", required: ["option_ids"], properties: { option_ids: { type: "array", items: { type: "string" } } } } },
  { name: "decline_estimate_options",          annotations: WRITE,   description: "Decline estimate options",                                   inputSchema: { type: "object", required: ["option_ids"], properties: { option_ids: { type: "array", items: { type: "string" } } } } },
  { name: "create_estimate_option",            annotations: WRITE,   description: "Create an option on an estimate",                            inputSchema: { type: "object", required: ["estimate_id"], properties: { estimate_id: { type: "string" }, name: { type: "string" } } } },
  { name: "create_estimate_option_note",       annotations: WRITE,   description: "Add a note to an estimate option",                           inputSchema: { type: "object", required: ["estimate_id","option_id","content"], properties: { estimate_id: { type: "string" }, option_id: { type: "string" }, content: { type: "string" } } } },
  { name: "delete_estimate_option_note",       annotations: DESTROY, description: "Delete a note from an estimate option",                      inputSchema: { type: "object", required: ["estimate_id","option_id","note_id"], properties: { estimate_id: { type: "string" }, option_id: { type: "string" }, note_id: { type: "string" } } } },
  { name: "bulk_update_estimate_option_line_items", annotations: WRITE, description: "Bulk update line items on an estimate option",            inputSchema: { type: "object", required: ["estimate_id","option_id","line_items"], properties: { estimate_id: { type: "string" }, option_id: { type: "string" }, line_items: { type: "array", items: { type: "object" } } } } },
  { name: "create_estimate_option_attachment", annotations: WRITE,   description: "Add an attachment to an estimate option",                    inputSchema: { type: "object", required: ["estimate_id","option_id","url"], properties: { estimate_id: { type: "string" }, option_id: { type: "string" }, url: { type: "string" } } } },
  { name: "create_estimate_option_link",       annotations: WRITE,   description: "Add a link to an estimate option",                           inputSchema: { type: "object", required: ["estimate_id","option_id","url"], properties: { estimate_id: { type: "string" }, option_id: { type: "string" }, url: { type: "string" } } } },
  { name: "update_estimate_option_schedule",   annotations: WRITE,   description: "Update the schedule for an estimate option",                 inputSchema: { type: "object", required: ["estimate_id","option_id"], properties: { estimate_id: { type: "string" }, option_id: { type: "string" }, scheduled_start: { type: "string", description: "ISO 8601 datetime, e.g. 2025-01-15T09:00:00Z" }, scheduled_end: { type: "string", description: "ISO 8601 datetime, e.g. 2025-01-15T11:00:00Z" } } } },

  // ── Leads ─────────────────────────────────────────────────────────────────
  { name: "create_lead",                       annotations: WRITE,   description: "Create a new lead",                                          inputSchema: { type: "object", properties: { customer_id: { type: "string" }, first_name: { type: "string" }, last_name: { type: "string" }, email: { type: "string" }, mobile_number: { type: "string" }, description: { type: "string" }, notes: { type: "string" }, lead_source: { type: "string" } } } },
  { name: "convert_lead",                      annotations: WRITE,   description: "Convert a lead to an estimate or job",                       inputSchema: { type: "object", required: ["lead_id","convert_to"], properties: { lead_id: { type: "string" }, convert_to: { type: "string", enum: ["estimate","job"] } } } },

  // ── Lead Sources ──────────────────────────────────────────────────────────
  { name: "create_lead_source",                annotations: WRITE,   description: "Create a new lead source",                                   inputSchema: { type: "object", required: ["name"], properties: { name: { type: "string" } } } },
  { name: "update_lead_source",                annotations: WRITE,   description: "Update a lead source",                                       inputSchema: { type: "object", required: ["lead_source_id","name"], properties: { lead_source_id: { type: "string" }, name: { type: "string" } } } },

  // ── Tags ──────────────────────────────────────────────────────────────────
  { name: "create_tag",                        annotations: WRITE,   description: "Create a new tag",                                           inputSchema: { type: "object", required: ["name"], properties: { name: { type: "string" } } } },
  { name: "update_tag",                        annotations: WRITE,   description: "Update an existing tag",                                     inputSchema: { type: "object", required: ["tag_id","name"], properties: { tag_id: { type: "string" }, name: { type: "string" } } } },

  // ── Job Types ─────────────────────────────────────────────────────────────
  { name: "create_job_type",                   annotations: WRITE,   description: "Create a new job type",                                      inputSchema: { type: "object", required: ["name"], properties: { name: { type: "string" } } } },
  { name: "update_job_type",                   annotations: WRITE,   description: "Update a job type",                                          inputSchema: { type: "object", required: ["job_type_id","name"], properties: { job_type_id: { type: "string" }, name: { type: "string" } } } },

  // ── Pricebook ─────────────────────────────────────────────────────────────
  { name: "create_pricebook_material",         annotations: WRITE,   description: "Create a pricebook material",                                inputSchema: { type: "object", required: ["name"], properties: { name: { type: "string" }, description: { type: "string" }, unit_cost: { type: "number", description: "Cost in cents, e.g. 5000 = $50.00" }, material_category_uuid: { type: "string" } } } },
  { name: "update_pricebook_material",         annotations: WRITE,   description: "Update a pricebook material",                                inputSchema: { type: "object", required: ["uuid"], properties: { uuid: { type: "string" }, name: { type: "string" }, unit_cost: { type: "number", description: "Cost in cents, e.g. 5000 = $50.00" } } } },
  { name: "delete_pricebook_material",         annotations: DESTROY, description: "Delete a pricebook material",                                inputSchema: { type: "object", required: ["uuid"], properties: { uuid: { type: "string" } } } },
  { name: "create_material_category",          annotations: WRITE,   description: "Create a material category",                                 inputSchema: { type: "object", required: ["name"], properties: { name: { type: "string" } } } },
  { name: "update_material_category",          annotations: WRITE,   description: "Update a material category",                                 inputSchema: { type: "object", required: ["uuid","name"], properties: { uuid: { type: "string" }, name: { type: "string" } } } },
  { name: "delete_material_category",          annotations: DESTROY, description: "Delete a material category",                                 inputSchema: { type: "object", required: ["uuid"], properties: { uuid: { type: "string" } } } },
  { name: "create_price_form",                 annotations: WRITE,   description: "Create a price form",                                        inputSchema: { type: "object", required: ["name"], properties: { name: { type: "string" } } } },
  { name: "update_price_form",                 annotations: WRITE,   description: "Update a price form",                                        inputSchema: { type: "object", required: ["uuid"], properties: { uuid: { type: "string" }, name: { type: "string" } } } },
  { name: "delete_price_form",                 annotations: DESTROY, description: "Delete a price form",                                        inputSchema: { type: "object", required: ["uuid"], properties: { uuid: { type: "string" } } } },

  // ── Schedule ──────────────────────────────────────────────────────────────
  { name: "update_schedule_availability",      annotations: WRITE,   description: "Update company schedule windows",                            inputSchema: { type: "object", required: ["schedule"], properties: { schedule: { type: "object" } } } },

  // ── Pipeline ──────────────────────────────────────────────────────────────
  { name: "update_pipeline_status",            annotations: WRITE,   description: "Update a pipeline status",                                   inputSchema: { type: "object", required: ["status"], properties: { status: { type: "object" } } } },

  // ── Application ───────────────────────────────────────────────────────────
  { name: "enable_application",                annotations: WRITE,   description: "Enable the application integration",                         inputSchema: { type: "object", properties: {} } },
  { name: "disable_application",               annotations: DESTROY, description: "Disable the application integration",                        inputSchema: { type: "object", properties: {} } },

  // ── Webhooks ──────────────────────────────────────────────────────────────
  { name: "create_webhook",                    annotations: WRITE,   description: "Enable webhook subscription for this company. Configure URL and events in HCP UI first.", inputSchema: { type: "object", properties: {} } },
  { name: "delete_webhook",                    annotations: DESTROY, description: "Delete the webhook subscription for this company.",          inputSchema: { type: "object", properties: {} } },

];

// Prefix all tool descriptions with system name for cross-connector clarity
for (const t of TOOLS) t.description = "[HouseCall Pro] " + t.description;

async function callTool(name, args, apiKey) {
  const c = (method, path, body) => hcp(apiKey, method, path, body);

  async function fetchAll(path, params, itemsKey) {
    const MAX_PAGES = 20;
    const allItems = [];
    const pageSize = 100;
    for (let page = 1; page <= MAX_PAGES; page++) {
      const data = await c("GET", `${path}${qs({ ...params, page, page_size: pageSize })}`);
      const items = data[itemsKey] ?? [];
      if (!items.length) break;
      allItems.push(...items);
      if (page >= (data.total_pages ?? 1)) break;
      if (page < MAX_PAGES) await new Promise(r => setTimeout(r, 100));
    }
    return { [itemsKey]: allItems, total_items: allItems.length };
  }

  switch (name) {
    case "list_customers": { const { fetch_all, ...rest } = args; if (fetch_all) return fetchAll("/customers", rest, "customers"); return c("GET", `/customers${qs(rest)}`); }
    case "get_customer": { const { customer_id, ...q } = args; return c("GET", `/customers/${customer_id}${qs(q)}`); }
    case "create_customer": return c("POST", `/customers`, args);
    case "update_customer": { const { customer_id, ...b } = args; return c("PUT", `/customers/${customer_id}`, b); }
    case "list_customer_addresses": { const { customer_id, ...q } = args; return c("GET", `/customers/${customer_id}/addresses${qs(q)}`); }
    case "get_customer_address": return c("GET", `/customers/${args.customer_id}/addresses/${args.address_id}`);
    case "create_customer_address": { const { customer_id, ...b } = args; return c("POST", `/customers/${customer_id}/addresses`, b); }
    case "list_employees": { const { fetch_all, ...rest } = args; if (fetch_all) return fetchAll("/employees", rest, "employees"); return c("GET", `/employees${qs(rest)}`); }
    case "list_jobs": { const { fetch_all, ...rest } = args; if (fetch_all) return fetchAll("/jobs", rest, "jobs"); return c("GET", `/jobs${qs(rest)}`); }
    case "get_job": { const { job_id, ...q } = args; return c("GET", `/jobs/${job_id}${qs(q)}`); }
    case "create_job": return c("POST", `/jobs`, args);
    case "dispatch_job": { const { job_id, ...b } = args; return c("PUT", `/jobs/${job_id}/dispatch`, b); }
    case "lock_job": return c("POST", `/jobs/${args.job_id}/lock`);
    case "lock_jobs": return c("POST", `/jobs/lock`, args);
    case "update_job_schedule": { const { job_id, ...b } = args; return c("PUT", `/jobs/${job_id}/schedule`, b); }
    case "delete_job_schedule": return c("DELETE", `/jobs/${args.job_id}/schedule`);
    case "list_job_appointments": return c("GET", `/jobs/${args.job_id}/appointments`);
    case "create_job_appointment": { const { job_id, ...b } = args; return c("POST", `/jobs/${job_id}/appointments`, b); }
    case "update_job_appointment": { const { job_id, appointment_id, ...b } = args; return c("PUT", `/jobs/${job_id}/appointments/${appointment_id}`, b); }
    case "delete_job_appointment": { const { job_id, appointment_id, ...b } = args; return c("DELETE", `/jobs/${job_id}/appointments/${appointment_id}${qs(b)}`); }
    case "create_job_note": return c("POST", `/jobs/${args.job_id}/notes`, { content: args.content });
    case "delete_job_note": return c("DELETE", `/jobs/${args.job_id}/notes/${args.note_id}`);
    case "add_job_tag": return c("POST", `/jobs/${args.job_id}/tags`, { tag: args.tag });
    case "delete_job_tag": return c("DELETE", `/jobs/${args.job_id}/tags/${args.tag_id}`);
    case "create_job_link": { const { job_id, ...b } = args; return c("POST", `/jobs/${job_id}/links`, b); }
    case "create_job_attachment": { const { job_id, ...b } = args; return c("POST", `/jobs/${job_id}/attachments`, b); }
    case "list_job_line_items": return c("GET", `/jobs/${args.job_id}/line_items`);
    case "create_job_line_item": { const { job_id, ...b } = args; return c("POST", `/jobs/${job_id}/line_items`, b); }
    case "update_job_line_item": { const { job_id, line_item_id, ...b } = args; return c("PUT", `/jobs/${job_id}/line_items/${line_item_id}`, b); }
    case "delete_job_line_item": return c("DELETE", `/jobs/${args.job_id}/line_items/${args.line_item_id}`);
    case "bulk_update_job_line_items": { const { job_id, ...b } = args; return c("PUT", `/jobs/${job_id}/line_items/bulk_update`, b); }
    case "list_job_input_materials": return c("GET", `/jobs/${args.job_id}/job_input_materials`);
    case "bulk_update_job_input_materials": { const { job_id, ...b } = args; return c("PUT", `/jobs/${job_id}/job_input_materials/bulk_update`, b); }
    case "list_job_invoices": return c("GET", `/jobs/${args.job_id}/invoices`);
    case "list_estimates": { const { fetch_all, ...rest } = args; if (fetch_all) return fetchAll("/estimates", rest, "estimates"); return c("GET", `/estimates${qs(rest)}`); }
    case "get_estimate": { const { estimate_id, ...q } = args; return c("GET", `/estimates/${estimate_id}${qs(q)}`); }
    case "create_estimate": return c("POST", `/estimates`, args);
    case "approve_estimate_options": return c("POST", `/estimates/options/approve`, args);
    case "decline_estimate_options": return c("POST", `/estimates/options/decline`, args);
    case "create_estimate_option": { const { estimate_id, ...b } = args; return c("POST", `/estimates/${estimate_id}/options`, b); }
    case "create_estimate_option_note": { const { estimate_id, option_id, ...b } = args; return c("POST", `/estimates/${estimate_id}/options/${option_id}/notes`, b); }
    case "delete_estimate_option_note": return c("DELETE", `/estimates/${args.estimate_id}/options/${args.option_id}/notes/${args.note_id}`);
    case "list_estimate_option_line_items": return c("GET", `/estimates/${args.estimate_id}/options/${args.option_id}/line_items`);
    case "bulk_update_estimate_option_line_items": { const { estimate_id, option_id, ...b } = args; return c("PUT", `/estimates/${estimate_id}/options/${option_id}/line_items/bulk_update`, b); }
    case "create_estimate_option_attachment": { const { estimate_id, option_id, ...b } = args; return c("POST", `/estimates/${estimate_id}/options/${option_id}/attachments`, b); }
    case "create_estimate_option_link": { const { estimate_id, option_id, ...b } = args; return c("POST", `/estimates/${estimate_id}/options/${option_id}/links`, b); }
    case "update_estimate_option_schedule": { const { estimate_id, option_id, ...b } = args; return c("PUT", `/estimates/${estimate_id}/options/${option_id}/schedule`, b); }
    case "list_invoices": { const { fetch_all, ...rest } = args; if (fetch_all) return fetchAll("/invoices", rest, "invoices"); return c("GET", `/invoices${qs(rest)}`); }
    case "get_invoice_by_uuid": return c("GET", `/api/invoices/${args.uuid}`);
    case "preview_invoice": throw new Error("preview_invoice returns a raw HTML blob — use get_invoice_by_uuid for structured invoice data instead.");
    case "list_leads": { const { fetch_all, ...rest } = args; if (fetch_all) return fetchAll("/leads", rest, "leads"); return c("GET", `/leads${qs(rest)}`); }
    case "get_lead": return c("GET", `/leads/${args.lead_id}`);
    case "create_lead": return c("POST", `/leads`, args);
    case "convert_lead": { const { lead_id, ...b } = args; return c("PUT", `/leads/${lead_id}/convert`, b); }
    case "list_lead_line_items": return c("GET", `/leads/${args.lead_id}/line_items`);
    case "list_lead_sources": return c("GET", `/lead_sources${qs(args)}`);
    case "create_lead_source": return c("POST", `/lead_sources`, args);
    case "update_lead_source": { const { lead_source_id, ...b } = args; return c("PUT", `/lead_sources/${lead_source_id}`, b); }
    case "list_tags": { const { fetch_all, ...rest } = args; if (fetch_all) return fetchAll("/tags", rest, "tags"); return c("GET", `/tags${qs(rest)}`); }
    case "create_tag": return c("POST", `/tags`, args);
    case "update_tag": { const { tag_id, ...b } = args; return c("PUT", `/tags/${tag_id}`, b); }
    case "list_job_types": return c("GET", `/job_fields/job_types${qs(args)}`);
    case "create_job_type": return c("POST", `/job_fields/job_types`, args);
    case "update_job_type": { const { job_type_id, ...b } = args; return c("PUT", `/job_fields/job_types/${job_type_id}`, b); }
    case "list_pricebook_services": { const { fetch_all, ...rest } = args; if (fetch_all) return fetchAll("/api/price_book/services", rest, "services"); return c("GET", `/api/price_book/services${qs(rest)}`); }
    case "list_pricebook_materials": { const { fetch_all, ...rest } = args; if (fetch_all) return fetchAll("/api/price_book/materials", rest, "materials"); return c("GET", `/api/price_book/materials${qs(rest)}`); }
    case "create_pricebook_material": { const { material_category_uuid, ...b } = args; return c("POST", `/api/price_book/materials${qs({ material_category_uuid })}`, b); }
    case "update_pricebook_material": { const { uuid, ...b } = args; return c("PUT", `/api/price_book/materials/${uuid}`, b); }
    case "delete_pricebook_material": return c("DELETE", `/api/price_book/materials/${args.uuid}`);
    case "list_material_categories": return c("GET", `/api/price_book/material_categories${qs(args)}`);
    case "create_material_category": return c("POST", `/api/price_book/material_categories`, args);
    case "update_material_category": { const { uuid, ...b } = args; return c("PUT", `/api/price_book/material_categories/${uuid}`, b); }
    case "delete_material_category": { const { uuid, ...b } = args; return c("DELETE", `/api/price_book/material_categories/${uuid}`, b); }
    case "list_price_forms": return c("GET", `/api/price_book/price_forms`);
    case "get_price_form": return c("GET", `/api/price_book/price_forms/${args.uuid}`);
    case "create_price_form": return c("POST", `/api/price_book/price_forms`, args);
    case "update_price_form": { const { uuid, ...b } = args; return c("PUT", `/api/price_book/price_forms/${uuid}`, b); }
    case "delete_price_form": return c("DELETE", `/api/price_book/price_forms/${args.uuid}`);
    case "list_events": {
      const { fetch_all, start_time_min, start_time_max, ...rest } = args;
      let data = fetch_all ? await fetchAll("/events", rest, "events") : await c("GET", `/events${qs(rest)}`);
      if (start_time_min || start_time_max) {
        const min = start_time_min ? new Date(start_time_min) : null;
        const max = start_time_max ? new Date(start_time_max) : null;
        data.events = (data.events || []).filter(e => {
          const t = new Date(e.schedule?.start_time);
          if (min && t < min) return false;
          if (max && t > max) return false;
          return true;
        });
        data.total_items = data.events.length;
      }
      return data;
    }
    case "get_event": return c("GET", `/events/${args.event_id}`);
    case "get_schedule_availability": return c("GET", `/company/schedule_availability`);
    case "update_schedule_availability": return c("PUT", `/company/schedule_availability`, args.schedule);
    case "get_booking_windows": return c("GET", `/company/schedule_availability/booking_windows${qs(args)}`);
    case "list_routes": return c("GET", `/routes${qs(args)}`);
    case "list_service_zones": return c("GET", `/service_zones${qs(args)}`);
    case "list_pipeline_statuses": return c("GET", `/pipeline/statuses${qs(args)}`);
    case "update_pipeline_status": return c("PUT", `/pipeline/statuses`, args.status);
    case "get_company": return c("GET", `/company`);
    case "list_checklists": return c("GET", `/checklists${qs(args)}`);
    case "enable_application": return c("POST", `/application/enable`);
    case "disable_application": return c("POST", `/application/disable`);
    case "create_webhook": return c("POST", `/webhooks/subscription`, {});
    case "delete_webhook": return c("DELETE", `/webhooks/subscription`, {});
    default: throw new Error(`Unknown tool: ${name}`);
  }
}


const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Mcp-Session-Id, Accept",
};

const HCP_ICON = "data:image/png;base64,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";
const HCP_ICON_MIME = "image/png";


function mcpJson(id, result) {
  return new Response(JSON.stringify({ jsonrpc: "2.0", id, result }), { headers: { "Content-Type": "application/json", ...CORS } });
}
function mcpErr(id, code, message) {
  return new Response(JSON.stringify({ jsonrpc: "2.0", id, error: { code, message } }), { headers: { "Content-Type": "application/json", ...CORS } });
}

async function handleMCP(request, env) {
  // Token auth — required on all MCP requests
  const url = new URL(request.url);
  const token = url.searchParams.get("token") ||
    (request.headers.get("Authorization") || "").replace(/^Bearer\s+/i, "").trim();
  if (!token) {
    return new Response(
      JSON.stringify({ error: "Unauthorized: add ?token=<your-token> to the MCP URL." }),
      { status: 401, headers: { "Content-Type": "application/json", ...CORS } }
    );
  }
  const recordStr = env.MCP_TOKENS ? await env.MCP_TOKENS.get(token) : null;
  if (!recordStr) {
    return new Response(
      JSON.stringify({ error: "Unauthorized: invalid or revoked token." }),
      { status: 401, headers: { "Content-Type": "application/json", ...CORS } }
    );
  }
  let userName = "Unknown", tier = "read";
  try { ({ name: userName, tier } = JSON.parse(recordStr)); } catch {}
  const readOnly = tier !== "write";

  if (request.method === "GET") {
    return new Response(JSON.stringify({ name: "HouseCall Pro", version: "3.3.1", protocolVersion: "2025-03-26", description: "HouseCall Pro field service management — customers, jobs, estimates, invoices, pricebook, and dispatch.", icons: [{ src: HCP_ICON, mimeType: HCP_ICON_MIME, sizes: ["any"] }] }), { headers: { "Content-Type": "application/json", ...CORS } });
  }
  let msg;
  try { msg = await request.json(); } catch { return mcpErr(null, -32700, "Parse error"); }
  const { id, method, params } = msg;
  try {
    switch (method) {
      case "initialize":
        return mcpJson(id, { protocolVersion: "2025-03-26", capabilities: { tools: {} }, serverInfo: { name: "HouseCall Pro", version: "3.3.1", description: "HouseCall Pro field service management — customers, jobs, estimates, invoices, pricebook, and dispatch.", icons: [{ src: HCP_ICON, mimeType: HCP_ICON_MIME, sizes: ["any"] }] } });
      case "notifications/initialized":
        return new Response(null, { status: 204, headers: CORS });
      case "ping":
        return mcpJson(id, {});
      case "tools/list":
        return mcpJson(id, { tools: readOnly ? TOOLS.filter(t => t.annotations?.readOnlyHint) : TOOLS });
      case "tools/call": {
        const { name, arguments: args } = params;
        if (readOnly) {
          const toolDef = TOOLS.find(t => t.name === name);
          if (toolDef && !toolDef.annotations?.readOnlyHint) {
            return mcpJson(id, { content: [{ type: "text", text: `Access denied: '${name}' requires write access. Contact your admin to upgrade your token tier.` }], isError: true });
          }
        }
        let result;
        try {
          result = await callTool(name, args || {}, env.HCP_API_KEY);
          result = stripPermissions(result);
          result = normalizePricebookPage(result);
        } catch (toolErr) {
          if (toolErr.message.startsWith("Unknown tool:")) throw toolErr;
          return mcpJson(id, { content: [{ type: "text", text: toolErr.message }], isError: true });
        }
        return mcpJson(id, { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] });
      }
      default:
        return mcpErr(id, -32601, `Method not found: ${method}`);
    }
  } catch (err) {
    return mcpErr(id, -32000, err.message);
  }
}

function getDashboardHTML() {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>HouseCall Pro Dispatch</title>
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&display=swap" rel="stylesheet">
<style>
*,*::before,*::after{box-sizing:border-box;margin:0;padding:0}
body{font-family:'Inter',sans-serif;background:#f5f5f4;color:#1c1c1b;min-height:100vh}
.bar{background:#2E8BC4;color:#fff;padding:0 1.25rem;height:52px;display:flex;align-items:center;justify-content:space-between;position:sticky;top:0;z-index:10;box-shadow:0 1px 3px rgba(0,0,0,.08)}
.bar-l{display:flex;align-items:center;gap:.6rem;font-size:15px;font-weight:600}
.ver{background:rgba(255,255,255,.18);padding:2px 8px;border-radius:10px;font-size:11px;font-weight:500}
.bar-r{display:flex;align-items:center;gap:.65rem;font-size:13px}
.dot{width:9px;height:9px;border-radius:50%;background:#5DCAA5;display:inline-block;transition:background .3s}
.cd{font-size:12px;opacity:.85}
.btn{background:rgba(255,255,255,.12);border:none;color:#fff;padding:6px 12px;border-radius:6px;font-family:inherit;font-size:12px;cursor:pointer;transition:background .15s;font-weight:500}
.btn:hover{background:rgba(255,255,255,.22)}
.btn.on{background:#fff;color:#2E8BC4}
.wrap{max-width:1280px;margin:0 auto;padding:1.25rem}
.slabel{font-size:11px;font-weight:600;color:#888;text-transform:uppercase;letter-spacing:.06em;margin:0 0 .65rem}
.trow{display:grid;grid-template-columns:repeat(auto-fit,minmax(210px,1fr));gap:10px;margin-bottom:1.25rem}
.tc{background:#fff;border:0.5px solid #e5e5e4;border-radius:12px;padding:14px 16px;cursor:pointer;transition:transform .12s,box-shadow .12s}
.tc:hover{transform:translateY(-1px);box-shadow:0 2px 8px rgba(0,0,0,.06)}
.th{display:flex;align-items:center;gap:10px;margin-bottom:10px}
.av{width:38px;height:38px;border-radius:50%;display:flex;align-items:center;justify-content:center;font-size:13px;font-weight:600;flex-shrink:0}
.tn{font-size:14px;font-weight:600;color:#1c1c1b;line-height:1.1}
.ts{font-size:11px;color:#888;margin-top:1px}
.pill{display:inline-block;font-size:11px;font-weight:600;padding:3px 10px;border-radius:12px;margin-bottom:6px;text-transform:uppercase;letter-spacing:.04em}
.p-idle{background:#f0f0ef;color:#777}
.p-omw{background:#FFE9D6;color:#C2410C}
.p-started{background:#E0F2FE;color:#0369A1}
.p-finished{background:#DCFCE7;color:#166534}
.td{font-size:12px;color:#444;line-height:1.4;min-height:32px}
.tt{font-size:11px;color:#999;margin-top:4px}
.stats{display:grid;grid-template-columns:repeat(auto-fit,minmax(110px,1fr));gap:8px;margin-bottom:1.25rem}
.stat{background:#fff;border:0.5px solid #e5e5e4;border-radius:10px;padding:10px 14px;text-align:center}
.sn{font-size:20px;font-weight:600;color:#1c1c1b}
.sl{font-size:11px;color:#777;margin-top:2px;text-transform:uppercase;letter-spacing:.04em}
.controls{display:flex;justify-content:space-between;align-items:center;margin-bottom:.85rem;gap:.5rem;flex-wrap:wrap}
.filters{display:flex;flex-wrap:wrap;gap:5px}
.fb{background:#fff;border:0.5px solid #d4d4d3;color:#444;padding:5px 11px;border-radius:14px;font-family:inherit;font-size:11px;cursor:pointer;font-weight:500}
.fb.on{background:#2E8BC4;color:#fff;border-color:#2E8BC4}
.tb{background:#fff;border:0.5px solid #d4d4d3;color:#444;padding:5px 11px;border-radius:14px;font-family:inherit;font-size:11px;cursor:pointer;font-weight:500}
.tb.on{background:#F05A1A;color:#fff;border-color:#F05A1A}
.ev{background:#fff;border:0.5px solid #e5e5e4;border-radius:10px;padding:11px 14px;margin-bottom:6px;display:grid;grid-template-columns:auto 1fr auto;gap:12px;align-items:flex-start;cursor:pointer;transition:background .12s}
.ev:hover{background:#fafafa}
.ev-c{min-width:0}
.ev-t{font-size:13px;font-weight:600;color:#1c1c1b;margin-bottom:2px}
.ev-d{font-size:12px;color:#666;line-height:1.4}
.ev-n{font-size:11px;color:#888;margin-top:4px;font-style:italic;line-height:1.4;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden}
.ev-time{font-size:11px;color:#999;white-space:nowrap;flex-shrink:0;text-align:right}
.badge{font-size:11px;font-weight:600;padding:3px 9px;border-radius:99px;white-space:nowrap;flex-shrink:0;margin-top:1px}
.bj{background:#dbeafe;color:#1e40af}
.bi{background:#dcfce7;color:#166534}
.bc{background:#ede9fe;color:#5b21b6}
.be{background:#fef3c7;color:#92400e}
.ba{background:#ffe4e6;color:#9f1239}
.bp{background:#d1fae5;color:#065f46}
.bl{background:#fef9c3;color:#854d0e}
.bx{background:#f5f5f4;color:#78716c}
.err{background:#FEE2E2;color:#991B1B;padding:14px;border-radius:8px;font-size:13px;text-align:center}
.spanel{background:#fff;border:0.5px solid #e5e5e4;border-radius:12px;padding:16px 20px;margin-bottom:1.25rem;display:none}
.spanel.show{display:block}
.spanel-h{font-size:14px;font-weight:600;margin-bottom:12px;color:#1c1c1b;display:flex;align-items:center;justify-content:space-between}
.spanel-grp{margin-bottom:14px}
.spanel-gl{font-size:10px;font-weight:600;color:#888;text-transform:uppercase;letter-spacing:.06em;margin-bottom:6px}
.srow{display:grid;grid-template-columns:auto 1fr auto auto;gap:10px;align-items:center;padding:7px 0;border-bottom:0.5px solid #f0f0ef}
.srow:last-child{border-bottom:none}
.dot-pri{width:8px;height:8px;border-radius:50%}
.sname{font-size:13px;color:#333}
.test-btn{background:#f5f5f4;border:0.5px solid #d4d4d3;border-radius:6px;width:26px;height:26px;cursor:pointer;display:flex;align-items:center;justify-content:center;font-size:11px;color:#666;padding:0}
.test-btn:hover{background:#e8e8e7}
.switch{position:relative;display:inline-block;width:38px;height:22px;cursor:pointer}
.switch input{opacity:0;width:0;height:0}
.slider{position:absolute;top:0;left:0;right:0;bottom:0;background:#ccc;border-radius:22px;transition:.2s}
.slider:before{position:absolute;content:"";height:16px;width:16px;left:3px;bottom:3px;background:#fff;border-radius:50%;transition:.2s}
input:checked+.slider{background:#5DCAA5}
input:checked+.slider:before{transform:translateX(16px)}
.mbg{position:fixed;top:0;left:0;right:0;bottom:0;background:rgba(0,0,0,.5);display:none;align-items:flex-start;justify-content:center;z-index:100;padding:5vh 1rem;overflow-y:auto}
.mbg.show{display:flex}
.modal{background:#fff;border-radius:14px;max-width:560px;width:100%;max-height:85vh;display:flex;flex-direction:column;box-shadow:0 10px 40px rgba(0,0,0,.2)}
.mhead{padding:16px 20px;border-bottom:0.5px solid #e5e5e4;display:flex;align-items:center;justify-content:space-between;gap:10px;flex-shrink:0}
.mtitle{font-size:15px;font-weight:600;color:#1c1c1b;display:flex;align-items:center;gap:9px}
.mclose{background:none;border:none;font-size:22px;color:#888;cursor:pointer;padding:0;width:30px;height:30px;display:flex;align-items:center;justify-content:center;border-radius:50%}
.mclose:hover{background:#f0f0ef;color:#333}
.mbody{padding:16px 20px;overflow-y:auto;flex:1}
.mrow{display:flex;justify-content:space-between;padding:8px 0;border-bottom:0.5px solid #f0f0ef;gap:12px;font-size:13px}
.mrow:last-child{border-bottom:none}
.ml{color:#777;flex-shrink:0;font-weight:500;text-transform:uppercase;letter-spacing:.04em;font-size:11px;align-self:center}
.mv{color:#1c1c1b;text-align:right;word-break:break-word;font-weight:500}
.msec{margin-top:14px}
.msec-h{font-size:11px;font-weight:600;color:#888;text-transform:uppercase;letter-spacing:.06em;margin-bottom:8px}
.mnote{background:#fafaf9;border-left:3px solid #2E8BC4;padding:10px 14px;border-radius:6px;font-size:13px;color:#333;line-height:1.5;white-space:pre-wrap;margin-bottom:6px}
.mtl{position:relative;padding-left:20px}
.mtl::before{content:"";position:absolute;left:6px;top:8px;bottom:8px;width:2px;background:#e5e5e4}
.mtli{position:relative;padding:8px 0;font-size:13px}
.mtli::before{content:"";position:absolute;left:-18px;top:14px;width:10px;height:10px;border-radius:50%;background:#fff;border:2px solid #2E8BC4}
.mtli-t{font-size:11px;color:#888;margin-bottom:2px}
.mtli-d{color:#333}
.mbig-sub{font-size:12px;color:#777;text-align:center;margin-bottom:14px}
</style>
</head>
<body>
<div class="bar">
  <div class="bar-l"><span>HouseCall Pro Dispatch</span><span class="ver">v2.5</span></div>
  <div class="bar-r">
    <span class="dot" id="dot"></span>
    <span class="cd" id="cd">Refresh in 60s</span>
    <button class="btn" id="settings-btn" onclick="togSettings()">Alerts</button>
    <button class="btn" id="mute-btn" onclick="togMute()">On</button>
  </div>
</div>
<div class="wrap">
<div class="spanel" id="spanel">
  <div class="spanel-h"><span>Alert Settings</span><span style="font-size:11px;color:#888;font-weight:400">Saved per device</span></div>
  <div class="spanel-grp"><div class="spanel-gl">High priority - pay attention now</div><div id="srows-high"></div></div>
  <div class="spanel-grp"><div class="spanel-gl">Medium - work in motion</div><div id="srows-med"></div></div>
  <div class="spanel-grp"><div class="spanel-gl">Low - money and leads</div><div id="srows-low"></div></div>
</div>
<div class="slabel">Field staff</div>
<div class="trow">
  <div class="tc" id="tc-tech1" onclick="showTech('tech1')">
    <div class="th"><div class="av" style="background:#e0f2f1;color:#00695c">KM</div><div><div class="tn">Technician One</div><div class="ts">Installer</div></div></div>
    <div class="pill p-idle" id="pill-tech1">Idle</div>
    <div class="td" id="det-tech1">No recent activity</div>
    <div class="tt" id="tim-tech1"></div>
  </div>
  <div class="tc" id="tc-tech2" onclick="showTech('tech2')">
    <div class="th"><div class="av" style="background:#e0f2f1;color:#00695c">MM</div><div><div class="tn">Technician Two</div><div class="ts">Installer</div></div></div>
    <div class="pill p-idle" id="pill-tech2">Idle</div>
    <div class="td" id="det-tech2">No recent activity</div>
    <div class="tt" id="tim-tech2"></div>
  </div>
  <div class="tc" id="tc-tech3" onclick="showTech('tech3')">
    <div class="th"><div class="av" style="background:#e8f5e9;color:#2e7d32">CS</div><div><div class="tn">Technician Three</div><div class="ts">Technician</div></div></div>
    <div class="pill p-idle" id="pill-tech3">Idle</div>
    <div class="td" id="det-tech3">No recent activity</div>
    <div class="tt" id="tim-tech3"></div>
  </div>
  <div class="tc" id="tc-tech4" onclick="showTech('tech4')">
    <div class="th"><div class="av" style="background:#fce4ec;color:#880d4f">CS</div><div><div class="tn">Technician Four</div><div class="ts">Comfort Advisor</div></div></div>
    <div class="pill p-idle" id="pill-tech4">Idle</div>
    <div class="td" id="det-tech4">No recent activity</div>
    <div class="tt" id="tim-tech4"></div>
  </div>
  <div class="tc" id="tc-tech5" onclick="showTech('tech5')">
    <div class="th"><div class="av" style="background:#fff3e0;color:#e65100">KR</div><div><div class="tn">Technician Five</div><div class="ts">Owner</div></div></div>
    <div class="pill p-idle" id="pill-tech5">Idle</div>
    <div class="td" id="det-tech5">No recent activity</div>
    <div class="tt" id="tim-tech5"></div>
  </div>
</div>
<div class="stats">
  <div class="stat"><div class="sn" id="s0">-</div><div class="sl">Events today</div></div>
  <div class="stat"><div class="sn" id="s1">-</div><div class="sl">Jobs</div></div>
  <div class="stat"><div class="sn" id="s2">-</div><div class="sl">Invoices</div></div>
  <div class="stat"><div class="sn" id="s3">-</div><div class="sl">New customers</div></div>
</div>
<div class="controls">
  <div class="filters">
    <button class="fb on" onclick="setF('all',this)">All</button>
    <button class="fb" onclick="setF('job',this)">Jobs</button>
    <button class="fb" onclick="setF('invoice',this)">Invoices</button>
    <button class="fb" onclick="setF('customer',this)">Customers</button>
    <button class="fb" onclick="setF('estimate',this)">Estimates</button>
    <button class="fb" onclick="setF('lead',this)">Leads</button>
    <button class="fb" onclick="setF('appointment',this)">Appts</button>
  </div>
  <button class="tb on" id="tdb" onclick="togToday()">Today only</button>
</div>
<div id="feed"></div>
</div>
<div class="mbg" id="mbg" onclick="if(event.target===this)closeM()">
  <div class="modal">
    <div class="mhead"><div class="mtitle" id="mtitle"></div><button class="mclose" onclick="closeM()">x</button></div>
    <div class="mbody" id="mbody"></div>
  </div>
</div>
<script>
var W='/activity?limit=50';
var POLL_INTERVAL=60;
var TIDS={'pro_REPLACE_ME_TECH1':'tech1','pro_REPLACE_ME_TECH2':'tech2','pro_REPLACE_ME_TECH3':'tech3','pro_REPLACE_ME_TECH4':'tech4','pro_REPLACE_ME_TECH5':'tech5'};
var TINFO={tech1:{name:'Technician One',role:'Installer',bg:'#e0f2f1',color:'#00695c',init:'KM'},tech2:{name:'Technician Two',role:'Installer',bg:'#e0f2f1',color:'#00695c',init:'MM'},tech3:{name:'Technician Three',role:'Technician',bg:'#e8f5e9',color:'#2e7d32',init:'CS'},tech4:{name:'Technician Four',role:'Comfort Advisor',bg:'#fce4ec',color:'#880d4f',init:'CS'},tech5:{name:'Technician Five',role:'Owner',bg:'#fff3e0',color:'#e65100',init:'KR'}};
var TECH_ORDER=['tech1','tech2','tech3','tech4','tech5'];
var EMAP={
  'job.on_my_way':{key:'omw',pri:'high',label:'On the way'},
  'job.canceled':{key:'canceled',pri:'high',label:'Canceled'},
  'job.appointment.rescheduled':{key:'rescheduled',pri:'high',label:'Rescheduled'},
  'job.started':{key:'started',pri:'medium',label:'Started'},
  'job.completed':{key:'completed',pri:'medium',label:'Completed'},
  'job.scheduled':{key:'scheduled',pri:'medium',label:'Scheduled'},
  'job.appointment.appointment_pros_assigned':{key:'pros_assigned',pri:'medium',label:'Pros assigned'},
  'invoice.paid':{key:'invoice_paid',pri:'low',label:'Invoice paid'},
  'estimate.approved':{key:'estimate_approved',pri:'low',label:'Estimate approved'},
  'lead.created':{key:'lead_created',pri:'low',label:'Lead created'},
  'lead.converted':{key:'lead_converted',pri:'low',label:'Lead converted'},
  'job.created':{key:'job_created',pri:'low',label:'Job created'},
  'lead.lost':{key:'lead_lost',pri:'low',label:'Lead lost',silent:true},
  'job.appointment.scheduled':{key:'appt_scheduled',pri:'medium',label:'Appointment set',silent:true},
  'invoice.created':{key:'invoice_created',pri:'low',label:'Invoice created',silent:true},
  'invoice.canceled':{key:'invoice_canceled',pri:'low',label:'Invoice canceled',silent:true},
  'invoice.payment.succeeded':{key:'invoice_payment_succeeded',pri:'low',label:'Payment received',silent:true},
  'customer.created':{key:'customer_created',pri:'low',label:'New customer',silent:true},
  'customer.updated':{key:'customer_updated',pri:'low',label:'Customer updated',silent:true},
  'job.updated':{key:'job_updated',pri:'low',label:'Job updated',silent:true}
};
var SDEFAULTS={omw:1,canceled:1,rescheduled:1,started:1,completed:1,scheduled:1,pros_assigned:1,invoice_paid:1,estimate_approved:1,lead_created:1,lead_converted:1,job_created:0};

function getS(k){var v=localStorage.getItem('alert_'+k);return v===null?!!SDEFAULTS[k]:v==='1';}
function setS(k,v){localStorage.setItem('alert_'+k,v?'1':'0');}
var muted=localStorage.getItem('alert_master_mute')==='1';

function togMute(){muted=!muted;localStorage.setItem('alert_master_mute',muted?'1':'0');var b=document.getElementById('mute-btn');b.textContent=muted?'Muted':'On';b.classList.toggle('on',!muted);}
function togSettings(){document.getElementById('spanel').classList.toggle('show');}

var actx=null;
function ac(){if(!actx)actx=new (window.AudioContext||window.webkitAudioContext)();return actx;}

function cleanTone(freq,dur,delay,gain,wave){
  var c=ac(),t0=c.currentTime+(delay||0);
  var o=c.createOscillator(),g=c.createGain();
  o.type=wave||'sine';o.frequency.value=freq;
  g.gain.setValueAtTime(0,t0);
  g.gain.linearRampToValueAtTime(gain||0.18,t0+0.01);
  g.gain.exponentialRampToValueAtTime(0.0001,t0+dur);
  o.connect(g);g.connect(c.destination);
  o.start(t0);o.stop(t0+dur);
}

function bellTone(freq,dur,delay,gain){
  var c=ac(),t0=c.currentTime+(delay||0);
  var carrier=c.createOscillator(),mod=c.createOscillator(),modGain=c.createGain(),g=c.createGain();
  carrier.frequency.value=freq;
  mod.frequency.value=freq*3.51;
  modGain.gain.value=freq*1.5;
  mod.connect(modGain);modGain.connect(carrier.frequency);
  carrier.connect(g);g.connect(c.destination);
  g.gain.setValueAtTime(0,t0);
  g.gain.linearRampToValueAtTime(gain||0.22,t0+0.005);
  g.gain.exponentialRampToValueAtTime(0.0001,t0+dur);
  carrier.start(t0);mod.start(t0);
  carrier.stop(t0+dur);mod.stop(t0+dur);
}

function noiseBurst(gain,dur,delay,hpFreq){
  var c=ac(),t0=c.currentTime+(delay||0);
  var bufferSize=Math.floor(c.sampleRate*dur);
  var buffer=c.createBuffer(1,bufferSize,c.sampleRate);
  var data=buffer.getChannelData(0);
  for(var i=0;i<bufferSize;i++)data[i]=Math.random()*2-1;
  var src=c.createBufferSource();src.buffer=buffer;
  var filter=c.createBiquadFilter();filter.type='highpass';filter.frequency.value=hpFreq||3000;
  var g=c.createGain();
  g.gain.setValueAtTime(gain||0.15,t0);
  g.gain.exponentialRampToValueAtTime(0.001,t0+dur);
  src.connect(filter);filter.connect(g);g.connect(c.destination);
  src.start(t0);src.stop(t0+dur);
}

function vibratoTone(freq,dur,delay,vibRate,vibDepth,gain){
  var c=ac(),t0=c.currentTime+(delay||0);
  var o=c.createOscillator(),lfo=c.createOscillator(),lfoG=c.createGain(),g=c.createGain();
  o.type='triangle';o.frequency.value=freq;
  lfo.frequency.value=vibRate||6;lfoG.gain.value=vibDepth||8;
  lfo.connect(lfoG);lfoG.connect(o.frequency);
  o.connect(g);g.connect(c.destination);
  g.gain.setValueAtTime(0,t0);
  g.gain.linearRampToValueAtTime(gain||0.18,t0+0.02);
  g.gain.exponentialRampToValueAtTime(0.001,t0+dur);
  o.start(t0);lfo.start(t0);
  o.stop(t0+dur);lfo.stop(t0+dur);
}

function honk(freq,dur,delay,gain){
  var c=ac(),t0=c.currentTime+(delay||0);
  var o=c.createOscillator(),g=c.createGain();
  o.type='square';o.frequency.value=freq;
  g.gain.setValueAtTime(0,t0);
  g.gain.linearRampToValueAtTime(gain||0.13,t0+0.005);
  g.gain.setValueAtTime(gain||0.13,t0+dur-0.02);
  g.gain.exponentialRampToValueAtTime(0.001,t0+dur);
  o.connect(g);g.connect(c.destination);
  o.start(t0);o.stop(t0+dur);
}

function sweepTone(f1,f2,dur,delay,gain){
  var c=ac(),t0=c.currentTime+(delay||0);
  var o=c.createOscillator(),g=c.createGain();
  o.type='sine';
  o.frequency.setValueAtTime(f1,t0);
  o.frequency.exponentialRampToValueAtTime(f2,t0+dur);
  g.gain.setValueAtTime(0,t0);
  g.gain.linearRampToValueAtTime(gain||0.2,t0+0.01);
  g.gain.exponentialRampToValueAtTime(0.0001,t0+dur);
  o.connect(g);g.connect(c.destination);
  o.start(t0);o.stop(t0+dur);
}

function play(key,force){
  if(!force&&(muted||!getS(key)))return;
  if(key==='omw'){honk(440,0.13,0,0.13);honk(440,0.13,0.20,0.13);}
  else if(key==='canceled'){vibratoTone(523.25,0.22,0,5,10,0.18);vibratoTone(440.00,0.22,0.20,5,10,0.17);vibratoTone(329.63,0.50,0.40,5,12,0.18);}
  else if(key==='rescheduled'){cleanTone(523.25,0.06,0,0.16);cleanTone(587.33,0.06,0.07,0.16);cleanTone(659.25,0.06,0.14,0.16);cleanTone(698.46,0.18,0.21,0.16);}
  else if(key==='started'){cleanTone(440,0.14,0,0.18);cleanTone(659.25,0.30,0.10,0.20);}
  else if(key==='completed'){cleanTone(523.25,0.10,0,0.20);cleanTone(659.25,0.10,0.10,0.20);cleanTone(783.99,0.40,0.20,0.24);bellTone(1567.98,0.35,0.22,0.10);}
  else if(key==='scheduled'){noiseBurst(0.05,0.025,0,4000);cleanTone(880,0.18,0.04,0.13);}
  else if(key==='pros_assigned'){sweepTone(180,90,0.18,0,0.30);}
  else if(key==='invoice_paid'){noiseBurst(0.08,0.08,0,4000);bellTone(2400,0.55,0,0.22);bellTone(3200,0.45,0.02,0.16);bellTone(1800,0.50,0.04,0.14);setTimeout(function(){noiseBurst(0.06,0.06,0,4500);bellTone(2800,0.55,0,0.22);bellTone(3600,0.45,0.02,0.16);bellTone(2200,0.50,0.04,0.14);},120);}
  else if(key==='estimate_approved'){cleanTone(659.25,0.08,0,0.20);cleanTone(783.99,0.08,0.08,0.20);cleanTone(1046.50,0.30,0.16,0.25);bellTone(2093,0.30,0.18,0.10);}
  else if(key==='lead_created'){for(var i=0;i<3;i++){cleanTone(880,0.05,i*0.10,0.15);cleanTone(1100,0.05,i*0.10+0.05,0.15);}}
  else if(key==='lead_converted'){cleanTone(523.25,0.05,0,0.18);cleanTone(659.25,0.05,0.06,0.18);cleanTone(783.99,0.05,0.12,0.18);cleanTone(1046.50,0.05,0.18,0.18);cleanTone(1318.51,0.30,0.24,0.22);bellTone(2637,0.25,0.26,0.10);}
  else if(key==='job_created'){noiseBurst(0.18,0.025,0,5000);}
}

function badgeCat(et){
  if(!et)return 'bx';
  if(et.indexOf('appointment')>=0)return 'ba';
  if(et.indexOf('payment')>=0)return 'bp';
  if(et.indexOf('job')===0)return 'bj';
  if(et.indexOf('invoice')===0)return 'bi';
  if(et.indexOf('customer')===0)return 'bc';
  if(et.indexOf('estimate')===0)return 'be';
  if(et.indexOf('lead')===0)return 'bl';
  return 'bx';
}
function prettyLabel(et){
  if(EMAP[et])return EMAP[et].label;
  if(!et)return 'Event';
  var s=et.replace(/_/g,' ').replace(/\\./g,' ');
  return s.charAt(0).toUpperCase()+s.slice(1);
}

function buildSettings(){
  var groups={high:[],medium:[],low:[]};
  var seenKeys={};
  for(var et in EMAP){var info=EMAP[et];if(info.silent)continue;if(!seenKeys[info.key]){seenKeys[info.key]=1;groups[info.pri].push({key:info.key,label:info.label});}}
  function renderRow(e,priColor){
    return '<div class="srow"><span class="dot-pri" style="background:'+priColor+'"></span><span class="sname">'+e.label+'</span><button class="test-btn" onclick="play(\\''+e.key+'\\',true)" title="Test">&#9658;</button><label class="switch"><input type="checkbox" data-key="'+e.key+'" '+(getS(e.key)?'checked':'')+' onchange="setS(this.dataset.key,this.checked)"><span class="slider"></span></label></div>';
  }
  var hHTML='',mHTML='',lHTML='';
  for(var i=0;i<groups.high.length;i++)hHTML+=renderRow(groups.high[i],'#E24B4A');
  for(var i=0;i<groups.medium.length;i++)mHTML+=renderRow(groups.medium[i],'#F59E0B');
  for(var i=0;i<groups.low.length;i++)lHTML+=renderRow(groups.low[i],'#10B981');
  document.getElementById('srows-high').innerHTML=hHTML;
  document.getElementById('srows-med').innerHTML=mHTML;
  document.getElementById('srows-low').innerHTML=lHTML;
}

function pl(e){return e.payload||{};}
function fmtMoney(cents){if(cents==null)return '';return '$'+(cents/100).toLocaleString('en-US',{minimumFractionDigits:2,maximumFractionDigits:2});}
function custName(e){
  var p=pl(e);
  if(p.lead&&p.lead.customer){var c=p.lead.customer;return((c.first_name||'')+' '+(c.last_name||'')).trim();}
  if(p.invoice&&p.invoice.customer){var c=p.invoice.customer;return((c.first_name||'')+' '+(c.last_name||'')).trim();}
  if(p.estimate&&p.estimate.customer){var c=p.estimate.customer;return((c.first_name||'')+' '+(c.last_name||'')).trim();}
  if(p.customer){var c=p.customer;if(c.first_name||c.last_name)return((c.first_name||'')+' '+(c.last_name||'')).trim();}
  if(p.job&&p.job.customer){var c=p.job.customer;return((c.first_name||'')+' '+(c.last_name||'')).trim();}
  if(p.customer_name)return p.customer_name;
  if(p.name)return p.name;
  return '';
}
function custAddr(e){
  var p=pl(e);
  var a=p.address||(p.lead&&p.lead.address)||(p.invoice&&p.invoice.address)||(p.estimate&&p.estimate.address)||p.service_address||(p.job&&p.job.address)||(p.customer&&p.customer.addresses&&p.customer.addresses[0])||{};
  var parts=[];if(a.street)parts.push(a.street);if(a.city)parts.push(a.city);if(a.state)parts.push(a.state);if(a.zip)parts.push(a.zip);
  return parts.join(', ');
}
function jobDesc(e){var p=pl(e);if(p.job&&p.job.description)return p.job.description;if(p.invoice&&p.invoice.description)return p.invoice.description;return p.description||p.work_description||p.note||'';}
function notesOf(e){var p=pl(e);var src=p.notes||(p.job&&p.job.notes)||null;if(src&&typeof src==='object'&&src.length){var out=[];for(var i=0;i<src.length;i++){var n=src[i];var t=typeof n==='string'?n:(n.content||n.text||n.body||'');if(t)out.push(t);}return out;}if(typeof src==='string')return [src];if(p.note)return [p.note];return [];}
function schedTime(e){var p=pl(e);if(p.appointment&&p.appointment.start_time)return p.appointment.start_time;if(p.job&&p.job.schedule&&p.job.schedule.scheduled_start)return p.job.schedule.scheduled_start;var s=p.schedule||{};return s.scheduled_start||p.scheduled_start||null;}
function techIdsOf(e){var p=pl(e);if(p.assigned_employee_ids&&p.assigned_employee_ids.length)return p.assigned_employee_ids;if(p.employee_ids&&p.employee_ids.length)return p.employee_ids;if(p.job&&p.job.assigned_employees){var out=[];for(var i=0;i<p.job.assigned_employees.length;i++){if(p.job.assigned_employees[i].id)out.push(p.job.assigned_employees[i].id);}return out;}if(p.appointment&&p.appointment.dispatched_employees){var out=[];for(var i=0;i<p.appointment.dispatched_employees.length;i++){if(p.appointment.dispatched_employees[i].id)out.push(p.appointment.dispatched_employees[i].id);}return out;}return [];}
function techNameFromId(id){var k=TIDS[id];return k?TINFO[k].name:null;}
function fmtTime(ts){var d=new Date(ts),now=new Date();if(d.toDateString()===now.toDateString())return d.toLocaleTimeString('en-US',{hour:'numeric',minute:'2-digit'});return d.toLocaleString('en-US',{month:'short',day:'numeric',hour:'numeric',minute:'2-digit'});}
function fmtDateTime(s){if(!s)return '';try{return new Date(s).toLocaleString('en-US',{month:'short',day:'numeric',hour:'numeric',minute:'2-digit'});}catch(e){return s;}}
function ago(ts){var d=Math.floor((Date.now()-ts)/1000);if(d<60)return d+'s ago';if(d<3600)return Math.floor(d/60)+'m ago';if(d<86400)return Math.floor(d/3600)+'h ago';return Math.floor(d/86400)+'d ago';}
function isToday(ts){var t=new Date().setHours(0,0,0,0);return ts>=t;}
function esc(s){return String(s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#39;');}

function statusFor(techKey,events){
  var tid=null;for(var id in TIDS){if(TIDS[id]===techKey){tid=id;break;}}
  if(!tid)return null;
  var today=[];
  for(var i=0;i<events.length;i++){var e=events[i];if(!isToday(e.ts))continue;var ids=techIdsOf(e);if(ids.indexOf(tid)>=0)today.push(e);}
  today.sort(function(a,b){return b.ts-a.ts;});
  if(!today.length)return {status:'idle',label:'Idle',detail:'No activity today',ts:null};
  for(var i=0;i<today.length;i++){
    var e=today[i];var p=pl(e);var job=p.job;if(!job)continue;
    var ts=job.work_timestamps||{};var custN=custName(e)||'job';
    if(ts.completed_at){return {status:'finished',label:'Finished',detail:'Last: '+custN,ts:new Date(ts.completed_at).getTime()};}
    if(ts.started_at){return {status:'started',label:'Started',detail:'Working: '+custN,ts:new Date(ts.started_at).getTime()};}
    if(ts.on_my_way_at){return {status:'omw',label:'OMW',detail:'On the way to '+custN,ts:new Date(ts.on_my_way_at).getTime()};}
  }
  return {status:'idle',label:'Idle',detail:'Assigned, not yet started',ts:today[0].ts};
}

function renderTechs(events){
  for(var i=0;i<TECH_ORDER.length;i++){
    var tk=TECH_ORDER[i],s=statusFor(tk,events);
    var pill=document.getElementById('pill-'+tk);
    var det=document.getElementById('det-'+tk);
    var tim=document.getElementById('tim-'+tk);
    if(!pill)continue;
    pill.className='pill p-'+(s&&s.status?s.status:'idle');
    pill.textContent=s&&s.label?s.label:'Idle';
    det.textContent=s&&s.detail?s.detail:'No recent activity';
    tim.textContent=s&&s.ts?ago(s.ts):'';
  }
}

function renderStats(events){
  var tEv=[],j=0,inv=0,cust=0;
  for(var i=0;i<events.length;i++){var e=events[i];if(!isToday(e.ts))continue;tEv.push(e);var et=e.event_type||'';if(et.indexOf('job.')===0||et.indexOf('appointment.')===0)j++;else if(et.indexOf('invoice.')===0)inv++;if(et==='customer.created')cust++;}
  document.getElementById('s0').textContent=tEv.length;
  document.getElementById('s1').textContent=j;
  document.getElementById('s2').textContent=inv;
  document.getElementById('s3').textContent=cust;
}

var curF='all',todayOnly=true,allEv=[],feedEvs=[];
function setF(f,btn){curF=f;var btns=document.querySelectorAll('.fb');for(var i=0;i<btns.length;i++)btns[i].classList.remove('on');btn.classList.add('on');renderFeed();}
function togToday(){todayOnly=!todayOnly;document.getElementById('tdb').classList.toggle('on',todayOnly);renderFeed();}

function renderFeed(){
  var feed=document.getElementById('feed');
  var evs=[];
  for(var i=0;i<allEv.length;i++){
    var e=allEv[i];
    if(todayOnly&&!isToday(e.ts))continue;
    if(curF!=='all'){
      var et=e.event_type||'';
      if(curF==='appointment'){if(et.indexOf('appointment')<0)continue;}
      else{if(et.indexOf(curF)!==0)continue;}
    }
    evs.push(e);
  }
  feedEvs=evs;
  if(!evs.length){feed.innerHTML='<div style="text-align:center;padding:2rem;color:#888;font-size:13px">No events match filters</div>';return;}
  var html='';
  for(var i=0;i<evs.length;i++){
    var e=evs[i];
    var cust=custName(e),addr=custAddr(e);
    var p=pl(e);
    var detParts=[];
    if(addr)detParts.push(addr);
    var jd=jobDesc(e);
    if(jd&&jd.length<80)detParts.push(jd);
    if(p.invoice&&p.invoice.total_amount!=null)detParts.push(fmtMoney(p.invoice.total_amount));
    if(p.lead&&p.lead.lead_source)detParts.push('Source: '+p.lead.lead_source);
    if(p.lead&&p.lead.pipeline_status)detParts.push('Stage: '+p.lead.pipeline_status);
    var det=detParts.join(' · ');
    var notes=notesOf(e);
    var noteSnippet=notes.length?notes[notes.length-1]:'';
    var noteEvents=['job.canceled','job.scheduled','job.created','job.appointment.rescheduled'];
    var showNote=noteEvents.indexOf(e.event_type)>=0&&noteSnippet;
    html+='<div class="ev" onclick="showEvent('+i+')">'+
      '<span class="badge '+badgeCat(e.event_type)+'">'+esc(prettyLabel(e.event_type))+'</span>'+
      '<div class="ev-c">'+
        (cust?'<div class="ev-t">'+esc(cust)+'</div>':'<div class="ev-t" style="color:#999">No customer</div>')+
        (det?'<div class="ev-d">'+esc(det)+'</div>':'')+
        (showNote?'<div class="ev-n">note: '+esc(noteSnippet)+'</div>':'')+
      '</div>'+
      '<div class="ev-time">'+fmtTime(e.ts)+'</div>'+
    '</div>';
  }
  feed.innerHTML=html;
}

function showEvent(i){
  var e=feedEvs[i];if(!e)return;
  var p=pl(e);
  var tids=techIdsOf(e);
  var techNamesArr=[];for(var j=0;j<tids.length;j++){var n=techNameFromId(tids[j]);if(n)techNamesArr.push(n);}
  var techNames=techNamesArr.length?techNamesArr.join(', '):'';
  var sched=schedTime(e);
  var notes=notesOf(e);
  document.getElementById('mtitle').innerHTML='<span class="badge '+badgeCat(e.event_type)+'">'+esc(prettyLabel(e.event_type))+'</span>';
  var body='';
  var name=custName(e);
  body+='<div class="mrow"><span class="ml">Customer</span><span class="mv">'+(esc(name)||'-')+'</span></div>';
  if(custAddr(e))body+='<div class="mrow"><span class="ml">Address</span><span class="mv">'+esc(custAddr(e))+'</span></div>';
  if(jobDesc(e))body+='<div class="mrow"><span class="ml">Description</span><span class="mv">'+esc(jobDesc(e))+'</span></div>';
  if(sched)body+='<div class="mrow"><span class="ml">Scheduled</span><span class="mv">'+fmtDateTime(sched)+'</span></div>';
  if(techNames)body+='<div class="mrow"><span class="ml">Tech(s)</span><span class="mv">'+esc(techNames)+'</span></div>';
  if(p.invoice){
    if(p.invoice.invoice_number)body+='<div class="mrow"><span class="ml">Invoice #</span><span class="mv">'+esc(p.invoice.invoice_number)+'</span></div>';
    if(p.invoice.status)body+='<div class="mrow"><span class="ml">Status</span><span class="mv">'+esc(p.invoice.status)+'</span></div>';
    if(p.invoice.total_amount!=null)body+='<div class="mrow"><span class="ml">Total</span><span class="mv">'+fmtMoney(p.invoice.total_amount)+'</span></div>';
    if(p.invoice.amount_paid!=null)body+='<div class="mrow"><span class="ml">Paid</span><span class="mv">'+fmtMoney(p.invoice.amount_paid)+'</span></div>';
    if(p.invoice.outstanding_balance!=null)body+='<div class="mrow"><span class="ml">Outstanding</span><span class="mv">'+fmtMoney(p.invoice.outstanding_balance)+'</span></div>';
    if(p.invoice.payment_method)body+='<div class="mrow"><span class="ml">Method</span><span class="mv">'+esc(p.invoice.payment_method)+'</span></div>';
    if(p.invoice.paid_at)body+='<div class="mrow"><span class="ml">Paid at</span><span class="mv">'+fmtDateTime(p.invoice.paid_at)+'</span></div>';
    if(p.invoice.due_at)body+='<div class="mrow"><span class="ml">Due at</span><span class="mv">'+fmtDateTime(p.invoice.due_at)+'</span></div>';
  }
  if(p.lead){
    if(p.lead.lead_source)body+='<div class="mrow"><span class="ml">Source</span><span class="mv">'+esc(p.lead.lead_source)+'</span></div>';
    if(p.lead.pipeline_status)body+='<div class="mrow"><span class="ml">Pipeline</span><span class="mv">'+esc(p.lead.pipeline_status)+'</span></div>';
    if(p.lead.status)body+='<div class="mrow"><span class="ml">Status</span><span class="mv">'+esc(p.lead.status)+'</span></div>';
    if(p.lead.customer&&p.lead.customer.mobile_number)body+='<div class="mrow"><span class="ml">Phone</span><span class="mv">'+esc(p.lead.customer.mobile_number)+'</span></div>';
    if(p.lead.total_amount!=null&&p.lead.total_amount>0)body+='<div class="mrow"><span class="ml">Value</span><span class="mv">'+fmtMoney(p.lead.total_amount)+'</span></div>';
  }
  if(p.estimate){
    if(p.estimate.estimate_number)body+='<div class="mrow"><span class="ml">Estimate #</span><span class="mv">'+esc(p.estimate.estimate_number)+'</span></div>';
    if(p.estimate.work_status)body+='<div class="mrow"><span class="ml">Status</span><span class="mv">'+esc(p.estimate.work_status)+'</span></div>';
    if(p.estimate.total_amount!=null)body+='<div class="mrow"><span class="ml">Total</span><span class="mv">'+fmtMoney(p.estimate.total_amount)+'</span></div>';
  }
  if(p.job){
    if(p.job.work_status)body+='<div class="mrow"><span class="ml">Job status</span><span class="mv">'+esc(p.job.work_status)+'</span></div>';
    if(p.job.lead_source)body+='<div class="mrow"><span class="ml">Source</span><span class="mv">'+esc(p.job.lead_source)+'</span></div>';
    if(p.job.total_amount!=null&&p.job.total_amount>0)body+='<div class="mrow"><span class="ml">Job total</span><span class="mv">'+fmtMoney(p.job.total_amount)+'</span></div>';
    if(p.job.invoice_number)body+='<div class="mrow"><span class="ml">Invoice #</span><span class="mv">'+esc(p.job.invoice_number)+'</span></div>';
  }
  if(p.customer&&!p.job&&!p.invoice&&!p.estimate){
    if(p.customer.email)body+='<div class="mrow"><span class="ml">Email</span><span class="mv">'+esc(p.customer.email)+'</span></div>';
    if(p.customer.mobile_number)body+='<div class="mrow"><span class="ml">Phone</span><span class="mv">'+esc(p.customer.mobile_number)+'</span></div>';
    if(p.customer.lead_source)body+='<div class="mrow"><span class="ml">Source</span><span class="mv">'+esc(p.customer.lead_source)+'</span></div>';
    if(p.customer.kind)body+='<div class="mrow"><span class="ml">Type</span><span class="mv">'+esc(p.customer.kind)+'</span></div>';
  }
  body+='<div class="mrow"><span class="ml">Event time</span><span class="mv">'+fmtDateTime(e.received_at||new Date(e.ts).toISOString())+'</span></div>';
  if(notes.length){body+='<div class="msec"><div class="msec-h">Notes</div>';for(var k=0;k<notes.length;k++)body+='<div class="mnote">'+esc(notes[k])+'</div>';body+='</div>';}
  document.getElementById('mbody').innerHTML=body;
  document.getElementById('mbg').classList.add('show');
}

function showTech(tk){
  var info=TINFO[tk];
  var tid=null;for(var id in TIDS){if(TIDS[id]===tk){tid=id;break;}}
  var today=[];
  for(var i=0;i<allEv.length;i++){var e=allEv[i];if(isToday(e.ts)&&techIdsOf(e).indexOf(tid)>=0)today.push(e);}
  today.sort(function(a,b){return b.ts-a.ts;});
  var status=statusFor(tk,allEv);
  document.getElementById('mtitle').innerHTML='<div class="av" style="background:'+info.bg+';color:'+info.color+';width:32px;height:32px;font-size:11px">'+info.init+'</div><div><div>'+esc(info.name)+'</div><div style="font-size:11px;color:#888;font-weight:400;margin-top:1px">'+esc(info.role)+'</div></div>';
  var body='';
  body+='<div class="pill p-'+status.status+'" style="margin:0 auto;display:block;width:fit-content;font-size:13px;padding:6px 16px">'+status.label+'</div>';
  body+='<div class="mbig-sub">'+esc(status.detail)+(status.ts?' / '+ago(status.ts):'')+'</div>';
  if(!today.length){body+='<div style="text-align:center;color:#888;font-size:13px;padding:1rem 0">No events today.</div>';}
  else{
    var byJob={},jobOrder=[];
    for(var i=0;i<today.length;i++){var e=today[i];var p=pl(e);var jid=p.job?p.job.id:('e'+i);if(!byJob[jid]){byJob[jid]=e;jobOrder.push(jid);}}
    body+='<div class="msec"><div class="msec-h">Jobs touched today ('+jobOrder.length+')</div><div class="mtl">';
    for(var i=jobOrder.length-1;i>=0;i--){var e=byJob[jobOrder[i]];var cust=custName(e);var p=pl(e);var ws=p.job&&p.job.work_status?p.job.work_status:'';body+='<div class="mtli"><div class="mtli-t">'+fmtTime(e.ts)+'</div><div class="mtli-d"><strong>'+esc(cust||prettyLabel(e.event_type))+'</strong>'+(ws?' - '+esc(ws):'')+'</div></div>';}
    body+='</div></div>';
    var omwCount=0,startCount=0,compCount=0;
    for(var i=0;i<today.length;i++){var et=today[i].event_type;if(et==='job.on_my_way')omwCount++;if(et==='job.started')startCount++;if(et==='job.completed'||et==='appointment.completed')compCount++;}
    body+='<div class="msec"><div class="msec-h">Totals today</div><div class="mrow"><span class="ml">OMWs</span><span class="mv">'+omwCount+'</span></div><div class="mrow"><span class="ml">Started</span><span class="mv">'+startCount+'</span></div><div class="mrow"><span class="ml">Completed</span><span class="mv">'+compCount+'</span></div><div class="mrow"><span class="ml">Total events</span><span class="mv">'+today.length+'</span></div></div>';
  }
  document.getElementById('mbody').innerHTML=body;
  document.getElementById('mbg').classList.add('show');
}

function closeM(){document.getElementById('mbg').classList.remove('show');}
document.addEventListener('keydown',function(e){if(e.key==='Escape')closeM();});

function reqNotif(){try{if(!('Notification' in window))return;if(Notification.permission==='default')Notification.requestPermission();}catch(e){}}
function notif(e){try{if(!('Notification' in window)||Notification.permission!=='granted')return;var info=EMAP[e.event_type];if(!info||info.silent)return;var n=custName(e);new Notification('HouseCall Pro - '+info.label,{body:n||info.label,tag:e.id});}catch(err){}}

var cd=POLL_INTERVAL,timer=null,seen={};
function resetCd(){if(timer)clearInterval(timer);cd=POLL_INTERVAL;timer=setInterval(function(){cd--;document.getElementById('cd').textContent='Refresh in '+cd+'s';if(cd<=0)load();},1000);}

function load(){
  var dot=document.getElementById('dot');dot.style.background='#FAC775';
  fetch(W).then(function(res){return res.json();}).then(function(data){
    var fresh=(data.events||[]).slice().sort(function(a,b){return b.ts-a.ts;});
    for(var i=0;i<fresh.length;i++){var e=fresh[i];if(!seen[e.id]){seen[e.id]=1;var info=EMAP[e.event_type];if(info&&!info.silent&&isToday(e.ts)){try{play(info.key);}catch(err){}try{notif(e);}catch(err){}}}}
    allEv=fresh;
    try{renderTechs(allEv);}catch(err){console.error('renderTechs',err);}
    try{renderStats(allEv);}catch(err){console.error('renderStats',err);}
    try{renderFeed();}catch(err){console.error('renderFeed',err);}
    dot.style.background='#5DCAA5';
  }).catch(function(err){
    dot.style.background='#f87171';
    var msg=err&&err.message?err.message:'Network error';
    document.getElementById('feed').innerHTML='<div class="err">Could not load: '+esc(msg)+'</div>';
  });
  resetCd();
}

document.addEventListener('visibilitychange',function(){
  if(document.hidden){
    if(timer){clearInterval(timer);timer=null;}
    var cdEl=document.getElementById('cd');if(cdEl)cdEl.textContent='Paused (tab hidden)';
  }else{
    load();
  }
});

buildSettings();
var mb=document.getElementById('mute-btn');
mb.textContent=muted?'Muted':'On';
mb.classList.toggle('on',!muted);
reqNotif();
load();
</script>
</body>
</html>`;
}


export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });
    if (url.pathname === "/mcp") return handleMCP(request, env);
    if (url.pathname === "/webhook") {
      if (request.method === "POST") return handleWebhook(request, env, ctx);
      return new Response("Method not allowed", { status: 405, headers: CORS });
    }
    if (url.pathname === "/activity") {
      if (request.method === "GET") return handleActivity(request, env, ctx);
      return new Response("Method not allowed", { status: 405, headers: CORS });
    }
    if (url.pathname === "/dashboard") {
      return new Response(getDashboardHTML(), { headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-cache, no-store, must-revalidate", "Pragma": "no-cache", "Expires": "0" } });
    }
    return new Response(`HouseCall Pro MCP Worker v3.3.1 — ${TOOLS.length} tools | /mcp | /webhook | /activity | /dashboard`, { status: 200, headers: CORS });
  },
};
