/**
 * AI PR Review · events ingestion Worker.
 *
 * Endpoints:
 *   GET  /events.jsonl              → returns current events.jsonl from R2 (CORS-friendly, no-cache)
 *   POST /events  Authorization: Bearer <WRITE_TOKEN>
 *                                  → appends one event to events.jsonl
 *   GET  /healthz                   → 200 OK
 *
 * Storage:
 *   R2 bucket bound as `EVENTS` (see wrangler.toml). Single key:
 *   `events.jsonl` — the canonical log, newline-delimited JSON.
 *
 * Concurrency note:
 *   For the demo's traffic (a handful of PRs/day), the read-append-write
 *   race window is microseconds. Production-grade serialization would use
 *   a Durable Object as a write coordinator, or the per-event
 *   one-object-per-key strategy with a list-on-read.
 */

export interface Env {
  EVENTS: R2Bucket;
  WRITE_TOKEN: string;
}

const KEY = "events.jsonl";
const ALLOWED_ORIGIN = "*"; // public dashboard, no need to restrict

function corsHeaders(extra: Record<string, string> = {}): Record<string, string> {
  return {
    "Access-Control-Allow-Origin": ALLOWED_ORIGIN,
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
    "Access-Control-Max-Age": "86400",
    ...extra,
  };
}

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);
    const { pathname } = url;
    const method = req.method.toUpperCase();

    // CORS preflight
    if (method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeaders() });
    }

    // Health
    if (method === "GET" && pathname === "/healthz") {
      return new Response("OK", { status: 200, headers: corsHeaders({ "Content-Type": "text/plain" }) });
    }

    // GET events
    if (method === "GET" && (pathname === "/events.jsonl" || pathname === "/events")) {
      const obj = await env.EVENTS.get(KEY);
      const body = obj ? await obj.text() : "";
      return new Response(body, {
        status: 200,
        headers: corsHeaders({
          "Content-Type": "application/x-ndjson",
          "Cache-Control": "no-store, no-cache, must-revalidate",
        }),
      });
    }

    // POST single event
    if (method === "POST" && pathname === "/events") {
      const auth = req.headers.get("authorization") ?? "";
      if (!env.WRITE_TOKEN || auth !== `Bearer ${env.WRITE_TOKEN}`) {
        return new Response("Unauthorized", { status: 401, headers: corsHeaders() });
      }

      const text = (await req.text()).trim();
      if (!text) {
        return new Response("Empty body", { status: 400, headers: corsHeaders() });
      }

      // Validate as JSON (single line) or JSONL (multiple lines, useful for backfill)
      const lines = text.split("\n").filter((l) => l.trim().length > 0);
      for (const line of lines) {
        try {
          JSON.parse(line);
        } catch {
          return new Response(`Invalid JSON line: ${line.slice(0, 80)}`, { status: 400, headers: corsHeaders() });
        }
      }

      // Read-append-write
      const existing = await env.EVENTS.get(KEY);
      let buffer = existing ? await existing.text() : "";
      if (buffer.length > 0 && !buffer.endsWith("\n")) buffer += "\n";
      buffer += lines.join("\n") + "\n";

      await env.EVENTS.put(KEY, buffer, {
        httpMetadata: { contentType: "application/x-ndjson" },
      });

      return new Response(JSON.stringify({ ok: true, appended: lines.length }), {
        status: 200,
        headers: corsHeaders({ "Content-Type": "application/json" }),
      });
    }

    // PUT (full overwrite — useful for a one-shot reseed)
    if (method === "PUT" && pathname === "/events") {
      const auth = req.headers.get("authorization") ?? "";
      if (!env.WRITE_TOKEN || auth !== `Bearer ${env.WRITE_TOKEN}`) {
        return new Response("Unauthorized", { status: 401, headers: corsHeaders() });
      }
      const body = await req.text();
      await env.EVENTS.put(KEY, body, {
        httpMetadata: { contentType: "application/x-ndjson" },
      });
      return new Response(JSON.stringify({ ok: true, replaced: true }), {
        status: 200,
        headers: corsHeaders({ "Content-Type": "application/json" }),
      });
    }

    return new Response("Not Found", { status: 404, headers: corsHeaders() });
  },
};
