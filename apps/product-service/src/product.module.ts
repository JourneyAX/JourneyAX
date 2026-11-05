import { Module } from '@nestjs/common';
import { ProductController } from './product.controller';
import { ProductService } from './product.service';
import { RenderService } from './render.service';
import { TryOnService } from './tryon.service';
import { TryOnAccessGuard } from './tryon-access.guard';

@Module({
  controllers: [ProductController],
  providers: [ProductService, RenderService, TryOnService, TryOnAccessGuard]
})
export class ProductModule {}
