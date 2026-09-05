/**
 * Dashboard suggestions panel: renders the pure engine's output ordered by
 * severity, each row resolving `rule.<id>.title/.detail` through i18n with
 * the suggestion's interpolation params, plus an evidence button the view
 * wires to scroll-and-highlight location. (The session-scope variant renders
 * its suggestions as plain text inside SessionList — no cross-panel anchors.)
 * @module @qihongmu/dsh-client-ui-token-tracing/src/client/dashboard/SuggestionsPanel
 */

import type { ReactNode } from 'react'
import type { TokenTracingKey } from '../locales.ts'
import type { Translate } from '../translate.ts'
import type { Suggestion, SuggestionEvidence, SuggestionSeverity } from './suggest.ts'
import css from './Dashboard.module.css'

interface SuggestionsPanelProps {
  suggestions: readonly Suggestion[]
  onLocate: (evidence: SuggestionEvidence) => void
  t: Translate
}

function severityClass(severity: SuggestionSeverity): string | undefined {
  switch (severity) {
    case 'high': return css.sevHigh
    case 'medium': return css.sevMedium
    case 'info': return css.sevInfo
  }
}

/**
 * One suggestion row: severity dot, i18n copy, and — in the panel variant —
 * the evidence button wired to scroll-and-highlight location. The session
 * detail renders the inline variant (no `onLocate`, no cross-panel anchors).
 */
export function SuggestionRow({ suggestion, onLocate, t }: {
  suggestion: Suggestion
  onLocate?: (evidence: SuggestionEvidence) => void
  t: Translate
}): ReactNode {
  return (
    <div className={css.suggestRow}>
      {onLocate === undefined ? null : <span className={`${css.sevDot} ${severityClass(suggestion.severity)}`} />}
      <div className={css.suggestBody}>
        <div className={css.suggestTitle}>
          {t(`rule.${suggestion.ruleId}.title` as TokenTracingKey, suggestion.params)}
        </div>
        <div className={css.suggestDetail}>
          {t(`rule.${suggestion.ruleId}.detail` as TokenTracingKey, suggestion.params)}
        </div>
      </div>
      {onLocate === undefined
        ? null
        : (
            <button
              type="button"
              className={css.evidenceButton}
              onClick={() => { onLocate(suggestion.evidence) }}
            >
              {t('dashboard.suggest.locate')} →
            </button>
          )}
    </div>
  )
}

export function SuggestionsPanel({ suggestions, onLocate, t }: SuggestionsPanelProps): ReactNode {
  return (
    <section className={css.section}>
      <div className={css.sectionTitle}>{t('dashboard.suggest.title')}</div>
      {suggestions.length === 0
        ? <div className={css.suggestNone}>{t('dashboard.suggest.none')}</div>
        : (
            <div className={css.suggestList}>
              {suggestions.map(suggestion => (
                <SuggestionRow key={suggestion.ruleId} suggestion={suggestion} onLocate={onLocate} t={t} />
              ))}
            </div>
          )}
    </section>
  )
}
