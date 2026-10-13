import { lazy, Suspense, type ComponentType } from 'react';
import { Navigate, Route, Routes, useLocation } from 'react-router-dom';
import { ApiError } from './lib/api';
import { useSession } from './lib/session';
import { Shell } from './components/Shell';
import { Login } from './pages/Login';
import { Icon } from './components/Icon';
import { ChangePassword } from './components/ChangePassword';

const RELOADED = 'ff-reloaded-for-update';

/**
 * A screen, fetched the first time somebody opens it.
 *
 * The client was one 630 kB script, so a technician's phone on weak plant-room wifi
 * downloaded Admin, Money and Power before it could show the job board. Each screen is its
 * own file now, fetched on first visit and cached after.
 *
 * The trap in that is an update: a tab left open across one still holds the old page, which
 * names script files the host no longer has. A screen that fails to load reloads the page
 * once to pick up the new build, rather than leaving a broken screen; a second failure in
 * the same tab is shown, because then it is not an update.
 */
function screen<K extends string>(
  load: () => Promise<{ [P in K]: ComponentType }>, name: K,
) {
  return lazy(async () => {
    try {
      const m = await load();
      try { sessionStorage.removeItem(RELOADED); } catch { /* private mode */ }
      return { default: m[name] };
    } catch (err) {
      let again = false;
      try { again = sessionStorage.getItem(RELOADED) === '1'; sessionStorage.setItem(RELOADED, '1'); } catch { again = true; }
      if (!again) {
        window.location.reload();
        return new Promise<never>(() => {});
      }
      throw err;
    }
  });
}

const Setup = screen(() => import('./pages/Setup'), 'Setup');
const Overview = screen(() => import('./pages/Overview'), 'Overview');
const Jobs = screen(() => import('./pages/Jobs'), 'Jobs');
const JobCard = screen(() => import('./pages/JobCard'), 'JobCard');
const Roster = screen(() => import('./pages/Roster'), 'Roster');
const Power = screen(() => import('./pages/Power'), 'Power');
const Apartments = screen(() => import('./pages/Apartments'), 'Apartments');
const Handover = screen(() => import('./pages/Handover'), 'Handover');
const Stores = screen(() => import('./pages/Stores'), 'Stores');
const Assets = screen(() => import('./pages/Assets'), 'Assets');
const Ppm = screen(() => import('./pages/Ppm'), 'Ppm');
const Safety = screen(() => import('./pages/Safety'), 'Safety');
const Money = screen(() => import('./pages/Money'), 'Money');
const Admin = screen(() => import('./pages/Admin'), 'Admin');

/**
 * Land people on the first screen their role can actually open. A technician has no
 * report.read, so sending everyone to the dashboard greets half the department with
 * a permission error on the screen they see most.
 */
const LANDING: { path: string; need: string }[] = [
  { path: '/', need: 'report.read' },
  { path: '/jobs', need: 'wo.read' },
  { path: '/roster', need: 'roster.read' },
  { path: '/power', need: 'fuel.read' },
  { path: '/assets', need: 'asset.read' },
  { path: '/stores', need: 'stock.read' },
  { path: '/safety', need: 'permit.request' },
];

function Home() {
  const { can } = useSession();
  if (can('report.read')) return <Overview />;
  const first = LANDING.find((l) => l.path !== '/' && can(l.need));
  return first
    ? <Navigate to={first.path} replace />
    : <main className="view"><div className="note">Your role has no screens assigned yet. Ask an administrator to check your permissions.</div></main>;
}

function Booting() {
  return (
    <div className="center">
      <div className="tac c-3">
        <div className="grid c-on-acc bg-acc" style={{ width: 38, height: 38, borderRadius: 9, placeItems: 'center', margin: '0 auto 14px' }}>
          <Icon name="bolt" size={20} />
        </div>
        <div className="f-mono t-sm caps-wide caps">Connecting to the host…</div>
      </div>
    </div>
  );
}

/** Everything behind the shell needs a session; a 401 sends you back to the door. */
function Private() {
  const { query } = useSession();
  const location = useLocation();

  if (query.isLoading) return <Booting />;

  if (query.isError) {
    const err = query.error as ApiError;
    if (err.status === 401) return <Navigate to="/login" replace state={{ from: location.pathname }} />;
    return (
      <div className="center">
        <div className="panel-form">
          <div className="note crit err" role="alert">
            <b>{err.message}</b>
            <div className="mt-4">
              The host PC may be switched off, or this device may be on a different network from it.
            </div>
          </div>
          <button className="btn full mt-6"
                  onClick={() => query.refetch()}>Try again</button>
        </div>
      </div>
    );
  }
  // A temporary password somebody else chose is not an identity. Everything behind this
  // is attributed to a named person in an append-only log, so the wall comes before the
  // screens rather than as a reminder people dismiss.
  if (query.data?.user.mustChangePassword) return <ChangePassword forced />;

  return <Shell />;
}

export function App() {
  return (
    <Routes>
      <Route path="/login" element={<Login />} />
      <Route path="/setup" element={<Suspense fallback={<Booting />}><Setup /></Suspense>} />
      <Route element={<Private />}>
        <Route index element={<Home />} />
        <Route path="jobs" element={<Jobs />} />
        <Route path="jobs/:id" element={<JobCard />} />
        <Route path="roster" element={<Roster />} />
        <Route path="power" element={<Power />} />
        <Route path="apartments" element={<Apartments />} />
        <Route path="assets" element={<Assets />} />
        <Route path="ppm" element={<Ppm />} />
        <Route path="stores" element={<Stores />} />
        <Route path="safety" element={<Safety />} />
        <Route path="money" element={<Money />} />
        <Route path="handover" element={<Handover />} />
        <Route path="admin" element={<Admin />} />
      </Route>
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}
