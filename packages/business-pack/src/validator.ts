/**
 * Business Pack Semantic and Referential Validator
 *
 * Enforces cross-referencing correctness, secret-free snapshots,
 * and executable integrity before any release can be published.
 */

import { BusinessPackRelease } from './schemas/business-pack.schema';
import { validateSecretReference } from './schemas/capability-binding.schema';
import { pluginGate } from './plugins';
import { shopperCanUse } from './access';

export interface ValidationIssue {
  severity: 'error' | 'warning';
  path: string;
  message: string;
}

export interface ValidationResult {
  valid: boolean;
  issues: ValidationIssue[];
}

export function validateBusinessPack(pack: BusinessPackRelease, options: { publishedRead?: boolean } = {}): ValidationResult {
  const issues: ValidationIssue[] = [];
  if (pack.catalogMapping?.pricing?.demoFallback?.enabled) {
    issues.push({ severity: options.publishedRead ? 'warning' : 'error', path: 'catalogMapping.pricing.demoFallback', message: 'Generated prices are not supported. Configure an authoritative price source; missing prices remain price on request.' });
  }


  // 1. Validate Secret References (No raw keys or tokens)
  const jsonStr = JSON.stringify(pack);
  if (/sk-[a-zA-Z0-9]{20,}/.test(jsonStr) || /ghp_[a-zA-Z0-9]{20,}/.test(jsonStr)) {
    issues.push({
      severity: 'error',
      path: 'security',
      message: 'Detected raw API key or token in Business Pack snapshot. Use secretRef (e.g. gcp-secret://...) instead.',
    });
  }

  const payment = pack.extensions?.payment?.stripe;
  const handoff = pack.extensions?.supportHandoff;
  if (handoff) {
    const source = pack.extensions?.connectors?.connectors.find(entry => entry.connectorId === handoff.connector && entry.enabled !== false);
    const action = source?.tools.find(entry => entry.name === handoff.tool);
    if (action?.sideEffect !== 'write') issues.push({ severity: 'error', path: 'extensions.supportHandoff', message: 'Support handoff requires an enabled connector and a declared write operation.' });
    if (handoff.receiptCard && !pack.experience.cards.allowedCardTypes.includes('records')) issues.push({ severity: 'error', path: 'extensions.supportHandoff.receiptCard', message: 'Support receipt presentation requires the records card type.' });
  }
  if (payment) for (const field of ['secretRef', 'publishableKeyRef', 'webhookSecretRef'] as const) {
    if (!payment[field]) continue;
    for (const problem of validateSecretReference(payment[field]!, pack.manifest.tenantId, pack.manifest.environmentId)) issues.push({ severity: 'error', path: `extensions.payment.stripe.${field}`, message: problem.message });
  }

  // 2. Validate Model Policy References
  const policyIds = new Set(pack.modelPolicy.policies.map((p) => p.policyId));
  for (const agent of pack.agents) {
    if (!policyIds.has(agent.modelPolicyRef)) {
      issues.push({
        severity: 'error',
        path: `agents[${agent.agentId}].modelPolicyRef`,
        message: `Agent '${agent.agentId}' references unknown model policy '${agent.modelPolicyRef}'`,
      });
    }
  }

  // 3. Collect registered Tool IDs
  const registeredToolIds = new Set(pack.capabilities.toolDefinitions.map((t) => t.toolId));
  for (const desk of pack.extensions?.operationalDesks?.desks ?? []) {
    if (!desk.preparation) continue;
    if (pack.extensions?.agentMode?.enabled !== true || pack.extensions?.jaxOntology?.enabled !== true) issues.push({ severity: 'error', path: `extensions.operationalDesks.${desk.deskId}.preparation`, message: 'Automatic preparation requires the canonical agent mode and shared IQ layer.' });
    const agent = pack.agents.find(agent => agent.agentId === desk.preparation!.agentId);
    if (!agent || !['read_desk', 'propose_connector_action', 'call_connector_tool'].every(tool => agent.allowedTools.includes(tool) || agent.allowedTools.includes('*'))) issues.push({ severity: 'error', path: `extensions.operationalDesks.${desk.deskId}.preparation`, message: 'Preparation needs an existing agent with the shared desk, proposal and approved connector tools.' });
    for (const proposal of desk.preparation.proposalTools) {
      const connector = pack.extensions?.connectors?.connectors.find(connector => connector.connectorId === proposal.connector);
      if (connector?.enabled === false || !connector?.tools.some(tool => tool.name === proposal.tool && tool.sideEffect === 'write')) issues.push({ severity: 'error', path: `extensions.operationalDesks.${desk.deskId}.preparation.proposalTools`, message: 'A preparation proposal must reference an enabled, explicitly declared change tool.' });
    }
  }

  // 4. Validate Agent Allowed Tools
  for (const agent of pack.agents) {
    for (const toolId of agent.allowedTools) {
      if (!registeredToolIds.has(toolId) && !toolId.includes('*')) {
        issues.push({
          severity: 'error',
          path: `agents[${agent.agentId}].allowedTools`,
          message: `Agent '${agent.agentId}' allows tool '${toolId}' which is not explicitly defined in toolDefinitions`,
        });
      }
    }
  }

  // 4a. Skills: every skill an agent carries must be defined in the pack
  const definedSkills = new Set(((pack as any).extensions?.skills || []).map((skill: any) => skill?.skillId));
  for (const agent of pack.agents) {
    for (const skillId of agent.skills || []) {
      if (!definedSkills.has(skillId)) {
        issues.push({
          severity: 'error',
          path: `agents[${agent.agentId}].skills`,
          message: `Agent '${agent.agentId}' carries skill '${skillId}' which is not defined in extensions.skills`,
        });
      }
    }
  }

  // 4b. Validate configured default journey exists (never guessed or fabricated)
  const configuredDefaultJourneyId = pack.routingPolicy?.defaultJourneyId;
  if (configuredDefaultJourneyId && !pack.journeys.some((j) => j.journeyId === configuredDefaultJourneyId)) {
    issues.push({
      severity: 'error',
      path: 'routingPolicy.defaultJourneyId',
      message: `routingPolicy.defaultJourneyId '${configuredDefaultJourneyId}' does not match any journey in the pack`,
    });
  }

  // 4c. Validate Agent Default Configuration (exactly one default when there are several agents)
  const agents = pack.agents || [];
  const configuredDefaultAgentId = (pack as any).defaultAgentId || pack.routingPolicy?.defaultAgentId;
  const isDefaultAgents = agents.filter((a) => a.isDefault === true);

  if (configuredDefaultAgentId && !agents.some((a) => a.agentId === configuredDefaultAgentId)) {
    issues.push({
      severity: 'error',
      path: 'defaultAgentId',
      message: `defaultAgentId '${configuredDefaultAgentId}' does not match any agent in the pack`,
    });
  }

  if (agents.length > 1) {
    const hasExplicitDefaultId = Boolean(configuredDefaultAgentId && agents.some((a) => a.agentId === configuredDefaultAgentId));
    const hasSingleFlag = isDefaultAgents.length === 1;

    if (!hasExplicitDefaultId && !hasSingleFlag) {
      if (isDefaultAgents.length > 1) {
        issues.push({
          severity: 'error',
          path: 'agents',
          message: `Multiple agents marked with isDefault (${isDefaultAgents.map((a) => a.agentId).join(', ')}). Exactly one default agent is required when a pack declares several agents.`,
        });
      } else {
        issues.push({
          severity: 'error',
          path: 'agents',
          message: `Pack declares ${agents.length} agents but no default agent is designated. Provide defaultAgentId or mark exactly one agent with isDefault: true.`,
        });
      }
    } else if (hasExplicitDefaultId && isDefaultAgents.length > 1) {
      issues.push({
        severity: 'error',
        path: 'agents',
        message: `Ambiguous default agents: defaultAgentId is '${configuredDefaultAgentId}' and multiple agents have isDefault: true (${isDefaultAgents.map((a) => a.agentId).join(', ')}).`,
      });
    }
  }

  // 4e. Validate who may use which agent (extensions.agentAccess). A row naming an agent that is not in the pack is a typo that would
  // silently leave an agent open or closed; a shopper row cannot name groups (groups are staff-only); and shoppers must keep an agent,
  // including the one the pack opens by default, or the shop's own chat would have nobody to answer it.
  const accessRows = (pack as any).extensions?.agentAccess?.rows as Array<{ agentId: string; audience: string; groups?: string[]; level: string }> | undefined;
  if (Array.isArray(accessRows) && accessRows.length > 0) {
    const knownAgentIds = new Set(agents.map((a) => a.agentId));
    accessRows.forEach((row, index) => {
      if (!knownAgentIds.has(row.agentId)) {
        issues.push({ severity: 'error', path: `extensions.agentAccess.rows[${index}].agentId`, message: `Access row names agent '${row.agentId}', which is not in the pack.` });
      }
      if (row.audience === 'shopper' && (row.groups || []).length > 0) {
        issues.push({ severity: 'error', path: `extensions.agentAccess.rows[${index}].groups`, message: `A shopper row for '${row.agentId}' names groups; groups apply to staff rows only.` });
      }
      if (row.level === 'required' && row.audience === 'staff' && (row.groups || []).length === 0) {
        issues.push({ severity: 'warning', path: `extensions.agentAccess.rows[${index}].level`, message: `'${row.agentId}' is required for every member of staff: nobody on staff could use any other agent.` });
      }
    });
    const shopperAgents = agents.filter((a) => shopperCanUse(a.agentId, (pack as any).extensions.agentAccess));
    if (agents.length > 0 && shopperAgents.length === 0) {
      issues.push({ severity: 'error', path: 'extensions.agentAccess', message: 'No agent is available to shoppers: the shop\'s own chat would have nobody to answer it.' });
    }
    const openingId = configuredDefaultAgentId && knownAgentIds.has(configuredDefaultAgentId) ? configuredDefaultAgentId : isDefaultAgents[0]?.agentId;
    if (openingId && agents.length > 1 && shopperAgents.length > 0 && !shopperCanUse(openingId, (pack as any).extensions.agentAccess)) {
      issues.push({ severity: 'error', path: 'extensions.agentAccess', message: `The pack's default agent '${openingId}' is not available to shoppers, so a shopper's chat could not open on it. Give shoppers a row for it or choose another default agent.` });
    }
  }

  // 4f. Validate who has which skill (extensions.skillAccess). A row naming a skill the pack does not define is a typo that would leave
  // a skill carried as its own tier says (or hidden) without anyone noticing, and a shopper row cannot name groups.
  const skillRows = (pack as any).extensions?.skillAccess?.rows as Array<{ skillId: string; audience: string; groups?: string[]; level: string }> | undefined;
  if (Array.isArray(skillRows) && skillRows.length > 0) {
    const knownSkillIds = new Set((((pack as any).extensions?.skills as Array<{ skillId: string }> | undefined) || []).map((skill) => skill.skillId));
    skillRows.forEach((row, index) => {
      if (!knownSkillIds.has(row.skillId)) {
        issues.push({ severity: 'error', path: `extensions.skillAccess.rows[${index}].skillId`, message: `Skill access row names skill '${row.skillId}', which the pack does not define.` });
      }
      if (row.audience === 'shopper' && (row.groups || []).length > 0) {
        issues.push({ severity: 'error', path: `extensions.skillAccess.rows[${index}].groups`, message: `A shopper row for skill '${row.skillId}' names groups; groups apply to staff rows only.` });
      }
    });
  }

  // 4i. Validate the connectors the chat may reach (extensions.connectors). A policy row that names a connector or tool the pack does not
  // list is a typo that would silently leave a tool blocked (or, worse, look as if it were governed); a shopper row cannot name groups;
  // a secret reference must be a reference to this pack's own tenant and environment; a tool that changes data and is set to "allow" is
  // flagged so it is a decision and not an accident; and a connector nobody can use is flagged because new tools start blocked.
  const connectorsExt = (pack as any).extensions?.connectors as
    | { connectors?: Array<{ connectorId: string; enabled?: boolean; sample?: boolean; secretRef?: string; tools?: Array<{ name: string; sideEffect?: string }> }>; policy?: Array<{ connectorId: string; tool: string; audience: string; groups?: string[]; state: string }> }
    | undefined;
  if (connectorsExt && Array.isArray(connectorsExt.connectors)) {
    const byId = new Map<string, NonNullable<typeof connectorsExt.connectors>[number]>();
    connectorsExt.connectors.forEach((connector, index) => {
      if (byId.has(connector.connectorId)) {
        issues.push({ severity: 'error', path: `extensions.connectors.connectors[${index}].connectorId`, message: `Connector '${connector.connectorId}' is declared twice.` });
      }
      byId.set(connector.connectorId, connector);
      const toolNames = (connector.tools || []).map((tool) => tool.name);
      if (new Set(toolNames).size !== toolNames.length) {
        issues.push({ severity: 'error', path: `extensions.connectors.connectors[${index}].tools`, message: `Connector '${connector.connectorId}' lists the same tool twice.` });
      }
      if (connector.secretRef) {
        for (const refIssue of validateSecretReference(connector.secretRef, pack.manifest?.tenantId, pack.manifest?.environmentId)) {
          issues.push({ severity: 'error', path: `extensions.connectors.connectors[${index}].secretRef`, message: refIssue.message });
        }
      }
      if (connector.sample && pack.manifest?.environmentId === 'production') {
        issues.push({ severity: 'warning', path: `extensions.connectors.connectors[${index}].sample`, message: `Connector '${connector.connectorId}' runs on sample data but this pack is for production.` });
      }
    });
    const rows = connectorsExt.policy || [];
    rows.forEach((row, index) => {
      const connector = byId.get(row.connectorId);
      if (!connector) {
        issues.push({ severity: 'error', path: `extensions.connectors.policy[${index}].connectorId`, message: `Policy row names connector '${row.connectorId}', which is not in the pack.` });
        return;
      }
      const tool = row.tool === '*' ? undefined : (connector.tools || []).find((entry) => entry.name === row.tool);
      if (row.tool !== '*' && !tool) {
        issues.push({ severity: 'error', path: `extensions.connectors.policy[${index}].tool`, message: `Policy row names tool '${row.tool}', which connector '${row.connectorId}' does not list. Tools that are not listed start blocked.` });
      }
      if (row.audience === 'shopper' && (row.groups || []).length > 0) {
        issues.push({ severity: 'error', path: `extensions.connectors.policy[${index}].groups`, message: `A shopper row for connector '${row.connectorId}' names groups; groups apply to staff rows only.` });
      }
      if (row.state === 'allow') {
        // A default row only covers the tools that have no row of their own.
        const writes = row.tool === '*'
          ? (connector.tools || []).filter((entry) => entry.sideEffect === 'write' && !rows.some((other) => other.connectorId === row.connectorId && other.tool === entry.name)).map((entry) => entry.name)
          : tool?.sideEffect === 'write' ? [tool.name] : [];
        if (writes.length > 0) {
          issues.push({ severity: 'warning', path: `extensions.connectors.policy[${index}].state`, message: `Connector '${row.connectorId}': ${writes.join(', ')} change data in the other system but ${row.tool === '*' ? 'the default row' : 'this row'} lets ${row.audience === 'shopper' ? 'everyone' : 'staff'} run it without asking first.` });
        }
      }
    });
    byId.forEach((connector, id) => {
      if (connector.enabled !== false && !rows.some((row) => row.connectorId === id && row.state !== 'blocked')) {
        issues.push({ severity: 'warning', path: `extensions.connectors.connectors[${id}]`, message: `Connector '${id}' is enabled but no policy row lets anyone use any of its tools: new tools start blocked.` });
      }
    });
  }

  // 4g. Validate what each tool may do for whom (extensions.toolStates). A row naming a tool no agent of the pack can call is a typo (a
  // warning: the tool may be added later), and a shopper row cannot name groups.
  const delivery = (pack as any).extensions?.payment?.delivery;
  if (delivery) {
    const connector = (pack as any).extensions?.connectors?.connectors?.find((entry: any) => entry.connectorId === delivery.connectorId);
    if (!connector || connector.enabled === false || !connector.connectionRef || connector.sample === true ||
        !connector.tools?.some((tool: any) => tool.name === delivery.writeTool && tool.sideEffect === 'write') ||
        !connector.tools?.some((tool: any) => tool.name === delivery.receiptTool && tool.sideEffect === 'read')) {
      issues.push({ severity: 'error', path: 'extensions.payment.delivery', message: 'Paid order delivery requires an enabled, scoped, non-sample connector with declared write and receipt tools.' });
    }
    if (delivery.paymentWriteTool && (!connector?.tools?.some((tool: any) => tool.name === delivery.paymentWriteTool && tool.sideEffect === 'write') || !connector?.tools?.some((tool: any) => tool.name === delivery.paymentReceiptTool && tool.sideEffect === 'read'))) {
      issues.push({ severity: 'error', path: 'extensions.payment.delivery', message: 'Payment linkage requires declared write and read receipt bindings on the paid-order connector.' });
    }
  }
  const toolRows = (pack as any).extensions?.toolStates?.rows as Array<{ toolId: string; audience: string; groups?: string[]; state: string }> | undefined;
  for (const source of pack.extensions?.customerProfiles?.enabled ? pack.extensions.customerProfiles.sources : []) {
    const connector = pack.extensions?.connectors?.connectors.find(c => c.connectorId === source.connectorId);
    if (!connector || connector.enabled === false || connector.sample || !connector.connectionRef || !connector.tools.some(t => t.name === source.createTool && t.sideEffect === 'write') || !connector.tools.some(t => t.name === source.readTool && t.sideEffect === 'read')) issues.push({ severity: 'error', path: 'extensions.customerProfiles', message: 'Customer profile sources require real scoped connectors with declared creation and read-back tools.' });
    if (source.orderLinkTool && (!connector?.tools.some(t => t.name === source.orderLinkTool && t.sideEffect === 'write') || !connector?.tools.some(t => t.name === source.orderReadTool && t.sideEffect === 'read'))) issues.push({ severity: 'error', path: 'extensions.customerProfiles', message: 'Customer order linkage requires declared write and read-back tools on the same scoped connector.' });
  }
  if (Array.isArray(toolRows) && toolRows.length > 0) {
    const callable = new Set(agents.flatMap((a) => (Array.isArray((a as any).allowedTools) ? (a as any).allowedTools : [])));
    toolRows.forEach((row, index) => {
      if (callable.size > 0 && !callable.has(row.toolId)) {
        issues.push({ severity: 'warning', path: `extensions.toolStates.rows[${index}].toolId`, message: `Tool state row names '${row.toolId}', which no agent of the pack lists in its allowed tools.` });
      }
      if (row.audience === 'shopper' && (row.groups || []).length > 0) {
        issues.push({ severity: 'error', path: `extensions.toolStates.rows[${index}].groups`, message: `A shopper row for tool '${row.toolId}' names groups; groups apply to staff rows only.` });
      }
    });
  }

  // 4h. Validate the forms the shop offers (extensions.forms): two forms with one id would open the wrong one, and a form the assistant
  // is never allowed to open (no agent lists open_form) would never be seen.
  const forms = (pack as any).extensions?.forms as Array<{ formId: string }> | undefined;
  if (Array.isArray(forms) && forms.length > 0) {
    const seenForms = new Set<string>();
    forms.forEach((form, index) => {
      if (seenForms.has(form.formId)) issues.push({ severity: 'error', path: `extensions.forms[${index}].formId`, message: `Two forms are called '${form.formId}'.` });
      seenForms.add(form.formId);
    });
    if (!agents.some((a) => Array.isArray((a as any).allowedTools) && (a as any).allowedTools.includes('open_form'))) {
      issues.push({ severity: 'warning', path: 'extensions.forms', message: 'The pack has forms but no agent lists open_form in its allowed tools, so the assistant can never open one.' });
    }
  }

  // 4j. Validate the plugins (extensions.plugins). A plugin names things the pack defines; a name that matches nothing is a typo that would
  // leave the bundle half empty. Plugins must never leave shoppers without an agent (the shop's own chat would have nobody to answer it).
  const pluginsExt = (pack as any).extensions?.plugins as { plugins?: Array<{ pluginId: string; provides?: Record<string, string[]> }>; access?: Array<{ pluginId: string; audience: string; groups?: string[] }> } | undefined;
  if (pluginsExt && Array.isArray(pluginsExt.plugins) && pluginsExt.plugins.length > 0) {
    const known = {
      agents: new Set(agents.map((a) => a.agentId)),
      skills: new Set((((pack as any).extensions?.skills as Array<{ skillId: string }> | undefined) || []).map((s) => s.skillId)),
      forms: new Set((((pack as any).extensions?.forms as Array<{ formId: string }> | undefined) || []).map((f) => f.formId)),
      connectors: new Set((((pack as any).extensions?.connectors?.connectors as Array<{ connectorId: string }> | undefined) || []).map((c) => c.connectorId)),
    };
    const seenPlugins = new Set<string>();
    pluginsExt.plugins.forEach((plugin, index) => {
      if (seenPlugins.has(plugin.pluginId)) issues.push({ severity: 'error', path: `extensions.plugins.plugins[${index}].pluginId`, message: `Two plugins are called '${plugin.pluginId}'.` });
      seenPlugins.add(plugin.pluginId);
      const provides = plugin.provides || {};
      for (const kind of ['agents', 'skills', 'forms', 'connectors'] as const) {
        for (const id of provides[kind] || []) {
          if (!known[kind].has(id)) issues.push({ severity: 'error', path: `extensions.plugins.plugins[${index}].provides.${kind}`, message: `Plugin '${plugin.pluginId}' names ${kind.slice(0, -1)} '${id}', which the pack does not define.` });
        }
      }
      if (Object.values(provides).every((list) => !list || list.length === 0)) {
        issues.push({ severity: 'warning', path: `extensions.plugins.plugins[${index}].provides`, message: `Plugin '${plugin.pluginId}' names nothing, so switching it on or off changes nothing.` });
      }
    });
    (pluginsExt.access || []).forEach((row, index) => {
      if (!seenPlugins.has(row.pluginId)) issues.push({ severity: 'error', path: `extensions.plugins.access[${index}].pluginId`, message: `Plugin access row names plugin '${row.pluginId}', which is not in the pack.` });
      if (row.audience === 'shopper' && (row.groups || []).length > 0) issues.push({ severity: 'error', path: `extensions.plugins.access[${index}].groups`, message: `A shopper row for plugin '${row.pluginId}' names groups; groups apply to staff rows only.` });
    });
    const shopperGate = pluginGate(pluginsExt as any, { audience: 'shopper', groups: [] });
    const shopperAgentsLeft = agents.filter((a) => shopperGate.allows('agents', a.agentId) && shopperCanUse(a.agentId, (pack as any).extensions?.agentAccess));
    if (agents.length > 0 && shopperAgentsLeft.length === 0) {
      issues.push({ severity: 'error', path: 'extensions.plugins', message: 'With these plugins no agent is available to shoppers: the shop\'s own chat would have nobody to answer it.' });
    }
  }

  // 5. Validate Journeys and Stages
  for (const journey of pack.journeys) {
    const stageIds = new Set(Object.keys(journey.stages));

    // Check initialStage
    if (!stageIds.has(journey.initialStage)) {
      issues.push({
        severity: 'error',
        path: `journeys[${journey.journeyId}].initialStage`,
        message: `Journey '${journey.journeyId}' initialStage '${journey.initialStage}' does not exist in stages.`,
      });
    }

    // Check exitConditions target stages
    for (const [stageId, rawStage] of Object.entries(journey.stages)) {
      const stage = rawStage as any;
      if (!stage || !stage.exitConditions) continue;
      for (let i = 0; i < stage.exitConditions.length; i++) {
        const cond = stage.exitConditions[i];
        if (!stageIds.has(cond.nextStage)) {
          issues.push({
            severity: 'error',
            path: `journeys[${journey.journeyId}].stages[${stageId}].exitConditions[${i}].nextStage`,
            message: `Exit condition points to non-existent stage '${cond.nextStage}' in journey '${journey.journeyId}'`,
          });
        }
      }

      // Check allowed capabilities in stage
      if (Array.isArray(stage.allowedCapabilities)) {
        for (const capId of stage.allowedCapabilities) {
          if (!registeredToolIds.has(capId) && !capId.includes('*')) {
            issues.push({
              severity: 'error',
              path: `journeys[${journey.journeyId}].stages[${stageId}].allowedCapabilities`,
              message: `Stage '${stageId}' allows capability '${capId}' which is not declared in toolDefinitions.`,
            });
          }
        }
      }
    }
  }

  // 6. Validate Tool Bindings and Executor Secret References
  const boundToolIds = new Set<string>();
  for (const binding of pack.capabilities.toolBindings) {
    boundToolIds.add(binding.toolId);
    if (!registeredToolIds.has(binding.toolId)) {
      issues.push({
        severity: 'error',
        path: `capabilities.toolBindings[${binding.toolId}]`,
        message: `Tool binding references unknown toolId '${binding.toolId}'`,
      });
    }

    const secretRef = binding.executor?.secretRef;
    if (secretRef) {
      const refIssues = validateSecretReference(secretRef, binding.tenantId, binding.environmentId);
      for (const refIssue of refIssues) {
        issues.push({
          severity: 'error',
          path: `capabilities.toolBindings[${binding.toolId}].executor.secretRef`,
          message: refIssue.message,
        });
      }
    }
  }

  // 7. Enforce Capability Binding: Reject capabilities with no binding
  for (const toolDef of pack.capabilities.toolDefinitions) {
    if (!boundToolIds.has(toolDef.toolId)) {
      issues.push({
        severity: 'error',
        path: `capabilities.toolDefinitions[${toolDef.toolId}]`,
        message: `Capability '${toolDef.toolId}' is defined in toolDefinitions but has no binding in toolBindings`,
      });
    }
  }
  for (const journey of pack.journeys) {
    for (const [stageId, rawStage] of Object.entries(journey.stages)) {
      const stage = rawStage as any;
      if (Array.isArray(stage.allowedCapabilities)) {
        for (const capId of stage.allowedCapabilities) {
          if (!boundToolIds.has(capId) && !capId.includes('*')) {
            issues.push({
              severity: 'error',
              path: `journeys[${journey.journeyId}].stages[${stageId}].allowedCapabilities`,
              message: `Stage '${stageId}' allows capability '${capId}' which has no binding in toolBindings`,
            });
          }
        }
      }
    }
  }

  // 8. Collect all declared fact keys across the entire pack
  const declaredFactKeys = new Set<string>();
  if (pack.vocabulary?.terms) {
    for (const term of pack.vocabulary.terms) {
      if (term.category) declaredFactKeys.add(term.category);
    }
  }
  if (pack.vocabulary?.slotSynonyms) {
    for (const key of Object.keys(pack.vocabulary.slotSynonyms)) {
      declaredFactKeys.add(key);
    }
  }
  if ((pack.vocabulary as any)?.slotQuestions) {
    for (const key of Object.keys((pack.vocabulary as any).slotQuestions)) {
      declaredFactKeys.add(key);
    }
  }
  if (pack.entities?.entities) {
    for (const ent of pack.entities.entities) {
      if ((ent as any).entityName) declaredFactKeys.add((ent as any).entityName);
      if (ent.entityId) declaredFactKeys.add(ent.entityId);
      if (ent.attributes) {
        for (const attr of ent.attributes) {
          if (attr.name) declaredFactKeys.add(attr.name);
        }
      }
    }
  }
  for (const tb of pack.capabilities.toolBindings) {
    if ((tb as any).outputFactMapping) {
      for (const k of Object.keys((tb as any).outputFactMapping)) {
        declaredFactKeys.add(k);
      }
    }
  }
  for (const sb of pack.capabilities.stageBindings || []) {
    for (const t of sb.tools || []) {
      if ((t as any).outputFactMapping) {
        for (const k of Object.keys((t as any).outputFactMapping)) {
          declaredFactKeys.add(k);
        }
      }
    }
  }
  for (const journey of pack.journeys) {
    for (const stage of Object.values(journey.stages || {})) {
      const s = stage as any;
      for (const f of s.requiredFacts || []) {
        const k = typeof f === 'string' ? f : (f?.key || f?.factKey);
        if (k) declaredFactKeys.add(k);
      }
      for (const f of s.optionalFacts || []) {
        const k = typeof f === 'string' ? f : (f?.key || f?.factKey);
        if (k) declaredFactKeys.add(k);
      }
      for (const cp of s.capabilityPlan || []) {
        for (const pf of cp.producesFacts || []) declaredFactKeys.add(pf);
      }
    }
  }

  // 9. Enforce Exit Condition Fact Integrity: Reject unknown fact keys in exits
  for (const journey of pack.journeys) {
    for (const [stageId, rawStage] of Object.entries(journey.stages)) {
      const stage = rawStage as any;
      if (Array.isArray(stage.exitConditions)) {
        for (let i = 0; i < stage.exitConditions.length; i++) {
          const cond = stage.exitConditions[i];
          const exitFacts = [...(cond.allFactsPresent || []), ...(cond.anyFactsPresent || [])];
          for (const f of exitFacts) {
            if (!declaredFactKeys.has(f)) {
              issues.push({
                severity: 'error',
                path: `journeys[${journey.journeyId}].stages[${stageId}].exitConditions[${i}]`,
                message: `Exit condition references unknown fact key '${f}' (not declared in stage facts, vocabulary, entities, or capability outputs)`,
              });
            }
          }
        }
      }
    }
  }

  // 10. Enforce Required Fact Questionnaire Coverage: Reject required facts with no slotQuestion
  const slotQuestions = (pack.vocabulary as any)?.slotQuestions || {};
  for (const journey of pack.journeys) {
    for (const [stageId, rawStage] of Object.entries(journey.stages)) {
      const stage = rawStage as any;
      if (Array.isArray(stage.requiredFacts)) {
        for (const rawFact of stage.requiredFacts) {
          const factKey = typeof rawFact === 'string' ? rawFact : (rawFact?.key || rawFact?.factKey);
          if (!factKey) continue;
          const hasQuestion =
            slotQuestions[factKey] ||
            stage.questionDefinitions?.[factKey] ||
            (typeof rawFact === 'object' && rawFact?.question) ||
            (stage.factRequirements || []).some(
              (r: any) => (r.key === factKey || r.factKey === factKey) && r.question
            );
          if (!hasQuestion) {
            issues.push({
              severity: 'error',
              path: `journeys[${journey.journeyId}].stages[${stageId}].requiredFacts`,
              message: `Required fact '${factKey}' in stage '${stageId}' has no declared slotQuestion in vocabulary.json`,
            });
          }
        }
      }
    }
  }

  // 11. Enforce Rule Expression Parseability: Reject rule expressions that don't parse
  for (const rule of pack.rules || []) {
    const expr = rule.condition?.ruleExpression;
    if (expr && typeof expr === 'string' && expr.trim()) {
      const trimmed = expr.trim();
      const binaryMatch = trimmed.match(
        /^\s*([a-zA-Z0-9_$.]+)\s*(===|!==|==|!=|>=|<=|>|<)\s*(.+)$/
      );
      const singleIdentMatch = trimmed.match(/^\s*!?([a-zA-Z0-9_$.]+)\s*$/);
      if (!binaryMatch && !singleIdentMatch) {
        issues.push({
          severity: 'error',
          path: `rules[${rule.ruleId}].condition.ruleExpression`,
          message: `Rule expression '${expr}' in rule '${rule.ruleId}' could not be parsed by runtime evaluator`,
        });
      }
    }
  }

  // 12. Validate Calculators: Reject any calculator with an unresolved verificationRef
  const knownVerificationIds = new Set<string>();
  if (Array.isArray((pack as any).factRegistry?.verifications)) {
    for (const v of (pack as any).factRegistry.verifications) {
      if (v.recordId) knownVerificationIds.add(v.recordId);
      if (v.id) knownVerificationIds.add(v.id);
    }
  }
  if (Array.isArray((pack as any).knowledgeModel?.verifications)) {
    for (const v of (pack as any).knowledgeModel.verifications) {
      if (v.recordId) knownVerificationIds.add(v.recordId);
      if (v.id) knownVerificationIds.add(v.id);
    }
  }
  if (Array.isArray((pack as any).verifications)) {
    for (const v of (pack as any).verifications) {
      if (v.recordId) knownVerificationIds.add(v.recordId);
      if (v.id) knownVerificationIds.add(v.id);
    }
  }

  for (const calc of pack.calculators || []) {
    if (!calc.verificationRef) {
      issues.push({
        severity: 'error',
        path: `calculators[${calc.calculatorId}].verificationRef`,
        message: `Calculator '${calc.calculatorId}' must have an authoritative verificationRef to be included in a release`,
      });
    } else if (!knownVerificationIds.has(calc.verificationRef)) {
      issues.push({
        severity: 'error',
        path: `calculators[${calc.calculatorId}].verificationRef`,
        message: `Calculator '${calc.calculatorId}' references unresolved verificationRef '${calc.verificationRef}'`,
      });
    }
  }

  return {
    valid: !issues.some((i) => i.severity === 'error'),
    issues,
  };
}
