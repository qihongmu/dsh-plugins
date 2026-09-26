/* Vendored by hand for this external plugin (the DSH generator cannot see
 * external repos — see FEASIBILITY.md). Host-face TYPERT manifest: the
 * invocation descriptors are the SAME objects the vendored client
 * contribution carries (single source of truth; the loader/registry
 * validation treats both faces identically for direct, non-lookup methods),
 * and `model` carries the minimal reflection face the loader accepts.
 * Kept in sync with host/src/types.ts and typert.remote-client.js.
 */
import TYPERT_REMOTE from './typert.remote-client.js'

export const TYPERT = {
  package: '@qihongmu/dsh-plugins-scheduled-task',
  face: 'host',
  schemas: [],
  invocations: TYPERT_REMOTE.descriptors,
  model: {
    services: [
      {
        key: 'scheduledTasks',
        exportName: 'ScheduledTaskService',
        summary: 'Global scheduled tasks: durable registry, scheduler, delivery, Remote surface.',
        tags: [],
        members: [
          { name: 'list', signature: '() => Promise<RemoteResult<ScheduledTaskView[]>>', kind: 'method' },
          { name: 'create', signature: '(input: ScheduledTaskCreateInput) => Promise<RemoteResult<ScheduledTaskMutationResult>>', kind: 'method' },
          { name: 'update', signature: '(id: ScheduledTaskId, input: ScheduledTaskUpdateInput) => Promise<RemoteResult<ScheduledTaskMutationResult>>', kind: 'method' },
          { name: 'setStatus', signature: '(id: ScheduledTaskId, status: ScheduledTaskSettableStatus) => Promise<RemoteResult<ScheduledTaskMutationResult>>', kind: 'method' },
          { name: 'delete', signature: '(id: ScheduledTaskId) => Promise<RemoteResult<ScheduledTaskDeleteResult>>', kind: 'method' },
          { name: 'markRead', signature: '(id: ScheduledTaskId) => Promise<RemoteResult<null>>', kind: 'method' },
        ],
        types: [],
      },
    ],
    events: [],
    objects: [],
  },
}
