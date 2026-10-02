import { Navigate, Route, Routes, useLocation } from 'react-router-dom';
import { ApiError } from './lib/api';
import { useSession } from './lib/session';
import { Shell } from './components/Shell';
import { Login } from './pages/Login';
import { Setup } from './pages/Setup';
import { Overview } from './pages/Overview';
import { Jobs } from './pages/Jobs';
import { JobCard } from './pages/JobCard';
import { Roster } from './pages/Roster';
import { Power } from './pages/Power';
import { Apartments } from './pages/Apartments';
import { Handover } from './pages/Handover';
import { Stores } from './pages/Stores';
import { Assets } from './pages/Assets';
import { Ppm } from './pages/Ppm';
import { Safety } from './pages/Safety';
import { Money } from './pages/Money';
import { Admin } from './pages/Admin';
import { Icon } from './components/Icon';
import { ChangePassword } from './components/ChangePassword';

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
      <div style={{ textAlign: 'center', color: 'var(--text-3)' }}>
        <div style={{ width: 38, height: 38, borderRadius: 9, background: 'var(--accent)',
                      display: 'grid', placeItems: 'center', margin: '0 auto 14px',
                      color: 'var(--on-accent)' }}>
          <Icon name="bolt" size={20} />
        </div>
        <div style={{ fontFamily: 'var(--mono)', fontSize: '0.6875rem', letterSpacing: '.16em',
                      textTransform: 'uppercase' }}>Connecting to the host…</div>
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
            <div style={{ marginTop: 8 }}>
              The host PC may be switched off, or this device may be on a different network from it.
            </div>
          </div>
          <button className="btn" style={{ width: '100%', marginTop: 14 }}
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
      <Route path="/setup" element={<Setup />} />
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
