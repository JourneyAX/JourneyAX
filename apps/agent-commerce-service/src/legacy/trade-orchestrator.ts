/**
 * @deprecated FROZEN LEGACY TRADE ORCHESTRATOR
 * Preserved strictly for unmigrated tenants behind the legacy boundary.
 * Canonical runtime paths must NEVER import or invoke this module.
 */

import {
  BusinessPackRelease,
  BusinessPackLoader,
  getSpacePlannerExtension,
  SpacePlannerExtension,
} from '@journeyax/business-pack';
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
          undefined;
      } catch {
        pack = undefined;
      }
    }

    const plannerExt = pack ? getSpacePlannerExtension(pack) : null;
    if (!plannerExt) {
      return {
        ok: false,
        roomType: '',
        message: `[Configuration Required] Space Planner extension is not published for tenant "${tenantId}". Failing closed.`,
      };
    }

    const allowedRooms = plannerExt.roomTypes.map((r) => r.id.toLowerCase());
    const rawRoom = String(args.roomType || plannerExt.defaults?.defaultRoomType || '')
      .toLowerCase()
      .trim();
    if (!rawRoom || !allowedRooms.includes(rawRoom)) {
      return {
        ok: false,
        roomType: '',
        message: `Invalid or unsupported roomType: "${args.roomType}". Must be one of: ${allowedRooms.join(', ')}`,
      };
    }
    const roomType = rawRoom;

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
   * Calculates structural trade project materials.
   * Fails closed without fabricating products or prices.
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

    const projectType = String(args.projectType || '').toLowerCase().trim();
    if (!projectType) {
      return {
        ok: false,
        message: 'projectType is required (fencing, lining, decking, retaining)',
      };
    }

    if (!args.material || typeof args.material !== 'string' || !args.material.trim()) {
      return {
        ok: false,
        message: `material is required for ${projectType} calculation`,
      };
    }

    return {
      ok: false,
      unavailable: true,
      projectType,
      message: `Project plan calculation for '${projectType}' requires a published domain extension formula and real catalogue/inventory connectors. Static fabrication is disabled in generic runtime.`,
    };
  }

  /**
   * Checks branch stock availability across retail network locations via tenant-scoped connector.
   */
  static async handleCheckBranchStock(tenantId: string, rawArgs: string | Record<string, any>): Promise<any> {
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
      tenantId,
      args.sku,
      args.productTitle || 'Item',
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
        const result = await this.handleCheckBranchStock(tenantId, rawArgs);
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
