import { Body, Controller, Get, Headers, HttpCode, Inject, Param, Post, Query, UnauthorizedException, BadRequestException } from '@nestjs/common';
import { commerceIdentity } from '../identity';
import { CanonicalRuntimeAdapter } from '../runtime/canonical-runtime.adapter';

@Controller('api/v1/:projectId/commerce/cart')
export class CartController {
  constructor(@Inject(CanonicalRuntimeAdapter) private readonly runtime: CanonicalRuntimeAdapter) {}
  private run(projectId: string, assertion: string | undefined, sessionId: unknown, mutation?: Record<string, unknown>) {
    const tenantId = projectId.toLowerCase().trim();
    const person = commerceIdentity(assertion, tenantId);
    if (!person) throw new UnauthorizedException('Sign in to use your cart.');
    if (typeof sessionId !== 'string' || !sessionId.trim() || sessionId.length > 200) throw new BadRequestException('A conversation is required.');
    return this.runtime.commerceCart(tenantId, person.environmentId, { sub: person.principalId, role: person.role, groups: person.groups }, sessionId, mutation);
  }
  @Get()
  get(@Param('projectId') projectId: string, @Query('sessionId') sessionId: string, @Headers('x-gateway-assertion') assertion: string | undefined) { return this.run(projectId, assertion, sessionId); }
  @Post()
  @HttpCode(200)
  update(@Param('projectId') projectId: string, @Body() body: Record<string, unknown>, @Headers('x-gateway-assertion') assertion: string | undefined) { return this.run(projectId, assertion, body?.sessionId, body); }
}
