/**
 * What happens after a named person approves: each step of the approved list is carried out in the system it names. This is the only place in the
 * care module that changes anything outside our own case files, and it runs only from an approval.
 *
 * `UnavailableWriteBack` is what runs until the write tools are switched on: it changes nothing and says so, so an approval never looks as if it
 * had done something it had not.
 */
import type { CareCase, CareStep } from './care.types';

export interface CareActor { name: string; id: string; isLead: boolean }
export interface WriteResult { ok: boolean; message?: string }

export interface CareWriteBack {
  run(tenantId: string, doc: CareCase, step: CareStep, ctx: { draft: string; actor: CareActor }): Promise<WriteResult>;
}

export class UnavailableWriteBack implements CareWriteBack {
  async run(_tenantId: string, _doc: CareCase, step: CareStep): Promise<WriteResult> {
    return { ok: false, message: `Changing ${step.system} from here is not switched on yet. Nothing was changed.` };
  }
}
