/**
 * Trade & Space Planner Orchestrator
 *
 * Focuses trade-specific calculation, branch inventory, and modular space planner
 * execution out of agent.service.ts into a typed, pack-driven orchestration module.
 */

import {
  BusinessPackRelease,
  BusinessPackLoader,
  getSpacePlannerExtension,
  SpacePlannerExtension,
} from '@journeyax/business-pack';
import { ProjectCalculatorService } from '../commerce/project-calculator.service';
import { BranchStockService } from '../commerce/branch-stock.service';

export interface SpacePlannerOpenResult {
  ok: boolean;
  roomType: string;
  wallWidthMm?: number;
  installType?: 'diy' | 'trade';
  finish?: string;
  message: string;
  config?: SpacePlannerExtension;
}

export class TradeOrchestrator {
  private static packLoader = new BusinessPackLoader();

  /**
   * Resolves and normalizes space planner launch arguments against the tenant's active Business Pack.
   */
  static async handleOpenSpacePlanner(
    tenantId: string,
    rawArgs: string | Record<string, any>,
    providedPack?: BusinessPackRelease
  ): Promise<SpacePlannerOpenResult> {
    let args: any = {};
    if (typeof rawArgs === 'string') {
      try {
        args = JSON.parse(rawArgs || '{}');
      } catch {
        args = {};
      }
    } else if (rawArgs && typeof rawArgs === 'object') {
      args = rawArgs;
    }

    let pack = providedPack;
    if (!pack) {
      try {
        pack =
          (await this.packLoader.loadPublished(tenantId, 'production').catch(() => null)) ||
          (await this.packLoader.loadPublished(tenantId, 'test').catch(() => null)) ||
          undefined;
      } catch {
        pack = undefined;
      }
    }

    const plannerExt = pack ? getSpacePlannerExtension(pack) : null;
    const allowedRooms = plannerExt?.roomTypes.map((r) => r.id.toLowerCase()) || [
      'laundry',
      'bathroom',
      'kitchen',
      'utility',
    ];

    const rawRoom = String(args.roomType || plannerExt?.defaults?.defaultRoomType || 'laundry')
      .toLowerCase()
      .trim();
    const roomType = allowedRooms.includes(rawRoom) ? rawRoom : allowedRooms[0] || 'laundry';

    const wallWidthMm =
      typeof args.wallWidthMm === 'number'
        ? args.wallWidthMm
        : Number(args.wallWidthMm) > 0
        ? Number(args.wallWidthMm)
        : undefined;

    const installType =
      args.installType === 'trade' || args.installType === 'diy' ? args.installType : undefined;

    const finish =
      typeof args.finish === 'string' && args.finish.trim() ? args.finish.trim() : undefined;

    const companyName = pack?.profile?.companyName || pack?.manifest?.name || tenantId;

    return {
      ok: true,
      roomType,
      ...(wallWidthMm ? { wallWidthMm } : {}),
      ...(installType ? { installType } : {}),
      ...(finish ? { finish } : {}),
      message: `${companyName} Space Planner launched for ${roomType}`,
      ...(plannerExt ? { config: plannerExt } : {}),
    };
  }

  /**
   * Calculates structural trade project materials (decking, fencing, wall lining).
   */
  static handleBuildProjectPlan(rawArgs: string | Record<string, any>): any {
    let args: any = {};
    if (typeof rawArgs === 'string') {
      try {
        args = JSON.parse(rawArgs || '{}');
      } catch {
        args = {};
      }
    } else if (rawArgs && typeof rawArgs === 'object') {
      args = rawArgs;
    }

    const projectType = String(args.projectType || 'decking').toLowerCase();
    if (projectType === 'fencing') {
      return ProjectCalculatorService.calculateFencing(
        args.lengthM || 15,
        args.heightM || 1.8,
        args.material || 'Timber Palings'
      );
    }
    if (projectType === 'lining') {
      return ProjectCalculatorService.calculateWallLining(
        args.areaM2 || 35,
        args.material || 'GIB Standard 10mm'
      );
    }
    // Default to decking
    return ProjectCalculatorService.calculateDecking(
      args.lengthM || 4,
      args.widthM || 3,
      args.material || 'Kwila',
      args.heightM || 0.4
    );
  }

  /**
   * Checks branch stock availability across retail network locations.
   */
  static handleCheckBranchStock(rawArgs: string | Record<string, any>): any {
    let args: any = {};
    if (typeof rawArgs === 'string') {
      try {
        args = JSON.parse(rawArgs || '{}');
      } catch {
        args = {};
      }
    } else if (rawArgs && typeof rawArgs === 'object') {
      args = rawArgs;
    }

    return BranchStockService.getStockForSku(
      args.sku || 'PM-TIMBER-100',
      args.productTitle || 'Building Material / Tool',
      args.branch
    );
  }

  /**
   * Central dispatch handler for trade-specific capabilities.
   */
  static async executeTradeTool(
    toolName: string,
    rawArgs: any,
    tenantId: string,
    pack?: BusinessPackRelease
  ): Promise<{ handled: boolean; result?: any }> {
    switch (toolName) {
      case 'openSpacePlanner': {
        const result = await this.handleOpenSpacePlanner(tenantId, rawArgs, pack);
        return { handled: true, result };
      }
      case 'buildProjectPlan': {
        const result = this.handleBuildProjectPlan(rawArgs);
        return { handled: true, result };
      }
      case 'checkBranchStock': {
        const result = this.handleCheckBranchStock(rawArgs);
        return { handled: true, result };
      }
      default:
        return { handled: false };
    }
  }

  /**
   * Generates a pack-driven consultative sales rep trade prompt block.
   */
  static getPackDrivenConsultativePrompt(projectConfig?: any, pack?: BusinessPackRelease): string {
    const company =
      pack?.profile?.companyName ||
      projectConfig?.companyName ||
      'Trade Materials Specialist';
    const persona = projectConfig?.systemName || `${company} Consultant`;

    return (
      `[CONSULTATIVE SALES REP PARTNERSHIP & ROOM DISCOVERY] You are an experienced ${persona} partnering with the customer to design their space.\n` +
      `When the customer asks to build or plan a room makeover, cabinetry, or utility space:\n` +
      `1. Engage warmly as a pair-planning consultant: congratulate their project, explain that you will build it together step-by-step.\n` +
      `2. Check what they already told you in THIS message before asking anything else, then ask ONLY about whichever core dimension is still missing (Room Type/Wall Run, Style & Finish, Fixtures & Appliances, and Installation Preference).\n` +
      `3. On discovery, call setPhase("clarify") to render the question cards in the conversation with selectable options. Do NOT call openSpacePlanner or showItems yet.\n` +
      `4. Once the customer answers the clarifying questions, then openSpacePlanner or product recommendations can be launched with their chosen configuration.`
    );
  }
}
