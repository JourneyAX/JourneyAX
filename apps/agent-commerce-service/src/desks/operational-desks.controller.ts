import { Controller, Get, Post, Body, Headers, Inject, Param, Query, UnauthorizedException, BadRequestException, HttpException } from '@nestjs/common';
import { commerceIdentity } from '../identity';
import { CanonicalRuntimeAdapter } from '../runtime/canonical-runtime.adapter';

/** A transport boundary only. It never loads a separate model, runs a playbook, or calls vendor systems itself. */
@Controller('api/v1/:projectId/commerce/desks')
export class OperationalDesksController {
  constructor(@Inject(CanonicalRuntimeAdapter) private readonly runtime: CanonicalRuntimeAdapter) {}
  private async read(projectId: string, assertion: string | undefined, deskId?: string, recordId?: string, cursor?: string) {
    const tenantId = projectId.toLowerCase().trim();
    const person = commerceIdentity(assertion, tenantId);
    if (!person) throw new UnauthorizedException('Sign in to open a working surface.');
    const result = await this.runtime.getOperationalDesks(tenantId, person.environmentId, { sub: person.principalId, role: person.role, groups: person.groups }, deskId, recordId, cursor);
    if (result?.ok === false) throw new HttpException(result, ['not_allowed', 'refused_by_rule'].includes(result.code) ? 403 : result.code === 'invalid_request' ? 400 : 503);
    return result;
  }
  @Get()
  list(@Param('projectId') projectId: string, @Headers('x-gateway-assertion') assertion: string | undefined) { return this.read(projectId, assertion); }
  @Get(':deskId')
  one(@Param('projectId') projectId: string, @Param('deskId') deskId: string, @Query('recordId') recordId: string | undefined, @Headers('x-gateway-assertion') assertion: string | undefined, @Query('cursor') cursor?: string) { return this.read(projectId, assertion, deskId, recordId, cursor); }
  @Post(':deskId/prepare')
  prepare(@Param('projectId') projectId: string, @Param('deskId') deskId: string, @Body() body: any, @Headers('x-gateway-assertion') assertion: string | undefined) {
    const tenantId = projectId.toLowerCase().trim(); const person = commerceIdentity(assertion, tenantId);
    if (!person) throw new UnauthorizedException('Sign in to open a working surface.');
    if (typeof body?.recordId !== 'string' || !body.recordId || body.recordId.length > 200) throw new BadRequestException('A selected record is required.');
    if (body.workId !== undefined && (typeof body.workId !== 'string' || !/^[a-f0-9]{64}$/.test(body.workId))) throw new BadRequestException('Invalid investigation.');
    return this.runtime.prepareDeskRecord(tenantId, person.environmentId, { sub: person.principalId, role: person.role, groups: person.groups }, deskId, body.recordId, body.workId);
  }
}
