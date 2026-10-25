/**
 * Demo people for trying "who sees what" with real sign-ins: six members of staff, each in exactly one team the pack's access table
 * names (customer service, sales, sales managers, marketing, insights, leadership), and one signed-in shopper. Each person belongs to a
 * single team on purpose: when two rows disagree the stricter one wins, so a second team could only take access away, never add it.
 * Pure planning and writing against any database object, so a test can rehearse it in memory.
 *
 * A staff sign-in has three parts, all in the one database the services read:
 *   users            the login (email, password hash, tenant, role)
 *   project_teams    the team (its name is the group the pack's access rows use, normalised)
 *   project_members  the person's membership of the project, with the teams they are in
 * The gateway then looks the teams up and signs them into the identity the runtime reads; nothing the browser says can add one.
 *
 * Demo passwords are for a rehearsal or a demo. Change them (or do not load the staff at all) for a shop that is open to real customers.
 */
export interface DemoStaffPerson {
  email: string;
  fullName: string;
  /** The login role: `cs` (customer service) and `rep` are staff roles; `buyer` is a signed-in shopper, who is in no team. */
  role: 'cs' | 'rep' | 'buyer';
  /** The member's role in the project (what the back office lets them do); read-only is enough to chat as staff. Staff only. */
  memberRole?: 'viewer' | 'analyst';
  /** The teams, by name; the pack's access rows name them in their normalised form (`Customer Service` -> `customer-service`). Empty for a shopper. */
  teams: string[];
  password: string;
}

export const DEMO_TEAMS: Array<{ name: string; description: string }> = [
  { name: 'Customer Service', description: 'Answers customers about orders, pick-up, deliveries and account questions.' },
  { name: 'Sales', description: 'Builds quotes and trade pricing for contractors and builders.' },
  { name: 'Sales Managers', description: 'Leads the sales team: everything sales can see, plus the sales and service reports.' },
  { name: 'Marketing', description: 'Plans and sends campaigns, and reads web traffic and the reports behind them.' },
  { name: 'Insights', description: 'Reads web traffic and the sales and service reports; sees no customer records.' },
  { name: 'Leadership', description: 'Reads everything across the business; changes nothing.' },
];

export const DEMO_STAFF: DemoStaffPerson[] = [
  { email: 'csr@placemakers.demo', fullName: 'Demo Customer Service', role: 'cs', memberRole: 'viewer', teams: ['Customer Service'], password: 'csr-demo-2026' },
  { email: 'sales@placemakers.demo', fullName: 'Demo Sales Rep', role: 'rep', memberRole: 'viewer', teams: ['Sales'], password: 'sales-demo-2026' },
  { email: 'sales.manager@placemakers.demo', fullName: 'Demo Sales Manager', role: 'rep', memberRole: 'viewer', teams: ['Sales Managers'], password: 'salesmanager-demo-2026' },
  { email: 'marketing@placemakers.demo', fullName: 'Demo Marketing Manager', role: 'rep', memberRole: 'viewer', teams: ['Marketing'], password: 'marketing-demo-2026' },
  { email: 'insights@placemakers.demo', fullName: 'Demo Insights Analyst', role: 'rep', memberRole: 'viewer', teams: ['Insights'], password: 'insights-demo-2026' },
  { email: 'exec@placemakers.demo', fullName: 'Demo Executive', role: 'rep', memberRole: 'viewer', teams: ['Leadership'], password: 'exec-demo-2026' },
  { email: 'shopper@placemakers.demo', fullName: 'Demo Shopper', role: 'buyer', teams: [], password: 'shopper-demo-2026' },
];

export interface DemoStaffPlan {
  tenantId: string;
  teams: Array<{ projectId: string; orgId: string; teamId: string; name: string; description: string; workflowOwnership: string[]; createdAt: string }>;
  members: Array<{ projectId: string; orgId: string; email: string; fullName: string; role: string; status: 'active'; isActive: true; teams: string[]; invitedAt: string; acceptedAt: string }>;
  users: Array<{ email: string; tenantId: string; role: string; fullName: string; isActive: true; password: string }>;
}

const teamIdFor = (name: string): string => `team_${name.toLowerCase().replace(/[^a-z0-9]/g, '_')}`.slice(0, 40);

/** What would be written for a project; no database is touched. */
export function planDemoStaff(tenantId: string, orgId = tenantId, now: Date = new Date(), staff: DemoStaffPerson[] = DEMO_STAFF): DemoStaffPlan {
  const projectId = tenantId.toLowerCase();
  const at = now.toISOString();
  const wanted = new Set(staff.flatMap((person) => person.teams));
  return {
    tenantId: projectId,
    teams: DEMO_TEAMS.filter((team) => wanted.has(team.name)).map((team) => ({ projectId, orgId, teamId: teamIdFor(team.name), name: team.name, description: team.description, workflowOwnership: [], createdAt: at })),
    // A shopper is not a member of the project, so only people with a team get a membership.
    members: staff.filter((person) => person.teams.length > 0).map((person) => ({ projectId, orgId, email: person.email.toLowerCase(), fullName: person.fullName, role: person.memberRole ?? 'viewer', status: 'active' as const, isActive: true as const, teams: person.teams, invitedAt: at, acceptedAt: at })),
    users: staff.map((person) => ({ email: person.email.toLowerCase(), tenantId: projectId, role: person.role, fullName: person.fullName, isActive: true as const, password: person.password })),
  };
}

interface DbLike { collection(name: string): { updateOne(filter: any, update: any, options?: any): Promise<any>; deleteMany?(filter: any): Promise<any> } }

/**
 * Where the pieces live. The sign-in service keeps people's logins in one database and the project service keeps teams and members in
 * another (on the PlaceMakers setup: `journeyx` and `journeyax`), so each is named on its own; a rehearsal may give the same one twice.
 */
export interface DemoStaffDatabases { users: DbLike; project: DbLike }

/** Writes the plan with upserts, so running it twice changes nothing. `hash` turns a password into the stored hash (bcrypt in the script). */
export async function applyDemoStaff(dbs: DemoStaffDatabases, plan: DemoStaffPlan, hash: (password: string) => Promise<string>): Promise<{ teams: number; members: number; users: number }> {
  for (const team of plan.teams) {
    await dbs.project.collection('project_teams').updateOne({ projectId: team.projectId, teamId: team.teamId }, { $set: team }, { upsert: true });
  }
  for (const member of plan.members) {
    await dbs.project.collection('project_members').updateOne({ projectId: member.projectId, email: member.email }, { $set: member }, { upsert: true });
  }
  for (const user of plan.users) {
    const { password, ...rest } = user;
    await dbs.users.collection('users').updateOne({ email: user.email }, { $set: { ...rest, passwordHash: await hash(password) }, $setOnInsert: { createdAt: new Date() } }, { upsert: true });
  }
  return { teams: plan.teams.length, members: plan.members.length, users: plan.users.length };
}

/** Undoes a load: removes the demo staff's login and membership (the teams are left, they may hold real people). */
export async function removeDemoStaff(dbs: DemoStaffDatabases, plan: DemoStaffPlan): Promise<void> {
  for (const member of plan.members) await dbs.project.collection('project_members').deleteMany?.({ projectId: member.projectId, email: member.email });
  for (const user of plan.users) await dbs.users.collection('users').deleteMany?.({ email: user.email });
}
