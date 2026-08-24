/**
 * External scheduled-tasks sidebar panel (browser half): registers a
 * `sidebar.footer.action` entry whose trigger opens a right-docked drawer with
 * two views — the 已安排的任务 history list (search/filter/hover actions) and
 * the 新建定时任务 create/edit form (schedule presets, instruction prompt,
 * project workspace, confirm-before-change, model). The `scheduledTasks`
 * Remote namespace is provided by the sibling remotes assembly entry
 * (`@deepseek-ai/dsh-client-remotes-scheduled-task`), which activates first —
 * this entry declares it plus `connection`/`sessions` (the project and model
 * option catalogs) in its inject list so cordis grants the guarded reads.
 * @module @deepseek-ai/dsh-client-ui-scheduled-task/client
 */

import type { Context } from '@deepseek-ai/cordis'
import type { ConnectionHandle, WorkspaceView } from '@deepseek-ai/dsh-api-remotes/client'
import type {} from '@deepseek-ai/dsh-client-runtime/client'
import type { SessionRuntime } from '@deepseek-ai/dsh-client-runtime/client'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar/client'
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
 * and the connection/session runtimes backing the create form's option lists.
 */
export const inject = [
  'slots', 'locale', 'remote', 'remote.scheduledTasks', 'connection', 'sessions',
]

/** Register the scheduled-tasks sidebar panel over the mounted Remote namespace. */
export function apply(ctx: Context): void {
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'ui-scheduled-task: dictionaries')
  const sessions = ctx.get('sessions') as SessionRuntime
  const connection = ctx.get('connection') as ConnectionHandle
  ctx.slots.inject('sidebar.footer.action', () => ctx.slots.register({
    name: 'sidebar.footer.action',
    id: 'scheduled-tasks',
    locale: NS,
    inject: (): ScheduledTasksPanelFace => ({
      remote: ctx.remote.scheduledTasks,
      listProjects: async () => {
        const response = await connection.api.workspace.list({})
        if (!response.result.ok) {
          throw new Error(`${response.result.error.code}: ${response.result.error.message}`)
        }
        return response.result.value.items.map((item: WorkspaceView) => ({
          workspaceId: String(item.workspaceId),
          title: item.title,
          path: item.path,
        }))
      },
      listModels: async () => {
        // The advisory catalog is session-scoped; borrow the open conversation's.
        const sessionId = sessions.list.getSnapshot().current
        if (sessionId === undefined) return []
        const response = await connection.api.sessions.models({ sessionId })
        if (!response.result.ok) {
          throw new Error(`${response.result.error.code}: ${response.result.error.message}`)
        }
        const rows: ScheduledTaskModelOption[] = []
        for (const group of response.result.value.groups) {
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
