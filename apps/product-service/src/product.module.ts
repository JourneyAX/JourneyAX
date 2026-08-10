import { Module } from '@nestjs/common';
import { ProductController } from './product.controller';
import { ProductService } from './product.service';
import { ArtworkService } from './artwork.service';
import { RenderService } from './render.service';
import { TryOnService } from './tryon.service';

@Module({
  controllers: [ProductController],
  providers: [ProductService, ArtworkService, RenderService, TryOnService]
})
export class ProductModule {}
