import { BranchStockService } from '../../commerce/branch-stock.service';
import { ProjectCalculatorService } from '../../commerce/project-calculator.service';
import { adapterRegistry } from '@journeyax/integration';

export function handleBuildProjectPlan(rawArgs: string): any {
  let args: any = {};
  try { args = JSON.parse(rawArgs || '{}'); } catch { /* fall through */ }
  const projectType = String(args.projectType || 'decking').toLowerCase();
  if (projectType === 'fencing') return ProjectCalculatorService.calculateFencing(args.lengthM || 15, args.heightM || 1.8, args.material || 'Timber Palings');
  if (projectType === 'lining') return ProjectCalculatorService.calculateWallLining(args.areaM2 || 35, args.material || 'GIB Standard 10mm');
  return ProjectCalculatorService.calculateDecking(args.lengthM || 4, args.widthM || 3, args.material || 'Kwila', args.heightM || 0.4);
}

export function handleCheckBranchStock(rawArgs: string): any {
  let args: any = {};
  try { args = JSON.parse(rawArgs || '{}'); } catch { /* fall through */ }
  return BranchStockService.getStockForSku(args.sku || 'PM-TIMBER-100', args.productTitle || 'Building Material / Tool', args.branch);
}

export async function saveEntity(tenantId: string, rawArgs: string): Promise<unknown> {
  let args: any = {};
  try { args = JSON.parse(rawArgs || '{}'); } catch { /* fall through */ }
  if (!args?.name) return { ok: false, message: 'A name is required — ask the customer.' };
  try {
    const business = await adapterRegistry.getBusiness(tenantId);
    if (typeof business.registerEntity !== 'function') return { ok: false, message: 'This business cannot save records; carry the details in the conversation instead.' };
    return await business.registerEntity({ tenantId }, args);
  } catch (err) {
    console.error('[AgentService] registerEntity error:', err);
    return { ok: false, message: 'Could not save right now.' };
  }
}
