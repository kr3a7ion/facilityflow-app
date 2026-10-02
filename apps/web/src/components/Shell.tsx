import { useEffect, useRef, useState } from 'react';
import { Link, NavLink, Outlet, useNavigate } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, qk } from '../lib/api';
import { useSession } from '../lib/session';
import { initials, when } from '../lib/format';
import { Icon, type IconName } from './Icon';
import { play, soundOn, setSoundOn, preview, deviceId, audioReady } from '../lib/sound';
import { textSize, setTextSize, nextTextSize, LABEL, type TextSize } from '../lib/textsize';
import { Mimic } from './Mimic';
import { LogoTile } from './Logo';
import { ChangePassword } from './ChangePassword';
import { Outstanding } from './Outstanding';
import { PairPhone } from './PairPhone';
import { Alarm } from './Alarm';
import { RaiseEmergency } from './RaiseEmergency';
import { RingSomebody } from './RingSomebody';
import { DutyBar, DutySetup } from './Duty';
import { connectLive } from '../lib/live';

interface NavItem { to: string; label: string; icon: IconName; need?: string; tab?: boolean }

interface Note {
  id: string; kind: string; title: string; body: string | null;
  entity_type: string | null; entity_id: string | null;
  created_at: string; read_at: string | null;
}

const ITEMS: NavItem[] = [
  { to: '/', label: 'Overview', icon: 'gauge', need: 'report.read' },
  { to: '/jobs', label: 'Jobs', icon: 'clip', need: 'wo.read', tab: true },
  { to: '/ppm', label: 'Planned Work', icon: 'repeat', need: 'ppm.read' },
  { to: '/roster', label: 'Roster', icon: 'cal', need: 'roster.read' },
  { to: '/power', label: 'Power & Diesel', icon: 'fuel', need: 'fuel.read', tab: true },
  { to: '/apartments', label: 'Apartments', icon: 'bldg', need: 'apartment.read' },
  { to: '/assets', label: 'Assets', icon: 'tag', need: 'asset.read' },
  { to: '/stores', label: 'Stores', icon: 'box', need: 'stock.read' },
  { to: '/safety', label: 'Safety', icon: 'shield', need: 'permit.request' },
  { to: '/handover', label: 'Handover', icon: 'swap', need: 'handover.write' },
];

// A supervisor records purchases but never sees the departmental budget. Gating this
// section on finance.read alone would hide the screen from the person who uses it most.
const FINANCE_NEEDS = ['finance.read', 'purchase.record', 'vendor.manage', 'finance.expense.create'];
const FINANCE_ITEMS: NavItem[] = [
  { to: '/money', label: 'Costs & Budget', icon: 'money' },
];

const ADMIN_ITEMS: NavItem[] = [
  { to: '/admin', label: 'Admin', icon: 'user', need: 'admin.audit.read' },
];

export function Shell() {
  const { me, can, canAny } = useSession();
  const qc = useQueryClient();
  const navigate = useNavigate();

  const items = ITEMS.filter((i) => !i.need || can(i.need));
  // Anyone holding any administrative right gets the section; the page hides the tabs
  // they cannot use.
  const adminItems = ADMIN_ITEMS.filter(() =>
    canAny('admin.users.manage', 'admin.roles.manage', 'admin.settings.manage',
           'admin.backup.run', 'admin.audit.read'));
  const financeItems = FINANCE_ITEMS.filter(() => canAny(...FINANCE_NEEDS));

  const [bell, setBell] = useState(false);
  const [pw, setPw] = useState(false);
  const [sheet, setSheet] = useState(false);
  const [pairing, setPairing] = useState(false);
  const [raising, setRaising] = useState(false);
  const [ringing, setRinging] = useState(false);
  const [duty, setDuty] = useState(false);
  // Four across the bottom, everything else one tap away. `tab: true` marks the two the
  // department lives in; the rest fill the remaining slots in nav order, so a role that
  // cannot open Jobs still gets a sensible bar rather than gaps.
  const allNav = [...items, ...financeItems, ...adminItems];
  const phoneTabs = [
    ...items.filter((i) => i.tab),
    ...items.filter((i) => !i.tab),
  ].slice(0, 4);
  const sheetItems = allNav.filter((i) => !phoneTabs.some((t) => t.to === i.to));

  const { data: notes } = useQuery<{ unread: number; notifications: Note[] }>({
    queryKey: qk.notifications,
    queryFn: () => api.get('/api/notifications'),
    // A minute is the compromise: a breached P1 is worth hearing about promptly, and this
    // is one cheap query against a SQLite file on the same LAN.
    refetchInterval: 60_000,
  });

  const { data: board } = useQuery<{ jobs: { sla: { state: string } }[] }>({
    queryKey: qk.jobs('nav'),
    queryFn: () => api.get('/api/jobs?limit=200'),
    enabled: can('wo.read'),
    refetchInterval: 120_000,
  });
  const breached = board?.jobs.filter((j) => j.sla.state === 'breached').length ?? 0;

  // A role that is handed work may not go quiet. The control is shown locked rather than
  // hidden: somebody reaching for it should learn why it is not theirs to turn off, not
  // wonder where it went.
  const maySilence = can('alerts.silence');
  const [audible, setAudible] = useState(() => (maySilence ? soundOn() : true));
  const [size, setSize] = useState<TextSize>(textSize);
  const bumpSize = () => { const n = nextTextSize(size); setTextSize(n); setSize(n); };
  // Counts from the previous poll. Refs, not state: comparing them must not itself cause a
  // render, and the very first poll has nothing to compare against — announcing every
  // unread notification the moment somebody signs in would train people to ignore it.
  const seen = useRef<{ unread: number | null; breached: number | null }>(
    { unread: null, breached: null });

  useEffect(() => {
    if (notes?.unread === undefined) return;
    const before = seen.current.unread;
    seen.current.unread = notes.unread;
    if (before === null || notes.unread <= before) return;
    // The voice follows the message. A P1 arriving on your board and a note about a
    // contract renewal both used to make the same polite two-note chime, which is how a
    // department learns to stop hearing it.
    const newest = notes.notifications.find((n) => !n.read_at);
    const urgent = !!newest && (/^P1\b/.test(newest.body ?? '')
      || newest.kind === 'wo.breached' || newest.kind === 'wo.escalated');
    // Being told your work was signed off is the one message that is not a demand, and it
    // gets the settled chime rather than the one that means "come and look".
    play(urgent ? 'urgent' : newest?.kind === 'wo.verified' ? 'done' : 'notify');
  }, [notes?.unread, notes?.notifications]);

  useEffect(() => {
    if (!board) return;
    const before = seen.current.breached;
    seen.current.breached = breached;
    // Only a NEW breach speaks. A job that is still breached tomorrow morning must not
    // make the tablet chirp every minute until somebody closes it.
    if (before !== null && breached > before) play('urgent');
  }, [board, breached]);

  /*
   * Tell the host what this device is doing about alerts.
   *
   * Reported rather than asked for, because the setting lives in this browser's storage.
   * Sent on arrival and whenever it changes, and again once the browser lets audio
   * through — which is often long after sign-in, since nothing can play until somebody
   * has touched the page.
   */
  const report = useMutation({
    mutationFn: (v: { soundOn: boolean; audioReady: boolean }) =>
      api.post('/api/me/alerts', { deviceId: deviceId(), ...v }),
  });
  const reported = useRef<string>('');
  useEffect(() => {
    if (!me) return;
    const signature = `${audible}:${audioReady()}`;
    if (signature === reported.current) return;
    reported.current = signature;
    report.mutate({ soundOn: audible, audioReady: audioReady() });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [me, audible, notes?.unread]);

  /*
   * One connection instead of four timers.
   *
   * The polling intervals are left in place underneath as a floor: if the stream cannot
   * be opened at all — an old browser, something in the building eating event-streams —
   * the app behaves exactly as it did before rather than going quiet. `live` only drives
   * the dot in the top bar, so nobody is told the board is current when it is not.
   */
  const [live, setLive] = useState(false);
  useEffect(() => {
    if (!me) return;
    return connectLive({
      onEvent: (kind) => {
        if (kind === 'notification') void qc.invalidateQueries({ queryKey: qk.notifications });
        if (kind === 'jobs') {
          void qc.invalidateQueries({ queryKey: ['jobs'] });
          void qc.invalidateQueries({ queryKey: ['outstanding'] });
        }
        if (kind === 'plant') void qc.invalidateQueries({ queryKey: qk.plant });
        // The two that take over the screen. Routed here rather than left to the poll
        // underneath them, because "within a minute" is not what either of these means.
        if (kind === 'ring') void qc.invalidateQueries({ queryKey: qk.rings });
        if (kind === 'emergency') void qc.invalidateQueries({ queryKey: qk.emergency });
      },
      onState: setLive,
      // Whatever happened while the phone was out of range was never delivered.
      onResync: () => { void qc.invalidateQueries(); },
    });
  }, [me, qc]);

  /* Escape closes the notification panel. On a phone it covers most of the screen, so
     there has to be a way out that is not "find the small x". */
  useEffect(() => {
    if (!bell) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setBell(false); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [bell]);

  const markRead = useMutation({
    mutationFn: () => api.post('/api/notifications/read'),
    onSuccess: () => qc.invalidateQueries({ queryKey: qk.notifications }),
  });

  /**
   * Sign out, and leave nothing of this person behind.
   *
   * This used to be `qc.clear()` plus a client-side navigate. `clear()` removes the
   * cached queries but the session observer is still mounted, so it kept rendering its
   * last result and never refetched: the next person to sign in on the same tablet got
   * the previous person's identity, nav and permissions until somebody thought to
   * reload the page. The server knew who they really were and refused the calls, which
   * is how it showed up — a technician looking at an administrator's screens full of
   * 403s.
   *
   * The full page load is the guarantee: on a tablet handed between a technician and a
   * supervisor all day, no component state, no module state and no in-flight request may
   * outlive the person it belonged to. It costs a reload from the host on the same LAN,
   * which is imperceptible, and it removes the whole class of bug rather than this one
   * instance of it.
   *
   * Cancel and drop rather than reset: resetting refetches, and every one of those
   * refetches is a request made with a cookie that has just been revoked. That put seven
   * 401s in the host's log every time anybody signed out, which is both waste and noise
   * in the one log that is supposed to mean something.
   */
  const logout = useMutation({
    mutationFn: () => api.post('/api/auth/logout'),
    onSettled: async () => {
      await qc.cancelQueries();
      qc.clear();
      // Even a failed sign-out ends at the door: leaving somebody on a screen that looks
      // signed in when it might not be is the worse failure.
      window.location.assign('/login');
    },
  });

  function toggleTheme() {
    const root = document.documentElement;
    const dark = root.getAttribute('data-theme') === 'dark'
      || (!root.getAttribute('data-theme') && matchMedia('(prefers-color-scheme: dark)').matches);
    root.setAttribute('data-theme', dark ? 'light' : 'dark');
    try { localStorage.setItem('ff-theme', dark ? 'light' : 'dark'); } catch { /* private mode */ }
  }

  return (
    <div className="app">
      <aside className="side">
        <div className="brand">
          <LogoTile size={30} />
          <span>
            <b>FacilityFlow</b>
            <small>Maintenance &amp; FM</small>
          </span>
        </div>
        <nav className="nav">
          <div className="nav-lab">Operations</div>
          {items.map((i) => (
            <NavLink key={i.to} to={i.to} end={i.to === '/'}
                     className={({ isActive }) => (isActive ? 'on' : '')}>
              <Icon name={i.icon} />
              {i.label}
              {i.to === '/jobs' && breached > 0 && <span className="cnt">{breached}</span>}
            </NavLink>
          ))}
          {financeItems.length > 0 && (
            <>
              <div className="nav-lab">Money</div>
              {financeItems.map((i) => (
                <NavLink key={i.to} to={i.to} className={({ isActive }) => (isActive ? 'on' : '')}>
                  <Icon name={i.icon} />{i.label}
                </NavLink>
              ))}
            </>
          )}
          {adminItems.length > 0 && (
            <>
              <div className="nav-lab">Configuration</div>
              {adminItems.map((i) => (
                <NavLink key={i.to} to={i.to} className={({ isActive }) => (isActive ? 'on' : '')}>
                  <Icon name={i.icon} />{i.label}
                </NavLink>
              ))}
            </>
          )}
        </nav>
        <div className="who">
          <span className="av">{initials(me?.user.displayName ?? '?')}</span>
          <span style={{ minWidth: 0 }}>
            <span className="nm" title={me?.user.displayName}>{me?.user.displayName}</span>
            {/* The role's own name. This printed "hod" at the head of department. */}
            <span className="rl" title={me?.user.roleDescription}>{me?.user.roleName}</span>
          </span>
          {/* Until this existed, changing your own password meant asking an administrator
              to reset it — which hands your new password to a third person. */}
          <button className="icobtn" style={{ marginLeft: 'auto' }} title="Ring my phone"
                  onClick={() => setPairing(true)} aria-label="Pair a phone for alerts">
            <Icon name="bell" />
          </button>
          {can('duty.device.manage') && (
            <button className="icobtn" title="Make this the duty screen"
                    onClick={() => setDuty(true)} aria-label="Duty screen">
              <Icon name="shield" />
            </button>
          )}
          <button className="icobtn" title="Change your password"
                  onClick={() => setPw(true)} aria-label="Change your password">
            <Icon name="lock" />
          </button>
          <button className="icobtn" title="Sign out"
                  onClick={() => logout.mutate()} aria-label="Sign out">
            <Icon name="out" />
          </button>
        </div>
      </aside>

      <div className="main">
        <header className="top">
          <span className="prop">{me?.property?.short_name ?? 'FacilityFlow'}</span>
          <span className="sep" />
          <label className="search">
            <Icon name="search" size={14} />
            <input placeholder="Job ref, unit, asset tag…" aria-label="Search"
                   onKeyDown={(e) => {
                     if (e.key === 'Enter') {
                       const v = (e.target as HTMLInputElement).value.trim();
                       if (v) navigate(`/jobs?q=${encodeURIComponent(v)}`);
                     }
                   }} />
          </label>
          <span className="spacer" />
          {/* Deliberately a word and not an icon, and deliberately red. Nobody should have
              to hunt for this, and nobody should press it by accident either — the
              composer behind it asks what and where before anything is sent. */}
          {/* Reaching one person, and reaching everybody. Beside each other because they
              are the same thought at two different volumes, and in the top bar because a
              supervisor needs them from whatever screen they happen to be on. */}
          {can('alerts.ring') && (
            <button className="icobtn" onClick={() => setRinging(true)}
                    title="Ring somebody's device" aria-label="Ring somebody's device">
              <Icon name="bell" />
            </button>
          )}
          {can('alerts.emergency') && (
            <button className="emgbtn" onClick={() => setRaising(true)}
                    title="Alert everybody in the department at once">
              <Icon name="alert" size={14} /> <span>Emergency</span>
            </button>
          )}
          <span className="clock">{new Date().toLocaleDateString(undefined,
            { weekday: 'short', day: '2-digit', month: 'short' })}</span>
          {/* Small on purpose. It matters only when it is off, and then it explains why
              the board might be behind rather than leaving somebody to wonder. */}
          <span className={`livedot ${live ? 'on' : ''}`}
                title={live
                  ? 'Live — this screen updates the moment anything changes'
                  : 'Not live — this screen is refreshing on a timer instead'}
                aria-label={live ? 'Live connection' : 'No live connection'} />
          <span className="bellwrap">
            <button className="icobtn" aria-label="Notifications"
                    title="What happened while you were away"
                    aria-expanded={bell} onClick={() => setBell((v) => !v)}>
              <Icon name="bell" />
              {(notes?.unread ?? 0) > 0 && <span className="dot" />}
            </button>
            {bell && (
              <div className="bellscrim" aria-hidden="true" onClick={() => setBell(false)} />
            )}
            {bell && (
              <div className="bellpop" role="dialog" aria-label="Notifications">
                <header>
                  <b>Notifications</b>
                  <span className="spacer" />
                  {(notes?.unread ?? 0) > 0 && (
                    <button className="btn sm" onClick={() => markRead.mutate()}>Mark all read</button>
                  )}
                  <button className="icobtn" aria-label="Close notifications"
                          onClick={() => setBell(false)}>
                    <Icon name="x" size={14} />
                  </button>
                </header>
                {(notes?.notifications.length ?? 0) === 0 ? (
                  <p className="none">
                    Nothing yet. Escalations, assignments and approvals land here — the
                    system tells you, so nobody has to remember to check.
                  </p>
                ) : (
                  <ul>
                    {(notes?.notifications ?? []).slice(0, 25).map((n) => {
                      const body = (
                        <>
                          <span className="nt">{n.title}</span>
                          {n.body && <span className="nb">{n.body}</span>}
                          <span className="nw">{when(n.created_at)}</span>
                        </>
                      );
                      return (
                        <li key={n.id} className={n.read_at ? '' : 'unread'}>
                          {/* A notification that cannot be opened is just an interruption. */}
                          {n.entity_type === 'work_order' && n.entity_id
                            ? <Link to={`/jobs/${n.entity_id}`} onClick={() => setBell(false)}>{body}</Link>
                            : <span className="row">{body}</span>}
                        </li>
                      );
                    })}
                  </ul>
                )}
              </div>
            )}
          </span>
          <button className="icobtn"
                  aria-label={!maySilence ? 'Alert sounds are always on for your role'
                    : audible ? 'Turn alert sounds off' : 'Turn alert sounds on'}
                  title={!maySilence
                    ? 'Alert sounds stay on for your role — this is how you are told a job is yours'
                    : audible ? 'Alert sounds are on' : 'Alert sounds are off'}
                  aria-pressed={audible}
                  onClick={() => {
                    // Pressed by somebody who may not silence: still play, because that
                    // press is also the gesture the browser needs before it will allow
                    // any audio at all. Their tap is what makes the next alert audible.
                    if (!maySilence) { preview('notify'); report.mutate({ soundOn: true, audioReady: true }); return; }
                    const next = !audible;
                    setSoundOn(next);
                    setAudible(next);
                    if (next) preview('notify');
                  }}>
            <Icon name={audible ? 'sound' : 'muted'} />
            {!maySilence && (
              <span className="lockpip" aria-hidden="true"><Icon name="lock" size={9} /></span>
            )}
          </button>
          {/* Cycles rather than opening a menu: one thumb, three states, and the effect
              is visible the instant it is pressed. */}
          <button className="icobtn" onClick={bumpSize}
                  aria-label={`Text size: ${LABEL[size]}. Press to change.`}
                  title={`Text size — ${LABEL[size]}`}>
            <Icon name="text" />
            {size !== 'normal' && <span className="dot acc" />}
          </button>
          <button className="icobtn" onClick={toggleTheme} aria-label="Switch light and dark">
            <Icon name="theme" />
          </button>
        </header>

        <Mimic />
        {pw && <ChangePassword onClose={() => setPw(false)} />}
        {pairing && <PairPhone onClose={() => setPairing(false)} />}
        {raising && <RaiseEmergency onClose={() => setRaising(false)} />}
        {ringing && <RingSomebody onClose={() => setRinging(false)} />}
        {duty && <DutySetup onClose={() => setDuty(false)} />}
        <Outstanding />
        {/* Covers everything when it fires, which is the point of it. */}
        <Alarm live={live} />
        {/* Only draws itself on a screen that has been made the duty screen. */}
        <DutyBar live={live} />
        <Outlet />

        {/*
          * The phone's whole navigation.
          *
          * The sidebar is hidden below 900px, so for a long time this bar WAS the
          * navigation — four links and a bare sign-out arrow. A technician standing in a
          * plant room could not reach Assets, Safety, Stores or Planned Work at all, and
          * the one unlabelled button next to the links signed them out mid-job.
          *
          * Now: the four screens they open most, then everything else behind More.
          */}
        <nav className="tabbar" aria-label="Sections">
          {phoneTabs.map((i) => (
            <NavLink key={i.to} to={i.to} end={i.to === '/'}
                     className={({ isActive }) => (isActive ? 'on' : '')}>
              <Icon name={i.icon} />
              {i.label.split(' ')[0]}
            </NavLink>
          ))}
          <button className={`more ${sheet ? 'on' : ''}`} onClick={() => setSheet(true)}
                  aria-label="More screens and account">
            <Icon name="grid" />
            More
          </button>
        </nav>

        {sheet && (
          <div className="sheetwrap" role="dialog" aria-label="More"
               onClick={() => setSheet(false)}>
            <div className="sheet" onClick={(e) => e.stopPropagation()}>
              <div className="shead">
                <span>
                  <b>{me?.user.displayName}</b>
                  <small>{me?.user.roleName}</small>
                </span>
                <button className="icobtn" aria-label="Close" onClick={() => setSheet(false)}>
                  <Icon name="x" size={16} />
                </button>
              </div>

              <div className="sgrid">
                {sheetItems.map((i) => (
                  <NavLink key={i.to} to={i.to} end={i.to === '/'} onClick={() => setSheet(false)}
                           className={({ isActive }) => (isActive ? 'on' : '')}>
                    <Icon name={i.icon} />
                    <span>{i.label}</span>
                  </NavLink>
                ))}
              </div>

              <div className="sfoot">
                <button onClick={() => { setSheet(false); setPairing(true); }}>
                  <Icon name="bell" size={15} />Ring my phone
                </button>
                {can('duty.device.manage') && (
                  <button onClick={() => { setSheet(false); setDuty(true); }}>
                    <Icon name="shield" size={15} />Duty screen
                  </button>
                )}
                <button onClick={bumpSize}>
                  <Icon name="text" size={15} />Text size — {LABEL[size]}
                </button>
                <button onClick={() => { setSheet(false); setPw(true); }}>
                  <Icon name="lock" size={15} />Change password
                </button>
                <button className="danger" onClick={() => logout.mutate()}>
                  <Icon name="out" size={15} />Sign out
                </button>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
