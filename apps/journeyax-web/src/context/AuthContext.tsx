'use client';

import React, { createContext, useContext, useState, useEffect, useCallback, useRef } from 'react';

// ── Types ──────────────────────────────────────────────────────────
interface AuthUser {
  email: string;
  tenantId: string;
  role: string;
  fullName: string;
}

interface AuthTokens {
  accessToken: string;
  refreshToken: string;
  expiresIn: number; // seconds
  expiresAt: number; // epoch ms
}

interface AuthState {
  user: AuthUser | null;
  tokens: AuthTokens | null;
  isAuthenticated: boolean;
  isLoading: boolean;
}

interface AuthContextValue extends AuthState {
  login: (email: string, password: string, tenantId?: string) => Promise<{ success: boolean; message?: string }>;
  logout: () => Promise<void>;
  getAccessToken: () => Promise<string | null>;
}

// ── Storage Keys ───────────────────────────────────────────────────
const STORAGE_KEYS = {
  USER: 'jax_user',
  TOKENS: 'jax_tokens',
};

// ── Context ────────────────────────────────────────────────────────
const AuthContext = createContext<AuthContextValue | null>(null);

// ── Token Utils ────────────────────────────────────────────────────
function isTokenExpired(tokens: AuthTokens): boolean {
  // Consider token expired 60s before actual expiry for safety margin
  return Date.now() >= tokens.expiresAt - 60_000;
}

function persistAuth(user: AuthUser, tokens: AuthTokens) {
  localStorage.setItem(STORAGE_KEYS.USER, JSON.stringify(user));
  localStorage.setItem(STORAGE_KEYS.TOKENS, JSON.stringify(tokens));
}

function clearAuth() {
  localStorage.removeItem(STORAGE_KEYS.USER);
  localStorage.removeItem(STORAGE_KEYS.TOKENS);
}

function loadPersistedAuth(): { user: AuthUser; tokens: AuthTokens } | null {
  try {
    const user = localStorage.getItem(STORAGE_KEYS.USER);
    const tokens = localStorage.getItem(STORAGE_KEYS.TOKENS);
    if (user && tokens) {
      return { user: JSON.parse(user), tokens: JSON.parse(tokens) };
    }
  } catch {}
  return null;
}

// ── Provider ───────────────────────────────────────────────────────
export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [state, setState] = useState<AuthState>({
    user: null,
    tokens: null,
    isAuthenticated: false,
    isLoading: true,
  });

  // Ref for refresh lock — prevents concurrent refresh calls
  const refreshPromiseRef = useRef<Promise<AuthTokens | null> | null>(null);

  // ── Load persisted session on mount ─────────────────────────────
  useEffect(() => {
    const persisted = loadPersistedAuth();
    if (persisted) {
      setState({
        user: persisted.user,
        tokens: persisted.tokens,
        isAuthenticated: true,
        isLoading: false,
      });
    } else {
      setState(s => ({ ...s, isLoading: false }));
    }
  }, []);

  // ── Refresh token ────────────────────────────────────────────────
  const refreshTokens = useCallback(async (currentRefreshToken: string): Promise<AuthTokens | null> => {
    // Singleton — if a refresh is already in-flight, await it
    if (refreshPromiseRef.current) {
      return refreshPromiseRef.current;
    }

    refreshPromiseRef.current = (async () => {
      try {
        const res = await fetch('/api/auth/refresh', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ refreshToken: currentRefreshToken }),
        });

        if (!res.ok) {
          console.warn('[AuthContext] Refresh failed — logging out');
          clearAuth();
          setState({ user: null, tokens: null, isAuthenticated: false, isLoading: false });
          return null;
        }

        const data = await res.json();
        const newTokens: AuthTokens = {
          ...data.tokens,
          expiresAt: Date.now() + data.tokens.expiresIn * 1000,
        };

        setState(s => {
          if (s.user) persistAuth(s.user, newTokens);
          return { ...s, tokens: newTokens };
        });

        return newTokens;
      } catch {
        return null;
      } finally {
        refreshPromiseRef.current = null;
      }
    })();

    return refreshPromiseRef.current;
  }, []);

  // ── getAccessToken — auto-refreshes if needed ────────────────────
  const getAccessToken = useCallback(async (): Promise<string | null> => {
    const { tokens } = state;
    if (!tokens) return null;

    if (!isTokenExpired(tokens)) {
      return tokens.accessToken;
    }

    // Token is expired — refresh
    const newTokens = await refreshTokens(tokens.refreshToken);
    return newTokens?.accessToken ?? null;
  }, [state, refreshTokens]);

  // ── Login ────────────────────────────────────────────────────────
  const login = useCallback(async (
    email: string,
    password: string,
    tenantId = 'caroma'
  ): Promise<{ success: boolean; message?: string }> => {
    try {
      const res = await fetch('/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, password, tenantId }),
      });

      const data = await res.json();

      if (!res.ok || !data.success) {
        return { success: false, message: data.message || 'Login failed.' };
      }

      const tokens: AuthTokens = {
        ...data.tokens,
        expiresAt: Date.now() + data.tokens.expiresIn * 1000,
      };

      const user: AuthUser = data.user;

      persistAuth(user, tokens);
      setState({ user, tokens, isAuthenticated: true, isLoading: false });

      return { success: true };
    } catch (err: any) {
      return { success: false, message: 'Network error. Please try again.' };
    }
  }, []);

  // ── Logout ───────────────────────────────────────────────────────
  const logout = useCallback(async () => {
    const refreshToken = state.tokens?.refreshToken;

    // Revoke on server
    if (refreshToken) {
      try {
        await fetch('/api/auth/logout', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ refreshToken }),
        });
      } catch {}
    }

    clearAuth();
    setState({ user: null, tokens: null, isAuthenticated: false, isLoading: false });
  }, [state.tokens]);

  return (
    <AuthContext.Provider value={{ ...state, login, logout, getAccessToken }}>
      {children}
    </AuthContext.Provider>
  );
}

// ── Hook ───────────────────────────────────────────────────────────
export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used inside <AuthProvider>');
  return ctx;
}
