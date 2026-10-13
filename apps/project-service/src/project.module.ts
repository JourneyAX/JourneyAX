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
import { PublicationGateValidator } from './publication-gate-validator';
import { OkfAuthoringService } from './okf-authoring.service';
import { KnowledgeInsightService } from './knowledge-insight.service';

@Module({
  controllers: [ProjectController],
  providers: [
    ProjectService,
    CapabilityRegistryService,
    JourneyConfigurationService,
    PublicationGateValidator,
    {
      provide: OkfAuthoringService,
      useFactory: (projectService: ProjectService) => new OkfAuthoringService(
        () => projectService.getRuntimeDb(),
        (pid, update) => projectService.updateProject(pid, update as any)
      ),
      inject: [ProjectService],
    },
    {
      provide: KnowledgeInsightService,
      useFactory: (projectService: ProjectService, authoring: OkfAuthoringService) => new KnowledgeInsightService(
        () => projectService.getRuntimeDb(),
        (pid) => projectService.getProject(pid),
        authoring,
      ),
      inject: [ProjectService, OkfAuthoringService],
    },
    {
      provide: BusinessPackPublicationService,
      useFactory: (projectService: ProjectService, gateValidator: PublicationGateValidator) => {
        return new BusinessPackPublicationService(
          () => projectService.getRuntimeDb(),
          () => projectService.getProjectsCol(),
          () => projectService.getVersionsCol(),
          () => projectService.getIsConnected(),
          (pid: string) => projectService.bustCache(pid),
          (pid: string) => projectService.getProject(pid),
          gateValidator
        );
      },
      inject: [ProjectService, PublicationGateValidator],
    },
  ],
  exports: [
    ProjectService,
    CapabilityRegistryService,
    JourneyConfigurationService,
    PublicationGateValidator,
    BusinessPackPublicationService,
    OkfAuthoringService,
  ],
})
export class ProjectModule {}
