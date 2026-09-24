import { Injectable } from '@nestjs/common';
import { Collection } from 'mongodb';
import { ProjectTeam } from './project.types';

@Injectable()
export class TeamService {
  constructor(
    private getCollection: () => Collection<ProjectTeam & { projectId: string; orgId: string }>,
    private isConnected: () => boolean
  ) {}

  async addTeam(
    projectId: string,
    orgId: string,
    team: { teamId?: string; name: string; description?: string; workflowOwnership?: string[]; escalationContact?: string }
  ): Promise<{ success: boolean; team: ProjectTeam }> {
    if (!this.isConnected()) throw new Error('Database not available.');
    const pid = projectId.toLowerCase();
    const teamId = (team.teamId || `team_${team.name.toLowerCase().replace(/[^a-z0-9]/g, '_')}`).slice(0, 40);
    const doc: ProjectTeam & { projectId: string; orgId: string } = {
      projectId: pid,
      orgId,
      teamId,
      name: team.name,
      description: team.description,
      workflowOwnership: team.workflowOwnership || [],
      escalationContact: team.escalationContact,
      createdAt: new Date().toISOString(),
    };
    await this.getCollection().updateOne(
      { projectId: pid, teamId },
      { $set: doc },
      { upsert: true }
    );
    return { success: true, team: doc };
  }

  async listTeams(projectId: string): Promise<ProjectTeam[]> {
    if (!this.isConnected()) return [];
    const pid = projectId.toLowerCase();
    const teams = await this.getCollection().find({ projectId: pid }).toArray();
    return teams.map(({ _id, ...t }: any) => t);
  }
}
