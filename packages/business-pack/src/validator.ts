/**
 * Business Pack Semantic and Referential Validator
 *
 * Enforces cross-referencing correctness, secret-free snapshots,
 * and executable integrity before any release can be published.
 */

import { BusinessPackRelease } from './schemas/business-pack.schema';
import { validateSecretReference } from './schemas/capability-binding.schema';
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

export function validateBusinessPack(pack: BusinessPackRelease): ValidationResult {
  const issues: ValidationIssue[] = [];

  // 1. Validate Secret References (No raw keys or tokens)
  const jsonStr = JSON.stringify(pack);
  if (/sk-[a-zA-Z0-9]{20,}/.test(jsonStr) || /ghp_[a-zA-Z0-9]{20,}/.test(jsonStr)) {
    issues.push({
      severity: 'error',
      path: 'security',
      message: 'Detected raw API key or token in Business Pack snapshot. Use secretRef (e.g. gcp-secret://...) instead.',
    });
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

  // 4g. Validate what each tool may do for whom (extensions.toolStates). A row naming a tool no agent of the pack can call is a typo (a
  // warning: the tool may be added later), and a shopper row cannot name groups.
  const toolRows = (pack as any).extensions?.toolStates?.rows as Array<{ toolId: string; audience: string; groups?: string[]; state: string }> | undefined;
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
