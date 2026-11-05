import { operationalDesksFor, type OperationalDesk } from '@journeyax/business-pack';
import { iqQueryForSource, iqRecordsView, readIqPath, type IqClient } from '@journeyax/jax-iq';
import { executeIqTool, iqEnabled } from '../agent/iq-tools';
import type { AgentToolContext } from '../agent/agent-tools';

export function deskSummaries(ctx: Pick<AgentToolContext, 'release' | 'principal'>) {
  if (!iqEnabled(ctx.release)) return [];
  return operationalDesksFor(ctx.release.extensions?.operationalDesks, ctx.principal ?? { audience: 'shopper', groups: [] }).map(desk => ({ deskId: desk.deskId, title: desk.title, description: desk.description, ...(desk.recordType ? { recordType: desk.recordType } : {}), ...(desk.board ? { boardTitle: desk.board.title } : {}) }));
}

/** Chat and canvases use this same IQ read. No direct connector or separate staff LLM fallback exists. */
export async function readOperationalDesk(deskId: string, recordId: string | undefined, ctx: AgentToolContext, client?: IqClient, cursor?: string) {
  if (!iqEnabled(ctx.release)) return { ok: false as const, code: 'not_configured' };
  const desk = operationalDesksFor(ctx.release.extensions?.operationalDesks, ctx.principal ?? { audience: 'shopper', groups: [] }).find(entry => entry.deskId === deskId);
  if (!desk) return { ok: false as const, code: 'not_allowed' };
  if (recordId !== undefined && (typeof recordId !== 'string' || !recordId || recordId.length > 200 || /[\u0000-\u001f\u007f]/.test(recordId))) return { ok: false as const, code: 'invalid_request' };
  const source = recordId ? desk.detail.source : desk.source;
  const pageBindingId = recordId ? desk.pagination?.detailBindingId : desk.pagination?.listBindingId;
  if (cursor !== undefined && (!pageBindingId || typeof cursor !== 'string' || !cursor || cursor.length > 1000 || /[\u0000-\u001f\u007f]/.test(cursor) || !Object.values(source.args).includes('$cursor'))) return { ok: false as const, code: 'invalid_request' };
  const args = Object.fromEntries(Object.entries(source.args).filter(([, value]) => value !== '$cursor' || cursor !== undefined).map(([key, value]) => [key, value === '$recordId' ? recordId : value === '$cursor' ? cursor : value]));
  const route = iqQueryForSource(ctx.release.extensions!.jaxOntology as any, source.connector, source.tool, args);
  if (!route.covered || !route.query) return { ok: false as const, code: 'missing_iq_mapping' };
  const { operation, ...query } = route.query;
  const answer = await executeIqTool(`jaxiq_${operation}`, query, ctx, client);
  if (answer.ok === false) return { ok: false as const, code: answer.code };
  const records: any[] = (iqRecordsView(answer) as any).records;
  const fields = recordId ? desk.detail.fields : desk.columns;
  const matchingPages = pageBindingId ? answer.pages?.filter(page => page.bindingId === pageBindingId) ?? [] : [];
  const page = matchingPages.length === 1 ? matchingPages[0] : undefined;
  return { ok: true as const, desk: { deskId: desk.deskId, title: desk.title, description: desk.description }, columns: fields, ...(desk.preparation ? { preparationAvailable: true } : {}), ...(!recordId && desk.board ? { board: desk.board } : {}), ...(desk.refreshSeconds ? { refreshSeconds: desk.refreshSeconds } : {}), status: answer.status, queryId: answer.queryId, release: answer.release, sample: answer.sources.some(source => source.sample), ...(page ? { page: { more: page.more, nextCursor: page.nextCursor } } : {}),
    records: records.map(record => ({ canonicalId: record.canonicalId, thing: record.thing,
      values: Object.fromEntries(fields.map(field => [field.field, readIqPath(record, field.field)])),
      provenance: record.provenance,
      ask: deskQuestion(desk, record.canonicalId),
    })),
  };
}

function deskQuestion(desk: OperationalDesk, recordId: string): string {
  return desk.ask.split('{deskId}').join(desk.deskId).split('{recordId}').join(recordId);
}

/** UI button prompts are control-plane presentation, never facts returned by Zendesk/CRM/commerce. */
export function deskToolResult(view: any): any {
  if (view?.ok !== true) return view;
  const { columns: _columns, board: _board, refreshSeconds: _refresh, preparationAvailable: _preparation, records, ...result } = view;
  return { ...result, records: records.map(({ ask: _ask, ...record }: any) => record) };
}

/** The model chooses to show a card; only the authorised desk read supplies its rows and labels. */
export function deskRecordCard(view: any, recordId?: unknown): any | undefined {
  if (view?.ok !== true || !view.desk?.title || !Array.isArray(view.records) || !Array.isArray(view.columns)) return undefined;
  const records = recordId === undefined ? view.records : view.records.filter((record: any) => record.canonicalId === recordId);
  if (!records.length) return undefined;
  const text = (value: unknown): string | undefined => typeof value === 'string' ? value.slice(0, 1000) : typeof value === 'number' || typeof value === 'boolean' ? String(value) : undefined;
  return { heading: view.desk.title, rows: records.slice(0, 12).map((record: any) => ({
    title: String(record.canonicalId),
    detail: view.columns.flatMap((field: any) => { const value = text(record.values?.[field.field]); return value === undefined || field.format === 'messages' ? [] : [`${field.label}: ${value}`]; }).join(' · '),
    ...(view.sample ? { badge: 'Sample data', tone: 'warn' } : {}),
    ...(typeof record.ask === 'string' ? { ask: record.ask } : {}),
  })), shown: Math.min(records.length, 12), total: records.length,
    ...(view.status === 'partial' || view.page?.more ? { atLeast: true } : {}),
  };
}
