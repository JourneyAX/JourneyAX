import { Module } from '@nestjs/common';
import { ProductController } from './product.controller';
import { ProductService } from './product.service';
import { RenderService } from './render.service';
import { TryOnService } from './tryon.service';

@Module({
  controllers: [ProductController],
  providers: [ProductService, RenderService, TryOnService]
})
export class ProductModule {}
