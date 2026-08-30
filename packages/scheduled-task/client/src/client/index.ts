/**
 * External scheduled-tasks sidebar panel (browser half): registers a
 * `sidebar.footer.action` entry whose trigger opens a right-docked drawer with
 * two views — the 已安排的任务 history list (search/filter/hover actions) and
 * the 新建定时任务 create/edit form (schedule presets, instruction prompt,
 * project workspace, confirm-before-change, model). The `scheduledTasks`
 * Remote namespace is provided by the sibling remotes assembly entry
 * (`@qihongmu/dsh-client-remotes-scheduled-task`), which activates first —
 * this entry declares it plus `workspaces`/`remote.session` (the project and
 * model option catalogs) in its inject list so cordis grants the guarded reads.
 * @module @qihongmu/dsh-client-ui-scheduled-task/client
 */

import type { Context } from '@deepseek-ai/cordis'
import type { IWorkspaces } from '@deepseek-ai/dsh-api-workspace-controller/client'
import type { WorkspaceView } from '@deepseek-ai/dsh-api-workspace-controller/client'
// Type-only: the one assembly import that widens `ctx.remote` on `Context`,
// merges the first-party Remote namespaces (`session` for the model catalog),
// and re-exports the wire vocabulary this half reads.
import type {} from '@deepseek-ai/dsh-api-remotes/client'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar/client'
// Type-only: the renderer's `Context` merge provides `ctx.slots` (moved here
// from the removed `dsh-client-runtime` in dsh v0.1.2-alpha.1).
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import { en, NS, zh } from './locales.ts'
import type { ScheduledTaskKey } from './locales.ts'
import { ScheduledTasksPanel } from './ScheduledTasksPanel.tsx'
import type { ScheduledTaskModelOption, ScheduledTasksPanelFace } from './slots.ts'

// Merge the plugin's locale namespace into the shared map at the register site
// (the bundle resolves the built d.ts, so the augmentation must be co-located
// with the register call for `keyof LocaleNamespaceMap` to widen here).
declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    'scheduled-tasks': ScheduledTaskKey
  }
}

export { ScheduledTasksPanel } from './ScheduledTasksPanel.tsx'
export type {
  ScheduledTaskModelOption,
  ScheduledTaskProjectOption,
  ScheduledTasksPanelFace,
  ScheduledTasksRemote,
} from './slots.ts'

/**
 * Required services: the slot system, locale, the Remote key, the
 * `remote.scheduledTasks` namespace provided by the remotes assembly entry,
 * and the workspace state / session-model catalog backing the create form's
 * option lists.
 */
export const inject = [
  'slots', 'locale', 'remote', 'remote.scheduledTasks', 'workspaces', 'remote.session',
]

/** Register the scheduled-tasks sidebar panel over the mounted Remote namespace. */
export function apply(ctx: Context): void {
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'ui-scheduled-task: dictionaries')
  const workspaces = ctx.get('workspaces') as IWorkspaces
  ctx.slots.inject('sidebar.footer.action', () => ctx.slots.register({
    name: 'sidebar.footer.action',
    id: 'scheduled-tasks',
    locale: NS,
    inject: (): ScheduledTasksPanelFace => ({
      remote: ctx.remote.scheduledTasks,
      listProjects: async () => {
        // The client Workspace runtime keeps `list` fed by its own follow
        // stream; by the time the create form opens, the boot baseline has
        // landed, so the snapshot read needs no RPC of its own.
        const items = workspaces.list.getSnapshot().items
        return items.map((item: WorkspaceView) => ({
          workspaceId: String(item.workspaceId),
          title: item.title,
          path: item.path,
        }))
      },
      listModels: async () => {
        // The advisory catalog is Host-generation scoped and session-free;
        // rows come flattened per provider group.
        const response = await ctx.remote.session.modelCatalog()
        if (!response.ok) {
          throw new Error(`${response.error.code}: ${response.error.message}`)
        }
        const rows: ScheduledTaskModelOption[] = []
        for (const group of response.value.groups) {
          for (const model of group.models) {
            rows.push({
              providerId: group.id,
              providerName: group.name,
              modelId: model.id,
              modelName: model.name,
            })
          }
        }
        return rows
      },
    }),
  }, ScheduledTasksPanel))
}
