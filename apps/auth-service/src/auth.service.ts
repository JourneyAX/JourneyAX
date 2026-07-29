import { Injectable } from '@nestjs/common';
import { connectToDatabase } from '@journeyax/database';
import { Db, Collection } from 'mongodb';
import * as jwt from 'jsonwebtoken';
import * as bcrypt from 'bcrypt';

// ── Constants ─────────────────────────────────────────────────────────
const DB_NAME = 'journeyx';
const USERS_COLLECTION = 'users';
const REFRESH_COLLECTION = 'refresh_tokens';
const BCRYPT_ROUNDS = 12;

// ── Types ──────────────────────────────────────────────────────────────
export interface User {
  _id?: any;
  email: string;
  passwordHash: string;
  tenantId: string;
  role: 'admin' | 'buyer' | 'manager';
  fullName: string;
  isActive: boolean;
  createdAt: Date;
  lastLoginAt?: Date;
}

export interface TokenPayload {
  sub: string;        // user email
  tenantId: string;
  role: string;
  fullName: string;
  iat?: number;
  exp?: number;
}

export interface AuthTokens {
  accessToken: string;
  refreshToken: string;
  expiresIn: number;  // seconds
}

// ── AuthService ────────────────────────────────────────────────────────
@Injectable()
export class AuthService {
  private db: Db | null = null;

  // ── JWT Config ─────────────────────────────────────────────────────
  private get JWT_SECRET(): string {
    const secret = process.env.JWT_SECRET;
    if (!secret) throw new Error('JWT_SECRET environment variable is required');
    return secret;
  }

  private get JWT_REFRESH_SECRET(): string {
    return process.env.JWT_REFRESH_SECRET || `${this.JWT_SECRET}_refresh`;
  }

  private readonly ACCESS_TOKEN_TTL = '15m';    // short-lived
  private readonly REFRESH_TOKEN_TTL = '7d';    // long-lived

  // ── DB Connection ──────────────────────────────────────────────────
  private async getDb(): Promise<Db> {
    if (this.db) return this.db;
    const uri = process.env.MONGODB_URI;
    if (!uri) throw new Error('MONGODB_URI not set');
    const { db } = await connectToDatabase(uri, DB_NAME);
    this.db = db;
    return db;
  }

  private async getUsersCollection(): Promise<Collection<User>> {
    const db = await this.getDb();
    return db.collection<User>(USERS_COLLECTION);
  }

  private async getRefreshCollection(): Promise<Collection<{ token: string; email: string; expiresAt: Date }>> {
    const db = await this.getDb();
    return db.collection(REFRESH_COLLECTION);
  }

  // ── Password Helpers ───────────────────────────────────────────────
  async hashPassword(password: string): Promise<string> {
    return bcrypt.hash(password, BCRYPT_ROUNDS);
  }

  async verifyPassword(password: string, hash: string): Promise<boolean> {
    return bcrypt.compare(password, hash);
  }

  // ── Token Generation ───────────────────────────────────────────────
  private generateAccessToken(payload: TokenPayload): string {
    return jwt.sign(payload, this.JWT_SECRET, {
      expiresIn: this.ACCESS_TOKEN_TTL,
      issuer: 'journeyax-auth',
      audience: 'journeyax-api',
    });
  }

  private generateRefreshToken(email: string): string {
    return jwt.sign(
      { sub: email, type: 'refresh' },
      this.JWT_REFRESH_SECRET,
      { expiresIn: this.REFRESH_TOKEN_TTL }
    );
  }

  // ── Register ───────────────────────────────────────────────────────
  async register(params: {
    email: string;
    password: string;
    tenantId: string;
    fullName: string;
    role?: 'admin' | 'buyer' | 'manager';
  }): Promise<{ success: boolean; message: string; user?: Partial<User> }> {
    const users = await this.getUsersCollection();

    // Check duplicate
    const existing = await users.findOne({ email: params.email.toLowerCase() });
    if (existing) {
      return { success: false, message: 'Email already registered.' };
    }

    // Validate password strength
    if (params.password.length < 8) {
      return { success: false, message: 'Password must be at least 8 characters.' };
    }

    const passwordHash = await this.hashPassword(params.password);

    const newUser: User = {
      email: params.email.toLowerCase(),
      passwordHash,
      tenantId: params.tenantId.toLowerCase(),
      role: params.role || 'buyer',
      fullName: params.fullName,
      isActive: true,
      createdAt: new Date(),
    };

    await users.insertOne(newUser);

    console.log(`[AuthService] Registered: ${newUser.email} | tenant=${newUser.tenantId} | role=${newUser.role}`);

    return {
      success: true,
      message: 'Account created successfully.',
      user: {
        email: newUser.email,
        tenantId: newUser.tenantId,
        role: newUser.role,
        fullName: newUser.fullName,
      },
    };
  }

  // ── Login ──────────────────────────────────────────────────────────
  async login(params: {
    email: string;
    password: string;
    tenantId?: string;
  }): Promise<{
    success: boolean;
    message: string;
    tokens?: AuthTokens;
    user?: Partial<User>;
  }> {
    const users = await this.getUsersCollection();
    const user = await users.findOne({ email: params.email.toLowerCase() });

    if (!user) {
      return { success: false, message: 'Invalid email or password.' };
    }

    if (!user.isActive) {
      return { success: false, message: 'Account is disabled. Contact your administrator.' };
    }

    // Verify tenantId if provided
    if (params.tenantId && user.tenantId !== params.tenantId.toLowerCase()) {
      return { success: false, message: 'Email not registered under this tenant.' };
    }

    const passwordValid = await this.verifyPassword(params.password, user.passwordHash);
    if (!passwordValid) {
      return { success: false, message: 'Invalid email or password.' };
    }

    // Update last login
    await users.updateOne(
      { email: user.email },
      { $set: { lastLoginAt: new Date() } }
    );

    // Generate tokens
    const payload: TokenPayload = {
      sub: user.email,
      tenantId: user.tenantId,
      role: user.role,
      fullName: user.fullName,
    };

    const accessToken = this.generateAccessToken(payload);
    const refreshToken = this.generateRefreshToken(user.email);

    // Store refresh token in DB
    const refreshCol = await this.getRefreshCollection();
    await refreshCol.insertOne({
      token: refreshToken,
      email: user.email,
      expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000), // 7 days
    });

    console.log(`[AuthService] Login: ${user.email} | tenant=${user.tenantId} | role=${user.role}`);

    return {
      success: true,
      message: 'Login successful.',
      tokens: {
        accessToken,
        refreshToken,
        expiresIn: 900, // 15 minutes in seconds
      },
      user: {
        email: user.email,
        tenantId: user.tenantId,
        role: user.role,
        fullName: user.fullName,
      },
    };
  }

  // ── Verify Token (called by API Gateway) ───────────────────────────
  async verify(token: string): Promise<{
    valid: boolean;
    payload?: TokenPayload;
    message?: string;
  }> {
    try {
      const payload = jwt.verify(token, this.JWT_SECRET, {
        issuer: 'journeyax-auth',
        audience: 'journeyax-api',
      }) as TokenPayload;

      return { valid: true, payload };
    } catch (err: any) {
      if (err.name === 'TokenExpiredError') {
        return { valid: false, message: 'Token expired. Please refresh.' };
      }
      if (err.name === 'JsonWebTokenError') {
        return { valid: false, message: 'Invalid token signature.' };
      }
      return { valid: false, message: 'Token verification failed.' };
    }
  }

  // ── Refresh Token ──────────────────────────────────────────────────
  async refresh(refreshToken: string): Promise<{
    success: boolean;
    message: string;
    tokens?: AuthTokens;
  }> {
    try {
      const decoded = jwt.verify(refreshToken, this.JWT_REFRESH_SECRET) as {
        sub: string;
        type: string;
      };

      if (decoded.type !== 'refresh') {
        return { success: false, message: 'Invalid refresh token.' };
      }

      // Verify token exists in DB (not revoked)
      const refreshCol = await this.getRefreshCollection();
      const stored = await refreshCol.findOne({ token: refreshToken });
      if (!stored) {
        return { success: false, message: 'Refresh token revoked or not found.' };
      }

      // Get current user data
      const users = await this.getUsersCollection();
      const user = await users.findOne({ email: decoded.sub });
      if (!user || !user.isActive) {
        return { success: false, message: 'User not found or disabled.' };
      }

      // Rotate: delete old, issue new tokens
      await refreshCol.deleteOne({ token: refreshToken });

      const payload: TokenPayload = {
        sub: user.email,
        tenantId: user.tenantId,
        role: user.role,
        fullName: user.fullName,
      };

      const newAccessToken = this.generateAccessToken(payload);
      const newRefreshToken = this.generateRefreshToken(user.email);

      await refreshCol.insertOne({
        token: newRefreshToken,
        email: user.email,
        expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
      });

      console.log(`[AuthService] Token refreshed: ${user.email}`);

      return {
        success: true,
        message: 'Tokens refreshed.',
        tokens: {
          accessToken: newAccessToken,
          refreshToken: newRefreshToken,
          expiresIn: 900,
        },
      };
    } catch (err: any) {
      return { success: false, message: 'Invalid or expired refresh token.' };
    }
  }

  // ── Logout (revoke refresh token) ──────────────────────────────────
  async logout(refreshToken: string): Promise<{ success: boolean }> {
    const refreshCol = await this.getRefreshCollection();
    await refreshCol.deleteOne({ token: refreshToken });
    return { success: true };
  }

  // ── Ensure Indexes on startup ──────────────────────────────────────
  async ensureIndexes(): Promise<void> {
    const users = await this.getUsersCollection();
    const refresh = await this.getRefreshCollection();

    await users.createIndex({ email: 1 }, { unique: true });
    await users.createIndex({ tenantId: 1 });

    await refresh.createIndex({ token: 1 }, { unique: true });
    await refresh.createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0 }); // TTL auto-delete
    await refresh.createIndex({ email: 1 });

    console.log('[AuthService] MongoDB indexes ensured.');
  }
}
