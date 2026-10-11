import { createHash } from 'node:crypto';
import { readFile, readdir, lstat } from 'node:fs/promises';
import path from 'node:path';
import { compareKnowledgeKeys, computeKnowledgeChecksum, computeKnowledgeEntityHash, stableKnowledgeJson } from './checksum';
import { OkfTenantPolicySchema } from './policy';
import { AcceptanceScenarioSchema, ConceptSchema, ConceptTypeSchema, EvidenceChunkSchema, FactDefinitionSchema, OkfReleaseContentSchema, RelationshipSchema, SourceSchema, type OkfReleaseContent, type OkfReleaseEnvelope } from './contracts';
import { type OkfBundleFiles, readOkfZip, safeOkfPath, validateOkfFiles } from './okf-archive';

// This dependency is deliberately used only at the interchange boundary.
// Runtime gate evaluation never parses frontmatter.
const yaml = require('js-yaml') as {
  JSON_SCHEMA: unknown;
  load(input: string, options?: Record<string, unknown>): unknown;
  dump(input: unknown, options: Record<string, unknown>): string;
};
const encoder = new TextEncoder();
const decoder = new TextDecoder('utf-8', { fatal: true });

export interface ImportedOkfBundle {
  kind: 'imported_okf_bundle';
  draft: OkfReleaseContent;
  files: OkfBundleFiles;
  declaredVersion?: string;
  diagnostics: string[];
}

const STANDARD = new Set(['type', 'title', 'description', 'resource', 'tags', 'sources', 'generated', 'verified', 'status', 'stale_after']);

function actor(value: string): string {
  return /^(?:human:[^\s]+|process:[^\s]+|[^\s/]+\/[^\s/]+)$/.test(value) ? value : `process:${value}`;
}

function conceptPath(concept: OkfReleaseContent['concepts'][number], tenantId: string): string {
  const source = concept.interchange?.path || concept.conceptId.replace(`concept://${tenantId}/`, '');
  const file = source.endsWith('.md') ? source : `${source}.md`;
  safeOkfPath(file);
  if (file.endsWith('/index.md') || file.endsWith('/log.md') || file === 'index.md' || file === 'log.md') {
    throw new Error(`Reserved OKF concept path: ${file}`);
  }
  return file;
}

function yamlDocument(frontmatter: Record<string, unknown>, body: string): Uint8Array {
  const source = yaml.dump(frontmatter, { sortKeys: true, lineWidth: -1, noRefs: true, forceQuotes: false });
  return encoder.encode(`---\n${source}---\n${body.replace(/\r\n?/g, '\n')}`);
}

function sourceResource(source: OkfReleaseContent['sources'][number]): string | undefined {
  if ('uri' in source) return source.uri;
  if ('officialUri' in source) return source.officialUri;
  if ('url' in source) return source.url;
  if ('statementRef' in source) return source.statementRef;
  return undefined;
}

/** The release is authoritative. Interchange extras are never consulted for runtime decisions. */
export function exportOkfBundle(input: OkfReleaseEnvelope | ImportedOkfBundle): OkfBundleFiles {
  if ('kind' in input && input.kind === 'imported_okf_bundle') {
    return validateOkfFiles(Object.fromEntries(Object.entries(input.files).map(([key, value]) => [key, new Uint8Array(value)])));
  }
  const release = input as OkfReleaseEnvelope;
  const content = OkfReleaseContentSchema.parse(release.content);
  const paths = new Map(content.concepts.map((concept) => [concept.conceptId, conceptPath(concept, release.tenantId)]));
  if (new Set(paths.values()).size !== paths.size) throw new Error('Duplicate OKF concept path');
  const files: OkfBundleFiles = Object.create(null);
  const sourceMap = new Map(content.sources.map((source) => [source.sourceId, source]));

  for (const concept of [...content.concepts].sort((a, b) => compareKnowledgeKeys(paths.get(a.conceptId)!, paths.get(b.conceptId)!))) {
    const file = paths.get(concept.conceptId)!;
    const related = content.relationships.filter((relationship) => relationship.from === concept.conceptId)
      .sort((a, b) => compareKnowledgeKeys(a.relationshipId, b.relationshipId));
    const verification = content.verifications.filter((record) => record.targetType === 'concept' && record.targetId === concept.conceptId && record.status === 'verified');
    const sourceIds = new Set(verification.flatMap((record) => record.sourceRefs));
    for (const chunkId of concept.evidenceRefs) {
      const chunk = content.evidenceChunks.find((entry) => entry.chunkId === chunkId);
      if (chunk) sourceIds.add(chunk.sourceRef);
    }
    for (const relationship of related) for (const sourceId of relationship.sourceRefs) sourceIds.add(sourceId);
    const sources = [...sourceIds].sort().flatMap((sourceId) => {
      const source = sourceMap.get(sourceId);
      const resource = source && sourceResource(source);
      return source && resource ? [{ id: sourceId, resource, title: source.title }] : [];
    });
    const currentDir = path.posix.dirname(file);
    const links = related.map((relationship) => {
      const target = paths.get(relationship.to);
      const targetName = content.concepts.find((entry) => entry.conceptId === relationship.to)?.name || relationship.to;
      const label = relationship.customerLabel || relationship.type.replace(/_/g, ' ');
      return target ? `* ${label}: [${targetName}](${path.posix.relative(currentDir, target)})` : `* ${label}: ${targetName}`;
    });
    const body = concept.interchange?.bodyMarkdown ?? `# ${concept.name}\n\n${concept.description}\n`;
    const linkedBody = concept.interchange
      ? body
      : links.length ? `${body.trimEnd()}\n\n## Related concepts\n\n${links.join('\n')}\n` : `${body.trimEnd()}\n`;
    const extras = concept.interchange?.frontmatterExtras || {};
    const preservedStandard = concept.interchange?.standardFields || {};
    const canonicalResource = sources.map((source) => source.resource).find((resource) => /^(?:https?:\/\/|gs:\/\/)/.test(resource));
    const frontmatter: Record<string, unknown> = {
      ...extras,
      type: concept.interchange?.originalType || concept.type.replace(/_/g, ' '),
      title: concept.name,
      description: concept.description,
      ...(canonicalResource ? { resource: canonicalResource } : {}),
      tags: [],
      ...(sources.length ? { sources } : {}),
      generated: { by: actor(release.publishedBy), at: release.publishedAt.toISOString() },
      ...(verification.length ? { verified: verification.map((record) => ({ by: actor(record.verifiedBy!), at: record.verifiedAt })) } : {}),
      status: concept.lifecycle.status === 'deprecated' || concept.lifecycle.status === 'retired'
        ? 'deprecated' : verification.length ? 'stable' : 'draft',
      ...(verification.map((record) => record.staleAfter).filter(Boolean).sort()[0]
        ? { stale_after: verification.map((record) => record.staleAfter).filter(Boolean).sort()[0] }
        : {}),
      ...preservedStandard,
      ...(concept.synonyms.length ? { 'x-journeyax-synonyms': concept.synonyms } : {}),
      'x-journeyax-concept': concept,
      'x-journeyax-relationships': related,
    };
    files[file] = yamlDocument(frontmatter, linkedBody);
  }

  const chunkManifest = content.evidenceChunks.map((chunk) => {
    const chunkPath = `references/chunks/${createHash('sha256').update(chunk.chunkId).digest('hex')}.txt`;
    files[chunkPath] = encoder.encode(chunk.content.replace(/\r\n?/g, '\n'));
    const { content: _text, ...metadata } = chunk;
    return { ...metadata, contentPath: chunkPath };
  });
  const manifest = {
    format: 'journeyax-okf-interchange-1',
    releaseId: release.releaseId,
    tenantId: release.tenantId,
    environmentId: release.environmentId,
    version: release.version,
    checksum: release.checksum,
    modelId: content.modelId,
    schemaVersion: content.schemaVersion,
    factRegistry: content.factRegistry,
    sources: content.sources,
    evidenceChunks: chunkManifest,
    verifications: content.verifications,
    index: content.index,
    evaluation: content.evaluation,
    ...(content.policy ? { policy: content.policy } : {}),
    ...(content.acceptanceScenarios ? { acceptanceScenarios: content.acceptanceScenarios } : {}),
    ...(content.extensions ? { extensions: content.extensions } : {}),
  };
  files['references/manifest.json'] = encoder.encode(`${stableKnowledgeJson(manifest)}\n`);
  files['log.md'] = encoder.encode(`# Directory Update Log\n\n## ${release.publishedAt.toISOString().slice(0, 10)}\n\n* **Publication**: ${release.version} (${release.checksum}) by ${actor(release.publishedBy)}.\n`);

  const directories = new Set(['']);
  for (const file of Object.keys(files)) {
    let directory = path.posix.dirname(file);
    while (directory !== '.') {
      directories.add(directory);
      directory = path.posix.dirname(directory);
    }
  }
  for (const directory of [...directories].sort()) {
    const prefix = directory ? `${directory}/` : '';
    const immediate = Object.keys(files).filter((file) => file.startsWith(prefix) && !file.slice(prefix.length).includes('/'));
    const childDirectories = [...directories].filter((entry) => entry && path.posix.dirname(entry) === (directory || '.'));
    const links = [
      ...immediate.filter((file) => path.posix.basename(file) !== 'index.md').map((file) => {
        const concept = content.concepts.find((entry) => paths.get(entry.conceptId) === file);
        return `* [${concept?.name || path.posix.basename(file)}](${path.posix.basename(file)}) - ${concept?.description || 'Knowledge artifact'}`;
      }),
      ...childDirectories.map((child) => `* [${path.posix.basename(child)}](${path.posix.basename(child)}/) - Knowledge and references`),
    ].sort();
    const index = `${directory ? '' : '---\nokf_version: "0.2"\n---\n'}# ${directory || 'Knowledge'}\n\n${links.join('\n')}\n`;
    files[`${prefix}index.md`] = encoder.encode(index);
  }
  return validateOkfFiles(files);
}

function splitMarkdown(file: string, bytes: Uint8Array): { frontmatter: Record<string, unknown>; body: string } {
  const source = decoder.decode(bytes);
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(source);
  if (!match) throw new Error(`Missing OKF frontmatter: ${file}`);
  const parsed = yaml.load(match[1], { schema: yaml.JSON_SCHEMA });
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error(`Invalid OKF frontmatter: ${file}`);
  const seen = new WeakSet<object>();
  let count = 0;
  function check(value: unknown, depth: number): void {
    if (++count > 100000 || depth > 32) throw new Error(`OKF frontmatter too complex: ${file}`);
    if (!value || typeof value !== 'object') return;
    if (seen.has(value)) throw new Error(`Cyclic OKF frontmatter: ${file}`);
    seen.add(value);
    for (const child of Object.values(value)) check(child, depth + 1);
    seen.delete(value);
  }
  check(parsed, 0);
  return { frontmatter: parsed as Record<string, unknown>, body: source.slice(match[0].length) };
}

function importedConcept(file: string, frontmatter: Record<string, unknown>, body: string, tenantId: string, conceptId: string): OkfReleaseContent['concepts'][number] {
  if (typeof frontmatter.type !== 'string' || !frontmatter.type.trim()) throw new Error(`OKF concept requires non-empty type: ${file}`);
  const classified = frontmatter.type.toLowerCase().replace(/[\s-]+/g, '_');
  const embedded = ConceptSchema.safeParse(frontmatter['x-journeyax-concept']);
  const controlFields = embedded.success
    ? Object.fromEntries(Object.entries(embedded.data).filter(([key]) => ![
      'conceptId', 'tenantId', 'type', 'name', 'description', 'contentHash', 'interchange', 'importReview',
    ].includes(key)))
    : {};
  const candidate = {
    conceptId, tenantId,
    type: ConceptTypeSchema.safeParse(classified).success ? classified : 'unknown',
    name: String(frontmatter.title || file.slice(0, -3)),
    description: String(frontmatter.description || body.replace(/[#*_\[\]()]/g, '').trim().slice(0, 200) || 'Imported knowledge concept'),
    synonyms: [], customerPhrases: [], lens: 'product',
    // An imported file cannot classify its own risk or select a journey/search scope.
    // Every concept remains fail-closed until an authenticated reviewer authors controls.
    riskClass: 'safety_critical', compatibilitySensitive: true,
    requiredFacts: [], discriminators: [],
    searchScope: { catalogCategoryIds: [], enrichmentFacets: [], excludeCategoryIds: [] },
    commercePolicy: { addToCart: 'blocked', checkout: 'blocked' },
    safety: { blocksProducts: true, stepRefs: [] }, evidenceRefs: [],
    lifecycle: { status: 'active_draft' }, version: 1,
    importReview: { status: 'required', fields: Object.keys(controlFields).sort() },
    interchange: {
      path: file,
      originalType: frontmatter.type,
      standardFields: Object.fromEntries(Object.entries(frontmatter).filter(([key]) =>
        ['resource', 'tags', 'sources', 'generated', 'status', 'stale_after'].includes(key))),
      frontmatterExtras: Object.fromEntries(Object.entries(frontmatter).filter(([key]) =>
        !STANDARD.has(key) && !['x-journeyax-concept', 'x-journeyax-relationships'].includes(key))),
      bodyMarkdown: body,
      ...(Object.keys(controlFields).length ? { controlFields } : {}),
    },
  } as any;
  return { ...candidate, contentHash: computeKnowledgeEntityHash(candidate) };
}

function conceptIdsForFiles(files: string[], tenantId: string): Map<string, string> {
  const ids = new Map<string, string>();
  const used = new Set<string>();
  for (const file of files) {
    const segments = file.slice(0, -3).split('/').map((segment) =>
      segment.toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'item');
    let id = `concept://${tenantId}/${segments.join('/')}`;
    if (used.has(id)) id += `-${createHash('sha256').update(file).digest('hex').slice(0, 12)}`;
    ids.set(file, id);
    used.add(id);
  }
  return ids;
}

export function importOkfBundle(input: Uint8Array | OkfBundleFiles, tenantId: string): ImportedOkfBundle {
  if (!/^[a-z0-9-]+$/.test(tenantId)) throw new Error('Invalid OKF tenantId');
  const files = validateOkfFiles(input instanceof Uint8Array ? readOkfZip(input) : input);
  const root = files['index.md'];
  const diagnostics: string[] = [];
  let declaredVersion: string | undefined;
  if (root && decoder.decode(root).startsWith('---')) {
    try {
      const frontmatter = splitMarkdown('index.md', root).frontmatter;
      if (frontmatter.okf_version !== undefined) {
        if (typeof frontmatter.okf_version !== 'string') diagnostics.push('Non-string OKF version declaration');
        else declaredVersion = frontmatter.okf_version;
      }
    } catch {
      diagnostics.push('Malformed root OKF index');
    }
  }
  const concepts: OkfReleaseContent['concepts'] = [];
  const relationships: OkfReleaseContent['relationships'] = [];
  const parsedFiles = new Map<string, { frontmatter: Record<string, unknown>; body: string }>();
  for (const file of Object.keys(files).filter((entry) => entry.endsWith('.md') && !['index.md', 'log.md'].includes(path.posix.basename(entry))).sort()) {
    try {
      const parsed = splitMarkdown(file, files[file]);
      if (typeof parsed.frontmatter.type !== 'string' || !parsed.frontmatter.type.trim()) {
        throw new Error('non-empty type is required');
      }
      parsedFiles.set(file, parsed);
    } catch (error: any) {
      diagnostics.push(`Skipped non-conformant Markdown ${file}: ${error?.message || 'invalid frontmatter'}`);
    }
  }
  const conceptFiles = [...parsedFiles.keys()];
  const ids = conceptIdsForFiles(conceptFiles, tenantId);
  const originalIds = new Map<string, string>();
  for (const file of conceptFiles) {
    const { frontmatter } = parsedFiles.get(file)!;
    const embedded = ConceptSchema.safeParse(frontmatter['x-journeyax-concept']);
    if (embedded.success) {
      originalIds.set(embedded.data.conceptId, ids.get(file)!);
    }
  }
  for (const file of conceptFiles) {
    const { frontmatter, body } = parsedFiles.get(file)!;
    const concept = importedConcept(file, frontmatter, body, tenantId, ids.get(file)!);
    concepts.push(concept);
    diagnostics.push(`Imported concept ${file} requires review before publication${concept.importReview?.fields.length ? `: ${concept.importReview.fields.join(', ')}` : ''}`);
    const ownRelations = Array.isArray(frontmatter['x-journeyax-relationships']) ? frontmatter['x-journeyax-relationships'] as any[] : [];
    for (const [index, relation] of ownRelations.entries()) {
      const from = concept.conceptId;
      const to = originalIds.get(String(relation?.to || ''));
      if (!to) { diagnostics.push(`Unresolved relationship in ${file}`); continue; }
      const embedded = RelationshipSchema.safeParse(relation);
      const value = { ...(embedded.success ? embedded.data : {}), relationshipId: `imported-${computeKnowledgeChecksum([file, index, relation]).slice(0, 24)}`, from,
        to, type: embedded.success ? embedded.data.type : 'relevant_to',
        strength: embedded.success ? embedded.data.strength : 'optional',
        scope: embedded.success ? embedded.data.scope : 'general',
        confidence: embedded.success ? embedded.data.confidence : 'low',
        verificationRef: undefined, sourceRefs: [], claimClasses: [],
        extensions: { ...(embedded.success ? embedded.data.extensions : {}), importStatus: 'draft', importVerification: 'unverified' },
        interchange: {
          path: file,
          originalType: String(relation.type || 'relevant_to'),
          frontmatterExtras: embedded.success ? {} : { originalRelationship: relation },
          bodyMarkdown: '',
        } };
      relationships.push({ ...value, contentHash: computeKnowledgeEntityHash(value) });
    }
    const linkPattern = /\[[^\]]+\]\(([^)]+\.md)(?:#[^)]*)?\)/g;
    for (const match of body.matchAll(linkPattern)) {
      const href = match[1];
      if (/^(?:[a-z]+:|\/)/i.test(href)) continue;
      const target = path.posix.normalize(path.posix.join(path.posix.dirname(file), href));
      const targetId = ids.get(target);
      if (targetId && target !== file && !relationships.some((r) => r.from === concept.conceptId && r.to === targetId)) {
        const value = { relationshipId: `imported-${computeKnowledgeChecksum([file, target]).slice(0, 24)}`, from: concept.conceptId,
          to: targetId, type: 'relevant_to' as const, strength: 'optional' as const,
          scope: 'general' as const, confidence: 'low' as const, sourceRefs: [], claimClasses: [],
          extensions: { importStatus: 'draft', importVerification: 'unverified' },
          interchange: { path: file, originalType: 'relevant_to', frontmatterExtras: { href }, bodyMarkdown: match[0] } };
        relationships.push({ ...value, contentHash: computeKnowledgeEntityHash(value) });
      } else if (!ids.has(target)) diagnostics.push(`Broken link in ${file}: ${href}`);
    }
  }
  const ownManifest = (() => {
    if (!files['references/manifest.json']) return null;
    try {
      const value = JSON.parse(decoder.decode(files['references/manifest.json']));
      return value?.format === 'journeyax-okf-interchange-1' ? value : null;
    } catch {
      diagnostics.push('Unreadable JourneyAX interchange manifest');
      return null;
    }
  })();
  const sources = Array.isArray(ownManifest?.sources)
    ? ownManifest.sources.flatMap((value: unknown) => {
      const parsed = SourceSchema.safeParse(value);
      return parsed.success ? [parsed.data] : [];
    }) : [];
  const factRegistry = Array.isArray(ownManifest?.factRegistry)
    ? ownManifest.factRegistry.flatMap((value: unknown) => {
      const parsed = FactDefinitionSchema.safeParse(value);
      return parsed.success ? [parsed.data] : [];
    }) : [];
  const evidenceChunks: OkfReleaseContent['evidenceChunks'] = Array.isArray(ownManifest?.evidenceChunks)
    ? ownManifest.evidenceChunks.flatMap((entry: any) => {
      const contentPath = typeof entry?.contentPath === 'string' ? entry.contentPath : '';
      const bytes = files[contentPath];
      if (!bytes) { diagnostics.push(`Missing evidence text: ${contentPath}`); return []; }
      const { contentPath: _contentPath, ...metadata } = entry;
      const chunk = {
        ...metadata,
        content: decoder.decode(bytes),
        conceptIds: Array.isArray(metadata.conceptIds) ? metadata.conceptIds.map((id: string) => originalIds.get(id)).filter(Boolean) : [],
      };
      chunk.contentHash = computeKnowledgeEntityHash(chunk);
      const parsed = EvidenceChunkSchema.safeParse(chunk);
      if (!parsed.success) { diagnostics.push(`Invalid evidence metadata: ${contentPath}`); return []; }
      return [parsed.data];
    }) : [];
  // Policy and tenant scenarios are imported as data only when they validate;
  // otherwise they are dropped with a diagnostic, never half-applied.
  const importedPolicy = ownManifest?.policy !== undefined ? OkfTenantPolicySchema.safeParse(ownManifest.policy) : undefined;
  if (importedPolicy && !importedPolicy.success) diagnostics.push('Imported tenant policy is invalid and was ignored');
  const importedScenarios = Array.isArray(ownManifest?.acceptanceScenarios)
    ? ownManifest.acceptanceScenarios.flatMap((value: unknown) => {
      const parsed = AcceptanceScenarioSchema.safeParse(value);
      if (!parsed.success) diagnostics.push('An imported acceptance scenario is invalid and was ignored');
      return parsed.success ? [parsed.data] : [];
    }) : [];
  const empty = computeKnowledgeChecksum([]);
  const draft = OkfReleaseContentSchema.parse({
    schemaVersion: '1.0.0', modelId: typeof ownManifest?.modelId === 'string' ? ownManifest.modelId : `imported-${tenantId}`,
    factRegistry, concepts, relationships, sources, evidenceChunks, verifications: [],
    ...(importedPolicy?.success ? { policy: importedPolicy.data } : {}),
    ...(importedScenarios.length ? { acceptanceScenarios: importedScenarios } : {}),
    index: { embeddingModel: 'unbuilt', embeddingModelVersion: 'unbuilt', chunkingVersion: 'unbuilt', indexChecksum: empty, builtAt: '1970-01-01T00:00:00.000Z', sourceChecksum: empty },
    evaluation: { reportId: 'not-evaluated', passed: false, evaluatedAt: '1970-01-01T00:00:00.000Z', scenarioCount: 0, failedScenarioCount: 0 },
  });
  return { kind: 'imported_okf_bundle', draft, files, declaredVersion, diagnostics };
}

export async function importOkfDirectory(root: string, tenantId: string): Promise<ImportedOkfBundle> {
  const rootStats = await lstat(root);
  if (!rootStats.isDirectory() || rootStats.isSymbolicLink()) throw new Error('OKF import root must be a real directory');
  const files: OkfBundleFiles = Object.create(null);
  let total = 0;
  async function walk(directory: string, depth: number): Promise<void> {
    if (depth > 12) throw new Error('OKF directory exceeds depth limit');
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const absolute = path.join(directory, entry.name);
      const relative = safeOkfPath(path.relative(root, absolute).split(path.sep).join('/'));
      const stats = await lstat(absolute);
      if (stats.isSymbolicLink()) throw new Error(`OKF symlink prohibited: ${relative}`);
      if (stats.isDirectory()) { await walk(absolute, depth + 1); continue; }
      if (!stats.isFile() || stats.size > 8 * 1024 * 1024) throw new Error(`Invalid OKF file: ${relative}`);
      if (Object.keys(files).length >= 2000) throw new Error('OKF bundle exceeds file-count limit');
      total += stats.size;
      if (total > 64 * 1024 * 1024) throw new Error('OKF bundle exceeds total size limit');
      files[relative] = await readFile(absolute);
    }
  }
  await walk(root, 0);
  return importOkfBundle(files, tenantId);
}
