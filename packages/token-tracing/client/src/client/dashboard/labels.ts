/**
 * Shared display label resolution for byComponent keys: a bare kind renders
 * through the localized kind table; a composite `kind/name` key (e.g.
 * `tool-result/read`) renders as 「kind·name」. Unknown kinds fall through to
 * the unattributed label via `kindLabel`.
 * @module @qihongmu/dsh-client-ui-token-tracing/src/client/dashboard/labels
 */

import { kindLabel } from '../component-meta.ts'
import type { Translate } from '../translate.ts'

export function labelForKey(key: string, t: Translate): string {
  const slash = key.indexOf('/')
  if (slash < 0) return kindLabel(key, t)
  return `${kindLabel(key.slice(0, slash), t)}·${key.slice(slash + 1)}`
}
