import { Module } from '@nestjs/common';
import { ProductController } from './product.controller';
import { ProductService } from './product.service';
import { ArtworkService } from './artwork.service';
import { RenderService } from './render.service';
import { TryOnService } from './tryon.service';
import { SizingController } from './sizing.controller';
import { SizingService } from './sizing.service';

@Module({
  controllers: [ProductController, SizingController],
  providers: [ProductService, ArtworkService, RenderService, TryOnService, SizingService]
})
export class ProductModule {}
