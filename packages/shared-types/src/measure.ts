/** UN/CEFACT measure codes stored by catalogues. Unknown codes remain unchanged. */
const UNITS: Readonly<Record<string, string>> = {
  MMT: 'mm', CMT: 'cm', MTR: 'm', KMT: 'km', INH: 'in', FOT: 'ft', YRD: 'yd',
  MMK: 'mm²', CMK: 'cm²', MTK: 'm²', MMQ: 'mm³', CMQ: 'cm³', MTQ: 'm³',
  MLT: 'mL', LTR: 'L', GLL: 'gal', GRM: 'g', KGM: 'kg', TNE: 't', LBR: 'lb', ONZ: 'oz',
  ANN: 'years', MON: 'months', DAY: 'days', HUR: 'hours', MIN: 'min', SEC: 's',
  CEL: '°C', WTT: 'W', KWT: 'kW', VLT: 'V', AMP: 'A', BAR: 'bar', PAL: 'Pa', KPA: 'kPa', NEW: 'N',
  PCE: 'pieces', SET: 'set', PR: 'pairs', P1: '%',
};

export function humanizeMeasure(value: unknown): string {
  const raw = String(value ?? '').replace(/\s+/g, ' ').trim();
  const match = raw.match(/^(-?\d+(?:,\d{3})*(?:\.\d+)?|-?\d+,\d+)\s*([A-Z0-9]{2,3})$/);
  return match && UNITS[match[2]] ? `${match[1]} ${UNITS[match[2]]}` : raw;
}

/** Deterministic equivalents for source-owned length measurements, never inferred room/product dimensions. */
export function metricLengthEquivalents(value: unknown): Record<string, number> | undefined {
  const match = humanizeMeasure(value).match(/^(-?\d+(?:,\d{3})*(?:\.\d+)?|-?\d+,\d+)\s*(mm|cm|m)$/);
  if (!match) return undefined;
  const factor = { mm: 1, cm: 10, m: 1000 }[match[2]]!;
  const number = /^-?[1-9]\d{0,2}(?:,\d{3})+(?:\.\d+)?$/.test(match[1]) ? match[1].replace(/,/g, '') : match[1].replace(',', '.');
  const mm = Number(number) * factor;
  const clean = (value: number) => Number(value.toPrecision(12));
  return { mm: clean(mm), cm: clean(mm / 10), m: clean(mm / 1000) };
}
