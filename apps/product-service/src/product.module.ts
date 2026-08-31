import { Module } from '@nestjs/common';
import { ProductController } from './product.controller';
import { ProductService } from './product.service';
import { ArtworkService } from './artwork.service';
import { RenderService } from './render.service';
import { TryOnService } from './tryon.service';
import { CdlController } from './cdl.controller';
import { CdlTemplateService } from './cdl-template.service';
import { CdlAnalyzeService } from './cdl-analyze.service';
import { FabricService } from './fabric.service';
import { RetextureService } from './retexture.service';
import { SizingController } from './sizing.controller';
import { SizingService } from './sizing.service';

@Module({
  controllers: [ProductController, CdlController, SizingController],
  providers: [ProductService, ArtworkService, RenderService, TryOnService, CdlTemplateService, CdlAnalyzeService, FabricService, RetextureService, SizingService]
})
export class ProductModule {}
