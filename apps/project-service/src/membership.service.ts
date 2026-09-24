import { Injectable } from '@nestjs/common';
import { Collection } from 'mongodb';
import * as crypto from 'crypto';
import {
  ProjectMember,
  MemberRole,
  MembershipStatus,
} from './project.types';

@Injectable()
export class MembershipService {
  constructor(
    private getCollection: () => Collection<ProjectMember & { projectId: string; orgId: string }>,
    private isConnected: () => boolean
  ) {}

  async inviteMember(
    projectId: string,
    orgId: string,
    email: string,
    fullName: string,
    role: MemberRole,
    invitedBy = 'system',
    options?: {
      teams?: string[];
      responsibilities?: string[];
      workflowOwnership?: string[];
      autoActivate?: boolean;
    }
  ): Promise<{ success: boolean; message?: string; invitationToken?: string; expiresAt?: string }> {
    if (!this.isConnected()) return { success: false, message: 'Database not available.' };
    const pid = projectId.toLowerCase();
    const cleanEmail = email.toLowerCase().trim();

    const col = this.getCollection();
    const exists = await col.findOne({ projectId: pid, email: cleanEmail });
    const now = new Date().toISOString();
    const token = crypto.randomBytes(24).toString('hex');
    const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();
    const isAutoActive = Boolean(options?.autoActivate);

    if (exists) {
      if (exists.status === 'revoked') {
        await col.updateOne(
          { projectId: pid, email: cleanEmail },
          {
            $set: {
              role,
              fullName,
              status: isAutoActive ? 'active' : 'pending',
              isActive: isAutoActive,
              invitationToken: isAutoActive ? undefined : token,
              invitationExpiresAt: isAutoActive ? undefined : expiresAt,
              invitedAt: now,
              teams: options?.teams || exists.teams || [],
              responsibilities: options?.responsibilities || exists.responsibilities || [],
              workflowOwnership: options?.workflowOwnership || exists.workflowOwnership || [],
            },
            $push: {
              auditTrail: {
                action: 'invited',
                performedBy: invitedBy,
                timestamp: now,
                note: 'Re-invited revoked member',
                details: { role, teams: options?.teams },
              },
            } as any,
          }
        );
        return { success: true, invitationToken: isAutoActive ? undefined : token, expiresAt };
      }
      return { success: false, message: `'${cleanEmail}' is already a member of project '${pid}'.` };
    }

    const newMember: ProjectMember & { projectId: string; orgId: string } = {
      projectId: pid,
      orgId,
      email: cleanEmail,
      fullName,
      role,
      status: isAutoActive ? 'active' : 'pending',
      isActive: isAutoActive,
      invitationToken: isAutoActive ? undefined : token,
      invitationExpiresAt: isAutoActive ? undefined : expiresAt,
      invitedAt: now,
      teams: options?.teams || [],
      responsibilities: options?.responsibilities || [],
      workflowOwnership: options?.workflowOwnership || [],
      auditTrail: [
        {
          action: 'invited',
          performedBy: invitedBy,
          timestamp: now,
          details: { role, teams: options?.teams },
        },
      ],
    };

    await col.insertOne(newMember as any);
    return { success: true, invitationToken: isAutoActive ? undefined : token, expiresAt };
  }

  async addMember(
    projectId: string,
    orgId: string,
    email: string,
    fullName: string,
    role: MemberRole,
    options?: {
      teams?: string[];
      responsibilities?: string[];
      workflowOwnership?: string[];
      autoActivate?: boolean;
    }
  ): Promise<{ success: boolean; message?: string; invitationToken?: string }> {
    return this.inviteMember(projectId, orgId, email, fullName, role, 'system', {
      ...options,
      autoActivate: options?.autoActivate ?? true,
    });
  }

  async acceptInvitation(
    projectId: string,
    email: string,
    token: string
  ): Promise<{ success: boolean; message?: string }> {
    if (!this.isConnected()) return { success: false, message: 'Database not available.' };
    const pid = projectId.toLowerCase();
    const cleanEmail = email.toLowerCase().trim();
    const col = this.getCollection();

    const member = await col.findOne({
      projectId: pid,
      email: cleanEmail,
    });

    if (!member) {
      return { success: false, message: `No pending invitation found for '${cleanEmail}'.` };
    }

    if (member.status === 'active') {
      return { success: true, message: 'Member is already active.' };
    }

    if (!member.invitationToken || member.invitationToken !== token) {
      return { success: false, message: 'Invalid invitation token.' };
    }

    if (member.invitationExpiresAt && new Date(member.invitationExpiresAt) < new Date()) {
      await col.updateOne(
        { projectId: pid, email: cleanEmail },
        { $set: { status: 'expired' } }
      );
      return { success: false, message: 'Invitation has expired.' };
    }

    const now = new Date().toISOString();
    await col.updateOne(
      { projectId: pid, email: cleanEmail },
      {
        $set: {
          status: 'active',
          isActive: true,
          acceptedAt: now,
        },
        $unset: {
          invitationToken: '',
          invitationExpiresAt: '',
        },
        $push: {
          auditTrail: {
            action: 'accepted',
            performedBy: cleanEmail,
            timestamp: now,
          },
        } as any,
      }
    );

    return { success: true };
  }

  async listMembers(projectId: string): Promise<any[]> {
    if (!this.isConnected()) return [];
    const docs = await this.getCollection()
      .find({ projectId: projectId.toLowerCase() })
      .sort({ invitedAt: -1 })
      .toArray();
    return docs.map(({ _id, ...rest }) => rest);
  }

  async updateMemberRole(
    projectId: string,
    email: string,
    role: MemberRole,
    isActive?: boolean,
    performedBy = 'system',
    extras?: { teams?: string[]; responsibilities?: string[]; workflowOwnership?: string[] }
  ): Promise<{ success: boolean; message?: string }> {
    if (!this.isConnected()) return { success: false, message: 'Database not available.' };
    const pid = projectId.toLowerCase();
    const cleanEmail = email.toLowerCase().trim();
    const now = new Date().toISOString();

    const update: any = { role };
    if (isActive !== undefined) {
      update.isActive = isActive;
      update.status = isActive ? 'active' : 'revoked';
    }
    if (extras?.teams) update.teams = extras.teams;
    if (extras?.responsibilities) update.responsibilities = extras.responsibilities;
    if (extras?.workflowOwnership) update.workflowOwnership = extras.workflowOwnership;

    const result = await this.getCollection().updateOne(
      { projectId: pid, email: cleanEmail },
      {
        $set: update,
        $push: {
          auditTrail: {
            action: 'role_changed',
            performedBy,
            timestamp: now,
            details: { newRole: role, isActive, ...extras },
          },
        } as any,
      }
    );

    if (result.matchedCount === 0) {
      return { success: false, message: `Member '${cleanEmail}' not found in project '${projectId}'.` };
    }
    return { success: true };
  }

  async removeMember(
    projectId: string,
    email: string,
    revokedBy = 'system',
    note?: string
  ): Promise<{ success: boolean }> {
    if (!this.isConnected()) return { success: false };
    const pid = projectId.toLowerCase();
    const cleanEmail = email.toLowerCase().trim();
    const now = new Date().toISOString();

    const result = await this.getCollection().updateOne(
      { projectId: pid, email: cleanEmail },
      {
        $set: {
          status: 'revoked',
          isActive: false,
          revokedAt: now,
          revokedBy,
        },
        $push: {
          auditTrail: {
            action: 'revoked',
            performedBy: revokedBy,
            timestamp: now,
            note: note || 'Membership revoked',
          },
        } as any,
      }
    );

    return { success: result.matchedCount > 0 };
  }

  async verifyMembership(
    email: string,
    projectId: string
  ): Promise<{ isMember: boolean; role?: MemberRole; orgId?: string; status?: MembershipStatus }> {
    if (!this.isConnected()) return { isMember: false };
    const cleanEmail = email.toLowerCase().trim();
    const member = await this.getCollection().findOne({
      email: cleanEmail,
      projectId: projectId.toLowerCase(),
      isActive: true,
    });
    if (!member || member.status === 'revoked' || member.status === 'expired') {
      return { isMember: false };
    }
    return { isMember: true, role: member.role, orgId: member.orgId, status: member.status || 'active' };
  }
}
