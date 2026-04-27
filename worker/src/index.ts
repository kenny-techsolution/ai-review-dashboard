/**
 * AI PR Review · events ingestion Worker.
 *
 * Endpoints:
 *   GET  /events.jsonl              → returns current events.jsonl from R2 (CORS-friendly, no-cache)
 *   GET  /stream                    → Server-Sent Events stream of new events (push, ~sub-second)
 *   POST /events  Authorization: Bearer <WRITE_TOKEN>
 *                                  → appends one or more events; broadcasts to /stream subscribers
 *   PUT  /events  Authorization: Bearer <WRITE_TOKEN>
 *                                  → replaces events.jsonl wholesale (one-shot reseed)
 *   GET  /healthz                   → 200 OK
 *
 * Storage:
 *   R2 bucket bound as `EVENTS` (see wrangler.toml). Single key `events.jsonl`.
 *
 * Push:
 *   Durable Object `EventBroadcaster` holds open SSE connections from
 *   dashboards and fan-outs each new event line. SQLite-backed DO so the
 *   free Workers plan covers it.
 */

export interface Env {
  EVENTS: R2Bucket;
  WRITE_TOKEN: string;
  BROADCASTER: DurableObjectNamespace;
}

const KEY = "events.jsonl";
const BROADCAST_ID = "global";
const ALLOWED_ORIGIN = "*";

function corsHeaders(extra: Record<string, string> = {}): Record<string, string> {
  return {
    "Access-Control-Allow-Origin": ALLOWED_ORIGIN,
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
    "Access-Control-Max-Age": "86400",
    ...extra,
  };
}

// Pick the SSE event name from the payload shape.
// Merge events are tagged `{ type: "merged", ... }`; everything else is a review.
function eventNameFor(line: string): string {
  try {
    const obj = JSON.parse(line);
    if (obj && typeof obj === "object" && obj.type === "merged") return "merged";
  } catch {}
  return "review";
}

/**
 * EventBroadcaster — a single global Durable Object that holds open SSE
 * writers and fans out broadcasts. State is in-memory only (no SQL needed),
 * but we declare it SQLite-backed so it runs on the free Workers plan.
 */
export class EventBroadcaster {
  private writers = new Set<WritableStreamDefaultWriter<Uint8Array>>();
  private encoder = new TextEncoder();

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  constructor(_state: DurableObjectState, _env: Env) {}

  async fetch(req: Request): Promise<Response> {
    const url = new URL(req.url);

    if (req.method === "GET" && url.pathname === "/subscribe") {
      const { readable, writable } = new TransformStream<Uint8Array, Uint8Array>();
      const writer = writable.getWriter();
      this.writers.add(writer);

      // Initial hello — lets the browser confirm "live" status.
      writer
        .write(this.encoder.encode(`event: hello\ndata: {"connected":true}\n\n`))
        .catch(() => this.writers.delete(writer));

      // 25s heartbeat keeps the connection alive through edge proxies and
      // serves as our liveness check — a failed write means the client went away.
      const hb = setInterval(() => {
        writer.write(this.encoder.encode(`: heartbeat\n\n`)).catch(() => {
          clearInterval(hb);
          this.writers.delete(writer);
        });
      }, 25000);

      return new Response(readable, {
        status: 200,
        headers: {
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-cache, no-transform",
          "Access-Control-Allow-Origin": ALLOWED_ORIGIN,
          "X-Accel-Buffering": "no",
        },
      });
    }

    if (req.method === "POST" && url.pathname === "/broadcast") {
      const body = await req.text();
      const lines = body.split("\n").filter((l) => l.trim().length > 0);
      for (const line of lines) {
        const name = eventNameFor(line);
        const message = `event: ${name}\ndata: ${line}\n\n`;
        const dead: WritableStreamDefaultWriter<Uint8Array>[] = [];
        for (const w of this.writers) {
          try {
            await w.write(this.encoder.encode(message));
          } catch {
            dead.push(w);
          }
        }
        for (const d of dead) this.writers.delete(d);
      }
      return new Response(JSON.stringify({ ok: true, clients: this.writers.size }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }

    return new Response("Not Found", { status: 404 });
  }
}

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);
    const { pathname } = url;
    const method = req.method.toUpperCase();

    if (method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeaders() });
    }

    if (method === "GET" && pathname === "/healthz") {
      return new Response("OK", { status: 200, headers: corsHeaders({ "Content-Type": "text/plain" }) });
    }

    // SSE stream — proxy directly through to the broadcaster DO.
    if (method === "GET" && pathname === "/stream") {
      const id = env.BROADCASTER.idFromName(BROADCAST_ID);
      const stub = env.BROADCASTER.get(id);
      return stub.fetch(new Request("https://do/subscribe", { method: "GET" }));
    }

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

    if (method === "POST" && pathname === "/events") {
      const auth = req.headers.get("authorization") ?? "";
      if (!env.WRITE_TOKEN || auth !== `Bearer ${env.WRITE_TOKEN}`) {
        return new Response("Unauthorized", { status: 401, headers: corsHeaders() });
      }

      const text = (await req.text()).trim();
      if (!text) {
        return new Response("Empty body", { status: 400, headers: corsHeaders() });
      }

      const lines = text.split("\n").filter((l) => l.trim().length > 0);
      for (const line of lines) {
        try {
          JSON.parse(line);
        } catch {
          return new Response(`Invalid JSON line: ${line.slice(0, 80)}`, { status: 400, headers: corsHeaders() });
        }
      }

      // Append to R2.
      const existing = await env.EVENTS.get(KEY);
      let buffer = existing ? await existing.text() : "";
      if (buffer.length > 0 && !buffer.endsWith("\n")) buffer += "\n";
      buffer += lines.join("\n") + "\n";
      await env.EVENTS.put(KEY, buffer, {
        httpMetadata: { contentType: "application/x-ndjson" },
      });

      // Broadcast to live subscribers — best-effort; an SSE hiccup must not fail the write.
      try {
        const id = env.BROADCASTER.idFromName(BROADCAST_ID);
        const stub = env.BROADCASTER.get(id);
        await stub.fetch(
          new Request("https://do/broadcast", {
            method: "POST",
            body: lines.join("\n"),
          }),
        );
      } catch (err) {
        console.warn("broadcast failed (non-fatal):", err);
      }

      return new Response(JSON.stringify({ ok: true, appended: lines.length }), {
        status: 200,
        headers: corsHeaders({ "Content-Type": "application/json" }),
      });
    }

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
