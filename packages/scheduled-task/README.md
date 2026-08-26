# @deepseek-ai/dsh-plugins-scheduled-task

Global scheduled tasks for DeepSeek Harness as a **pure external plugin**:
register a task once (instruction + schedule) and the host fires it into its
own conversation on schedule.

## Packages

| Half | Package | Role |
|------|---------|------|
| `host/` | `@deepseek-ai/dsh-plugins-scheduled-task` | Durable registry (storage-domain table), scheduler, run-session delivery, `scheduledTasks/*` Remote surface |
| `remotes/` | `@deepseek-ai/dsh-client-remotes-scheduled-task` | Browser-side Remote mount (vendored typert client schema) |
| `client/` | `@deepseek-ai/dsh-client-ui-scheduled-task` | Sidebar trigger + right drawer: list/search/filters, inline schedule editor, create/edit form |

## Schedule selectors

One-shot: `after_seconds`, `at` (absolute local calendar), `every_seconds`
(fixed rate ≥ 300s from creation). Wall-clock presets with IANA time zones:
`hourly {minute}`, `daily {time,tz}`, `weekly {weekdays 1=Mon..7,time,tz}`,
`monthly {dayOfMonth,time,tz}` (months without the day are skipped; DST-skipped
local times march to the next day).

Run sessions derive per task+project (`task-<id>-<cwd-hash>`): editing the
project starts a fresh conversation inside the new workspace; returning to an
earlier project re-attaches that project's history. Titles are pinned to the
task title via the session-title service.

## Development

From the repository root (see ../README.md "Setup"):

```sh
npm run bootstrap   # link against your local DeepSeek Harness checkout
npm run build && npm test && npm run verify
```

Unit suites live in `host/tests/` (domain math, record schema, service
behavior) and `client/tests/` (formatting helpers). The vendored typert
artifacts — `host/lib/typert.remote-client.d.ts` and
`remotes/src/client/remote-client.js` — mirror `host/src/types.ts` by hand;
update both together with any wire-model change.
