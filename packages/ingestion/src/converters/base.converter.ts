/**
 * AbstractConverter — composes ordered Populators into one SOURCE→TARGET mapping.
 *
 * Subclasses only declare how to create an empty target; every field mapping
 * lives in a small, independently testable Populator. Populators can be added,
 * removed or reordered (even per project) without touching the converter.
 */
import { Converter, Populator, ConversionContext } from '../ports';

export abstract class AbstractConverter<SOURCE, TARGET> implements Converter<SOURCE, TARGET> {
  abstract readonly id: string;
  private readonly populators: Populator<SOURCE, TARGET>[] = [];

  constructor(populators: Populator<SOURCE, TARGET>[] = []) {
    populators.forEach((p) => this.addPopulator(p));
  }

  /** Register a populator; ordering is by `order` (default 100), then insertion. */
  addPopulator(p: Populator<SOURCE, TARGET>): this {
    this.populators.push(p);
    this.populators.sort((a, b) => (a.order ?? 100) - (b.order ?? 100));
    return this;
  }

  removePopulator(id: string): this {
    const i = this.populators.findIndex((p) => p.id === id);
    if (i >= 0) this.populators.splice(i, 1);
    return this;
  }

  listPopulators(): string[] {
    return this.populators.map((p) => p.id);
  }

  abstract createTarget(source: SOURCE, ctx?: ConversionContext): TARGET;

  async convert(source: SOURCE, ctx?: ConversionContext): Promise<TARGET> {
    return this.convertInto(source, this.createTarget(source, ctx), ctx);
  }

  /** Accumulate onto an existing target — the merge case (many rows → one product). */
  async convertInto(source: SOURCE, target: TARGET, ctx?: ConversionContext): Promise<TARGET> {
    for (const p of this.populators) await p.populate(source, target, ctx);
    return target;
  }
}
