/**
 * What the dictionary merge and the release checks report: one record per finding, with a stable code, a severity, where it is and a
 * plain sentence. An error stops a release; a warning is listed so a person sees it. Each code has exactly one severity, fixed here, so
 * a caller can filter on `severity` without knowing the codes.
 *
 * A rule added after version 1 must be a warning: a stored release is read again on every load, and a new error would lock out a
 * release that was fine when it was published.
 */

export type DictionaryIssueSeverity = 'error' | 'warning';

const SEVERITY_OF = {
  schema: 'error',
  duplicate_id: 'error',
  merge_duplicate_part: 'error',
  merge_replace_invalid: 'error',
  merge_unredirectable: 'error',
  r1_system_unavailable: 'error',
  r2_tool_not_read: 'error',
  r3_tool_blocked_for_all: 'warning',
  r4_unknown_name: 'error',
  r4_name_mismatch: 'error',
  r5_no_self_test: 'error',
  r5_no_source: 'warning',
  r5_active_thing_unbound: 'error',
  r6_contract_incomplete: 'error',
  r6_contract_unknown: 'warning',
  r8_signal_setting_unset: 'error',
  r8_signal_unsigned: 'error',
  r9_setting_unset: 'warning',
  r10_person_scoped_connector: 'error',
  r11_scope_refused: 'error',
  r11_clause_refused: 'error',
  r12_path: 'error',
  r12_address: 'error',
  r12_secret: 'error',
  r13_claim_class_unknown: 'error',
  r14_state_map_lossy: 'warning',
  freshness_setting_missing: 'error',
  engine_setting_missing: 'error',
  claim_class_needs_guard: 'error',
  contract_change_unnamed: 'error',
  rule_mode_unsupported: 'error',
} as const satisfies Record<string, DictionaryIssueSeverity>;

export type DictionaryIssueCode = keyof typeof SEVERITY_OF;

/** Every code there is, in the order they are declared. */
export const DICTIONARY_ISSUE_CODES = Object.keys(SEVERITY_OF) as DictionaryIssueCode[];

export interface DictionaryIssue {
  code: DictionaryIssueCode;
  severity: DictionaryIssueSeverity;
  /** Where the finding is, for example `bindings[3].system`. */
  path: string;
  message: string;
}

export function dictionaryIssue(code: DictionaryIssueCode, path: string, message: string): DictionaryIssue {
  return { code, severity: SEVERITY_OF[code], path, message };
}

/** `issuePath('bindings', 3, 'system')` is `bindings[3].system`: names joined by dots, positions in brackets. */
export function issuePath(...segments: ReadonlyArray<string | number | symbol>): string {
  return segments.reduce<string>((text, segment) => {
    if (typeof segment === 'number') return `${text}[${segment}]`;
    return text === '' ? String(segment) : `${text}.${String(segment)}`;
  }, '');
}

/** The severity a code always has. */
export function severityOf(code: DictionaryIssueCode): DictionaryIssueSeverity {
  return SEVERITY_OF[code];
}
