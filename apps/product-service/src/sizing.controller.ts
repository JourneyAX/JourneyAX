import { Body, Controller, Inject, Param, Post } from '@nestjs/common';
import { RecommendInput, SizingService } from './sizing.service';

/**
 * Fitment guide (v1) endpoint — the agent's `recommendSize` tool calls this
 * directly (mirrors the `POST /:projectId/products/*` CDL/render pattern used
 * by analyzeDesign/generateDesign, but under its own `/sizing` path since it
 * is not a products-collection operation). Read-only catalogue-derived fact,
 * same exposure level as `/products/related` — no internal key required.
 */
@Controller('api/v1/:projectId/sizing')
export class SizingController {
  constructor(@Inject(SizingService) private readonly sizing: SizingService) {}

  @Post('recommend')
  async recommend(
    @Param('projectId') projectId: string,
    @Body() body: Omit<RecommendInput, 'tenantId'>,
  ) {
    const tenantId = (projectId || '').toLowerCase();
    return this.sizing.recommend({ ...body, tenantId });
  }
}
