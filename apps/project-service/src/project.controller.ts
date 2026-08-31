import {
  Controller, Get, Post, Patch, Delete,
  Body, Param, Query, Headers,
  NotFoundException, BadRequestException,
  Inject, UseGuards,
} from '@nestjs/common';
import { PermissionGuard, RequirePermission } from './permission.guard';
import { ProjectService, redactSecrets } from './project.service';
import {
  CreateProjectDto, UpdateProjectDto, MemberRole,
  CreateBusinessRuleDto, UpdateBusinessRuleDto,
} from './project.types';

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
    @Body() body?: { note?: string; publishedBy?: string },
  ) {
    const result = await this.projectService.publishConfig(projectId, body || {});
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
  ) {
    const result = await this.projectService.rollbackConfig(projectId, Number(version));
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

  @Post(':projectId/verify-membership')
  async verifyMembership(
    @Param('projectId') projectId: string,
    @Body() body: { email: string },
  ) {
    if (!body.email) throw new BadRequestException('email is required.');
    return this.projectService.verifyMembership(body.email, projectId);
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
}
