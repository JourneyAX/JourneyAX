import AppProviders from '@/components/shell/AppProviders';

export default function AppLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return <AppProviders>{children}</AppProviders>;
}
