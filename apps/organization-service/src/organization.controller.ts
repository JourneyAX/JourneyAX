import {
  Controller, Get, Post, Patch, Body, Param, Query,
  NotFoundException, BadRequestException, Inject,
} from '@nestjs/common';
import { OrganizationService } from './organization.service';
import { CreateOrgDto } from './organization.types';

/**
 * OrganizationController
 *
 * Minimal API for the billing/naming container.
 *
 * Key rule: Organizations do NOT hold any product data, user data,
 * or AI config. They only hold a list of projectId references.
 * All actual data lives in Projects (project-service).
 *
 * Routes:
 *   POST   /api/v1/organizations                   create org
 *   GET    /api/v1/organizations                   list orgs
 *   GET    /api/v1/organizations/:orgId            get org
 *   PATCH  /api/v1/organizations/:orgId/status     update status
 *   PATCH  /api/v1/organizations/:orgId/settings   update SSO/MFA settings
 *   POST   /api/v1/organizations/:orgId/projects/:projectId    link project
 *   DELETE /api/v1/organizations/:orgId/projects/:projectId    unlink project
 *   GET    /api/v1/organizations/health
 */
@Controller('api/v1/organizations')
export class OrganizationController {
  constructor(
    @Inject(OrganizationService)
    private readonly orgService: OrganizationService,
  ) {}

  @Get('health')
  health() {
    return {
      status: 'ok',
      service: 'organization-service',
      note: 'Billing container only — data lives in project-service',
      timestamp: new Date().toISOString(),
    };
  }

  @Post()
  async createOrg(@Body() dto: CreateOrgDto) {
    if (!dto.name || !dto.domain || !dto.billing || !dto.ownerEmail || !dto.ownerFullName) {
      throw new BadRequestException('name, domain, billing, ownerEmail, ownerFullName are required.');
    }
    const result = await this.orgService.createOrganization(dto);
    if (!result.success) throw new BadRequestException(result.message);
    return result;
  }

  @Get()
  async listOrgs(@Query('status') status?: string) {
    return this.orgService.listOrganizations(status);
  }

  @Get(':orgId')
  async getOrg(@Param('orgId') orgId: string) {
    if (orgId === 'health') return this.health();
    const org = await this.orgService.getOrganization(orgId);
    if (!org) throw new NotFoundException(`Organization '${orgId}' not found.`);
    return org;
  }

  @Patch(':orgId/status')
  async updateStatus(
    @Param('orgId') orgId: string,
    @Body() body: { status: string },
  ) {
    if (!body.status) throw new BadRequestException('status is required.');
    const result = await this.orgService.updateStatus(orgId, body.status);
    if (!result.success) throw new BadRequestException(result.message);
    return result;
  }

  @Patch(':orgId/settings')
  async updateSettings(
    @Param('orgId') orgId: string,
    @Body() body: Record<string, any>,
  ) {
    const result = await this.orgService.updateSettings(orgId, body);
    if (!result.success) throw new NotFoundException(`Organization '${orgId}' not found.`);
    return result;
  }

  /**
   * Link a project to this org (called after project-service creates the project).
   * Projects are created in project-service — this just updates the reference list.
   */
  @Post(':orgId/projects/:projectId')
  async linkProject(
    @Param('orgId') orgId: string,
    @Param('projectId') projectId: string,
  ) {
    const result = await this.orgService.addProject(orgId, projectId);
    if (!result.success) throw new NotFoundException(`Organization '${orgId}' not found.`);
    return { success: true, orgId, projectId, linked: true };
  }

  /** Unlink project from org (does NOT delete project data) */
  @Post(':orgId/projects/:projectId/unlink')
  async unlinkProject(
    @Param('orgId') orgId: string,
    @Param('projectId') projectId: string,
  ) {
    const result = await this.orgService.removeProject(orgId, projectId);
    if (!result.success) throw new NotFoundException(`Organization '${orgId}' not found.`);
    return { success: true, orgId, projectId, linked: false };
  }
}
