/**
 * Injected face + Remote typing for the external scheduled-tasks sidebar panel.
 */

import type { TypertRemoteNamespaceMap } from '@deepseek-ai/dsh-typert-protocol'
// Type-only: pulls the `sidebar.footer.action` SlotMap owner poll (the `wide` prop).
import type {} from '@deepseek-ai/dsh-client-ui-sidebar/client'
// Type-only: pulls the client 服务' `Context` merge (ctx.remote behavior) and the
// locale/slot Context augments; the scheduledTasks namespace merge comes from the
// vendored `@qihongmu/dsh-plugins-scheduled-task/remote`.
import type {} from '@deepseek-ai/dsh-client-runtime/client'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@qihongmu/dsh-plugins-scheduled-task/remote'

/** The typed `scheduledTasks` Remote namespace the panel drives. */
export type ScheduledTasksRemote = TypertRemoteNamespaceMap['scheduledTasks']

/** One selectable project (DSH workspace) row for the create-form project selector. */
export interface ScheduledTaskProjectOption {
  /** Stable workspace identity sent back as `workspace_id` on create/update. */
  readonly workspaceId: string
  /** Display title (defaults to the directory basename). */
  readonly title: string
  /** Canonical project directory used as the run session `cwd`. */
  readonly path: string
}

/** One selectable provider/model row for the create-form model selector. */
export interface ScheduledTaskModelOption {
  /** Registered provider route id (e.g. `openrouter`). */
  readonly providerId: string
  /** Provider display name. */
  readonly providerName: string
  /** Provider-owned model id sent back as `model.model`. */
  readonly modelId: string
  /** Model display name. */
  readonly modelName: string
}

/**
 * Registrant-private injected share (arrives via the register inject factory):
 * the live Remote namespace plus the two option loaders backing the create
 * form's project and model selectors. Loaders throw on wire failure; the form
 * surfaces the message inline and keeps the field optional.
 */
export interface ScheduledTasksPanelFace {
  readonly remote: ScheduledTasksRemote
  /** List registered workspaces (projects) in registry display order. */
  readonly listProjects: () => Promise<readonly ScheduledTaskProjectOption[]>
  /**
   * Flatten the current conversation session's advisory model catalog into
   * selectable rows. Empty when no conversation session is open (the task then
   * runs with the deployment default model).
   */
  readonly listModels: () => Promise<readonly ScheduledTaskModelOption[]>
}
