/**
 * A test scenario for every use case of every persona: who to sign in as, what to type, what the assistant should be able to do, and what
 * it should and should not say. Built from the persona library (which carries each persona's demo login and the project's test set) and the
 * tools check (what the persona's team may use today). The question can be set by a person for each scenario; where nobody has, the test
 * set's own question is used, and where there is none, one is worded from the use case itself.
 *
 * Pure: it reads, it never calls the assistant. Trying a scenario is a person (or a recording) typing the question while signed in as the login.
 */
import type { PersonaChecks, PersonaLibraryView, UseCaseCheck, Verdict } from './personas';

export type QuestionSource = 'yours' | 'test set' | 'worded from the use case';

export interface TestScenario {
  useCaseId: string;
  title: string;
  personaId: string;
  personaName: string;
  /** The team (or "shoppers") whose rules apply. */
  audienceName: string;
  signIn: { kind: 'login'; email: string } | { kind: 'none'; note: string };
  question: { text: string; source: QuestionSource };
  /** What the tools check says the person can do with the tools this scenario needs. */
  doors: { works: string[]; asks: string[]; stopped: string[] };
  /** From the test set, when it has a case for this use case: what the answer should and should not contain. */
  shouldSay: string[];
  shouldNot: string[];
  note?: string;
  verdict: Verdict;
  summary: string;
}

/**
 * "As a trade support advisor, I want to see previous orders, so that I can help." becomes "I need to see previous orders." A story that does
 * not follow that shape falls back to the title.
 */
export function wordQuestion(story: string, title: string): string {
  const match = /\bI want (to )?([\s\S]+?)(?:,?\s+so that\b[\s\S]*)?[.!]?\s*$/i.exec(story.trim());
  const clause = match?.[2]?.trim().replace(/[.,;]+$/, '');
  if (clause && clause.length > 6) return `I need ${match?.[1] ? 'to ' : ''}${clause}.`;
  return `Help me with this: ${title.replace(/[.]+$/, '')}.`;
}

export function buildScenarios(view: PersonaLibraryView, checks: PersonaChecks): TestScenario[] {
  const personas = new Map(view.library.personas.map((p) => [p.id, p]));
  const curated = new Map<string, PersonaLibraryView['library']['testCases'][number]>();
  for (const entry of view.library.testCases) if (entry.useCase && !curated.has(entry.useCase)) curated.set(entry.useCase, entry);

  return view.library.useCases.map((useCase): TestScenario => {
    const persona = personas.get(useCase.personaId);
    const check: UseCaseCheck | undefined = checks.byUseCase[useCase.id];
    const own = view.scenarioPrompts[useCase.id];
    const set = curated.get(useCase.id);
    const question = own ? { text: own, source: 'yours' as const }
      : set ? { text: set.prompt, source: 'test set' as const }
      : { text: wordQuestion(useCase.story, useCase.title), source: 'worded from the use case' as const };
    const tools = check?.tools ?? [];
    const signIn: TestScenario['signIn'] = persona?.demoLogin ? { kind: 'login', email: persona.demoLogin }
      : persona?.kind === 'customer' ? { kind: 'none', note: 'No sign-in needed: ask as a visitor, or sign in as any customer.' }
      : { kind: 'none', note: `${check?.audienceName ?? 'This team'} has no demo login yet: its team is not in the project.` };
    return {
      useCaseId: useCase.id, title: useCase.title, personaId: useCase.personaId, personaName: persona?.name ?? useCase.persona,
      audienceName: check?.audienceName ?? '', signIn, question,
      doors: {
        works: tools.filter((t) => t.outcome === 'ok').map((t) => t.label),
        asks: tools.filter((t) => t.outcome === 'ask').map((t) => t.label),
        stopped: tools.filter((t) => t.outcome !== 'ok' && t.outcome !== 'ask').map((t) => `${t.label} (${t.note.replace(/\.$/, '')})`),
      },
      shouldSay: set?.shouldSay ?? [], shouldNot: set?.shouldNot ?? [], ...(set?.note ? { note: set.note } : {}),
      verdict: check?.verdict ?? 'unmapped', summary: check?.summary ?? '',
    };
  });
}
