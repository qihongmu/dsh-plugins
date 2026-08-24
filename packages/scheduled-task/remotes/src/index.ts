/**
 * External scheduled-tasks remotes assembly (node half): mounts the vendored
 * `scheduledTasks` Remote contribution in the browser. The mount must live in
 * its own entry so the UI entry can declare `remote.scheduledTasks` in its
 * inject list — cordis priviledges a consuming fiber to read a Remote
 * namespace only when a different, earlier-activated entry provided it.
 * @module @deepseek-ai/dsh-client-remotes-scheduled-task
 */

/** Host loader entry for the browser-only remotes assembly plugin. */

/** Provides no host-side behavior. */
export function apply(): void {}