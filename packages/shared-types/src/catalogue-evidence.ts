/** Recognise only a single catalogue-absence statement backed by a completed lookup. */
export function isCatalogueAbsenceStatement(text: string, missingSkus: Iterable<string> = []): boolean {
  const plain = text.replace(/[*`“”"‘’]/g, '').replace(/^\s*(?:[-•>]\s*|\d+[.)]\s*)/, '').replace(/^\s*factual statement(?: from the lookup)?:\s*/i, '').replace(/[.!?]+$/, '').replace(/\s+/g, ' ').trim().toLowerCase();
  for (const sku of missingSkus) {
    const id = sku.toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const subject = `(?:product )?sku[:#]? ${id}`;
    const where = '(?:in (?:our|the) (?:catalogue|catalog|range)|on file)';
    if (new RegExp(`^(?:(?:i|we) (?:couldn[’']t|could not|didn[’']t|did not|can[’']t|cannot) find (?:exact )?(?:product )?(?:sku[:#]? )?${id} ${where}|${subject} (?:(?:was |is )?not found(?: ${where})?|does not exist ${where}))$`, 'i').test(plain)) return true;
  }
  return false;
}
