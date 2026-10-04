// How an event's contracts relate (shared by the API and the decision ledger): 'threshold' (nested path levels),
// 'exclusive' (exactly one outcome resolves YES) or 'independent'.
export function distributionKindOf(event, contracts) {
  if (contracts.some((c) => /^YIELD_PATH_/.test(c.event_type || ''))) return 'threshold';
  if (event?.metadata?.mutually_exclusive === true || contracts.some((c) => ['MAX_TEMP_BUCKET', 'FOMC_DECISION_BUCKET'].includes(c.event_type))) return 'exclusive';
  return 'independent';
}
