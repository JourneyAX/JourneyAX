'use client';

/**
 * Storefront auth — cookie model (R4), same as the back-office.
 *
 * No token ever reaches JS. Login/logout go through the BFF, which sets and
 * clears HttpOnly cookies; the session is restored on load by asking the BFF
 * (`/api/auth/session`) whether the cookie is still valid. Every BFF route then
 * forwards that cookie's token upstream as a Bearer, so the gateway sees a real
 * authenticated customer — never an anonymous guest.
 *
 * Replaces the earlier context that kept access/refresh tokens in
 * localStorage and never actually gated anything.
 */
import React, { createContext, useContext, useState, useEffect, useCallback } from 'react';

export interface AuthUser {
  email: string;
  tenantId: string;
  role: string;
  fullName: string;
}

interface AuthState {
  user: AuthUser | null;
  isAuthenticated: boolean;
  /** True until the first session check completes — render nothing gated until then. */
  isLoading: boolean;
}

interface AuthContextValue extends AuthState {
  login: (email: string, password: string) => Promise<{ success: boolean; message?: string }>;
  logout: () => Promise<void>;
}

const AuthContext = createContext<AuthContextValue | null>(null);

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [state, setState] = useState<AuthState>({ user: null, isAuthenticated: false, isLoading: true });

  // Restore the session from the HttpOnly cookie via the BFF (no token in JS).
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch('/api/auth/session', { credentials: 'same-origin', cache: 'no-store' });
        const data = res.ok ? await res.json() : null;
        if (cancelled) return;
        if (data?.authenticated && data.user) {
          setState({ user: data.user, isAuthenticated: true, isLoading: false });
        } else {
          setState({ user: null, isAuthenticated: false, isLoading: false });
        }
      } catch {
        if (!cancelled) setState({ user: null, isAuthenticated: false, isLoading: false });
      }
    })();
    return () => { cancelled = true; };
  }, []);

  const login = useCallback(async (email: string, password: string) => {
    try {
      const res = await fetch('/api/auth/login' + (typeof window !== 'undefined' ? window.location.search : ''), {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, password }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || !data.success) {
        return { success: false, message: data.message || 'Invalid email or password.' };
      }
      setState({ user: data.user, isAuthenticated: true, isLoading: false });
      return { success: true };
    } catch {
      return { success: false, message: 'Network error. Please try again.' };
    }
  }, []);

  const logout = useCallback(async () => {
    try {
      await fetch('/api/auth/logout', { method: 'POST', credentials: 'same-origin' });
    } catch { /* cookies are cleared server-side; best effort */ }
    setState({ user: null, isAuthenticated: false, isLoading: false });
  }, []);

  return (
    <AuthContext.Provider value={{ ...state, login, logout }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used inside <AuthProvider>');
  return ctx;
}
