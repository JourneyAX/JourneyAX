import { Controller, Get, Param, Res } from '@nestjs/common';
import { InternalOnly } from './auth/auth.guard';
import { readVisual } from './agent/visual-generator';

/** Serves the pictures the visual tool made. Internal only: the storefront asks for them with its internal key, for its own tenant. */
@Controller()
export class VisualsController {
  @InternalOnly()
  @Get('api/v1/visuals/:tenantId/:id')
  async visual(@Param('tenantId') tenantId: string, @Param('id') id: string, @Res() res: any) {
    const picture = await readVisual(tenantId.toLowerCase(), id.toLowerCase());
    if (!picture) {
      res.status(404).json({ error: 'not found' });
      return;
    }
    res.set({ 'content-type': 'image/png', 'cache-control': 'private, max-age=86400', 'content-length': String(picture.length) });
    res.send(picture);
  }
}
