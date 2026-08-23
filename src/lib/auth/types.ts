/**
 * Account shapes, shared by every directory implementation.
 *
 * Split out so `users.ts`, `file-store.ts` and the route handlers can agree
 * on a record without importing each other in a circle.
 */

export type Role = 'csr' | 'admin';

export interface UserRecord {
  username: string;
  role: Role;
  passwordHash: string;

  /** Set when an administrator has issued a temporary password. */
  mustChangePassword?: boolean;
  passwordChangedAt?: string;

  /** base32 TOTP secret. Present only once MFA has been *activated*. */
  totpSecret?: string;
  /**
   * A secret that has been issued but not yet proven. Kept separate so an
   * abandoned enrolment can never lock someone out of their own account.
   */
  pendingTotpSecret?: string;
  totpActivatedAt?: string;
  /** Highest TOTP step already spent, to stop a code being replayed. */
  totpLastStep?: number;

  /** Hashed single-use recovery codes. Never stored in plaintext. */
  recoveryCodeHashes?: string[];

  /** An administrator can disable an account without deleting its history. */
  disabled?: boolean;
}

/** The fields a caller may change. Username and role are not among them. */
export type UserPatch = Partial<Omit<UserRecord, 'username' | 'role'>>;

export interface UserDirectory {
  find(username: string): Promise<UserRecord | null>;
  /**
   * Persist a change. Absent on read-only directories — check `writable`
   * before calling rather than relying on a thrown error.
   */
  update?(username: string, patch: UserPatch): Promise<UserRecord | null>;
  list?(): Promise<UserRecord[]>;
  /** False for the environment-variable directory. */
  writable: boolean;
}
