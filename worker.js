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
  { name: "list_customers", description: "List or search customers", inputSchema: { type: "object", properties: { q: { type: "string" }, page: { type: "number" }, page_size: { type: "number" }, sort_direction: { type: "string" }, expand: { type: "string" } } } },
  { name: "get_customer", description: "Get a customer by ID", inputSchema: { type: "object", required: ["customer_id"], properties: { customer_id: { type: "string" }, expand: { type: "string" } } } },
  { name: "create_customer", description: "Create a new customer", inputSchema: { type: "object", required: ["first_name","last_name"], properties: { first_name: { type: "string" }, last_name: { type: "string" }, email: { type: "string" }, mobile_number: { type: "string" }, home_number: { type: "string" }, work_number: { type: "string" }, company: { type: "string" }, notifications_enabled: { type: "boolean" }, lead_source: { type: "string" }, notes: { type: "string" } } } },
  { name: "update_customer", description: "Update a customer", inputSchema: { type: "object", required: ["customer_id"], properties: { customer_id: { type: "string" }, first_name: { type: "string" }, last_name: { type: "string" }, email: { type: "string" }, mobile_number: { type: "string" }, company: { type: "string" }, notifications_enabled: { type: "boolean" }, lead_source: { type: "string" }, notes: { type: "string" } } } },
  { name: "list_customer_addresses", description: "List all addresses for a customer", inputSchema: { type: "object", required: ["customer_id"], properties: { customer_id: { type: "string" } } } },
  { name: "get_customer_address", description: "Get a specific address for a customer", inputSchema: { type: "object", required: ["customer_id","address_id"], properties: { customer_id: { type: "string" }, address_id: { type: "string" } } } },
  { name: "create_customer_address", description: "Add a service address to a customer", inputSchema: { type: "object", required: ["customer_id","street","city","state","zip"], properties: { customer_id: { type: "string" }, street: { type: "string" }, street_line_2: { type: "string" }, city: { type: "string" }, state: { type: "string" }, zip: { type: "string" }, country: { type: "string" } } } },
  { name: "list_customer_memberships", description: "List memberships for a customer", inputSchema: { type: "object", required: ["customer_id"], properties: { customer_id: { type: "string" } } } },
  { name: "list_employees", description: "List all employees and technicians", inputSchema: { type: "object", properties: { page: { type: "number" }, page_size: { type: "number" } } } },
  { name: "get_employee", description: "Get an employee by ID", inputSchema: { type: "object", required: ["employee_id"], properties: { employee_id: { type: "string" } } } },
  { name: "list_jobs", description: "List or search jobs", inputSchema: { type: "object", properties: { page: { type: "number" }, page_size: { type: "number" }, work_status: { type: "array", items: { type: "string" } }, scheduled_start_min: { type: "string" }, scheduled_start_max: { type: "string" }, customer_id: { type: "string" }, employee_ids: { type: "array", items: { type: "string" } }, sort_direction: { type: "string" }, expand: { type: "string" } } } },
  { name: "get_job", description: "Get a job by ID", inputSchema: { type: "object", required: ["job_id"], properties: { job_id: { type: "string" }, expand: { type: "string" } } } },
  { name: "create_job", description: "Create a new job", inputSchema: { type: "object", required: ["customer_id"], properties: { customer_id: { type: "string" }, address_id: { type: "string" }, notes: { type: "string" }, description: { type: "string" }, lead_source: { type: "string" }, job_type_id: { type: "string" }, tags: { type: "array", items: { type: "string" } }, assigned_employee_ids: { type: "array", items: { type: "string" } }, schedule: { type: "object" } } } },
  { name: "update_job", description: "Update a job", inputSchema: { type: "object", required: ["job_id"], properties: { job_id: { type: "string" }, notes: { type: "string" }, description: { type: "string" }, work_status: { type: "string" }, assigned_employee_ids: { type: "array", items: { type: "string" } }, tags: { type: "array", items: { type: "string" } } } } },
  { name: "dispatch_job", description: "Dispatch a job to specific employees", inputSchema: { type: "object", required: ["job_id","employee_ids"], properties: { job_id: { type: "string" }, employee_ids: { type: "array", items: { type: "string" } } } } },
  { name: "lock_job", description: "Lock a single job", inputSchema: { type: "object", required: ["job_id"], properties: { job_id: { type: "string" } } } },
  { name: "lock_jobs", description: "Lock multiple jobs at once", inputSchema: { type: "object", required: ["job_ids"], properties: { job_ids: { type: "array", items: { type: "string" } } } } },
  { name: "update_job_schedule", description: "Update the schedule for a job", inputSchema: { type: "object", required: ["job_id"], properties: { job_id: { type: "string" }, scheduled_start: { type: "string" }, scheduled_end: { type: "string" }, arrival_window_minutes: { type: "number" }, assigned_employee_ids: { type: "array", items: { type: "string" } } } } },
  { name: "delete_job_schedule", description: "Remove the schedule from a job", inputSchema: { type: "object", required: ["job_id"], properties: { job_id: { type: "string" } } } },
  { name: "list_job_appointments", description: "List appointments for a job", inputSchema: { type: "object", required: ["job_id"], properties: { job_id: { type: "string" } } } },
  { name: "create_job_appointment", description: "Schedule an appointment for a job", inputSchema: { type: "object", required: ["job_id","scheduled_start","scheduled_end"], properties: { job_id: { type: "string" }, scheduled_start: { type: "string" }, scheduled_end: { type: "string" }, arrival_window_minutes: { type: "number" }, assigned_employee_ids: { type: "array", items: { type: "string" } }, dispatcher_note: { type: "string" }, notify_customer: { type: "boolean" } } } },
  { name: "update_job_appointment", description: "Update a job appointment", inputSchema: { type: "object", required: ["job_id","appointment_id"], properties: { job_id: { type: "string" }, appointment_id: { type: "string" }, scheduled_start: { type: "string" }, scheduled_end: { type: "string" }, assigned_employee_ids: { type: "array", items: { type: "string" } }, notify_customer: { type: "boolean" } } } },
  { name: "delete_job_appointment", description: "Delete a job appointment", inputSchema: { type: "object", required: ["job_id","appointment_id"], properties: { job_id: { type: "string" }, appointment_id: { type: "string" }, notify_customer: { type: "boolean" } } } },
  { name: "create_job_note", description: "Add a note to a job", inputSchema: { type: "object", required: ["job_id","content"], properties: { job_id: { type: "string" }, content: { type: "string" } } } },
  { name: "delete_job_note", description: "Delete a note from a job", inputSchema: { type: "object", required: ["job_id","note_id"], properties: { job_id: { type: "string" }, note_id: { type: "string" } } } },
  { name: "add_job_tag", description: "Add a tag to a job", inputSchema: { type: "object", required: ["job_id","tag"], properties: { job_id: { type: "string" }, tag: { type: "string" } } } },
  { name: "delete_job_tag", description: "Remove a tag from a job", inputSchema: { type: "object", required: ["job_id","tag_id"], properties: { job_id: { type: "string" }, tag_id: { type: "string" } } } },
  { name: "create_job_link", description: "Add a link to a job", inputSchema: { type: "object", required: ["job_id","url"], properties: { job_id: { type: "string" }, url: { type: "string" }, name: { type: "string" } } } },
  { name: "create_job_attachment", description: "Attach a file URL to a job", inputSchema: { type: "object", required: ["job_id","url"], properties: { job_id: { type: "string" }, url: { type: "string" }, name: { type: "string" } } } },
  { name: "list_job_line_items", description: "List all line items for a job", inputSchema: { type: "object", required: ["job_id"], properties: { job_id: { type: "string" } } } },
  { name: "create_job_line_item", description: "Add a line item to a job", inputSchema: { type: "object", required: ["job_id","name","unit_price"], properties: { job_id: { type: "string" }, name: { type: "string" }, unit_price: { type: "number" }, quantity: { type: "number" }, unit_cost: { type: "number" }, taxable: { type: "boolean" } } } },
  { name: "update_job_line_item", description: "Update a single line item on a job", inputSchema: { type: "object", required: ["job_id","line_item_id"], properties: { job_id: { type: "string" }, line_item_id: { type: "string" }, name: { type: "string" }, unit_price: { type: "number" }, quantity: { type: "number" } } } },
  { name: "delete_job_line_item", description: "Delete a line item from a job", inputSchema: { type: "object", required: ["job_id","line_item_id"], properties: { job_id: { type: "string" }, line_item_id: { type: "string" } } } },
  { name: "bulk_update_job_line_items", description: "Bulk update all line items on a job", inputSchema: { type: "object", required: ["job_id","line_items"], properties: { job_id: { type: "string" }, line_items: { type: "array", items: { type: "object" } } } } },
  { name: "list_job_input_materials", description: "List all input materials for a job", inputSchema: { type: "object", required: ["job_id"], properties: { job_id: { type: "string" } } } },
  { name: "bulk_update_job_input_materials", description: "Bulk update input materials for a job", inputSchema: { type: "object", required: ["job_id","materials"], properties: { job_id: { type: "string" }, materials: { type: "array", items: { type: "object" } } } } },
  { name: "list_job_invoices", description: "List invoices for a job", inputSchema: { type: "object", required: ["job_id"], properties: { job_id: { type: "string" } } } },
  { name: "list_estimates", description: "List or search estimates", inputSchema: { type: "object", properties: { page: { type: "number" }, page_size: { type: "number" }, customer_id: { type: "string" }, work_status: { type: "string" } } } },
  { name: "get_estimate", description: "Get an estimate by ID", inputSchema: { type: "object", required: ["estimate_id"], properties: { estimate_id: { type: "string" } } } },
  { name: "create_estimate", description: "Create a new estimate", inputSchema: { type: "object", required: ["customer_id"], properties: { customer_id: { type: "string" }, address_id: { type: "string" }, notes: { type: "string" }, lead_source: { type: "string" }, assigned_employee_ids: { type: "array", items: { type: "string" } } } } },
  { name: "update_estimate", description: "Update an estimate", inputSchema: { type: "object", required: ["estimate_id"], properties: { estimate_id: { type: "string" }, notes: { type: "string" }, work_status: { type: "string" }, assigned_employee_ids: { type: "array", items: { type: "string" } } } } },
  { name: "approve_estimate_options", description: "Approve estimate options", inputSchema: { type: "object", required: ["option_ids"], properties: { option_ids: { type: "array", items: { type: "string" } } } } },
  { name: "decline_estimate_options", description: "Decline estimate options", inputSchema: { type: "object", required: ["option_ids"], properties: { option_ids: { type: "array", items: { type: "string" } } } } },
  { name: "create_estimate_option", description: "Create an option on an estimate", inputSchema: { type: "object", required: ["estimate_id"], properties: { estimate_id: { type: "string" }, name: { type: "string" } } } },
  { name: "create_estimate_option_note", description: "Add a note to an estimate option", inputSchema: { type: "object", required: ["estimate_id","option_id","content"], properties: { estimate_id: { type: "string" }, option_id: { type: "string" }, content: { type: "string" } } } },
  { name: "delete_estimate_option_note", description: "Delete a note from an estimate option", inputSchema: { type: "object", required: ["estimate_id","option_id","note_id"], properties: { estimate_id: { type: "string" }, option_id: { type: "string" }, note_id: { type: "string" } } } },
  { name: "list_estimate_option_line_items", description: "List line items for an estimate option", inputSchema: { type: "object", required: ["estimate_id","option_id"], properties: { estimate_id: { type: "string" }, option_id: { type: "string" } } } },
  { name: "bulk_update_estimate_option_line_items", description: "Bulk update line items on an estimate option", inputSchema: { type: "object", required: ["estimate_id","option_id","line_items"], properties: { estimate_id: { type: "string" }, option_id: { type: "string" }, line_items: { type: "array", items: { type: "object" } } } } },
  { name: "create_estimate_option_attachment", description: "Add an attachment to an estimate option", inputSchema: { type: "object", required: ["estimate_id","option_id","url"], properties: { estimate_id: { type: "string" }, option_id: { type: "string" }, url: { type: "string" } } } },
  { name: "create_estimate_option_link", description: "Add a link to an estimate option", inputSchema: { type: "object", required: ["estimate_id","option_id","url"], properties: { estimate_id: { type: "string" }, option_id: { type: "string" }, url: { type: "string" } } } },
  { name: "update_estimate_option_schedule", description: "Update the schedule for an estimate option", inputSchema: { type: "object", required: ["estimate_id","option_id"], properties: { estimate_id: { type: "string" }, option_id: { type: "string" }, scheduled_start: { type: "string" }, scheduled_end: { type: "string" } } } },
  { name: "list_invoices", description: "List invoices account-wide", inputSchema: { type: "object", properties: { page: { type: "number" }, page_size: { type: "number" }, status: { type: "string" }, customer_uuid: { type: "string" }, created_at_min: { type: "string" }, created_at_max: { type: "string" }, paid_at_min: { type: "string" }, paid_at_max: { type: "string" }, sort_direction: { type: "string" } } } },
  { name: "get_invoice", description: "Get an invoice by ID", inputSchema: { type: "object", required: ["invoice_id"], properties: { invoice_id: { type: "string" } } } },
  { name: "get_invoice_by_uuid", description: "Get an invoice by UUID", inputSchema: { type: "object", required: ["uuid"], properties: { uuid: { type: "string" } } } },
  { name: "preview_invoice", description: "Get a preview of an invoice by UUID", inputSchema: { type: "object", required: ["uuid"], properties: { uuid: { type: "string" } } } },
  { name: "list_leads", description: "List or search leads", inputSchema: { type: "object", properties: { page: { type: "number" }, page_size: { type: "number" }, status: { type: "string" }, customer_id: { type: "string" }, lead_source: { type: "string" }, sort_direction: { type: "string" } } } },
  { name: "get_lead", description: "Get a lead by ID", inputSchema: { type: "object", required: ["lead_id"], properties: { lead_id: { type: "string" } } } },
  { name: "create_lead", description: "Create a new lead", inputSchema: { type: "object", properties: { customer_id: { type: "string" }, first_name: { type: "string" }, last_name: { type: "string" }, email: { type: "string" }, mobile_number: { type: "string" }, description: { type: "string" }, notes: { type: "string" }, lead_source: { type: "string" } } } },
  { name: "convert_lead", description: "Convert a lead to an estimate or job", inputSchema: { type: "object", required: ["lead_id","convert_to"], properties: { lead_id: { type: "string" }, convert_to: { type: "string", enum: ["estimate","job"] } } } },
  { name: "list_lead_line_items", description: "List line items for a lead", inputSchema: { type: "object", required: ["lead_id"], properties: { lead_id: { type: "string" } } } },
  { name: "list_lead_sources", description: "List all lead sources", inputSchema: { type: "object", properties: { q: { type: "string" }, page: { type: "number" } } } },
  { name: "create_lead_source", description: "Create a new lead source", inputSchema: { type: "object", required: ["name"], properties: { name: { type: "string" } } } },
  { name: "update_lead_source", description: "Update a lead source", inputSchema: { type: "object", required: ["lead_source_id","name"], properties: { lead_source_id: { type: "string" }, name: { type: "string" } } } },
  { name: "list_tags", description: "List all tags", inputSchema: { type: "object", properties: { page: { type: "number" }, page_size: { type: "number" } } } },
  { name: "create_tag", description: "Create a new tag", inputSchema: { type: "object", required: ["name"], properties: { name: { type: "string" } } } },
  { name: "update_tag", description: "Update an existing tag", inputSchema: { type: "object", required: ["tag_id","name"], properties: { tag_id: { type: "string" }, name: { type: "string" } } } },
  { name: "list_job_types", description: "List job type categories", inputSchema: { type: "object", properties: { name: { type: "string" } } } },
  { name: "create_job_type", description: "Create a new job type", inputSchema: { type: "object", required: ["name"], properties: { name: { type: "string" } } } },
  { name: "update_job_type", description: "Update a job type", inputSchema: { type: "object", required: ["job_type_id","name"], properties: { job_type_id: { type: "string" }, name: { type: "string" } } } },
  { name: "list_pricebook_services", description: "List pricebook services", inputSchema: { type: "object", properties: { page: { type: "number" }, q: { type: "string" } } } },
  { name: "list_pricebook_materials", description: "List pricebook materials", inputSchema: { type: "object", properties: { page: { type: "number" }, material_category_uuid: { type: "string" } } } },
  { name: "create_pricebook_material", description: "Create a pricebook material", inputSchema: { type: "object", required: ["name"], properties: { name: { type: "string" }, description: { type: "string" }, unit_cost: { type: "number" }, material_category_uuid: { type: "string" } } } },
  { name: "update_pricebook_material", description: "Update a pricebook material", inputSchema: { type: "object", required: ["uuid"], properties: { uuid: { type: "string" }, name: { type: "string" }, unit_cost: { type: "number" } } } },
  { name: "delete_pricebook_material", description: "Delete a pricebook material", inputSchema: { type: "object", required: ["uuid"], properties: { uuid: { type: "string" } } } },
  { name: "list_material_categories", description: "List material categories", inputSchema: { type: "object", properties: { page: { type: "number" } } } },
  { name: "create_material_category", description: "Create a material category", inputSchema: { type: "object", required: ["name"], properties: { name: { type: "string" } } } },
  { name: "update_material_category", description: "Update a material category", inputSchema: { type: "object", required: ["uuid","name"], properties: { uuid: { type: "string" }, name: { type: "string" } } } },
  { name: "delete_material_category", description: "Delete a material category", inputSchema: { type: "object", required: ["uuid"], properties: { uuid: { type: "string" } } } },
  { name: "list_price_forms", description: "List price forms", inputSchema: { type: "object", properties: {} } },
  { name: "get_price_form", description: "Get a price form by UUID", inputSchema: { type: "object", required: ["uuid"], properties: { uuid: { type: "string" } } } },
  { name: "create_price_form", description: "Create a price form", inputSchema: { type: "object", required: ["name"], properties: { name: { type: "string" } } } },
  { name: "update_price_form", description: "Update a price form", inputSchema: { type: "object", required: ["uuid"], properties: { uuid: { type: "string" }, name: { type: "string" } } } },
  { name: "delete_price_form", description: "Delete a price form", inputSchema: { type: "object", required: ["uuid"], properties: { uuid: { type: "string" } } } },
  { name: "list_events", description: "List calendar events", inputSchema: { type: "object", properties: { page: { type: "number" }, page_size: { type: "number" } } } },
  { name: "get_event", description: "Get a calendar event by ID", inputSchema: { type: "object", required: ["event_id"], properties: { event_id: { type: "string" } } } },
  { name: "list_scheduled_events", description: "List dispatch scheduled events", inputSchema: { type: "object", properties: { start_at_or_after: { type: "string" }, end_at_or_before: { type: "string" }, employee_id: { type: "string" }, page: { type: "number" } } } },
  { name: "get_schedule_availability", description: "Get company schedule availability", inputSchema: { type: "object", properties: {} } },
  { name: "update_schedule_availability", description: "Update company schedule windows", inputSchema: { type: "object", required: ["schedule"], properties: { schedule: { type: "object" } } } },
  { name: "get_booking_windows", description: "Get available booking windows", inputSchema: { type: "object", properties: { show_for_days: { type: "number" }, start_date: { type: "string" }, employee_ids: { type: "array", items: { type: "string" } } } } },
  { name: "list_routes", description: "List dispatch routes", inputSchema: { type: "object", properties: { date: { type: "string" }, page: { type: "number" } } } },
  { name: "list_service_zones", description: "List service zones", inputSchema: { type: "object", properties: { page: { type: "number" }, zip_code: { type: "string" } } } },
  { name: "list_pipeline_statuses", description: "List pipeline statuses", inputSchema: { type: "object", properties: { resource_type: { type: "string" }, page: { type: "number" } } } },
  { name: "update_pipeline_status", description: "Update a pipeline status", inputSchema: { type: "object", required: ["status"], properties: { status: { type: "object" } } } },
  { name: "get_company", description: "Get company account information", inputSchema: { type: "object", properties: {} } },
  { name: "update_franchise_info", description: "Update franchise information", inputSchema: { type: "object", required: ["data"], properties: { data: { type: "object" } } } },
  { name: "list_checklists", description: "List checklists for jobs or estimates", inputSchema: { type: "object", properties: { page: { type: "number" }, job_uuids: { type: "array", items: { type: "string" } } } } },
  { name: "get_application", description: "Get application info", inputSchema: { type: "object", properties: {} } },
  { name: "enable_application", description: "Enable the application integration", inputSchema: { type: "object", properties: {} } },
  { name: "disable_application", description: "Disable the application integration", inputSchema: { type: "object", properties: {} } },
  { name: "list_service_plans", description: "List membership and service plan templates", inputSchema: { type: "object", properties: { page: { type: "number" } } } },
  { name: "create_webhook", description: "Enable webhook subscription for this company. Configure URL and events in HCP UI first.", inputSchema: { type: "object", properties: {} } },
  { name: "delete_webhook", description: "Delete the webhook subscription for this company.", inputSchema: { type: "object", properties: {} } },
];

async function callTool(name, args, apiKey) {
  const c = (method, path, body) => hcp(apiKey, method, path, body);
  switch (name) {
    case "list_customers": return c("GET", `/customers${qs(args)}`);
    case "get_customer": { const { customer_id, ...q } = args; return c("GET", `/customers/${customer_id}${qs(q)}`); }
    case "create_customer": return c("POST", `/customers`, args);
    case "update_customer": { const { customer_id, ...b } = args; return c("PUT", `/customers/${customer_id}`, b); }
    case "list_customer_addresses": { const { customer_id, ...q } = args; return c("GET", `/customers/${customer_id}/addresses${qs(q)}`); }
    case "get_customer_address": return c("GET", `/customers/${args.customer_id}/addresses/${args.address_id}`);
    case "create_customer_address": { const { customer_id, ...b } = args; return c("POST", `/customers/${customer_id}/addresses`, b); }
    case "list_customer_memberships": return c("GET", `/customers/${args.customer_id}/memberships`);
    case "list_employees": return c("GET", `/employees${qs(args)}`);
    case "get_employee": return c("GET", `/employees/${args.employee_id}`);
    case "list_jobs": return c("GET", `/jobs${qs(args)}`);
    case "get_job": { const { job_id, ...q } = args; return c("GET", `/jobs/${job_id}${qs(q)}`); }
    case "create_job": return c("POST", `/jobs`, args);
    case "update_job": { const { job_id, ...b } = args; return c("PATCH", `/jobs/${job_id}`, b); }
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
    case "list_estimates": return c("GET", `/estimates${qs(args)}`);
    case "get_estimate": { const { estimate_id, ...q } = args; return c("GET", `/estimates/${estimate_id}${qs(q)}`); }
    case "create_estimate": return c("POST", `/estimates`, args);
    case "update_estimate": { const { estimate_id, ...b } = args; return c("PATCH", `/estimates/${estimate_id}`, b); }
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
    case "list_invoices": return c("GET", `/invoices${qs(args)}`);
    case "get_invoice": return c("GET", `/invoices/${args.invoice_id}`);
    case "get_invoice_by_uuid": return c("GET", `/api/invoices/${args.uuid}`);
    case "preview_invoice": return c("GET", `/api/invoices/${args.uuid}/preview`);
    case "list_leads": return c("GET", `/leads${qs(args)}`);
    case "get_lead": return c("GET", `/leads/${args.lead_id}`);
    case "create_lead": return c("POST", `/leads`, args);
    case "convert_lead": { const { lead_id, ...b } = args; return c("POST", `/leads/${lead_id}/convert`, b); }
    case "list_lead_line_items": return c("GET", `/leads/${args.lead_id}/line_items`);
    case "list_lead_sources": return c("GET", `/lead_sources${qs(args)}`);
    case "create_lead_source": return c("POST", `/lead_sources`, args);
    case "update_lead_source": { const { lead_source_id, ...b } = args; return c("PUT", `/lead_sources/${lead_source_id}`, b); }
    case "list_tags": return c("GET", `/tags${qs(args)}`);
    case "create_tag": return c("POST", `/tags`, args);
    case "update_tag": { const { tag_id, ...b } = args; return c("PUT", `/tags/${tag_id}`, b); }
    case "list_job_types": return c("GET", `/job_fields/job_types${qs(args)}`);
    case "create_job_type": return c("POST", `/job_fields/job_types`, args);
    case "update_job_type": { const { job_type_id, ...b } = args; return c("PUT", `/job_fields/job_types/${job_type_id}`, b); }
    case "list_pricebook_services": return c("GET", `/api/price_book/services${qs(args)}`);
    case "list_pricebook_materials": return c("GET", `/api/price_book/materials${qs(args)}`);
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
    case "list_events": return c("GET", `/events${qs(args)}`);
    case "get_event": return c("GET", `/events/${args.event_id}`);
    case "list_scheduled_events": return c("GET", `/scheduled_events${qs(args)}`);
    case "get_schedule_availability": return c("GET", `/company/schedule_availability`);
    case "update_schedule_availability": return c("PUT", `/company/schedule_availability`, args.schedule);
    case "get_booking_windows": return c("GET", `/company/schedule_availability/booking_windows${qs(args)}`);
    case "list_routes": return c("GET", `/routes${qs(args)}`);
    case "list_service_zones": return c("GET", `/service_zones${qs(args)}`);
    case "list_pipeline_statuses": return c("GET", `/pipeline/statuses${qs(args)}`);
    case "update_pipeline_status": return c("PUT", `/pipeline/statuses`, args.status);
    case "get_company": return c("GET", `/company`);
    case "update_franchise_info": return c("PATCH", `/company/franchise_info`, args.data);
    case "list_checklists": return c("GET", `/checklists${qs(args)}`);
    case "get_application": return c("GET", `/application`);
    case "enable_application": return c("POST", `/application/enable`);
    case "disable_application": return c("POST", `/application/disable`);
    case "list_service_plans": return c("GET", `/service_plans${qs(args)}`);
    case "create_webhook": return c("POST", `/webhooks/subscription`, {});
    case "delete_webhook": return c("DELETE", `/webhooks/subscription`, {});
    default: throw new Error(`Unknown tool: ${name}`);
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
      const message = `HCP MCP Worker v${VERSION} — ${TOOLS.length} tools | /mcp | /webhook

Next steps:
1. Point Claude to: ${request.url.replace(/\/$/, "")}/mcp
2. Claude will read SETUP_ZERO_KNOWLEDGE.md and guide you through setup

Need help? Point Claude at the GitHub repo and say:
"Walk me through SETUP_ZERO_KNOWLEDGE.md"`;
      return new Response(message, {
        status: 200,
        headers: { "Content-Type": "text/plain", ...CORS },
      });
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
