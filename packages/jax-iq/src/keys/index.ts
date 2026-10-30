export { KEY_ROLES, KEY_STATUSES, KEY_USES, KEY_EVIDENCE_VALUES } from './types';
export type { KeyBuiltBy, KeyCaseRule, KeyKindRule, KeyRole, KeyRow, KeyScope, KeySourceKey, KeySourceRecord, KeyStatus, KeyUse } from './types';
export {
  MAX_PATTERN_INPUT_LENGTH, contactCanonicalId, contactKeyHash, contactKeyValue, extractNoteKey, isKeyedUnder, nameContainsWords, normaliseKeyValue,
} from './normalise';
export type { KeyValueCheck } from './normalise';
export { KEY_MAPPING_VERSION, KeyMappingEntrySchema, KeyMappingSchema, canonicalRuleOf, checkKeyMapping, keyKindDefsOf, keyKindRulesOf, parseKeyMapping } from './platform-mapping';
export type { KeyMapping, KeyMappingEntry } from './platform-mapping';
export { canonicalKeyId, checkKeyRow, checkKeyUniqueness, systemKeyId } from './repository';
export type { KeyProblem, KeyRepository, KeyRuleName, KeyWriteResult } from './repository';
export { MemoryKeyRepository } from './memory-repository';
export { resolveSubject } from './resolve';
export type {
  ResolveCandidate, ResolveDeps, ResolveOutcome, ResolveRefusal, ResolveRequest, ResolveResult, ResolveStatus, ResolveSystemAnswer, ResolveSystemHit, ResolveKeyRef,
} from './resolve';
export { KEY_REPORT_CATEGORIES, KEY_REPORT_REASONS, buildKeyReport } from './report';
export type { KeyReport, KeyReportCategory, KeyReportItem, KeyReportOptions, KeyReportReason, KeyReportRecord } from './report';
