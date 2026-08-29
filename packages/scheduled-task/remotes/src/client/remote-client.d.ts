/**
 * Type face for the vendored runtime Remote contribution
 * (`remote-client.js`). The runtime file is generated output carrying the
 * `scheduledTasks` descriptors; this face pins its default export to the
 * public contribution type.
 * @module @qihongmu/dsh-client-ui-scheduled-task/src/client/remote-client
 */
import type { TypertRemoteContribution } from '@deepseek-ai/dsh-typert-protocol'

declare const TYPERT_REMOTE: TypertRemoteContribution

export default TYPERT_REMOTE
