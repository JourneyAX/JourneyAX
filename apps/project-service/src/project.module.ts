import { Module } from '@nestjs/common';
import { ProjectController } from './project.controller';
import { ProjectService } from './project.service';
import { CapabilityRegistryService } from './capability-registry.service';
import { ExperienceConfigurationService } from './experience-configuration.service';
import { JourneyConfigurationService } from './journey-configuration.service';
import { MembershipService } from './membership.service';
import { TeamService } from './team.service';
import { NotificationConfigurationService } from './notification-configuration.service';
import { BusinessPackPublicationService } from './business-pack-publication.service';

@Module({
  controllers: [ProjectController],
  providers: [
    ProjectService,
    CapabilityRegistryService,
    JourneyConfigurationService,
  ],
  exports: [
    ProjectService,
    CapabilityRegistryService,
    JourneyConfigurationService,
  ],
})
export class ProjectModule {}
