/**
 * Type face for the vendored runtime Remote contribution
 * (`remote-client.js`). The runtime file is hand-vendored output carrying the
 * `tokenTracing` descriptors (including the `follow` stream); this face pins
 * its default export to the public contribution type.
 * @module @qihongmu/dsh-client-remotes-token-tracing/src/client/remote-client
 */
import type { TypertRemoteContribution } from '@deepseek-ai/dsh-typert-protocol'

declare const TYPERT_REMOTE: TypertRemoteContribution

export default TYPERT_REMOTE
