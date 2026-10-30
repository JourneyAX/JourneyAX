export { mergeFacts } from './facts';
export type {
  AnswerFailure, AnswerFailureReason, BindingResult, BoundAnswer, FactSource, FactUnavailable, FactUnavailableReason, MergeBinding, MergeFactDef,
  MergeFactsInput, MergedFact, SystemLabel,
} from './facts';
export { mergeLists } from './lists';
export type { MergeListItem, MergeListSource, MergedList, MergedListItem } from './lists';
export { applyStateMap, indexStateMaps, listLossyStateMaps } from './state-map';
export type { LossyStateMapNote, StateMapConversion } from './state-map';
export { valuesAgree } from './crosscheck';
export type { FactCrossCheck } from './crosscheck';
