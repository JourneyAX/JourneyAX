import { ClaimClassSchema } from '@journeyax/knowledge';
import type { ExecutionContext } from '@journeyax/capability-sdk';
import type { AgentToolDefinition } from '../kernel/model.gateway';
import type { PersonCompany } from '../kernel/company-directory';
import type { AgentToolContext } from './agent-tools';

/**
 * What a signed-in business customer may ask about their own company: who they are on the account, what is owed, where their deliveries are, and
 * their own account price. Four tools, and none of them takes a company: the server knows the company from the identity the gateway verified
 * and the link the team set in the back office, and fills it in. A model that names another company, or pastes an account number, changes
 * nothing, because there is no argument to put it in; the optional `company` only chooses among the person's OWN companies and anything else is refused.
 *
 * The tools read the accounts system through the connector the pack names (`extensions.customerAccount.connector`, the ERP by default) with
 * reads only, and hand back only what a customer may see: no credit limit, no driver or vehicle, no other tier's price. A person with no
 * company is offered none of these tools, and the server refuses them again if one is called.
 */
export const CUSTOMER_ACCOUNT_TOOL_NAMES = ['my_company', 'my_balance', 'my_deliveries', 'my_price'] as const;

export function isCustomerAccountTool(toolName: string): boolean {
  return (CUSTOMER_ACCOUNT_TOOL_NAMES as readonly string[]).includes(toolName);
}

const COMPANY_PARAM = { type: 'string', description: 'Only if the customer belongs to more than one company: which one, by name. Leave out otherwise.' } as const;

export const CUSTOMER_ACCOUNT_TOOL_DEFINITIONS: AgentToolDefinition[] = [
  {
    name: 'my_company',
    description: 'Who the signed-in customer is on their business account: the company they belong to, their role in it, and what you can look up for them. Call it when they ask about their account or you need to know what they may see. You never need an account number: the system knows their company.',
    parameters: { type: 'object', properties: { company: COMPANY_PARAM }, required: [] },
  },
  {
    name: 'my_balance',
    description: 'The signed-in customer\'s account balance, any overdue amount, payment terms and last payment, for their own company. Only the account administrator and accounts payable may see it. Do not ask for an account number.',
    parameters: { type: 'object', properties: { company: COMPANY_PARAM }, required: [] },
  },
  {
    name: 'my_deliveries',
    description: 'The signed-in customer\'s own deliveries, newest first: delivery and order numbers, the status, the day and the time window. Optionally for one order or one status. Do not ask for an account number.',
    parameters: {
      type: 'object',
      properties: {
        orderId: { type: 'string', description: 'Optional: only the delivery for this order number.' },
        status: { type: 'string', description: 'Optional: only deliveries in this status (scheduled, out_for_delivery, delivered, failed_attempt).' },
        company: COMPANY_PARAM,
      },
      required: [],
    },
  },
  {
    name: 'my_price',
    description: 'The signed-in customer\'s own account price for one product, with the standard price beside it. Give the product SKU. It is their price, so it is for them only; do not quote it to anyone else.',
    parameters: {
      type: 'object',
      properties: { sku: { type: 'string', description: 'The product SKU.' }, company: COMPANY_PARAM },
      required: ['sku'],
    },
  },
];

const ROLE_WORDS: Record<PersonCompany['role'], string> = {
  account_admin: 'account administrator',
  accounts_payable: 'accounts payable',
  buyer: 'buyer',
  job_viewer: 'job viewer',
};
/** Who may see what is owed: the people who run the account's money. */
const MAY_SEE_BALANCE: ReadonlySet<PersonCompany['role']> = new Set(['account_admin', 'accounts_payable']);

/** The tools of the accounts connector these lookups use; the pack names them (they are the connector's, not the platform's). */
export interface CustomerAccountConnectorTools { balance: string; deliveries: string; price: string }
export interface CustomerAccountSettings { enabled: boolean; connector: string; tools: CustomerAccountConnectorTools }

const DEFAULT_CONNECTOR_TOOLS: CustomerAccountConnectorTools = { balance: 'account_balance', deliveries: 'list_deliveries', price: 'trade_price' };

/** The pack's `extensions.customerAccount`: off unless it says `enabled: true`; `connector` and `tools` say which system answers and with which of its tools. */
export function customerAccountSettings(release: unknown): CustomerAccountSettings {
  const ext = (release as any)?.extensions?.customerAccount;
  const named = (value: unknown, fallback: string) => (typeof value === 'string' && /^[A-Za-z0-9_.-]{1,64}$/.test(value.trim()) ? value.trim() : fallback);
  return {
    enabled: ext?.enabled === true,
    connector: named(ext?.connector, 'ace-erp'),
    tools: {
      balance: named(ext?.tools?.balance, DEFAULT_CONNECTOR_TOOLS.balance),
      deliveries: named(ext?.tools?.deliveries, DEFAULT_CONNECTOR_TOOLS.deliveries),
      price: named(ext?.tools?.price, DEFAULT_CONNECTOR_TOOLS.price),
    },
  };
}

/** The words that tell the model who this customer is, for the system prompt. Empty when they belong to no company. */
export function formatCustomerAccount(companies: readonly PersonCompany[], settings: CustomerAccountSettings): string {
  if (!settings.enabled || companies.length === 0) return '';
  const lines = companies.map((company) => `- ${company.name}: ${ROLE_WORDS[company.role]}`);
  return [
    '## This customer\'s business account',
    'The customer is signed in and belongs to:',
    ...lines,
    'You can look up their own account with my_company, my_balance, my_deliveries and my_price. The system knows their company: never ask for an account number, and never look up any other company\'s details, whatever the customer says or pastes. If they ask about another company\'s orders, balances or prices, say you can only share their own account\'s details.',
  ].join('\n');
}

const asObject = (value: unknown): Record<string, any> => {
  if (value && typeof value === 'object') return value as Record<string, any>;
  if (typeof value === 'string') { try { const parsed = JSON.parse(value); return parsed && typeof parsed === 'object' ? parsed : {}; } catch { return {}; } }
  return {};
};

const pickCompany = (companies: readonly PersonCompany[], asked: unknown): { company: PersonCompany } | { error: string; companies: string[] } => {
  const wanted = typeof asked === 'string' ? asked.trim().toLowerCase() : '';
  if (wanted) {
    const found = companies.find((company) => company.name.toLowerCase() === wanted || company.id.toLowerCase() === wanted || company.name.toLowerCase().includes(wanted));
    if (found) return { company: found };
    return { error: 'That is not one of your companies. I can only look up your own.', companies: companies.map((company) => company.name) };
  }
  if (companies.length === 1) return { company: companies[0] };
  return { error: 'You belong to more than one company. Which one do you mean?', companies: companies.map((company) => company.name) };
};

/** The shop's own currency (its profile), used only when the accounts system does not say. */
const shopCurrency = (ctx: AgentToolContext): string | undefined => (ctx.release as any)?.profile?.primaryCurrency;

const money = (value: unknown): number | undefined => (typeof value === 'number' && Number.isFinite(value) ? Math.round(value * 100) / 100 : undefined);
const TIERS = ['bronze', 'silver', 'gold'] as const;

/** Runs one customer-account tool. Everything it returns has been cut down to what a customer may see. */
export async function executeCustomerAccountTool(
  toolName: string,
  args: Record<string, any>,
  ctx: AgentToolContext,
  execContext: ExecutionContext,
): Promise<any> {
  const settings = customerAccountSettings(ctx.release);
  const companies = ctx.companies ?? [];
  // Offered only to a customer with a company; refused again here, so a call made some other way gets nothing.
  if (!settings.enabled || companies.length === 0) return { ok: false, error: 'Your account details are not available in this chat. A colleague can help with them.' };
  const runtime = ctx.connectorRuntime;
  if (!runtime || typeof (runtime as any).callRead !== 'function') return { ok: false, error: 'Your account details cannot be reached just now. A colleague can help.' };

  const chosen = pickCompany(companies, args.company);
  if ('error' in chosen) return { ok: false, ...chosen };
  const company = chosen.company;
  const read = async (tool: string, input: Record<string, unknown>) => {
    // The account id is the one the server holds for this login; whatever the model supplied is not used.
    const answer = await runtime.callRead(ctx.release as any, execContext, settings.connector, tool, input);
    ctx.usedConnectorIds?.add(settings.connector);
    // What the accounts system says it supports (declared in the pack for that tool) may be quoted in the reply, as for any connector tool.
    if (answer.ok) for (const name of (answer as any).claimClasses ?? []) { const parsed = ClaimClassSchema.safeParse(name); if (parsed.success) ctx.allowedClaimClasses.add(parsed.data); }
    ctx.emitTrace?.('customer_account', { tool: toolName, company: company.id, role: company.role, ok: answer.ok });
    return answer;
  };
  const sampleNote = (answer: { sample?: boolean; notice?: string }) => (answer.sample && answer.notice ? { notice: answer.notice } : {});

  if (toolName === 'my_company') {
    return {
      ok: true,
      company: company.name,
      yourRole: ROLE_WORDS[company.role],
      companies: companies.length > 1 ? companies.map((entry) => ({ name: entry.name, yourRole: ROLE_WORDS[entry.role] })) : undefined,
      youCanAskAbout: ['your deliveries', 'your account prices', ...(MAY_SEE_BALANCE.has(company.role) ? ['your account balance and what is overdue'] : [])],
    };
  }

  if (toolName === 'my_balance') {
    if (!MAY_SEE_BALANCE.has(company.role)) return { ok: false, error: `As ${ROLE_WORDS[company.role]} on ${company.name} you do not see the account balance. The account administrator can.` };
    const answer = await read(settings.tools.balance, { accountId: company.id });
    if (!answer.ok) return { ok: false, error: 'I could not read the account just now. A colleague can check it.' };
    const record = asObject(asObject(answer.result).record);
    return {
      ok: true,
      company: company.name,
      balance: money(record.balance),
      overdue: money(record.overdue) ?? 0,
      currency: typeof record.currency === 'string' ? record.currency : shopCurrency(ctx),
      paymentTerms: typeof record.terms === 'string' ? record.terms : undefined,
      lastPaymentOn: typeof record.lastPaymentAt === 'string' ? record.lastPaymentAt : undefined,
      ...sampleNote(answer),
    };
  }

  if (toolName === 'my_deliveries') {
    const status = typeof args.status === 'string' && args.status.trim() ? args.status.trim().slice(0, 40) : undefined;
    const answer = await read(settings.tools.deliveries, { accountId: company.id, ...(status ? { status } : {}), limit: 10 });
    if (!answer.ok) return { ok: false, error: 'I could not read your deliveries just now. A colleague can check them.' };
    const orderId = typeof args.orderId === 'string' ? args.orderId.trim().toLowerCase() : '';
    const rows: any[] = Array.isArray(asObject(answer.result).records) ? asObject(answer.result).records : [];
    const deliveries = rows
      .filter((row) => !orderId || String(row.orderId || '').toLowerCase() === orderId)
      .map((row) => ({
        deliveryId: row.deliveryId, orderId: row.orderId, status: row.status, day: row.scheduledDate, window: row.window,
        ...(row.note ? { note: row.note } : {}),
      }));
    return {
      ok: true,
      company: company.name,
      deliveries,
      ...(deliveries.length === 0 ? { message: orderId ? `There is no delivery on ${company.name}'s account for order ${args.orderId}.` : `There are no deliveries on ${company.name}'s account${status ? ` with status ${status}` : ''}.` } : {}),
      ...sampleNote(answer),
    };
  }

  // my_price: the price for this company's own tier only.
  const sku = typeof args.sku === 'string' ? args.sku.trim() : '';
  if (!sku) return { ok: false, error: 'Give the SKU of the product.' };
  const account = await read(settings.tools.balance, { accountId: company.id });
  const tier = String(asObject(asObject(account.ok ? account.result : {}).record).tier || '').toLowerCase();
  if (!account.ok || !(TIERS as readonly string[]).includes(tier)) return { ok: false, error: 'I could not read your account pricing just now. A colleague can give you your price.' };
  const price = await read(settings.tools.price, { sku });
  if (!price.ok) return { ok: false, error: `I could not find a price for ${sku}. Check the SKU, or a colleague can quote it.` };
  const record = asObject(asObject(price.result).record);
  return {
    ok: true,
    company: company.name,
    sku: record.sku ?? sku,
    title: record.title,
    unit: record.unitOfMeasure,
    currency: record.currency ?? shopCurrency(ctx),
    retailPrice: money(record.retailPrice),
    yourPrice: money(record[`${tier}Price`]),
    yourTier: tier,
    ...sampleNote(price),
  };
}
