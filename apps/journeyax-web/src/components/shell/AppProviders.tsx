'use client';

import type { ReactNode } from 'react';
import { StorefrontConfigProvider } from '@/context/StorefrontConfigContext';
import { AuthProvider } from '@/context/AuthContext';

/**
 * The providers every signed-in page shares, mounted once by the (app) route group's layout so that moving between Chats
 * and Customize keeps the tenant config and the session instead of fetching them again (and flashing blank while it does).
 */
export default function AppProviders({ children }: { children: ReactNode }) {
  return (
    <StorefrontConfigProvider>
      <AuthProvider>{children}</AuthProvider>
    </StorefrontConfigProvider>
  );
}
