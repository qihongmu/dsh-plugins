/**
 * Client-face type for the plugin's `scheduledTasks` Remote namespace.
 *
 * The generated descriptors (runtime) live in the host package's `./remote`
 * artifact; this source-level module carries the namespace's TYPE so
 * `ctx.remote.scheduledTasks` widens through the merge-extensible
 * `TypertRemoteNamespaceMap`. Kept in sync with host/src/types.ts and the
 * vendored `typert.remote-client` artifacts.
 * @module @qihongmu/dsh-client-ui-scheduled-task/client/remote-namespace
 */
import type { RemoteResult } from '@deepseek-ai/dsh-typert-protocol'
import type {
  ScheduledTaskCreateInput,
  ScheduledTaskDeleteResult,
  ScheduledTaskId,
  ScheduledTaskMutationResult,
  ScheduledTaskSettableStatus,
  ScheduledTaskUpdateInput,
  ScheduledTaskView,
} from '@qihongmu/dsh-plugins-scheduled-task/types'

declare module '@deepseek-ai/dsh-typert-protocol' {
  interface TypertRemoteNamespace$7363686564756c65645461736b73 {
    create: (input: ScheduledTaskCreateInput) => Promise<RemoteResult<ScheduledTaskMutationResult>>
    delete: (id: ScheduledTaskId) => Promise<RemoteResult<ScheduledTaskDeleteResult>>
    list: () => Promise<RemoteResult<ScheduledTaskView[]>>
    markRead: (id: ScheduledTaskId) => Promise<RemoteResult<null>>
    setStatus: (id: ScheduledTaskId, status: ScheduledTaskSettableStatus) => Promise<RemoteResult<ScheduledTaskMutationResult>>
    update: (id: ScheduledTaskId, input: ScheduledTaskUpdateInput) => Promise<RemoteResult<ScheduledTaskMutationResult>>
  }
  interface TypertRemoteMap {
    'scheduledTasks/create': (input: ScheduledTaskCreateInput) => Promise<RemoteResult<ScheduledTaskMutationResult>>
    'scheduledTasks/delete': (id: ScheduledTaskId) => Promise<RemoteResult<ScheduledTaskDeleteResult>>
    'scheduledTasks/list': () => Promise<RemoteResult<ScheduledTaskView[]>>
    'scheduledTasks/markRead': (id: ScheduledTaskId) => Promise<RemoteResult<null>>
    'scheduledTasks/setStatus': (id: ScheduledTaskId, status: ScheduledTaskSettableStatus) => Promise<RemoteResult<ScheduledTaskMutationResult>>
    'scheduledTasks/update': (id: ScheduledTaskId, input: ScheduledTaskUpdateInput) => Promise<RemoteResult<ScheduledTaskMutationResult>>
  }
  interface TypertRemoteNamespaceMap {
    'scheduledTasks': TypertRemoteNamespace$7363686564756c65645461736b73
  }
}
