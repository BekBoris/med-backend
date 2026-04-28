import { Module } from '@nestjs/common';
import { FilesModule } from '../files/files.module';
import { ResourcesModule } from '../resources/resources.module';
import { IntegrationsController } from './integrations.controller';
import { IntegrationsService } from './integrations.service';

@Module({
  imports: [FilesModule, ResourcesModule],
  controllers: [IntegrationsController],
  providers: [IntegrationsService],
})
export class IntegrationsModule {}
