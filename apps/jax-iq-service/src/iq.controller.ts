import { Body, Controller, Headers, HttpCode, Inject, Param, Post, Req, UnauthorizedException, ServiceUnavailableException } from '@nestjs/common';
import { verifyIqRequest, IQ_ASSERTION_HEADER } from '@journeyax/jax-iq';
import { IqService } from './iq.service';

@Controller('api/v1/:tenantId/:environmentId/iq')
export class IqController {
  constructor(@Inject(IqService) private readonly service: IqService) {}

  @Post('query')
  @HttpCode(200)
  async query(@Param('tenantId') tenantId: string, @Param('environmentId') environmentId: string, @Headers(IQ_ASSERTION_HEADER) assertion: string | undefined, @Body() body: unknown, @Req() request: any) {
    let verified: ReturnType<typeof verifyIqRequest>;
    try { verified = verifyIqRequest(assertion ?? '', body, process.env.JAX_IQ_SIGNING_SECRET ?? '', { tenantId, environmentId }); }
    catch { throw new UnauthorizedException('Verified IQ caller scope is required.'); }
    try {
      if (!(await this.service.store.claim(verified.jti, verified.context, verified.expiresAt))) throw new UnauthorizedException('IQ request already used.');
    } catch (error) {
      if (error instanceof UnauthorizedException) throw error;
      throw new ServiceUnavailableException('IQ replay protection is unavailable.');
    }
    const controller = new AbortController();
    const cancel = () => controller.abort(); request.once('aborted', cancel);
    try { return await this.service.query(body, verified.context, controller.signal); }
    finally { request.removeListener('aborted', cancel); }
  }
}
