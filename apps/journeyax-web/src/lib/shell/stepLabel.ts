/**
 * What the working strip and the "Worked for" list say when the assistant reaches into a connected system. The model's own tool names
 * (call_connector_tool and the like) never reach the screen: a step names what is being looked at, in the words a colleague would use.
 */

/** How a connected system is named in a sentence. A system not listed here is shown under its own id. */
const SYSTEM: Record<string, string> = {
  salesforce: 'Salesforce',
  commercetools: 'the order system',
  zendesk: 'Zendesk',
  'ace-erp': 'the ERP',
  'marketing-cloud': 'Marketing Cloud',
  'google-analytics': 'Google Analytics',
  'power-bi': 'Power BI',
};

/** One line per known tool, `system.tool`. A tool not listed falls back to "Checking <system>". */
const STEP: Record<string, string> = {
  'salesforce.find_account': 'Finding the account',
  'salesforce.get_account': 'Reading the account',
  'salesforce.list_opportunities': 'Looking at open deals',
  'salesforce.pipeline_summary': 'Reading the pipeline',
  'salesforce.list_cases': 'Looking at open cases',
  'salesforce.create_case': 'Getting a case ready',
  'salesforce.list_campaigns': 'Looking at campaigns',
  'commercetools.find_account': 'Finding the account',
  'commercetools.get_account': 'Reading the account terms',
  'commercetools.order_history': 'Looking at recent orders',
  'commercetools.get_order': 'Looking up the order',
  'commercetools.stock_by_branch': 'Checking stock by branch',
  'zendesk.find_tickets': 'Looking for support tickets',
  'ace-erp.find_account': 'Finding the account in the ERP',
  'ace-erp.list_deliveries': 'Checking recent deliveries',
  'marketing-cloud.list_messages': 'Looking at recent messages',
  'google-analytics.traffic_by_page': 'Reading website traffic',
  'power-bi.list_reports': 'Finding reports',
};

const CONNECTOR_STEPS = ['list_connectors', 'get_connector_tools', 'call_connector_tool'];

/** The words for a step that goes through the connector tools, or undefined when the step is something else. */
export function connectorStepLabel(toolName: string, connector?: string, tool?: string): string | undefined {
  if (!CONNECTOR_STEPS.includes(toolName)) return undefined;
  const system = connector ? SYSTEM[connector] ?? connector : undefined;
  if (toolName === 'list_connectors') return 'Seeing which systems are connected';
  if (toolName === 'get_connector_tools') return system ? `Opening ${system}` : 'Opening a connected system';
  return (connector && tool ? STEP[`${connector}.${tool}`] : undefined) ?? (system ? `Checking ${system}` : 'Checking the company systems');
}

/** What the strip says for a tool the page has no wording for: nothing technical, just that work is going on. */
export const UNKNOWN_STEP = 'Working on it';
