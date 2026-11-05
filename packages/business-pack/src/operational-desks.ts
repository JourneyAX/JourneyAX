import { z } from 'zod';

const Id = z.string().regex(/^[A-Za-z][A-Za-z0-9_-]{0,79}$/);
const Path = z.string().regex(/^[A-Za-z][A-Za-z0-9_.]{0,119}$/);
const Source = z.object({ connector: Id, tool: Id, args: z.record(z.string(), z.union([z.string().max(400), z.number().finite(), z.boolean()])).default({}) }).strict();
export const DeskIntakeSchema = z.object({
  enabled: z.boolean(),
  /** Explicit workload scope, never a staff member impersonated by the worker. */
  role: z.string().min(1).max(40), groups: z.array(Id).min(1).max(10),
  startAt: z.string().datetime(),
  updatedField: Path, statusField: Path, statuses: z.array(z.string().min(1).max(40)).min(1).max(12),
  pollSeconds: z.number().int().min(15).max(600),
  maxPagesPerPoll: z.number().int().min(1).max(10),
  maxJobsPerPoll: z.number().int().min(1).max(25),
  maxJobsPerHour: z.number().int().min(1).max(500),
  maxAttempts: z.number().int().min(1).max(10),
  resultTtlSeconds: z.number().int().min(300).max(604800),
  /** Optional controlled rollout to actual owned records; absent means all eligible records. */
  recordIds: z.array(z.string().min(1).max(200)).min(1).max(100).optional(),
}).strict();
const Field = z.object({ field: Path, label: z.string().min(1).max(100),
  format: z.enum(['text', 'date', 'messages', 'tags']).optional(),
  messageFields: z.object({ body: Path, author: Path.optional(), time: Path.optional(), visibility: Path.optional() }).strict().optional(),
}).strict().superRefine((field, ctx) => {
  if (field.format === 'messages' && !field.messageFields) ctx.addIssue({ code: 'custom', path: ['messageFields'], message: 'A message view requires explicit source field mappings.' });
});

/** Working surfaces select records. Dialogue and action selection remain in the shared agent, never in a desk playbook. */
export const OperationalDesksSchema = z.object({ desks: z.array(z.object({
  deskId: Id, title: z.string().min(1).max(120), description: z.string().max(500).optional(),
  /** Optional link kind handled by the shared Go canvas, e.g. an order reference. */
  recordType: Id.optional(),
  groups: z.array(z.string().min(1).max(100)).min(1).max(30),
  source: Source,
  columns: z.array(Field).min(1).max(12),
  detail: z.object({ source: Source, fields: z.array(Field).min(1).max(30) }).strict(),
  pagination: z.object({ listBindingId: z.string().min(1).max(160), detailBindingId: z.string().min(1).max(160).optional() }).strict().optional(),
  /** Source status groups describe work on a board; they do not prescribe the conversation. */
  board: z.object({ title: z.string().min(1).max(120), groupBy: Path, titleField: Path,
    groups: z.array(z.object({ value: z.string().min(1).max(80), label: z.string().min(1).max(100) }).strict()).min(1).max(20),
  }).strict().optional(),
  refreshSeconds: z.number().int().min(30).max(600).optional(),
  preparation: z.object({ agentId: Id, instruction: z.string().min(1).max(2000), proposalTools: z.array(z.object({ connector: Id, tool: Id }).strict()).max(20).default([]), intake: DeskIntakeSchema.optional() }).strict().optional(),
  /** A question template, not a sequence of steps. Only these two placeholders are substituted. */
  ask: z.string().min(1).max(500),
}).strict()).max(30) }).strict().superRefine((value, ctx) => {
  const ids = new Set<string>();
  value.desks.forEach((desk, index) => {
    if (ids.has(desk.deskId)) ctx.addIssue({ code: 'custom', path: ['desks', index, 'deskId'], message: 'Desk identifiers must be unique.' });
    ids.add(desk.deskId);
    const intake = desk.preparation?.intake;
    if (intake?.enabled) {
      const fields = new Set(desk.columns.map(field => field.field));
      if (!fields.has(intake.updatedField) || !fields.has(intake.statusField)) ctx.addIssue({ code: 'custom', path: ['desks', index, 'preparation', 'intake'], message: 'Intake must bind its revision and status to returned list fields.' });
      if (!intake.groups.every(group => desk.groups.includes(group))) ctx.addIssue({ code: 'custom', path: ['desks', index, 'preparation', 'intake', 'groups'], message: 'The background reader may use only groups explicitly permitted on this desk.' });
    }
    if (desk.board) {
      const fields = new Set(desk.columns.map(field => field.field));
      if (!fields.has(desk.board.groupBy) || !fields.has(desk.board.titleField)) ctx.addIssue({ code: 'custom', path: ['desks', index, 'board'], message: 'A board may group and label only fields returned by its permitted list read.' });
      if (new Set(desk.board.groups.map(group => group.value)).size !== desk.board.groups.length) ctx.addIssue({ code: 'custom', path: ['desks', index, 'board', 'groups'], message: 'Board group values must be unique.' });
    }
    if (!Object.values(desk.detail.source.args).includes('$recordId')) ctx.addIssue({ code: 'custom', path: ['desks', index, 'detail'], message: 'A detail read must bind the selected record identifier.' });
  });
});
export type OperationalDesk = z.infer<typeof OperationalDesksSchema>['desks'][number];
export function operationalDesksFor(value: unknown, person: { audience: string; groups: string[] }): OperationalDesk[] {
  const parsed = OperationalDesksSchema.safeParse(value);
  if (!parsed.success || person.audience !== 'staff') return [];
  const groups = new Set(person.groups.map(group => group.toLowerCase()));
  return parsed.data.desks.filter(desk => desk.groups.some(group => groups.has(group.toLowerCase())));
}
