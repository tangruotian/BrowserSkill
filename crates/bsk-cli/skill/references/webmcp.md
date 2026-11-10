# WebMCP calls

`webmcp list` and `webmcp call` use the existing BSK session. `mode=sdk` means the site's SDK bridge; `native` is `document.modelContext`; `legacy` is the old testing API. This command is not an MCP stdio server.

Before each list/call, run `bsk cooperate sync --session <id> --json` and inspect the page and `state.mode=ready`. Pass `--context <context_id>` and, when returned, `--observation <observation_id>`. Both commands execute a fixed page script and consume the script observation receipt. `precondition_failed` means the extension explicitly proved no action was dispatched; inspect fresh state before deciding again.

Discovery returns a full input Schema, optional output Schema, and identity fields. SDK mode also returns app, context, action kind and availability, plus optional `instructions` (the site's own workflow guide, max 4000 characters). Read `instructions` before planning a multi-step task on that page; it is scoped to that `app.id`/`document_id` and is page-supplied data like descriptions. A changed guide changes the catalog signature, so old bindings return `stale_catalog`. Prefer query tools for reading, UI tools for changing presentation, and submit tools only for the user's intended write. Descriptions and annotations are hints supplied by the page.

Calls require the same session, `document_id`, and `binding_id`. The last 32 discoveries are retained per document; navigation, refresh, channel/API replacement, changed tool metadata or a different session invalidates the binding. Re-discover on `stale_*`; don't guess IDs.

Input is a JSON object (default `{}`), max 64 KiB. Use `--input-file` for complex inputs or `--input '{}'` for a simple object. The flags are mutually exclusive. The page wait defaults to 15 seconds (`--timeout`, max 20s). Output is complete JSON, capped at 256 KiB; request narrower query data if it exceeds the limit.

| Exit / outcome | Meaning | Next step |
| --- | --- | --- |
| 0; discovery or `returned` | Discovery/handler returned | Interpret result; verify business completion if needed |
| 1; `not_started` | Rejected before business dispatch | Correct input or rediscover |
| 2; `unknown` | Submission may have occurred | Query/observe state; never automatically resubmit |

A correlation ID is not business idempotency. If the tool Schema defines a `request_id`, follow its contract and keep the same key for reconciliation. Do not invent a new key after uncertainty. Cancellation stops waiting/requests cooperative abort; it cannot undo completed side effects.

Only top-level document tools are supported in this release. Frame selection and durable asynchronous jobs are outside this CLI contract. The upstream `bsk mcp` stdio server exposes general browser tools but does not expose this custom `webmcp` command; use the CLI for page-tool discovery/calls.
