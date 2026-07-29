"use client";

import React, { useState, useEffect } from 'react';
import { 
  Search,
  Bell,
  ChevronDown,
  Globe,
  Settings as SettingsIcon,
  HelpCircle,
  Plus,
  RefreshCw,
  Upload,
  Edit2,
  Trash2,
  Lock,
  Mail,
  User,
  Power,
  ChevronRight
} from 'lucide-react';
import { projectApi, type Project } from '../lib/api';
import { resolveConsoleSections, SECTION_GROUPS } from '../lib/console-sections';
import { PublishControl } from '../components/PublishControl';
import { IntegrationsConfig } from '../components/IntegrationsConfig';
import { BusinessProfileConfig } from '../components/BusinessProfileConfig';
import { AgentEmbed } from '../components/AgentEmbed';
import { DashboardLive } from '../components/DashboardLive';
import { AnalyticsLive } from '../components/AnalyticsLive';
import { OrdersQuotes } from '../components/OrdersQuotes';
import { CatalogueView } from '../components/CatalogueView';
import { UsersRoles } from '../components/UsersRoles';
import { PlatformOps } from '../components/PlatformOps';
import { JourneyMap } from '../components/JourneyMap';
import { NotificationsConfig } from '../components/NotificationsConfig';
import { AccountView } from '../components/AccountView';
import { OnboardWizard } from '../components/OnboardWizard';
import { BusinessRules } from '../components/BusinessRules';
import { AiOrchestration } from '../components/AiOrchestration';
import { KnowledgeBase } from '../components/KnowledgeBase';
import { ChannelsConfig } from '../components/ChannelsConfig';
import { clearFetchCache } from '../lib/authed-fetch';

export default function BackOfficeSPA() {
  const [isLoggedIn, setIsLoggedIn] = useState(false);
  const [email, setEmail] = useState('admin');
  const [password, setPassword] = useState('admin');
  const [authError, setAuthError] = useState<string | null>(null);
  const [authLoading, setAuthLoading] = useState(false);
  const [currentUser, setCurrentUser] = useState<{ email: string; fullName: string; role: string; tenantId: string } | null>(null);

  // ── Tenant (workspace) state ──────────────────────────────────────────
  const [projects, setProjects] = useState<Project[]>([]);
  const [currentProject, setCurrentProject] = useState<Project | null>(null);
  const [tenantMenuOpen, setTenantMenuOpen] = useState(false);
  const [onboardOpen, setOnboardOpen] = useState(false);

  const loadProjects = React.useCallback(async (preferId?: string) => {
    try {
      // Archived projects are hidden from the workspace switcher (kept in the DB,
      // restorable) — so the dropdown shows only live customers.
      const list = (await projectApi.list()).filter((p) => p.status !== 'archived');
      setProjects(list);
      const stored = preferId || (typeof window !== 'undefined' ? sessionStorage.getItem('jax_project') : null);
      const pick = list.find((p) => p.projectId === stored) || list[0] || null;
      setCurrentProject(pick);
      if (pick && typeof window !== 'undefined') sessionStorage.setItem('jax_project', pick.projectId);
    } catch {
      /* services may be down — switcher just shows empty */
    }
  }, []);

  const selectProject = (p: Project) => {
    // Cached reads belong to the workspace they were fetched for; carrying them
    // across a switch would show one customer's figures under another's name.
    clearFetchCache();
    setCurrentProject(p);
    if (typeof window !== 'undefined') sessionStorage.setItem('jax_project', p.projectId);
    setTenantMenuOpen(false);
  };
  const [activeTab, setActiveTab] = useState<'dashboard' | 'builder' | 'catalog' | 'orders' | 'analytics' | 'embed' | 'channels' | 'integrations' | 'business' | 'orchestration' | 'rules' | 'knowledge' | 'platform-ops' | 'users-roles' | 'notifications' | 'account'>('dashboard');
  
  // R4: restore session from the HttpOnly cookie via the BFF (no token in JS).
  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const res = await fetch('/api/auth/session', { credentials: 'same-origin' });
        if (!alive) return;
        if (res.ok) {
          const data = await res.json();
          if (data.authenticated && data.user) {
            setIsLoggedIn(true);
            setCurrentUser(data.user);
            if (typeof window !== 'undefined') sessionStorage.setItem('jax_user', JSON.stringify(data.user));
            loadProjects();
          }
        }
      } catch { /* not signed in */ }
    })();
    return () => { alive = false; };
  }, [loadProjects]);

  // R4: login goes through the same-origin BFF, which sets HttpOnly cookies.
  // The browser never receives the tokens — only the profile for display.
  const handleSignIn = async () => {
    setAuthError(null);
    setAuthLoading(true);
    try {
      const res = await fetch('/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify({ email: email.trim(), password }),
      });
      const data = await res.json();
      if (!res.ok || !data.success) {
        setAuthError(data.message || 'Invalid email or password.');
        return;
      }
      if (typeof window !== 'undefined') sessionStorage.setItem('jax_user', JSON.stringify(data.user));
      setCurrentUser(data.user);
      setIsLoggedIn(true);
      loadProjects();
    } catch (e: any) {
      setAuthError(`Could not sign in (${e.message}).`);
    } finally {
      setAuthLoading(false);
    }
  };

  const handleSignOut = async () => {
    try {
      await fetch('/api/auth/logout', { method: 'POST', credentials: 'same-origin' });
    } catch { /* best-effort revoke */ }
    if (typeof window !== 'undefined') sessionStorage.removeItem('jax_user');
    setCurrentUser(null);
    setIsLoggedIn(false);
  };

  // ── 1. SIGN IN PAGE VIEW ──────────────────────────────────────────────────
  if (!isLoggedIn) {
    return (
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', width: '100vw', minHeight: '100vh', background: 'var(--jx-white)', fontFamily: 'var(--font-body)' }}>
        
        {/* Left half - Branding Summary */}
        <div style={{ background: 'var(--jx-black)', display: 'flex', flexDirection: 'column', justifyContent: 'space-between', padding: '48px', position: 'relative', overflow: 'hidden' }}>
          <div style={{ position: 'absolute', right: '-200px', top: '-220px', width: '600px', height: '600px', borderRadius: '50%', background: 'rgba(255,214,0,0.10)', filter: 'blur(100px)' }}></div>
          
          <div className="brand" style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
            <img src="/assets/logo-yellow.png" alt="JourneyAX" style={{ height: '26px', width: 'auto' }} />
          </div>

          <div style={{ zIndex: 10 }}>
            <h2 style={{ color: 'var(--jx-white)', fontSize: '36px', lineHeight: 1.15, maxWidth: '420px', letterSpacing: '-0.02em', fontWeight: 700 }}>
              Every customer. Every goal. One perfect journey.
            </h2>
            <p style={{ color: 'rgba(255,255,255,0.55)', fontSize: '14px', maxWidth: '380px', lineHeight: 1.6, marginTop: '14px' }}>
              Sign in to the JourneyAX console — configure AI journeys, manage your catalogue and knowledge, and orchestrate every workspace you run.
            </p>
          </div>

          <div style={{ color: 'rgba(255,255,255,0.35)', fontSize: '12px', fontFamily: 'var(--font-display)', zIndex: 10 }}>
            JourneyAX · AI Journey Orchestration Platform
          </div>
        </div>

        {/* Right half - Login Card */}
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '40px' }}>
          <div style={{ width: '100%', maxWidth: '380px', display: 'flex', flexDirection: 'column', gap: '16px' }}>
            <div>
              <h1 style={{ fontSize: '24px', fontWeight: 700, color: 'var(--jx-black)' }}>Sign in to the console</h1>
              <p style={{ fontSize: '13.5px', color: 'var(--jx-gray-600)', marginTop: '4px' }}>Use your workspace SSO or email &amp; password.</p>
            </div>

            <button
              disabled
              title="SSO is not configured in this environment"
              style={{ width: '100%', border: 'none', background: 'var(--jx-gray-200)', color: 'var(--jx-gray-500)', padding: '12px', borderRadius: '9px', fontWeight: 'bold', fontSize: '13px', cursor: 'not-allowed', textAlign: 'center' }}
            >
              Continue with SSO (Okta / Azure AD)
            </button>

            <div style={{ display: 'flex', alignItems: 'center', gap: '12px', color: 'var(--jx-gray-400)', fontSize: '11.5px', fontFamily: 'var(--font-display)' }}>
              <div style={{ flex: 1, height: '1px', background: 'var(--jx-gray-200)' }}></div>
              OR
              <div style={{ flex: 1, height: '1px', background: 'var(--jx-gray-200)' }}></div>
            </div>

            <div>
              <span style={{ fontSize: '12px', fontWeight: 600, color: 'var(--jx-gray-700)', fontFamily: 'var(--font-display)', marginBottom: '6px', display: 'block' }}>
                Work email
              </span>
              <input
                type="text"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter') handleSignIn(); }}
                autoFocus
                style={{ width: '100%', border: '1px solid var(--jx-gray-300)', borderRadius: '8px', padding: '10px 12px', fontSize: '13px', color: 'var(--jx-black)', background: 'var(--jx-white)' }}
              />
            </div>

            <div>
              <span style={{ fontSize: '12px', fontWeight: 600, color: 'var(--jx-gray-700)', fontFamily: 'var(--font-display)', marginBottom: '6px', display: 'block' }}>
                Password
              </span>
              <input
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter') handleSignIn(); }}
                style={{ width: '100%', border: '1px solid var(--jx-gray-300)', borderRadius: '8px', padding: '10px 12px', fontSize: '13px', color: 'var(--jx-black)', background: 'var(--jx-white)' }}
              />
            </div>

            {authError && (
              <div style={{ fontSize: '12.5px', color: '#B7392D', background: 'rgba(183,57,45,0.08)', border: '1px solid rgba(183,57,45,0.25)', borderRadius: '8px', padding: '9px 11px' }}>
                {authError}
              </div>
            )}

            <button
              onClick={handleSignIn}
              disabled={authLoading}
              style={{ width: '100%', border: 'none', background: 'var(--jx-yellow)', color: 'var(--jx-black)', padding: '12px', borderRadius: '9px', fontWeight: 'bold', fontSize: '13px', cursor: authLoading ? 'wait' : 'pointer', textAlign: 'center', opacity: authLoading ? 0.7 : 1 }}
            >
              {authLoading ? 'Signing in…' : 'Sign in →'}
            </button>

            <div style={{ textAlign: 'center', fontSize: '12.5px', color: 'var(--jx-gray-500)', marginTop: '6px' }}>
              Dev credentials: admin / admin · roles assigned by admin
            </div>
          </div>
        </div>

      </div>
    );
  }

  // ── 2. CONSOLE BACK-OFFICE APP VIEW ───────────────────────────────────────
  // Nav sections + labels are resolved from the active project (config-driven).
  const consoleSections = resolveConsoleSections(currentProject);
  return (
    <div className="board">
      
      {/* ── LEFT NAVIGATION SIDEBAR ───────────────────────────────────────── */}
      <div className="nav">
        {/* Brand logo header */}
        <div className="brand" style={{ display: 'flex', alignItems: 'center', gap: '9px', padding: '4px 8px 26px' }}>
          <img
            src="/assets/logo-mark-yellow.png"
            alt="JourneyAX"
            style={{ width: '26px', height: '26px', objectFit: 'contain' }}
          />
          <b style={{
            fontFamily: 'var(--font-display)',
            fontWeight: 700,
            fontSize: '14px',
            color: 'var(--jx-white)'
          }}>JourneyAX</b>
        </div>

        {/* Config-driven nav: sections + labels resolved from the active project
            (resolveConsoleSections). A bathroom brand and a fashion retailer get
            different, sensibly-labelled menus with no code change. */}
        {SECTION_GROUPS.map((group) => {
          const items = consoleSections.filter((s) => s.group === group);
          if (!items.length) return null;
          return (
            <React.Fragment key={group}>
              <div className="grp">{group}</div>
              {items.map((s) => (
                <button
                  key={s.id}
                  onClick={() => setActiveTab(s.id as typeof activeTab)}
                  className={`ni ${activeTab === s.id ? 'on' : ''}`}
                  title={s.status === 'demo' ? 'Demo — not yet wired to live data' : undefined}
                >
                  <span className="ic"></span>{s.label}
                  {s.status === 'demo' && (
                    <span style={{ marginLeft: 'auto', fontSize: 9, fontWeight: 700, opacity: 0.5, letterSpacing: '0.04em' }}>DEMO</span>
                  )}
                </button>
              ))}
            </React.Fragment>
          );
        })}

      </div>

      {/* ── CENTER WORKSPACE CONTAINER ────────────────────────────────────── */}
      <div className="center-wrap">
        
        {/* Workspace Mini-Header */}
        <div className="miniheader">
          <div className="mh-left" style={{ position: 'relative' }}>
            <button
              onClick={() => setTenantMenuOpen((o) => !o)}
              style={{ display: 'flex', alignItems: 'center', gap: '9px', border: 'none', background: 'transparent', cursor: 'pointer', padding: 0 }}
            >
              <div className="mh-brand" style={{ background: currentProject?.theme?.primaryColor || 'var(--jx-yellow)', color: currentProject?.theme?.accentColor || 'var(--jx-black)' }}>
                {(currentProject?.companyName || 'JX').slice(0, 2).toUpperCase()}
              </div>
              <div className="mh-name">{currentProject?.companyName || 'Select workspace'}</div>
              <ChevronDown size={14} style={{ color: 'var(--jx-gray-500)' }} />
            </button>

            {tenantMenuOpen && (
              <div style={{ position: 'absolute', top: '110%', left: 0, minWidth: '260px', background: 'var(--jx-white)', border: '1px solid var(--jx-gray-200)', borderRadius: '12px', boxShadow: '0 12px 34px rgba(0,0,0,0.16)', padding: '6px', zIndex: 200 }}>
                <div style={{ fontSize: '10.5px', fontWeight: 700, color: 'var(--jx-gray-500)', textTransform: 'uppercase', letterSpacing: '0.04em', padding: '8px 10px 4px' }}>Workspaces</div>
                <div style={{ maxHeight: '280px', overflowY: 'auto' }}>
                  {projects.length === 0 && (
                    <div style={{ fontSize: '12.5px', color: 'var(--jx-gray-500)', padding: '8px 10px' }}>No workspaces yet.</div>
                  )}
                  {projects.map((p) => (
                    <button
                      key={p.projectId}
                      onClick={() => selectProject(p)}
                      style={{ display: 'flex', alignItems: 'center', gap: '10px', width: '100%', border: 'none', background: currentProject?.projectId === p.projectId ? 'var(--jx-gray-100)' : 'transparent', borderRadius: '8px', padding: '8px 10px', cursor: 'pointer', textAlign: 'left' }}
                    >
                      <span style={{ width: '24px', height: '24px', borderRadius: '6px', background: p.theme?.primaryColor || 'var(--jx-yellow)', color: p.theme?.accentColor || 'var(--jx-black)', fontSize: '10px', fontWeight: 800, display: 'flex', alignItems: 'center', justifyContent: 'center', fontFamily: 'var(--font-display)' }}>
                        {p.companyName.slice(0, 2).toUpperCase()}
                      </span>
                      <span style={{ flex: 1 }}>
                        <b style={{ fontSize: '12.5px', color: 'var(--jx-black)', display: 'block' }}>{p.companyName}</b>
                        <span style={{ fontSize: '10.5px', color: 'var(--jx-gray-500)' }}>{p.projectId} · {p.status}</span>
                      </span>
                    </button>
                  ))}
                </div>
                <div style={{ height: '1px', background: 'var(--jx-gray-200)', margin: '6px 4px' }} />
                <button
                  onClick={() => { setTenantMenuOpen(false); setOnboardOpen(true); }}
                  style={{ display: 'flex', alignItems: 'center', gap: '9px', width: '100%', border: 'none', background: 'transparent', borderRadius: '8px', padding: '9px 10px', cursor: 'pointer', color: 'var(--jx-black)', fontSize: '12.5px', fontWeight: 700 }}
                >
                  <Plus size={15} /> Onboard customer
                </button>
              </div>
            )}
          </div>
          <div className="mh-right">
            {currentProject && (
              <PublishControl project={currentProject} onChanged={() => loadProjects(currentProject.projectId)} />
            )}
            <div className="mh-chip">🇦🇺 Australia · En ▾</div>
            <div className="mh-icon">
              🔔
              <span className="mh-dot"></span>
            </div>
            <button
              onClick={() => setActiveTab('account')}
              className="mh-av"
              style={{ border: 'none', cursor: 'pointer' }}
              title="Account"
            >
              R
            </button>
            <button
              onClick={handleSignOut}
              className="mh-icon"
              title="Sign out"
              style={{ border: 'none', cursor: 'pointer', background: 'transparent', color: '#B7392D' }}
            >
              <Power size={15} />
            </button>
          </div>
        </div>

        {onboardOpen && (
          <OnboardWizard
            onClose={() => setOnboardOpen(false)}
            onCreated={(projectId) => { setOnboardOpen(false); loadProjects(projectId); }}
          />
        )}

        {/* ── SWITCHABLE ACTIVE PAGES ─────────────────────────────────────── */}
        <div className="center">
          
          {/* A. DASHBOARD VIEW */}
          {activeTab === 'dashboard' && (currentProject
            ? <DashboardLive project={currentProject} />
            : <div className="panel">Select a workspace.</div>)}

          {/* B. JOURNEY BUILDER VIEW */}
          {activeTab === 'builder' && (currentProject
            ? <JourneyMap project={currentProject} onEdit={() => setActiveTab('orchestration')} />
            : <div className="panel">Select a workspace.</div>)}

          {/* C. CATALOGUE & COMPLIANCE VIEW */}
          {activeTab === 'catalog' && (currentProject
            ? <CatalogueView project={currentProject} />
            : <div className="panel">Select a workspace.</div>)}

          {/* D. ROSTERS & ORDERS VIEW */}
          {activeTab === 'orders' && (currentProject
            ? <OrdersQuotes project={currentProject} />
            : <div className="panel">Select a workspace.</div>)}

          {/* E. ANALYTICS VIEW */}
          {activeTab === 'analytics' && (currentProject
            ? <AnalyticsLive project={currentProject} />
            : <div className="panel">Select a workspace.</div>)}

          {/* F. CHANNELS VIEW */}
          {activeTab === 'channels' && (
            <>
              <div className="crumb">JourneyAX / Channels</div>
              {currentProject
                ? <ChannelsConfig project={currentProject} onSaved={() => loadProjects(currentProject.projectId)} />
                : <div className="panel">Select a workspace to configure its channels.</div>}
            </>
          )}

          {activeTab === 'embed' && (
            <>
              <div className="crumb">JourneyAX / Agent Embed</div>
              {currentProject
                ? <AgentEmbed project={currentProject} onSaved={() => loadProjects(currentProject.projectId)} />
                : <div className="panel">Select a workspace to configure its embed.</div>}
            </>
          )}

          {/* G. INTEGRATIONS & ADAPTERS VIEW */}
          {activeTab === 'integrations' && (
            <>
              <div className="crumb">JourneyAX / Integrations & Adapters</div>
              {currentProject
                ? <IntegrationsConfig project={currentProject} onSaved={() => loadProjects(currentProject.projectId)} />
                : <div className="panel">Select a workspace to configure its integrations.</div>}
            </>
          )}

          {/* G2. BUSINESS PROFILE VIEW — what kind of business, and what its customers buy for */}
          {activeTab === 'business' && (
            <>
              <div className="crumb">JourneyAX / Business Profile</div>
              {currentProject
                ? <BusinessProfileConfig project={currentProject} />
                : <div className="panel">Select a workspace to configure its business profile.</div>}
            </>
          )}

          {/* H. AI ORCHESTRATION VIEW */}
          {activeTab === 'orchestration' && (
            <>
              <div className="crumb">JourneyAX / AI Orchestration</div>
              {currentProject
                ? <AiOrchestration project={currentProject} onSaved={() => loadProjects(currentProject.projectId)} />
                : <div className="panel">Select a workspace to configure its model and prompts.</div>}

              <div className="micro" style={{ marginTop: '18px', marginBottom: '6px' }}>PIPELINE ARCHITECTURE (reference)</div>
              <div className="cardrow">
                <div className="panel">
                  <div className="micro">AGENT LAYER</div>
                  <div className="node">Intent detection <span className="pill p-active" style={{ float: 'right' }}>On</span></div>
                  <div className="node">Context &amp; memory (session)</div>
                  <div className="node">Recommendation engine → Catalogue &amp; Compliance rules</div>
                  <div className="node">Human hand-off &amp; guardrails <span className="pill p-active" style={{ float: 'right' }}>On</span></div>
                </div>

                <div className="panel">
                  <div className="micro">ORCHESTRATION LAYER</div>
                  <div className="node">Intent → domain routing: gear advisor vs. uniform program copilot</div>
                  <div className="node">MCP / tool router — selects catalogue, pricing, or CRM tool per step</div>
                  <div className="node">Workflow orchestration — multi-step bundle build, quote, hand-off</div>
                </div>
              </div>

              <div className="panel">
                <div className="micro">KNOWLEDGE &amp; CONTENT (RAG)</div>
                <div className="chips">
                  <span className="chip on">Compliance standards (AS/NZS)</span>
                  <span className="chip">Product specs</span>
                  <span className="chip">Sizing guides</span>
                  <span className="chip">Pricing &amp; promo rules</span>
                </div>
              </div>

              <div className="panel">
                <div className="micro">COMPLIANCE GUARDRAILS</div>
                <div className="node" style={{ background: '#FFF1F0', borderColor: '#F5222D' }}>
                  Never recommend a non-compliant hi-vis class or missing FR rating — <b>hard block, safety critical.</b>
                </div>
              </div>
            </>
          )}

          {/* H2. BUSINESS RULES VIEW */}
          {activeTab === 'rules' && (
            <>
              <div className="crumb">JourneyAX / Business Rules</div>
              {currentProject
                ? <BusinessRules projectId={currentProject.projectId} />
                : <div className="panel">Select a workspace to manage its agent rules.</div>}
            </>
          )}

          {/* H3. KNOWLEDGE BASE VIEW */}
          {activeTab === 'knowledge' && (
            <>
              <div className="crumb">JourneyAX / Knowledge Base</div>
              {currentProject
                ? <KnowledgeBase project={currentProject} />
                : <div className="panel">Select a workspace to view its knowledge base.</div>}
            </>
          )}

          {/* I. PLATFORM & OPS VIEW */}
          {activeTab === 'platform-ops' && <PlatformOps />}

          {/* J. USERS & ROLES VIEW */}
          {activeTab === 'users-roles' && (currentProject
            ? <UsersRoles project={currentProject} />
            : <div className="panel">Select a workspace.</div>)}

          {/* K. NOTIFICATIONS VIEW */}
          {activeTab === 'notifications' && (currentProject
            ? <NotificationsConfig project={currentProject} onSaved={() => loadProjects(currentProject.projectId)} />
            : <div className="panel">Select a workspace.</div>)}

          {/* L. ACCOUNT & SETTINGS VIEW */}
          {activeTab === 'account' && (currentProject
            ? <AccountView project={currentProject} />
            : <div className="panel">Select a workspace.</div>)}

        </div>

      </div>
    </div>
  );
}
