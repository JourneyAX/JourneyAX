import {
  Controller, Get, Post, Put, Patch, Delete,
  Body, Param, Query, Headers,
  NotFoundException, BadRequestException, UnauthorizedException,
  Inject, Optional, UseGuards, UseInterceptors, UploadedFile,
  ConflictException,
  StreamableFile,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { PermissionGuard, RequirePermission } from './permission.guard';
import { UNATTRIBUTED_PRINCIPAL } from '@journeyax/shared-types';
import { ProjectService, redactSecrets, isCardType, validateCardSpec, STANDARD_TOOL_SCHEMAS } from './project.service';
import { BusinessPackPublicationService } from './business-pack-publication.service';
import {
  CreateProjectDto, UpdateProjectDto, MemberRole,
  CreateBusinessRuleDto, UpdateBusinessRuleDto,
  CardTemplateDoc,
} from './project.types';
import { OKF_LIMITS, OkfIntegrityError } from '@journeyax/knowledge';
import { OkfAuthoringService, OkfDraftConflictError } from './okf-authoring.service';
import { KnowledgeInsightService } from './knowledge-insight.service';

/**
 * Internal runtime services (agent, WhatsApp sender) present this shared key to
 * receive UNREDACTED connector secrets; everyone else (browser/operator) gets
 * masked hints. Interim control until workload identity/mTLS + a KMS vault land.
 */
// Read lazily, not at module-eval time — ESM import hoisting can run this
// before main.ts's dotenv.config(), which would permanently bake in an empty
// key for the life of the process (see permission.guard.ts's identical fix).
function isInternal(key?: string): boolean {
  const internalKey = process.env.INTERNAL_API_KEY || '';
  return Boolean(internalKey) && key === internalKey;
}

/**
 * ProjectController
 *
 * Projects are the primary data isolation unit in JourneyAX.
 * Every downstream service (product, agent, auth, analytics)
 * scopes all its data to a single projectId.
 *
 * Routes:
 *
 *   GET    /api/v1/projects                         list all projects
 *   POST   /api/v1/projects                         create project
 *   GET    /api/v1/projects/:projectId              get project config
 *   PATCH  /api/v1/projects/:projectId              update project
 *   POST   /api/v1/projects/:projectId/publish      set status → active
 *   POST   /api/v1/projects/:projectId/archive      set status → archived
 *   GET    /api/v1/projects/:projectId/context      get isolation context (for inter-service)
 *   GET    /api/v1/projects/:projectId/members      list members
 *   POST   /api/v1/projects/:projectId/members      add member
 *   PATCH  /api/v1/projects/:projectId/members/:email  update role
 *   DELETE /api/v1/projects/:projectId/members/:email  remove member
 *   POST   /api/v1/projects/:projectId/verify-membership  check membership
 *   GET    /api/v1/projects/health                  health check
 */
@Controller('api/v1/projects')
@UseGuards(PermissionGuard)
export class ProjectController {
  constructor(
    @Inject(ProjectService) private readonly projectService: ProjectService,
    @Optional() @Inject(BusinessPackPublicationService) private readonly publicationService?: BusinessPackPublicationService,
    @Optional() @Inject(OkfAuthoringService) private readonly okfAuthoring?: OkfAuthoringService,
    @Optional() @Inject(KnowledgeInsightService) private readonly knowledgeInsight?: KnowledgeInsightService,
  ) {}

  // ── Health ────────────────────────────────────────────────────

  @Get('health')
  health() {
    return {
      status: 'ok',
      service: 'project-service',
      isolationKey: 'projectId',
      timestamp: new Date().toISOString(),
    };
  }

  // ── Project CRUD ──────────────────────────────────────────────

  @Get()
  async listProjects(
    @Query('orgId') orgId?: string,
    @Query('status') status?: string,
  ) {
    return this.projectService.listProjects(
      orgId,
      status as any,
    );
  }

  @Post()
  @RequirePermission('user.manage')
  async createProject(@Body() dto: CreateProjectDto) {
    if (!dto.projectId || !dto.orgId || !dto.name || !dto.companyName) {
      throw new BadRequestException('projectId, orgId, name, companyName are required.');
    }
    if (!dto.scope || !dto.pricing || !dto.persona || !dto.theme) {
      throw new BadRequestException('scope, pricing, persona, and theme are required.');
    }

    const result = await this.projectService.createProject(dto);
    if (!result.success) throw new BadRequestException(result.message);
    return result;
  }

  /**
   * Resolve the tenant owning a WhatsApp phone number id (webhook routing). Returns
   * the send token — INTERNAL ONLY: requires the internal key so a token can't be
   * harvested by an anonymous caller (P0-01).
   */
  @Get('resolve/whatsapp/:phoneNumberId')
  async resolveWhatsapp(
    @Param('phoneNumberId') phoneNumberId: string,
    @Headers('x-internal-key') internalKey?: string,
  ) {
    if (!isInternal(internalKey)) {
      throw new BadRequestException('This endpoint requires an internal service key.');
    }
    const r = await this.projectService.resolveByWhatsapp(phoneNumberId);
    if (!r) throw new NotFoundException(`No project registered for WhatsApp phone number id '${phoneNumberId}'.`);
    return r;
  }

  /** Resolve the project serving a storefront domain (multi-storefront routing). */
  @Get('resolve/domain/:domain')
  async resolveDomain(@Param('domain') domain: string) {
    const r = await this.projectService.resolveByDomain(domain);
    if (!r) throw new NotFoundException(`No project registered for domain '${domain}'.`);
    return r;
  }

  @Get(':projectId')
  async getProject(
    @Param('projectId') projectId: string,
    @Headers('x-internal-key') internalKey?: string,
  ) {
    // Guard: don't match 'health' as a projectId
    if (projectId === 'health') return this.health();

    const config = await this.projectService.getProject(projectId);
    if (!config) {
      throw new NotFoundException(`Project '${projectId}' not found.`);
    }
    // P0-01: redact connector secrets unless an internal runtime service asks.
    return isInternal(internalKey) ? config : redactSecrets(config);
  }

  @Patch(':projectId')
  @RequirePermission('config.edit')
  async updateProject(
    @Param('projectId') projectId: string,
    @Body() dto: UpdateProjectDto,
  ) {
    const result = await this.projectService.updateProject(projectId, dto);
    if (!result.success) throw new NotFoundException(result.message);
    return result;
  }

  // ── Config versioning (FR-CONFIG-002) ─────────────────────────
  // Draft = the project doc (PATCH above). Publish snapshots it immutably;
  // the runtime consumes /published; /versions is the audit; rollback re-points.

  @Post(':projectId/publish')
  @RequirePermission('config.publish')
  async publishProject(
    @Param('projectId') projectId: string,
    @Body() body?: { note?: string; environmentId?: string },
    @Headers('x-user-id') userId?: string,
  ) {
    const pubService = this.publicationService || this.projectService.getPublicationService();
    // Identity comes from the authenticated request, never from the body.
    const result = await pubService.publishConfig(projectId, {
      note: body?.note,
      environmentId: body?.environmentId,
      publishedBy: userId,
    });
    if (!result.success) throw new NotFoundException(result.message);
    return { ...result, status: 'active', projectId };
  }

  /** The immutable published config the runtime consumes (falls back to draft pre-first-publish). */
  @Get(':projectId/published')
  async getPublished(
    @Param('projectId') projectId: string,
    @Headers('x-internal-key') internalKey?: string,
  ) {
    const config = await this.projectService.getPublishedConfig(projectId);
    if (!config) throw new NotFoundException(`Project '${projectId}' not found.`);
    return isInternal(internalKey) ? config : redactSecrets(config);
  }

  /** Version history — the audit trail (metadata only). */
  @Get(':projectId/versions')
  async listVersions(@Param('projectId') projectId: string) {
    return this.projectService.listVersions(projectId);
  }

  @Post(':projectId/rollback/:version')
  @RequirePermission('config.publish')
  async rollback(
    @Param('projectId') projectId: string,
    @Param('version') version: string,
    @Body() body?: { environmentId?: string },
    @Headers('x-user-id') userId?: string,
  ) {
    const result = await this.projectService.rollbackConfig(projectId, Number(version), userId, body?.environmentId);
    if (!result.success) throw new NotFoundException(result.message);
    return { ...result, projectId, activeVersion: Number(version) };
  }

  @Post(':projectId/archive')
  @RequirePermission('config.publish')
  async archiveProject(@Param('projectId') projectId: string) {
    const result = await this.projectService.archiveProject(projectId);
    if (!result.success) throw new NotFoundException(result.message);
    return { ...result, status: 'archived', projectId };
  }

  // ── Structured knowledge (OKF) authoring ─────────────────────

  @Get(':projectId/knowledge/draft')
  @RequirePermission('knowledge.read')
  async getKnowledgeDraft(@Param('projectId') projectId: string, @Query('environmentId') environmentId?: string) {
    const draft = await this.okfAuthoring?.getDraft(projectId, environmentId || 'production');
    if (!draft) throw new NotFoundException(`OKF draft for '${projectId}' not found.`);
    return draft;
  }

  @Get(':projectId/knowledge/analysis')
  @RequirePermission('knowledge.read')
  async analyzeKnowledgeDraft(@Param('projectId') projectId: string, @Query('environmentId') environmentId?: string) {
    try {
      return await this.okfAuthoring!.analyzeDraft(projectId, environmentId || 'production');
    } catch (error: any) {
      throw new BadRequestException(error.message);
    }
  }

  @Put(':projectId/knowledge/draft')
  @RequirePermission('config.edit')
  async saveKnowledgeDraft(
    @Param('projectId') projectId: string,
    @Body() body: { environmentId?: string; expectedRevision: number; content: unknown },
    @Headers('x-user-id') userId?: string,
  ) {
    try {
      return await this.okfAuthoring!.saveDraft({
        projectId,
        environmentId: body.environmentId,
        expectedRevision: body.expectedRevision,
        content: body.content,
        updatedBy: this.principal(userId),
      });
    } catch (error: any) {
      if (error instanceof OkfDraftConflictError) throw new ConflictException(error.message);
      throw new BadRequestException(error.message);
    }
  }

  @Post(':projectId/knowledge/import')
  @RequirePermission('config.edit')
  @UseInterceptors(FileInterceptor('bundle', { limits: { files: 1, fileSize: OKF_LIMITS.importArchiveMaxBytes } }))
  async importKnowledgeBundle(
    @Param('projectId') projectId: string,
    @UploadedFile() file: { buffer?: Buffer } | undefined,
    @Body() body: { environmentId?: string; expectedRevision?: string },
    @Headers('x-user-id') userId?: string,
  ) {
    if (!file?.buffer) throw new BadRequestException('A ZIP bundle is required');
    try {
      return await this.okfAuthoring!.importBundle({
        projectId,
        environmentId: body.environmentId,
        expectedRevision: Number(body.expectedRevision),
        archive: file.buffer,
        updatedBy: this.principal(userId),
      });
    } catch (error: any) {
      if (error instanceof OkfDraftConflictError) throw new ConflictException(error.message);
      throw new BadRequestException(error.message);
    }
  }

  @Post(':projectId/knowledge/validate')
  @RequirePermission('knowledge.read')
  async validateKnowledgeDraft(@Param('projectId') projectId: string, @Body() body?: { environmentId?: string }) {
    return this.okfAuthoring!.validateDraft(projectId, body?.environmentId || 'production');
  }

  @Get(':projectId/knowledge/artifact-policy')
  @RequirePermission('knowledge.read')
  async getKnowledgeArtifactPolicy(@Param('projectId') projectId: string, @Query('environmentId') environmentId?: string) {
    return this.okfAuthoring!.getArtifactPolicy(projectId, environmentId || 'production');
  }

  @Put(':projectId/knowledge/artifact-policy')
  @RequirePermission('config.publish')
  async setKnowledgeArtifactPolicy(
    @Param('projectId') projectId: string,
    @Body() body: { environmentId?: string; artifactRequired: boolean },
    @Headers('x-user-id') userId?: string,
  ) {
    try {
      return await this.okfAuthoring!.setArtifactPolicy(projectId, body.environmentId || 'production', body.artifactRequired, this.principal(userId));
    } catch (error: any) {
      throw new BadRequestException(error.message);
    }
  }

  @Post(':projectId/knowledge/verifications/:recordId/attest')
  @RequirePermission('knowledge.verify')
  async attestKnowledgeVerification(
    @Param('projectId') projectId: string,
    @Param('recordId') recordId: string,
    @Body() body: { environmentId?: string; expectedRevision: number },
    @Headers('x-user-id') userId?: string,
    @Headers('x-authenticated-role') authenticatedRole?: string,
  ) {
    try {
      return await this.okfAuthoring!.attestDraftVerification({
        projectId,
        environmentId: body.environmentId,
        expectedRevision: body.expectedRevision,
        recordId,
        approvedBy: userId || '',
        approverRole: authenticatedRole || 'publisher',
      });
    } catch (error: any) {
      if (error instanceof OkfDraftConflictError) throw new ConflictException(error.message);
      throw new BadRequestException(error.message);
    }
  }

  @Put(':projectId/knowledge/verifier-roles/:roleId')
  @RequirePermission('user.manage')
  async configureKnowledgeVerifierRole(
    @Param('projectId') projectId: string,
    @Param('roleId') roleId: string,
    @Body() body: { environmentId?: string; principalIds: string[] },
    @Headers('x-user-id') userId?: string,
  ) {
    try {
      return await this.okfAuthoring!.configureVerifierRole(
        projectId, body.environmentId || 'production', roleId, body.principalIds, this.principal(userId),
      );
    } catch (error: any) {
      throw new BadRequestException(error.message);
    }
  }

  @Post(':projectId/knowledge/preview')
  @RequirePermission('knowledge.read')
  async previewKnowledgeDraft(
    @Param('projectId') projectId: string,
    @Body() body: { environmentId?: string; message: string; knownFacts?: Record<string, unknown>; intentCandidates?: string[]; forceShowResults?: boolean },
  ) {
    try {
      // With the insight service the preview also reports the live products each scope would select.
      return this.knowledgeInsight
        ? await this.knowledgeInsight.previewWithCatalogue(projectId, body, body.environmentId || 'production')
        : await this.okfAuthoring!.previewDraft(projectId, body, body.environmentId || 'production');
    } catch (error: any) {
      throw new BadRequestException(error.message);
    }
  }

  @Get(':projectId/knowledge/coverage')
  @RequirePermission('knowledge.read')
  async knowledgeCoverage(@Param('projectId') projectId: string, @Query('environmentId') environmentId?: string) {
    try {
      return await this.knowledgeInsight!.coverage(projectId, environmentId || 'production');
    } catch (error: any) {
      throw new BadRequestException(error.message);
    }
  }

  @Get(':projectId/knowledge/lifecycle')
  @RequirePermission('knowledge.read')
  async knowledgeLifecycle(@Param('projectId') projectId: string, @Query('environmentId') environmentId?: string) {
    try {
      return await this.knowledgeInsight!.lifecycle(projectId, environmentId || 'production');
    } catch (error: any) {
      throw new BadRequestException(error.message);
    }
  }

  /** Reads a bounded, evenly spread sample of the tenant's products and reports what the mapping would make of them. Writes nothing. */
  @Post(':projectId/catalog-mapping/check')
  @RequirePermission('config.edit')
  async checkCatalogMapping(@Param('projectId') projectId: string, @Body() body: { mapping?: unknown; sample?: number }) {
    try {
      return await this.knowledgeInsight!.checkCatalogMapping(projectId, body?.mapping, { sample: body?.sample });
    } catch (error: any) {
      throw new BadRequestException(error.message);
    }
  }

  @Post(':projectId/knowledge/publish')
  @RequirePermission('config.publish')
  async publishKnowledgeDraft(
    @Param('projectId') projectId: string,
    @Body() body: { environmentId?: 'dev' | 'test' | 'staging' | 'production'; expectedRevision: number; version: string; releaseId?: string; required?: boolean; failurePolicy?: 'fail_closed' | 'enrichment_only'; notes?: string },
    @Headers('x-user-id') userId?: string,
  ) {
    try {
      return await this.okfAuthoring!.publishDraft({ ...body, projectId, publishedBy: this.principal(userId) });
    } catch (error: any) {
      if (error instanceof OkfDraftConflictError) throw new ConflictException(error.message);
      throw new BadRequestException(error.message);
    }
  }

  @Get(':projectId/knowledge/releases')
  @RequirePermission('knowledge.read')
  async listKnowledgeReleases(@Param('projectId') projectId: string, @Query('environmentId') environmentId?: string) {
    return this.okfAuthoring!.listReleases(projectId, environmentId || 'production');
  }

  @Get(':projectId/knowledge/releases/:releaseId/export')
  @RequirePermission('knowledge.read')
  async exportKnowledgeRelease(
    @Param('projectId') projectId: string,
    @Param('releaseId') releaseId: string,
    @Query('environmentId') environmentId?: string,
  ) {
    try {
      const bytes = await this.okfAuthoring!.exportRelease(projectId, releaseId, environmentId || 'production');
      const filename = releaseId.replace(/[^a-zA-Z0-9._-]/g, '_');
      return new StreamableFile(Buffer.from(bytes), {
        type: 'application/zip',
        disposition: `attachment; filename="${filename}.zip"`,
      });
    } catch (error: any) {
      throw new BadRequestException(error.message);
    }
  }

  @Get(':projectId/knowledge/revocations')
  @RequirePermission('knowledge.read')
  async listKnowledgeRevocations(@Param('projectId') projectId: string, @Query('environmentId') environmentId?: string) {
    try {
      return await this.okfAuthoring!.listRevocations(projectId, environmentId || 'production');
    } catch (error: any) {
      throw new BadRequestException(error.message);
    }
  }

  @Post(':projectId/knowledge/revocations')
  @RequirePermission('knowledge.revoke')
  async createKnowledgeRevocation(
    @Param('projectId') projectId: string,
    @Body() body: { environmentId?: string; releaseId: string; conceptIds: string[]; cascade?: 'none' | 'descendants'; effect?: { suppressClaims?: boolean; suppressRetrieval?: boolean }; reason: string; expiresAt: string },
    @Headers('x-user-id') userId?: string,
  ) {
    try {
      return await this.okfAuthoring!.createRevocation({ ...body, projectId, actor: userId });
    } catch (error: any) {
      throw this.revocationError(error);
    }
  }

  @Post(':projectId/knowledge/revocations/:revocationId/lift')
  @RequirePermission('knowledge.revoke')
  async liftKnowledgeRevocation(
    @Param('projectId') projectId: string,
    @Param('revocationId') revocationId: string,
    @Body() body: { environmentId?: string; correctedReleaseId: string; reason?: string },
    @Headers('x-user-id') userId?: string,
  ) {
    try {
      return await this.okfAuthoring!.liftRevocation({ ...body, projectId, revocationId, actor: userId });
    } catch (error: any) {
      throw this.revocationError(error);
    }
  }

  @Post(':projectId/knowledge/revocations/prune')
  @RequirePermission('knowledge.revoke')
  async pruneKnowledgeRevocations(
    @Param('projectId') projectId: string,
    @Body() body: { environmentId?: string; before: string },
    @Headers('x-user-id') userId?: string,
  ) {
    try {
      return await this.okfAuthoring!.pruneRevocations(projectId, body.environmentId || 'production', body.before, userId);
    } catch (error: any) {
      throw this.revocationError(error);
    }
  }

  /** Human-attributed authoring actions require an authenticated principal; no default identity is invented. */
  private principal(userId?: string): string {
    const principal = (userId || '').trim();
    if (!principal) throw new UnauthorizedException('An authenticated principal is required for this action');
    return principal;
  }

  private revocationError(error: any): Error {
    if (error instanceof OkfIntegrityError && ['invalid_transition', 'revocation_not_found'].includes(error.code)) {
      return error.code === 'revocation_not_found' ? new NotFoundException(error.message) : new ConflictException(error.message);
    }
    return new BadRequestException(error.message);
  }

  @Post(':projectId/knowledge/select-release')
  @RequirePermission('config.publish')
  async selectKnowledgeRelease(
    @Param('projectId') projectId: string,
    @Body() body: { environmentId?: string; releaseId: string; version: string; checksum: string; required?: boolean; failurePolicy?: 'fail_closed' | 'enrichment_only' },
  ) {
    try {
      return await this.okfAuthoring!.selectRelease({ ...body, projectId });
    } catch (error: any) {
      throw new BadRequestException(error.message);
    }
  }

  // ── Isolation Context (inter-service use) ─────────────────────

  /**
   * GET /api/v1/projects/:projectId/context
   *
   * Returns the ProjectIsolationContext — the key object that every
   * downstream service uses to scope its MongoDB queries.
   *
   * Response includes:
   *   mongoFilter: { projectId }  ← apply this to EVERY DB query
   *   searchScope: { rooms, finishes, categories, complianceTags }
   *   pricing: { currency, taxRate, discountRate }
   *   persona: { systemName, systemPromptOverrides }
   */
  @Get(':projectId/context')
  async getIsolationContext(@Param('projectId') projectId: string) {
    const ctx = await this.projectService.getIsolationContext(projectId);
    if (!ctx) {
      throw new NotFoundException(`Isolation context for project '${projectId}' not found.`);
    }
    return ctx;
  }

  // ── Members ───────────────────────────────────────────────────

  @Get(':projectId/members')
  async listMembers(@Param('projectId') projectId: string) {
    const project = await this.projectService.getProject(projectId);
    if (!project) throw new NotFoundException(`Project '${projectId}' not found.`);
    return this.projectService.listMembers(projectId);
  }

  @Post(':projectId/members')
  @RequirePermission('user.manage')
  async addMember(
    @Param('projectId') projectId: string,
    @Body() body: {
      email: string;
      fullName: string;
      role: MemberRole;
      orgId?: string;
    },
  ) {
    if (!body.email || !body.fullName || !body.role) {
      throw new BadRequestException('email, fullName, and role are required.');
    }

    const project = await this.projectService.getProject(projectId);
    if (!project) throw new NotFoundException(`Project '${projectId}' not found.`);

    const result = await this.projectService.addMember(
      projectId,
      body.orgId || project.orgId,
      body.email,
      body.fullName,
      body.role,
    );

    if (!result.success) throw new BadRequestException(result.message);
    return result;
  }

  @Patch(':projectId/members/:email')
  @RequirePermission('user.manage')
  async updateMemberRole(
    @Param('projectId') projectId: string,
    @Param('email') email: string,
    @Body() body: { role: MemberRole; isActive?: boolean },
  ) {
    if (!body.role) throw new BadRequestException('role is required.');
    const result = await this.projectService.updateMemberRole(
      projectId, email, body.role, body.isActive,
    );
    if (!result.success) throw new NotFoundException(result.message);
    return result;
  }

  @Delete(':projectId/members/:email')
  @RequirePermission('user.manage')
  async removeMember(
    @Param('projectId') projectId: string,
    @Param('email') email: string,
  ) {
    const result = await this.projectService.removeMember(projectId, email);
    if (!result.success) throw new NotFoundException(`Member '${email}' not found.`);
    return result;
  }

  @Post(':projectId/members/invite')
  @RequirePermission('user.manage')
  async inviteMember(
    @Param('projectId') projectId: string,
    @Body() body: {
      email: string;
      fullName: string;
      role: MemberRole;
      orgId?: string;
      teams?: string[];
      responsibilities?: string[];
      workflowOwnership?: string[];
    },
    @Headers('x-user-id') userId?: string,
  ) {
    if (!body.email || !body.fullName || !body.role) {
      throw new BadRequestException('email, fullName, and role are required.');
    }
    const project = await this.projectService.getProject(projectId);
    if (!project) throw new NotFoundException(`Project '${projectId}' not found.`);

    const result = await this.projectService.inviteMember(
      projectId,
      body.orgId || project.orgId,
      body.email,
      body.fullName,
      body.role,
      this.principal(userId),
      {
        teams: body.teams,
        responsibilities: body.responsibilities,
        workflowOwnership: body.workflowOwnership,
      }
    );
    if (!result.success) throw new BadRequestException(result.message);
    return result;
  }

  @Post(':projectId/members/accept')
  async acceptInvitation(
    @Param('projectId') projectId: string,
    @Body() body: { email: string; token: string }
  ) {
    if (!body.email || !body.token) {
      throw new BadRequestException('email and token are required.');
    }
    const result = await this.projectService.acceptInvitation(projectId, body.email, body.token);
    if (!result.success) throw new BadRequestException(result.message);
    return result;
  }

  @Get(':projectId/teams')
  @RequirePermission('project.read')
  async listTeams(@Param('projectId') projectId: string) {
    const project = await this.projectService.getProject(projectId);
    if (!project) throw new NotFoundException(`Project '${projectId}' not found.`);
    return this.projectService.listTeams(projectId);
  }

  @Post(':projectId/teams')
  @RequirePermission('user.manage')
  async addTeam(
    @Param('projectId') projectId: string,
    @Body() body: {
      name: string;
      teamId?: string;
      description?: string;
      workflowOwnership?: string[];
      escalationContact?: string;
      orgId?: string;
    }
  ) {
    if (!body.name) throw new BadRequestException('Team name is required.');
    const project = await this.projectService.getProject(projectId);
    if (!project) throw new NotFoundException(`Project '${projectId}' not found.`);
    return this.projectService.addTeam(projectId, body.orgId || project.orgId, body);
  }

  @Post(':projectId/verify-membership')
  @RequirePermission('project.read')
  async verifyMembership(
    @Param('projectId') projectId: string,
    @Body() body: { email: string },
  ) {
    if (!body.email) throw new BadRequestException('email is required.');
    return this.projectService.verifyMembership(body.email, projectId);
  }

  @Get(':projectId/capabilities')
  @RequirePermission('project.read')
  async listCapabilities(@Param('projectId') projectId: string) {
    const project = await this.projectService.getProject(projectId);
    if (!project) throw new NotFoundException(`Project '${projectId}' not found.`);

    const toolIds: string[] = Array.isArray(project.capabilities)
      ? project.capabilities
      : Array.isArray((project as any).tools)
      ? (project as any).tools
      : [];

    if (toolIds.length > 0) {
      return toolIds.map((id) => ({
        id,
        label: id.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase()),
        description: `Authoritative tool for ${id}`,
      }));
    }

    return Object.keys(STANDARD_TOOL_SCHEMAS).map((id) => ({
      id,
      label: id.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase()),
      description: `Authoritative tool for ${id}`,
    }));
  }

  // ── Business Rules (back-office configurable, agent-consumed) ──
  //   GET    /api/v1/projects/:projectId/rules          list all rules
  //   GET    /api/v1/projects/:projectId/rules/active   active rules (agent uses this)
  //   POST   /api/v1/projects/:projectId/rules          create
  //   PATCH  /api/v1/projects/:projectId/rules/:ruleId  update
  //   DELETE /api/v1/projects/:projectId/rules/:ruleId  delete

  @Get(':projectId/rules')
  async listRules(@Param('projectId') projectId: string) {
    return this.projectService.listRules(projectId);
  }

  @Get(':projectId/rules/active')
  async listActiveRules(@Param('projectId') projectId: string) {
    return this.projectService.getActiveRules(projectId);
  }

  @Post(':projectId/rules')
  @RequirePermission('config.edit')
  async createRule(
    @Param('projectId') projectId: string,
    @Body() dto: CreateBusinessRuleDto,
  ) {
    if (!dto.name || !dto.scope || !dto.condition || !dto.action) {
      throw new BadRequestException('name, scope, condition and action are required.');
    }
    const result = await this.projectService.createRule(projectId, dto);
    if (!result.success) throw new BadRequestException(result.message);
    return result;
  }

  @Patch(':projectId/rules/:ruleId')
  @RequirePermission('config.edit')
  async updateRule(
    @Param('projectId') projectId: string,
    @Param('ruleId') ruleId: string,
    @Body() dto: UpdateBusinessRuleDto,
  ) {
    const result = await this.projectService.updateRule(projectId, ruleId, dto);
    if (!result.success) throw new NotFoundException(result.message);
    return result;
  }

  @Delete(':projectId/rules/:ruleId')
  @RequirePermission('config.edit')
  async deleteRule(
    @Param('projectId') projectId: string,
    @Param('ruleId') ruleId: string,
  ) {
    const result = await this.projectService.deleteRule(projectId, ruleId);
    if (!result.success) throw new NotFoundException(result.message);
    return result;
  }

  /** Publish gate: flips a rule to 'published' so getActiveRules (and thus the agent) honours it. */
  @Post(':projectId/rules/:ruleId/publish')
  @RequirePermission('config.publish')
  async publishRule(
    @Param('projectId') projectId: string,
    @Param('ruleId') ruleId: string,
  ) {
    const result = await this.projectService.publishRule(projectId, ruleId);
    if (!result.success) throw new NotFoundException(result.message);
    return result;
  }

  // ── Card CMS (v3 — docs/v3-card-cms-architecture.md) ────────────────────
  // Layer 3 of the tenant theme: one json-render spec per card type. GET is
  // unguarded (read-only, mirrors /rules); PUT/DELETE write the DRAFT and
  // require config.edit like every other config mutation. Cards take effect
  // once the draft is published, same as everything else on the project doc.
  //
  //   GET    /api/v1/projects/:projectId/cards              every card type, tenant override or platform default
  //   PUT    /api/v1/projects/:projectId/cards/:cardType     upsert a tenant override (draft)
  //   DELETE /api/v1/projects/:projectId/cards/:cardType     remove the override (falls back to default)

  @Get(':projectId/cards')
  async listCards(@Param('projectId') projectId: string) {
    const result = await this.projectService.listCardTemplates(projectId);
    if (!result) throw new NotFoundException(`Project '${projectId}' not found.`);
    return result;
  }

  @Put(':projectId/cards/:cardType')
  @RequirePermission('config.edit')
  async putCard(
    @Param('projectId') projectId: string,
    @Param('cardType') cardType: string,
    @Body() body: { spec: unknown; note?: string; variant?: string },
  ) {
    if (!isCardType(cardType)) {
      throw new BadRequestException(`Unknown cardType '${cardType}'.`);
    }
    const problems = validateCardSpec(body?.spec);
    if (problems.length) {
      throw new BadRequestException({ message: 'Invalid card spec.', problems });
    }
    const doc: CardTemplateDoc = {
      cardType,
      spec: body.spec as CardTemplateDoc['spec'],
      updatedAt: new Date().toISOString(),
      ...(body.variant ? { variant: body.variant } : {}),
      ...(body.note ? { note: body.note } : {}),
    };
    const result = await this.projectService.upsertCardTemplate(projectId, cardType, doc);
    if (!result.success) throw new NotFoundException(result.message);
    return result;
  }

  @Delete(':projectId/cards/:cardType')
  @RequirePermission('config.edit')
  async deleteCard(
    @Param('projectId') projectId: string,
    @Param('cardType') cardType: string,
  ) {
    if (!isCardType(cardType)) {
      throw new BadRequestException(`Unknown cardType '${cardType}'.`);
    }
    const result = await this.projectService.removeCardTemplate(projectId, cardType);
    if (!result.success) throw new NotFoundException(result.message);
    return result;
  }
}
