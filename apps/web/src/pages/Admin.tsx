import { useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { StartHere } from '../components/StartHere';
import { useSession } from '../lib/session';
import { Users } from './admin/Users';
import { Roles } from './admin/Roles';
import { Shifts } from './admin/Shifts';
import { Settings } from './admin/Settings';
import { Backups } from './admin/Backups';
import { AuditLog } from './admin/AuditLog';
import { Exports } from './admin/Exports';
import { Supplies } from './admin/Supplies';
import { Places } from './admin/Places';
import { People } from './admin/People';
import { Host } from './admin/Host';

type Tab = 'start' | 'host' | 'users' | 'people' | 'roles' | 'shifts' | 'settings' | 'places' | 'supplies' | 'backups' | 'exports' | 'audit';

/**
 * Grouped, because eleven flat tabs tell nobody which to open first. The order within
 * "Set up once" is the order the software actually requires — people before accounts,
 * because an account linked to nobody has an empty job board.
 */
const GROUPS = [
  { label: 'Start', keys: ['start'] },
  { label: 'Set up once', keys: ['people', 'users', 'roles', 'places', 'shifts', 'supplies'] },
  { label: 'Settings', keys: ['settings', 'exports'] },
  { label: 'The machine', keys: ['host', 'backups', 'audit'] },
] as const;

const TABS: { key: Tab; label: string; need: string }[] = [
  { key: 'start', label: 'Start here', need: 'admin.settings.manage' },
  { key: 'people', label: 'Staff', need: 'staff.manage' },
  { key: 'users', label: 'Users', need: 'admin.users.manage' },
  { key: 'roles', label: 'Roles', need: 'admin.roles.manage' },
  { key: 'places', label: 'Places', need: 'location.manage' },
  { key: 'shifts', label: 'Shifts', need: 'admin.settings.manage' },
  { key: 'supplies', label: 'Supplies', need: 'power.source.manage' },
  { key: 'settings', label: 'Settings', need: 'admin.settings.manage' },
  { key: 'exports', label: 'Exports', need: 'report.export' },
  { key: 'host', label: 'Host PC', need: 'admin.settings.manage' },
  { key: 'backups', label: 'Backups', need: 'admin.backup.run' },
  { key: 'audit', label: 'Audit log', need: 'admin.audit.read' },
];

export function Admin() {
  const { can } = useSession();
  const allowed = TABS.filter((t) => can(t.need));
  // A link from the Start here checklist lands on the right tab rather than dumping
  // somebody on the first one and making them hunt.
  const [params, setParams] = useSearchParams();
  const asked = params.get('tab') as Tab | null;
  const initial = asked && allowed.some((t) => t.key === asked) ? asked : (allowed[0]?.key ?? 'users');
  const [tab, setTabState] = useState<Tab>(initial);
  const setTab = (next: Tab) => {
    setTabState(next);
    setParams((prev) => {
      const n = new URLSearchParams(prev);
      n.set('tab', next);
      return n;
    }, { replace: true });
  };

  if (allowed.length === 0) {
    return <main className="view"><div className="note">Your role has no administrative rights.</div></main>;
  }

  return (
    <main className="view">
      <div className="vhead">
        <div>
          <p className="eyebrow">Configuration · everything here is data, not a release</p>
          <h1>Admin</h1>
          <p>Roles, people, shifts and thresholds. Changing what a role may do is a settings
             change here, never a code change.</p>
        </div>
      </div>

      <div className="row gap-7 mb-7 start">
        {GROUPS.map((g) => {
          const mine = allowed.filter((t) => (g.keys as readonly string[]).includes(t.key));
          if (mine.length === 0) return null;
          return (
            <div key={g.label}>
              <p className="eyebrow mb-3">{g.label}</p>
              <div className="row gap-3">
                {mine.map((t) => (
                  <button key={t.key} className={`btn sm ${tab === t.key ? 'on' : ''}`}
                          onClick={() => setTab(t.key)}>{t.label}</button>
                ))}
              </div>
            </div>
          );
        })}
      </div>

      {tab === 'start' && <StartHere />}
      {tab === 'host' && <Host />}
      {tab === 'users' && <Users />}
      {tab === 'people' && <People />}
      {tab === 'roles' && <Roles />}
      {tab === 'shifts' && <Shifts />}
      {tab === 'settings' && <Settings />}
      {tab === 'places' && <Places />}
      {tab === 'supplies' && <Supplies />}
      {tab === 'backups' && <Backups />}
      {tab === 'exports' && <Exports />}
      {tab === 'audit' && <AuditLog />}
    </main>
  );
}
