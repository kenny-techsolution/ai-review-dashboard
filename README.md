# AI PR Review · Metrics Dashboard

Public, GitHub-Pages-hosted metrics dashboard for the [AI PR Reviewer](https://github.com/kenny-techsolution/ai-pr-reviewer). Reads live event data sync'd from PR-review runs in [pos-lite](https://github.com/kenny-techsolution/pos-lite).

**Live URL:** https://kenny-techsolution.github.io/ai-review-dashboard

## What it shows

Five strategic dimensions in plain English:

| Panel | Question it answers |
|---|---|
| 💰 **Money** | Is the AI reviewer paying for itself? *(net $ saved · ROI · per-PR effectiveness)* |
| ⚡ **Speed** | Are PRs shipping faster? *(median cycle time · per-tier compression · bug-fix cycle)* |
| 🛡️ **Safety** | Is it safe? *(T3 escapes broken down by detection source)* |
| 📈 **Acceptance** | Are engineers accepting it? *(agreement rate · comment-addressed rate · suggestion-apply rate · override outliers)* |
| 📊 **Drifting** | Is the system drifting? *(4-week sparklines on cost · latency · backtest accuracy · proactive detection)* |

Each metric has an inline explanation tooltip (hover the `i` icon) and a methodology drilldown.

## Architecture

```
kenny-techsolution/pos-lite                 ← target repo · PRs land here
        │
        ▼
.github/workflows/ai-review.yml             ← reviewer Action fires per PR
        │
        ▼
artifacts/events.jsonl                      ← reviewer emits one structured event
        │
        ▼ (uploaded as Action artifact named "reviewer-events-{pr_id}")
        │
        ▼
scripts/sync-events.sh                      ← pulls latest artifacts, dedupes by PR
        │
        ▼
data/events.jsonl                           ← dashboard substrate (this repo)
        │
        ▼
index.html                                  ← fetches data/events.jsonl, renders the 5 panels
```

This is the same events schema the production dashboard would consume — see [`reviewer/src/types/index.ts`](https://github.com/kenny-techsolution/ai-pr-reviewer/blob/main/src/types/index.ts) in the reviewer repo for the full type definition.

## Refreshing the data

The dashboard is read-only. To pull new events from `pos-lite`'s recent Action runs:

```bash
bash scripts/sync-events.sh
git add data/events.jsonl
git commit -m "Sync events from pos-lite"
git push
```

GitHub Pages re-deploys automatically; the dashboard reflects the new data within a minute.

## Local development

The dashboard `fetch()`-es `data/events.jsonl` at page load. `file://` URLs fail CORS for fetch, so the dashboard ships an embedded sample dataset that activates as a fallback when the fetch fails.

To run locally with the real data:

```bash
python3 -m http.server 8000
# open http://localhost:8000
```

## Linked repos

- **[ai-pr-reviewer](https://github.com/kenny-techsolution/ai-pr-reviewer)** — the reviewer pipeline that emits these events (TypeScript · 4-layer signal stack + 3-agent specialist swarm + multi-provider LLM adapter)
- **[pos-lite](https://github.com/kenny-techsolution/pos-lite)** — synthetic fintech-shaped target repo where the reviewer runs on every PR

## Built for

A Staff/Principal IC interview demonstrating risk-tiered AI PR review at production grade. The dashboard is part of a larger artifact: the live reviewer at `ai-pr-reviewer`, the target repo at `pos-lite`, and this metrics surface here.

## Honesty

Numbers on this page are computed live from the event stream in `data/events.jsonl`. As of repo creation that's a small dataset (events from the initial demo PRs); it grows as more PRs land in `pos-lite`. Some metrics — e.g. weekly digest open rate, quarterly survey score, admin-merge bypass count — are inherently external-system signals and are sourced from production-only systems; in this public demo they're rendered with synthesized example values, clearly labeled where present.
