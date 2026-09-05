/**
 * Shared translate function type for the token-tracing view components. The
 * slot framework synthesizes a typed `t` from the declared locale namespace.
 * @module @qihongmu/dsh-client-ui-token-tracing/src/client/translate
 */

import type { TokenTracingKey } from './locales.ts'

/** Typed translate bound to the `token-tracing` namespace. */
export type Translate = (key: TokenTracingKey, params?: Record<string, string | number>) => string
