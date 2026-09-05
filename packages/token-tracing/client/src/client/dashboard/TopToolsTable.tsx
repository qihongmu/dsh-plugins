/**
 * Dashboard Top-tools table (two-column right): per-tool range tokens,
 * request-side share, range-scoped session reach, and period-over-period Δ.
 * @module @qihongmu/dsh-client-ui-token-tracing/src/client/dashboard/TopToolsTable
 */

import type { ReactNode } from 'react'
import { formatTokens } from '../format.ts'
import type { Translate } from '../translate.ts'
import type { ToolRow } from './aggregate.ts'
import type { SuggestionEvidence } from './suggest.ts'
import css from './Dashboard.module.css'

interface TopToolsTableProps {
  rows: readonly ToolRow[]
  locate: SuggestionEvidence | null
  t: Translate
}

const TOP = 10

export function TopToolsTable({ rows, locate, t }: TopToolsTableProps): ReactNode {
  const locatedTool = locate?.kind === 'tool' ? locate.key : null
  return (
    <section className={css.section}>
      <div className={css.sectionTitle}>{t('dashboard.tools.title')}</div>
      {rows.length === 0
        ? <div className={css.muted}>{t('dashboard.empty.title')}</div>
        : (
            <table className={css.table}>
              <thead>
                <tr>
                  <th className={css.th}>{t('dashboard.tools.tool')}</th>
                  <th className={css.th}>{t('dashboard.tools.tokens')}</th>
                  <th className={css.th}>{t('dashboard.tools.share')}</th>
                  <th className={css.th}>{t('dashboard.tools.reach')}</th>
                  <th className={css.th}>{t('dashboard.tools.delta')}</th>
                </tr>
              </thead>
              <tbody>
                {rows.slice(0, TOP).map(row => {
                  const located = locatedTool === row.tool
                  return (
                    <tr
                      key={row.tool}
                      className={located ? css.rowLocated : undefined}
                      data-locate={located ? `tool:${row.tool}` : undefined}
                    >
                      <td className={css.td}>{row.tool}</td>
                      <td className={`${css.td} ${css.num}`}>{formatTokens(row.tokens)}</td>
                      <td className={`${css.td} ${css.num}`}>{Math.round(row.share * 100)}%</td>
                      <td className={`${css.td} ${css.num}`}>{String(row.reach)}</td>
                      <td className={`${css.td} ${css.num}`}>
                        {row.delta === undefined
                          ? <span className={css.deltaFlat}>—</span>
                          : (
                              <span className={row.delta > 0 ? css.deltaBad : css.deltaGood}>
                                {row.delta > 0 ? '↑' : '↓'}
                                {' '}
                                {Math.round(Math.abs(row.delta) * 100)}%
                              </span>
                            )}
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          )}
    </section>
  )
}
