import type { BusinessPackRelease } from '@journeyax/business-pack';
import type { WorkspaceState } from '@journeyax/journey-core';

/**
 * Workspace release pins are immutable by default. A pack may opt in to re-pinning idle workspaces onto the
 * active release via `extensions.workspacePinPolicy.idleRepinAfterHours`; absent means never.
 */
export function idleRepinHours(pinned: BusinessPackRelease): number | undefined {
  const hours = (pinned as any)?.extensions?.workspacePinPolicy?.idleRepinAfterHours;
  return typeof hours === 'number' && Number.isFinite(hours) && hours > 0 ? hours : undefined;
}

export function isIdleBeyond(workspace: Pick<WorkspaceState, 'updatedAt'>, hours: number, now = new Date()): boolean {
  const last = new Date(workspace.updatedAt as any).getTime();
  return Number.isFinite(last) && now.getTime() - last > hours * 3_600_000;
}

function journeyList(pack: BusinessPackRelease): any[] {
  const raw: any = pack.journeys;
  if (Array.isArray(raw)) return raw;
  if (Array.isArray(raw?.journeys)) return raw.journeys;
  return raw && typeof raw === 'object' ? Object.values(raw) : [];
}

/** A re-pin is only safe when the candidate pack still contains the workspace's journey and current stage. */
export function packHostsWorkspace(pack: BusinessPackRelease, workspace: Pick<WorkspaceState, 'journeyId' | 'currentStage'>): boolean {
  const journey = journeyList(pack).find((candidate) => candidate?.journeyId === workspace.journeyId);
  if (!journey) return false;
  const stages: any = journey.stages;
  const ids: string[] = Array.isArray(stages)
    ? stages.map((stage: any) => stage?.stageId)
    : stages && typeof stages === 'object' ? Object.keys(stages) : [];
  return ids.includes(workspace.currentStage);
}
