# Adding Custom Tools

This guide shows how to add new HCP API tools to your worker.

## Overview

Each tool needs:
1. **Definition** — describe inputs/outputs for the MCP client
2. **Handler** — execute the API call

Both go in `worker.js`.

## Example: Add `update_customer`

### 1. Add the tool definition

In `worker.js`, find the `TOOLS` array and add:

```js
{
  name: "update_customer",
  description: "Update a customer's name, email, or notes",
  inputSchema: {
    type: "object",
    required: ["customer_id"],
    properties: {
      customer_id: { type: "string", description: "Customer ID" },
      first_name: { type: "string" },
      last_name: { type: "string" },
      email: { type: "string" },
      notes: { type: "string" },
    },
  },
}
```

### 2. Add the handler

In `worker.js`, find the `callTool()` switch statement and add:

```js
case "update_customer": {
  const { customer_id, ...body } = args;
  return c("PUT", `/customers/${customer_id}`, body);
}
```

That's it! The `c()` helper is `(method, path, body) => hcp(apiKey, method, path, body)`.

### 3. Deploy

```bash
git add worker.js
git commit -m "Add update_customer tool"
git push origin main
```

Cloudflare auto-deploys. Your new tool appears in `/mcp` immediately.

## Tool Patterns

### GET with query params (search)

```js
{
  name: "search_jobs",
  description: "Search jobs by status",
  inputSchema: {
    type: "object",
    properties: {
      work_status: { type: "array", items: { type: "string" } },
      page: { type: "number" },
    },
  },
}

// Handler
case "search_jobs":
  return c("GET", `/jobs${qs(args)}`);
```

The `qs()` helper converts args to query string (`?page=1&work_status=completed`).

### GET with path param

```js
{
  name: "get_employee",
  description: "Get an employee by ID",
  inputSchema: {
    type: "object",
    required: ["employee_id"],
    properties: { employee_id: { type: "string" } },
  },
}

// Handler
case "get_employee":
  return c("GET", `/employees/${args.employee_id}`);
```

### POST (create)

```js
{
  name: "create_invoice",
  description: "Create an invoice",
  inputSchema: {
    type: "object",
    required: ["job_id", "amount"],
    properties: {
      job_id: { type: "string" },
      amount: { type: "number" },
      notes: { type: "string" },
    },
  },
}

// Handler
case "create_invoice":
  return c("POST", `/invoices`, args);
```

### PUT with mixed params

```js
{
  name: "update_job_schedule",
  description: "Update a job's appointment time",
  inputSchema: {
    type: "object",
    required: ["job_id", "scheduled_start"],
    properties: {
      job_id: { type: "string" },
      scheduled_start: { type: "string" },
      scheduled_end: { type: "string" },
    },
  },
}

// Handler
case "update_job_schedule": {
  const { job_id, ...body } = args;
  return c("PUT", `/jobs/${job_id}/schedule`, body);
}
```

## HCP API Reference

See [HouseCall Pro API docs](https://dev.housecallpro.com/) for available endpoints.

Common patterns:
- `GET /customers` — list
- `GET /customers/{id}` — fetch one
- `POST /customers` — create
- `PUT /customers/{id}` — update (full replacement)
- `PATCH /customers/{id}` — partial update
- `DELETE /customers/{id}` — delete

## Example: List all estimates for a job

```js
{
  name: "list_job_estimates",
  description: "List all estimates for a job",
  inputSchema: {
    type: "object",
    required: ["job_id"],
    properties: {
      job_id: { type: "string" },
      page: { type: "number" },
    },
  },
}

// Handler
case "list_job_estimates": {
  const { job_id, ...q } = args;
  return c("GET", `/jobs/${job_id}/estimates${qs(q)}`);
}
```

## Tips

- **Error handling:** The `hcp()` helper throws on non-2xx responses. The MCP handler catches these and returns them as error responses. No need to handle manually.
- **JSON schemas:** Keep them simple. Only describe what the user needs to pass; omit server defaults.
- **Descriptions:** Clear, short. "Get customer details" is better than "Retrieve a customer from the database."
- **Testing:** After deploying, use curl to test:
  ```bash
  curl -X POST https://your-worker.workers.dev/mcp \
    -H "Content-Type: application/json" \
    -d '{
      "jsonrpc": "2.0",
      "method": "tools/call",
      "id": 1,
      "params": {
        "name": "update_customer",
        "arguments": {
          "customer_id": "123",
          "email": "new@example.com"
        }
      }
    }'
  ```

## Full example: Add `list_estimates` and `get_estimate`

```js
// In TOOLS array
{
  name: "list_estimates",
  description: "List all estimates",
  inputSchema: {
    type: "object",
    properties: {
      page: { type: "number" },
      page_size: { type: "number" },
      customer_id: { type: "string" },
    },
  },
},
{
  name: "get_estimate",
  description: "Get an estimate by ID",
  inputSchema: {
    type: "object",
    required: ["estimate_id"],
    properties: { estimate_id: { type: "string" } },
  },
},

// In callTool() switch
case "list_estimates":
  return c("GET", `/estimates${qs(args)}`);
case "get_estimate": {
  const { estimate_id, ...q } = args;
  return c("GET", `/estimates/${estimate_id}${qs(q)}`);
}
```

Push to main, auto-deploys, done.

## Need help?

- Check the HCP API docs for the endpoint structure
- Look at existing tools in `worker.js` for patterns
- Test with curl first before adding to your worker
- Post errors in your prompt to Claude and it'll help debug

---

That's it. Start small (1-2 tools), test, iterate.
