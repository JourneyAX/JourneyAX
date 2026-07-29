import { Module } from '@nestjs/common';
import { ProductController } from './product.controller';
import { ProductService } from './product.service';
import { ArtworkService } from './artwork.service';
import { RenderService } from './render.service';

@Module({
  controllers: [ProductController],
  providers: [ProductService, ArtworkService, RenderService]
})
export class ProductModule {}
