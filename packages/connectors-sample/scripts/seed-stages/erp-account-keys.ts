/**
 * The sample ERP learns the account numbers the other systems know a trade account by, so JAX IQ can be shown "this is the same customer".
 *
 * account_balances: `commercetoolsUnitKey` (the account number in lower case, the rule the real loaders use), and `salesforceAccountId` and
 * `zendeskOrganizationId`, empty until the backfill. deliveries: `commercetoolsOrderNumber`, equal to `orderId`. That is the ERP's own
 * ORD-1000nn series, not an order number commercetools has issued. Nothing is drawn from a random stream; every value follows from the row.
 */
import type { Rec, SeedFile } from '../../src/types';
import type { SeedStage } from './index';

const text = (row: Rec, field: string): string => {
  const value = row[field];
  if (typeof value !== 'string' || value === '') throw new Error(`erp-account-keys: a row has no ${field}`);
  return value;
};

const addMissing = (row: Rec, fields: Rec): void => {
  for (const [name, value] of Object.entries(fields)) if (!(name in row)) row[name] = value;
};

const addNotes = (seed: SeedFile, collection: string, notes: Record<string, string>): void => {
  const madeUp = seed.provenance[collection].madeUpFields;
  for (const [field, note] of Object.entries(notes)) if (!madeUp.some((entry) => entry.startsWith(field))) madeUp.push(`${field} (${note})`);
};

export const erpAccountKeys: SeedStage = {
  name: 'erp-account-keys',
  connectorId: 'ace-erp',
  apply(seed) {
    for (const row of seed.collections.account_balances) {
      addMissing(row, { commercetoolsUnitKey: text(row, 'accountId').toLowerCase(), salesforceAccountId: null, zendeskOrganizationId: null });
    }
    for (const row of seed.collections.deliveries) addMissing(row, { commercetoolsOrderNumber: text(row, 'orderId') });
    addNotes(seed, 'account_balances', {
      commercetoolsUnitKey: 'the account number in lower case',
      salesforceAccountId: 'empty until the backfill',
      zendeskOrganizationId: 'empty until the backfill',
    });
    addNotes(seed, 'deliveries', { commercetoolsOrderNumber: 'equal to orderId: the ERP\'s own order number, not one commercetools has issued' });
  },
};
