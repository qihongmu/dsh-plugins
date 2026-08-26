# Scheduled Tasks

A global scheduler for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness): write an instruction once, and the assistant runs it on your schedule — every hour / day / week / month, at a specific time, or after a delay — each run in its own conversation.

## Opening the panel

Click the **Scheduled Tasks** trigger in the sidebar to open the drawer.

## Creating a task

In the drawer, click **Create** and fill in:

| Field | Meaning |
| ----- | ------- |
| **Title** | A short label. If left blank, the first 40 characters of the instruction are used. |
| **Schedule** | One of the presets below. |
| **Instruction** | What the assistant should do when the task fires. |
| **Project** | Which workspace/project directory the task runs in (optional — the default directory is used when unset). |
| **Model** | Which model to run with (optional — the default model is used when unset). |
| **Confirm before changes** | When enabled, each run asks for confirmation before sensitive actions such as writes. |

### Schedule presets

- **Every hour** — at a chosen minute (0–59).
- **Every day** — at a wall-clock time.
- **Every week** — at a time on one or more selected weekdays.
- **Every month** — on a day of the month (months without that day are skipped).
- **Custom**
  - **At a time** — a specific date and time (runs once).
  - **After a delay** — runs once after a number of seconds.

The timezone is shown as a GMT offset (e.g. `GMT+8`). Click it to edit the underlying IANA region (e.g. `Asia/Shanghai`).

## Managing tasks

- **Pause / Resume** — stop or continue a recurring task.
- **Edit** — change the title, schedule, project, model, or confirmation setting.
- **Delete** — remove the task and its live run session.
- **Mark read** — click a row to clear its unread badge.
- **Search / Filter** — find tasks by title, or filter by All / Active / Paused.

### Status indicators

- **Unread dot** — the task ran and you haven't read it yet.
- **Overdue** — a recurring task is past its scheduled time (it fires on the next tick).
- **Last run failed** — the previous run could not start (hover for the error); the task retries automatically with backoff.
- **Completed** — a one-shot task that has already fired.

## Notes

- Every task runs in its own conversation, titled with the task title.
- Each task runs under its bound **Project**: changing the project starts a fresh conversation in the new workspace, and switching back re-attaches the old conversation.
- Wall-clock presets follow the selected timezone's daylight-saving rules — a skipped local time (e.g. spring-forward) moves to the next day.
