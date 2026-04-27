# Events ingestion Worker

A Cloudflare Worker that:

- **Ingests** reviewer events POSTed by `pos-lite`'s GitHub Action — appends each to `events.jsonl` in an R2 bucket
- **Serves** the current `events.jsonl` to the public dashboard via a CORS-enabled GET endpoint

## Deploy in 4 commands (~10 min the first time)

You need a Cloudflare account (free) and the Wrangler CLI:

```bash
npm install -g wrangler
wrangler login          # browser auth
```

Then from this directory:

```bash
# 1. Install local deps (just for typecheck)
npm install

# 2. Create the R2 bucket
wrangler r2 bucket create ai-review-events

# 3. Generate + set the write secret (the auth token pos-lite will use)
openssl rand -hex 32 | wrangler secret put WRITE_TOKEN
#  ↑ when prompted "Enter a secret value", paste the random hex.
#    Save it locally too — pos-lite needs the same value.

# 4. Deploy
wrangler deploy
```

Wrangler prints the deployed URL — something like:

```
https://ai-review-events.<your-cf-subdomain>.workers.dev
```

That URL is the events endpoint. Save it.

## Verify it's live

```bash
curl https://ai-review-events.<your-subdomain>.workers.dev/healthz
# expect: OK

curl https://ai-review-events.<your-subdomain>.workers.dev/events.jsonl
# expect: empty (no events posted yet)
```

## Wire it into pos-lite (one-time)

Add the Worker URL + write token as secrets on `kenny-techsolution/pos-lite`:

```bash
gh secret set CF_WORKER_URL --repo kenny-techsolution/pos-lite
# paste the Worker URL when prompted

gh secret set CF_WRITE_TOKEN --repo kenny-techsolution/pos-lite
# paste the same hex string from step 3 above
```

Then pos-lite's `.github/workflows/ai-review.yml` posts each event to `${CF_WORKER_URL}/events` after the reviewer runs (see the `Push event to dashboard` step there).

## Wire it into the dashboard (one-time)

Set the URL constant in the dashboard's `index.html`:

```js
const RAW_EVENTS_URL = "https://ai-review-events.<your-subdomain>.workers.dev/events.jsonl";
```

Push, GitHub Pages rebuilds once. From then on, every Worker write is visible to the dashboard within ~2–5s (cache-bust query param defeats CDN caching).

## Endpoints

| Method | Path | Auth | Description |
|---|---|---|---|
| GET  | `/events.jsonl` | none (public) | Returns the full events.jsonl, no-cache headers |
| GET  | `/events`       | none (public) | Same as `/events.jsonl` |
| POST | `/events`       | `Bearer <WRITE_TOKEN>` | Appends one or more JSON lines to the file |
| PUT  | `/events`       | `Bearer <WRITE_TOKEN>` | Replaces the entire file (one-shot reseed) |
| GET  | `/healthz`      | none | Returns `OK` |

## Reseed with current events (one-shot)

If you want to bootstrap the R2 file with the events already collected from
`pos-lite`'s past Action artifacts:

```bash
WORKER_URL="https://ai-review-events.<your-subdomain>.workers.dev"
WRITE_TOKEN="<the hex from step 3>"
curl -X PUT "$WORKER_URL/events" \
  -H "Authorization: Bearer $WRITE_TOKEN" \
  -H "Content-Type: application/x-ndjson" \
  --data-binary @../data/events.jsonl
```

## Cost

Free tier covers our usage by orders of magnitude:

| Resource | Free tier | Our usage |
|---|---|---|
| R2 storage | 10 GB | < 1 KB total |
| R2 Class A operations | 1M / month | ~30 / day |
| R2 Class B operations | 10M / month | ~hundreds / day at most |
| Worker requests | 100K / day | < 100 / day |

Monthly bill: $0.
