import type { Binding, FactDef, JaxOntologyRelease, LinkDef, SettingDef, StateMap, ThingDef } from '../model';

/**
 * The lookups the planner, the query pipeline and the tool descriptions use, built once from a release block. Pure: it reads the block,
 * changes nothing and keeps no clock. It trusts the block to have passed the release checks; if an id is defined twice the first
 * definition wins. What it returns is the block's own data: callers read it and do not change it.
 */
export interface DictionaryIndex {
  /** Every thing, in the block's order. */
  things(): readonly ThingDef[];
  /** A thing by its exact name. */
  thing(name: string): ThingDef | undefined;
  /**
   * The things a word finds: a thing's own name or one of its aliases, ignoring case and extra spaces. A word two things share finds both,
   * sorted by name; the caller shows a short list and never picks.
   */
  thingsByWord(word: string): readonly ThingDef[];
  /** A fact by its thing and the part of its path after the dot: ('Account', 'balance'). */
  fact(thing: string, name: string): FactDef | undefined;
  factByPath(path: string): FactDef | undefined;
  /** The facts of a thing, in the block's order. */
  factsOf(thing: string): readonly FactDef[];
  link(name: string): LinkDef | undefined;
  /** The links that start at a thing, in the block's order. */
  linksFrom(thing: string): readonly LinkDef[];
  /** The bindings of a fact, in the block's order: the source of truth, the cross-checks and the fallbacks together. */
  bindingsForFact(fact: string): readonly Binding[];
  bindingsForLink(link: string): readonly Binding[];
  setting(key: string): SettingDef | undefined;
  stateMap(id: string): StateMap | undefined;
}

const wordOf = (text: string): string => text.trim().toLowerCase().replace(/\s+/g, ' ');

function firstOf<T>(items: readonly T[], key: (item: T) => string): Map<string, T> {
  const found = new Map<string, T>();
  for (const item of items) if (!found.has(key(item))) found.set(key(item), item);
  return found;
}

function groupedBy<T>(items: readonly T[], key: (item: T) => string): Map<string, T[]> {
  const groups = new Map<string, T[]>();
  for (const item of items) groups.set(key(item), [...(groups.get(key(item)) ?? []), item]);
  return groups;
}

export function buildDictionaryIndex(block: JaxOntologyRelease): DictionaryIndex {
  const things = firstOf(block.things, (item) => item.thing);
  const facts = firstOf(block.facts, (item) => item.fact);
  const links = firstOf(block.links, (item) => item.link);
  const settings = firstOf(block.settings, (item) => item.key);
  const stateMaps = firstOf(block.stateMaps, (item) => item.id);
  const factsOf = groupedBy(block.facts, (item) => item.thing);
  const linksFrom = groupedBy(block.links, (item) => item.from);
  const factBindings = groupedBy(block.bindings.filter((item) => item.target.kind === 'fact'), (item) => (item.target.kind === 'fact' ? item.target.fact : ''));
  const linkBindings = groupedBy(block.bindings.filter((item) => item.target.kind === 'link'), (item) => (item.target.kind === 'link' ? item.target.link : ''));

  const words = new Map<string, ThingDef[]>();
  for (const thing of things.values()) {
    for (const word of new Set([thing.thing, ...thing.aliases].map(wordOf))) words.set(word, [...(words.get(word) ?? []), thing]);
  }
  for (const [word, found] of words) words.set(word, [...found].sort((a, b) => (a.thing < b.thing ? -1 : a.thing > b.thing ? 1 : 0)));

  return {
    things: () => block.things,
    thing: (name) => things.get(name),
    thingsByWord: (word) => words.get(wordOf(word)) ?? [],
    fact: (thing, name) => facts.get(`${thing}.${name}`),
    factByPath: (path) => facts.get(path),
    factsOf: (thing) => factsOf.get(thing) ?? [],
    link: (name) => links.get(name),
    linksFrom: (thing) => linksFrom.get(thing) ?? [],
    bindingsForFact: (fact) => factBindings.get(fact) ?? [],
    bindingsForLink: (link) => linkBindings.get(link) ?? [],
    setting: (key) => settings.get(key),
    stateMap: (id) => stateMaps.get(id),
  };
}
