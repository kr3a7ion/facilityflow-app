/** Admin → The host PC: address, network, certificate, remote access and the commands to run it. */
import { useEffect, useState } from 'react';
import QRCode from 'qrcode';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, ApiError } from '../../lib/api';
import { when } from '../../lib/format';
import { humanBytes } from '../../lib/image';
import { Card, Chip, Tile, Loading, Empty, ErrorNote, Btn, Field, Flash } from '../../components/Bits';

type Known<T> = { state: T | 'unknown'; why?: string; detail?: string };

interface Nic {
  name: string; address: string; netmask: string; mac: string;
  kind: 'ethernet' | 'wifi' | 'virtual' | 'other';
  linkLocal: boolean; privateRange: boolean; ssid: string | null; dhcp: boolean | null;
  recommended: boolean; note: string | null; usable: boolean;
}
interface HostStatus {
  version: string; startedAt: string; uptimeSeconds: number; node: string; platform: string;
  port: number; bindsTo: string;
  network: { nics: Nic[]; advertise: string | null; chosen: boolean; ssid: string | null;
             platform: string };
  advertise: string | null;
  boundTo: string | null;
  addresses: { label: string; url: string; kind: 'local' | 'lan' }[];
  pendingPort: number | null;
  dataDir: string; dataBytes: number; attachmentCount: number; freeBytes: number | null;
  backups: { count: number; newestAt: string | null; newestFile: string | null;
             newestBytes: number | null; totalBytes: number; ageHours: number | null };
  bootService: Known<'registered' | 'missing'>;
  firewall: Known<'open' | 'missing'>;
  isWindows: boolean;
}

function uptimeWords(s: number): string {
  if (s < 90) return `${Math.round(s)} seconds`;
  const m = Math.round(s / 60);
  if (m < 90) return `${m} minutes`;
  const h = Math.round(m / 60);
  if (h < 48) return `${h} hours`;
  return `${Math.round(h / 24)} days`;
}

/**
 * The host PC, from the inside.
 *
 * Every question somebody asks on install day and cannot otherwise answer: what address
 * do I hand out, is this running as a service or just in a window somebody will close,
 * did the firewall rule take, when did it last back up. It reports what can be
 * established and says plainly when it cannot tell — a status screen that guesses is
 * worse than none, because somebody acts on it.
 *
 * It cannot start or stop anything. This page is served by the server it would be
 * reporting on, so a stop button would be a button that destroys the page pressing it,
 * and a start button could only ever appear when it was not needed. Those live in the
 * launcher on the host PC, and the commands are here to copy.
 */
interface TlsState {
  enabled: boolean; generated: boolean; httpsPort: number;
  fingerprint?: string; expiresAt?: string | null; daysLeft?: number | null;
  covers?: string[]; addresses: string[]; uncovered?: string[];
}

/**
 * The property's own certificate.
 *
 * Why it is worth the trouble: a browser only treats a page as a *secure context* over
 * HTTPS, and without one there are no background notifications and no camera API. On a
 * LAN there is nobody to buy a certificate from for 192.168.1.50 — so the property signs
 * its own, and the department installs that root on its phones once.
 *
 * The fingerprint is the part that matters. Installing a root is handing a key to
 * whatever handed it to you, so the six pairs of hex here are what somebody checks
 * against the six pairs their phone shows them.
 */
function OwnCertificate() {
  const qc = useQueryClient();
  const [msg, setMsg] = useState<{ text: string; bad?: boolean } | null>(null);
  const q = useQuery<TlsState>({ queryKey: ['tls'], queryFn: () => api.get('/api/admin/tls') });
  const host = useQuery<HostStatus>({ queryKey: ['host'], queryFn: () => api.get('/api/admin/host') });
  const save = useMutation({
    mutationFn: (enabled: boolean) => api.post<{ message: string }>('/api/admin/host/https', { enabled }),
    onSuccess: async (r) => {
      await qc.invalidateQueries({ queryKey: ['tls'] });
      setMsg({ text: r.message });
    },
    onError: (e) => setMsg({ text: (e as ApiError).message, bad: true }),
  });

  if (q.isLoading || !q.data) return null;
  const t = q.data;
  const address = host.data?.advertise ?? t.addresses[0];

  return (
    <div className="mt-6">
      <Flash msg={msg} />
      <Card title="This property's own certificate"
            right={<Chip tone={t.enabled ? 'ok' : ''} lamp>{t.enabled ? 'On' : 'Off'}</Chip>}>
        <p className="mt-0 mb-5 t-ui lh-loose c-2">
          Plain HTTP always keeps working. Turning this on serves <b>HTTPS as well</b>, using
          a certificate this property signs for itself — which is what lets a browser do
          background notifications without the phone app.
        </p>

        <label className="row gap-5 mb-5">
          <input type="checkbox" checked={t.enabled} disabled={save.isPending}
                 onChange={(e) => save.mutate(e.target.checked)} />
          <span className="t-body"><b>Also serve HTTPS</b></span>
        </label>

        {t.enabled && t.generated && (
          <>
            <div className="grid g3 mb-5">
              <Tile label="HTTPS address"
                    value={address ? `${address}:${t.httpsPort}` : `port ${t.httpsPort}`}
                    sub="for devices with the root installed" />
              <Tile label="Certificate runs out" value={t.daysLeft ?? '—'} unit="days"
                    tone={(t.daysLeft ?? 0) < 45 ? 'warn' : 'ok'}
                    sub="renewed by itself before then" />
              <Tile label="Covers" value={t.covers?.length ?? 0}
                    sub={(t.covers ?? []).slice(0, 2).join(', ')} />
            </div>

            {(t.uncovered?.length ?? 0) > 0 && (
              <div className="note warn mb-5">
                <b>This PC answers on {t.uncovered!.join(', ')}, which the certificate does
                not cover.</b> Devices opening that address get a warning. Restart the host
                and a new certificate covering it is made automatically — the root does not
                change, so nothing needs reinstalling.
              </div>
            )}

            <dl className="kv mb-5">
              <dt>Root fingerprint</dt>
              <dd className="mono t-sm break-all">
                {t.fingerprint}
              </dd>
            </dl>

            <div className="note">
              <b>Installing it on a phone.</b> Open{' '}
              <span className="mono">http://{address}:{host.data?.port ?? 4700}/ca.crt</span>{' '}
              on the device and open the file it downloads. Android asks what the
              certificate is for — choose <b>Wi-Fi</b> or <b>VPN and apps</b>. iPhone needs a
              second step: <b>Settings → General → About → Certificate Trust Settings</b>, and
              switch it on there, or it is installed and still not trusted.
              {' '}<b>Check the fingerprint above matches what the phone shows before accepting it.</b>
            </div>
          </>
        )}

        {t.enabled && !t.generated && (
          <div className="note">
            The certificate is generated the next time the host restarts.
          </div>
        )}
      </Card>
    </div>
  );
}

interface RemoteState {
  enabled: boolean; publicHost: string | null; idleMinutes: number;
  changedBy: string | null; changedAt: string | null;
  allowed: { display_name: string; role_name: string; may_change: number }[];
  blocked: { display_name: string }[];
  liveRemote: number;
}

/**
 * Checking in from outside the property.
 *
 * Off until somebody deliberately turns it on, and the panel says who that was. The
 * department's whole premise is a system that needs no internet; this is the one door
 * through that premise, so it is presented as a door — what it opens, who can walk
 * through it, and what they can do once inside — rather than as a checkbox.
 */
function RemoteDoor() {
  const qc = useQueryClient();
  const [host, setHost] = useState<string | null>(null);
  const [msg, setMsg] = useState<{ text: string; bad?: boolean } | null>(null);
  const q = useQuery<RemoteState>({
    queryKey: ['remote'], queryFn: () => api.get('/api/admin/remote'),
  });
  const save = useMutation({
    mutationFn: (next: Partial<RemoteState>) => api.patch('/api/admin/remote', next),
    onSuccess: async (_r, next) => {
      await qc.invalidateQueries({ queryKey: ['remote'] });
      setHost(null);
      setMsg({ text: next.enabled === undefined ? 'Saved.'
        : next.enabled ? 'Remote access is open. It is recorded that you opened it.'
                       : 'Remote access is closed. Nothing outside the property can reach this PC.' });
    },
    onError: (e) => setMsg({ text: (e as ApiError).message, bad: true }),
  });

  if (q.isLoading || !q.data) return null;
  const r = q.data;

  return (
    <div className="mt-6">
      <Flash msg={msg} />
      <Card title="Checking in from outside"
            right={<Chip tone={r.enabled ? 'warn' : 'ok'} lamp>
              {r.enabled ? 'Open' : 'Closed'}
            </Chip>}>
        <p className="mt-0 mb-5 t-ui lh-loose c-2">
          With this open, the people below can sign in from anywhere through the tunnel
          running on this PC. The department keeps working on the property network either
          way — this changes nothing on site.
        </p>

        <label className="row gap-5 mb-5">
          <input type="checkbox" checked={r.enabled} disabled={save.isPending}
                 onChange={(e) => save.mutate({ enabled: e.target.checked })} />
          <span className="t-body">
            <b>Allow signing in from outside the property</b>
          </span>
        </label>

        {r.changedBy && (
          <p className="t-sm c-3 mt-0 mb-5">
            Last changed by {r.changedBy}{r.changedAt ? ` · ${when(r.changedAt)}` : ''}.
          </p>
        )}

        {r.enabled && (
          <>
            <div className="grid g3 mb-5">
              <Tile label="Signed in from outside" value={r.liveRemote}
                    tone={r.liveRemote ? 'warn' : undefined}
                    sub={r.liveRemote ? 'right now' : 'nobody at the moment'} />
              <Tile label="Can get in" value={r.allowed.length}
                    sub={`${r.allowed.filter((a) => a.may_change).length} can also change things`} />
              <Tile label="Times out after" value={r.idleMinutes} unit="min"
                    sub="of doing nothing" />
            </div>

            <Field label="The address the tunnel publishes"
                   hint="Shown to whoever needs it, and any request for this address is treated as from outside however it arrives. Setting it here does not create the tunnel — see the note below.">
              <input className="inp" placeholder="e.g. srl-maintenance.example.com"
                     value={host ?? r.publicHost ?? ''}
                     onChange={(e) => setHost(e.target.value)}
                     onBlur={() => host !== null && save.mutate({ publicHost: host })} />
            </Field>

            <div className="tw mt-5">
              <table className="wide">
                <thead><tr><th>Who can sign in from outside</th><th>Role</th><th>From there they can</th></tr></thead>
                <tbody>
                  {r.allowed.map((a) => (
                    <tr key={a.display_name}>
                      <td><span className="ttl">{a.display_name}</span></td>
                      <td>{a.role_name}</td>
                      <td>
                        {a.may_change
                          ? <Chip tone="warn">assign and approve</Chip>
                          : <Chip tone="ok">look only</Chip>}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            {r.blocked.length > 0 && (
              <div className="note warn mt-5">
                <b>Still on a default password, so blocked from outside:</b>{' '}
                {r.blocked.map((b) => b.display_name).join(', ')}. They can sign in on the
                property network and change it; until they do, the tunnel will refuse them.
                That is deliberate — a known password and a public address is the one
                combination that must not exist.
              </div>
            )}
          </>
        )}

        <div className="note mt-6">
          <b>This switch does not create the tunnel.</b> It decides whether the system
          accepts anything that arrives through one. Install <b>cloudflared</b> on this PC
          as a service, point it at <b>http://127.0.0.1:{'{'}port{'}'}</b>, and put
          Cloudflare Access in front with a list of the exact email addresses allowed —
          a named list, not a whole domain. Everything that comes through is marked as
          remote in the audit log, so an approval can always be placed on site or off it.
        </div>
        <div className="note mt-4">
          <b>Using a different tunnel or a proxy?</b> Anything that adds a forwarding header,
          or asks for the address above, is treated as outside. A tunnel that does neither —
          one that rewrites the address to <b>localhost</b> and adds no header — looks exactly
          like this PC's own browser and gets through as the property network. Keep its
          default headers on, and fill in the address above.
        </div>
      </Card>
    </div>
  );
}

export function Host() {
  const q = useQuery<HostStatus>({
    queryKey: ['host'], queryFn: () => api.get('/api/admin/host'),
    refetchInterval: 30_000,
  });

  if (q.isLoading) return <Card><Loading rows={5} /></Card>;
  if (q.isError) return <Card><ErrorNote error={q.error} /></Card>;
  const h = q.data!;

  const backupStale = h.backups.ageHours == null || h.backups.ageHours > 48;

  return (
    <>
      <div className="grid g4 mb-6">
        <Tile label="Listening on" value={h.port}
              sub={h.boundTo ? `only on ${h.boundTo}` : 'every network on this PC'} />
        <Tile label="Running for" value={uptimeWords(h.uptimeSeconds)}
              sub={`since ${when(h.startedAt)}`} />
        <Tile label="Newest backup"
              value={h.backups.ageHours == null ? 'none'
                : h.backups.ageHours < 1 ? 'just now' : `${Math.round(h.backups.ageHours)}h ago`}
              tone={backupStale ? 'warn' : 'ok'}
              sub={`${h.backups.count} kept · ${humanBytes(h.backups.totalBytes)}`} />
        <Tile label="Free on this disk"
              value={h.freeBytes == null ? '—' : humanBytes(h.freeBytes)}
              sub={`data folder is ${humanBytes(h.dataBytes)}`} />
      </div>

      {h.pendingPort != null && (
        <div className="note warn mb-6">
          <b>Port {h.pendingPort} is saved but not in force.</b> This host is still answering on
          {' '}{h.port} and will move when it next restarts. Open the firewall for {h.pendingPort}
          {' '}first, or the wifi loses it.
        </div>
      )}

      <div className="mb-6"><AddressCard h={h} /></div>

      <div className="grid g2 mb-6">
        <Card title="How it is running"
              right={<Chip tone={h.bootService.state === 'registered' ? 'ok'
                : h.bootService.state === 'missing' ? 'warn' : ''} lamp>
                {h.bootService.state === 'registered' ? 'starts at boot'
                  : h.bootService.state === 'missing' ? 'window only' : 'cannot tell'}
              </Chip>}>
          <ul className="iso mt-0">
            <li>
              <span>Starts when the PC boots</span>
              <span className="sp">
                <Chip tone={h.bootService.state === 'registered' ? 'ok'
                  : h.bootService.state === 'missing' ? 'warn' : ''}>
                  {h.bootService.state === 'registered' ? 'Yes'
                    : h.bootService.state === 'missing' ? 'No' : 'Unknown'}
                </Chip>
              </span>
            </li>
            <li>
              <span>Port {h.port} open on the private network</span>
              <span className="sp">
                <Chip tone={h.firewall.state === 'open' ? 'ok'
                  : h.firewall.state === 'missing' ? 'warn' : ''}>
                  {h.firewall.state === 'open' ? 'Yes'
                    : h.firewall.state === 'missing' ? 'No' : 'Unknown'}
                </Chip>
              </span>
            </li>
          </ul>

          {h.bootService.state === 'missing' && (
            <div className="note warn mt-5">
              <b>This server is only running because a window is open.</b> Close it, or log out,
              or let the PC restart overnight, and the department loses the system until somebody
              starts it again. Run the launcher on the host PC and choose
              <b> Install as a boot service</b>.
            </div>
          )}
          {h.bootService.state === 'unknown' && (
            <div className="note mt-5">{h.bootService.why}</div>
          )}
          {h.firewall.state === 'missing' && h.bootService.state !== 'missing' && (
            <div className="note warn mt-5">
              No firewall rule for port {h.port}. The system works on this PC but phones on the
              wifi cannot reach it.
            </div>
          )}
        </Card>

        <PortCard current={h.port} pending={h.pendingPort} />
      </div>

      <Card title="Doing this on the host PC">
        <p className="sub mt-0 mb-5">
          Starting, stopping and installing the boot service all happen on the host PC itself —
          this page is served by the server it would be acting on. Double-click
          {' '}<b>FacilityFlow.cmd</b> in the app folder for a menu, or copy a command.
        </p>
        <CmdList windows={h.isWindows} />
      </Card>

      <PhoneApp dataDir={h.dataDir} />
      <OwnCertificate />
      <RemoteDoor />

      <div className="note mt-6">
        <b>{h.dataDir}</b> is the whole business record — database, photos and backups.
        {' '}{h.attachmentCount.toLocaleString()} file{h.attachmentCount === 1 ? '' : 's'} attached
        so far. Copy that folder and you have copied everything.
        {' '}Running FacilityFlow {h.version} on Node {h.node}, {h.platform}.
      </div>
    </>
  );
}

interface Installer {
  present: boolean; bytes?: number; updatedAt?: string;
  version: string | null; build: number | null;
}

/**
 * The alert app's installer: whether this host has one, and which build.
 *
 * The pairing dialog sends people here for the installer, and a phone on an older build
 * is offered whatever is here — so the build number is what an administrator checks after
 * copying a new one in.
 */
function PhoneApp({ dataDir }: { dataDir: string }) {
  const q = useQuery<Installer>({ queryKey: ['installer'], queryFn: () => api.get('/api/admin/installer') });
  if (q.isLoading || !q.data) return null;
  const i = q.data;
  const unreadable = i.present && i.build == null;

  return (
    <div className="mt-6">
      <Card title="The phone app"
            right={<Chip tone={!i.present || unreadable ? 'warn' : 'ok'} lamp>
              {!i.present ? 'not on this host' : unreadable ? 'unreadable' : `build ${i.build}`}
            </Chip>}>
        {!i.present ? (
          <p className="mt-0 mb-0 t-ui lh-loose c-2">
            No installer here yet. Download the newest <b>Build APK</b> run of the alert app from
            GitHub, unzip it, and copy <b>app-release.apk</b> into <b>{dataDir}</b> renamed
            to <b>app.apk</b>. Phones then install it from this host's address
            followed by <b>/app.apk</b>.
          </p>
        ) : (
          <>
            <p className="mt-0 mb-5 t-ui lh-loose c-2">
              {unreadable
                ? <>The file in the data folder could not be read as an app, so phones are not
                    told about it. Copy <b>app-release.apk</b> in again, renamed to <b>app.apk</b>.</>
                : <>Version <b>{i.version}</b>, build <b>{i.build}</b>
                    {i.bytes != null && <> · {humanBytes(i.bytes)}</>}
                    {i.updatedAt && <> · copied in {when(i.updatedAt)}</>}.
                    {' '}A paired phone on an older build is told a newer one is waiting. To
                    update everybody, copy the new <b>app.apk</b> over this one.</>}
            </p>
            <a className="btn sm" href="/app.apk" download>Download the installer</a>
          </>
        )}
      </Card>
    </div>
  );
}

/**
 * The address the department is given, and the network it comes from — in one card.
 *
 * These used to be three: which network, the address with its code, and the port, with the
 * same "the router can change this" warning printed once per adapter and again under the
 * code. Somebody looking for "what do I write on the notice board" read all three to find it.
 *
 * A host PC is rarely on one network. It has a cable, and wifi, and — once anybody has
 * installed VirtualBox, Docker or WSL — two or three adapters that look exactly like a
 * network and reach nobody. So the choice of which address goes on the wall stays here,
 * under the address it decides, rather than being left to whichever adapter Node lists first.
 */
function AddressCard({ h }: { h: HostStatus }) {
  const qc = useQueryClient();
  const [msg, setMsg] = useState<{ text: string; bad?: boolean } | null>(null);
  const [advanced, setAdvanced] = useState(false);
  const [svg, setSvg] = useState('');

  const url = h.advertise ? `http://${h.advertise}:${h.port}` : null;
  const nic = h.network.nics.find((n) => n.address === h.advertise) ?? null;

  useEffect(() => {
    let cancelled = false;
    if (!url) { setSvg(''); return; }
    // Generated in the browser: the host has no route to the internet, so a code from
    // an image service would be a permanently broken square on the wall.
    QRCode.toString(url, { type: 'svg', errorCorrectionLevel: 'M', margin: 0,
                           color: { dark: '#000000', light: '#ffffff' } })
      .then((out) => { if (!cancelled) setSvg(out); })
      .catch(() => { if (!cancelled) setSvg(''); });
    return () => { cancelled = true; };
  }, [url]);

  const save = useMutation({
    mutationFn: (body: { advertise?: string | null; bindTo?: string | null }) =>
      api.post<{ message: string }>('/api/admin/host/network', body),
    onSuccess: async (r) => {
      setMsg({ text: r.message });
      await qc.invalidateQueries({ queryKey: ['host'] });
    },
    onError: (e) => setMsg({ text: (e as ApiError).message, bad: true }),
  });

  const usable = h.network.nics.filter((n) => n.usable);
  const rest = h.network.nics.filter((n) => !n.usable);
  const kindWord = (n: Nic) =>
    n.kind === 'ethernet' ? 'Cable' : n.kind === 'wifi' ? 'Wifi'
      : n.kind === 'virtual' ? 'Virtual' : 'Other';
  // Unknown counts as "may change": the warning is cheap, a reprinted sticker sheet is not.
  const mayChange = nic != null && nic.dhcp !== false;

  return (
    <>
      <Flash msg={msg} />
      <Card title="The address to hand out" right={<Chip>Port {h.port}</Chip>}>
        {h.network.nics.length === 0 ? (
          <Empty title="This PC is not on any network"
                 hint="No cable and no wifi, so nothing in the department can reach it. Connect it to the office network, then reload this page." />
        ) : (
          <>
            {url ? (
              <div className="row gap-7 start">
                {svg && (
                  <div className="p-4" style={{ width: 132, height: 132, flex: 'none', background: '#fff', borderRadius: 'var(--r-lg)', border: '1px solid var(--line)' }}
                       dangerouslySetInnerHTML={{ __html: svg }} />
                )}
                <div className="joinaddr">
                  <div className="url f-mono t-lede fw-5 mb-3">{url}</div>
                  {nic && (
                    <p className="sub mt-0 mb-4">
                      {nic.name}{nic.ssid ? ` · ${nic.ssid}` : ''}
                    </p>
                  )}
                  <p className="t-ui mt-0 mb-0">
                    Anyone on {nic?.kind === 'wifi' && nic.ssid
                      ? <>the <b>{nic.ssid}</b> wifi</> : 'the office network'} opens this and
                    signs in. On a phone, <b>Add to home screen</b> and it behaves like an app.
                  </p>
                </div>
              </div>
            ) : (
              <div className="note warn">
                <b>Nothing here can be reached from a phone.</b> Every address this PC has belongs
                to virtual software or is one the PC gave itself because nothing answered. Plug it
                into the office network, or join it to the staff wifi.
              </div>
            )}

            {mayChange && (
              <div className="note warn mt-6">
                <b>Ask IT to reserve {h.advertise} for this PC before printing it on anything.</b>
                {' '}{nic.dhcp
                  ? 'The router handed this address out, and it can change after a power cut or overnight'
                  : 'If the router hands this PC its address, it can change after a power cut or overnight'}
                {' '}— and every bookmark, home-screen shortcut and QR sticker breaks the same morning.
              </div>
            )}

            {usable.length > 0 && (
              <>
                <p className="eyebrow mt-6 mb-3">
                  {usable.length > 1 ? 'Which network to hand out' : 'The network it comes from'}
                </p>
                <div className="niclist">
                  {usable.map((n) => (
                    <label key={n.address + n.name} className={n.recommended ? 'nic on' : 'nic'}>
                      <input type="radio" name="advertise" checked={n.recommended}
                             onChange={() => save.mutate({ advertise: n.address })} />
                      <span className="nname">
                        {n.name}
                        <Chip>{kindWord(n)}</Chip>
                        {n.ssid && <Chip>{n.ssid}</Chip>}
                        {n.dhcp === true && <Chip tone="warn">Can change</Chip>}
                      </span>
                      <span className="naddr">{n.address}</span>
                      {n.note && <span className="nnote">{n.note}</span>}
                    </label>
                  ))}
                </div>
                <p className="sub mt-4 mb-0">
                  The host answers on <b>{h.boundTo ? `${h.boundTo} only` : 'every network listed'}</b>
                  {' '}whichever you pick — this changes what people are told, not what the server
                  listens on.
                </p>
              </>
            )}

            {rest.length > 0 && (
              <details className="mt-5">
                <summary className="sub clickable">
                  {rest.length} more {rest.length === 1 ? 'address' : 'addresses'} on this PC that
                  cannot be used
                </summary>
                <div className="niclist mt-4 dim">
                  {rest.map((n) => (
                    <div key={n.address + n.name} className="nic dead">
                      <span className="nname">{n.name} <Chip>{kindWord(n)}</Chip></span>
                      <span className="naddr">{n.address}</span>
                      {n.note && <span className="nnote">{n.note}</span>}
                    </div>
                  ))}
                </div>
              </details>
            )}

            {usable.length > 0 && (
              <Btn size="sm" className="mt-5"
                   onClick={() => setAdvanced((v) => !v)} aria-expanded={advanced}>
                {advanced ? 'Hide' : 'Show'} advanced: answer on one network only
              </Btn>
            )}

            {advanced && (
              <div className="note warn mt-5">
                <b>Only if this PC can be reached from a network the department should not be on</b>
                {' '}— a guest wifi, for instance. Narrowing it here means the system refuses every
                other network from the next restart.
                <p className="mt-4 mb-0">
                  Reserve the address first. If it moves, the host cannot answer on the old one: it
                  falls back to every network and says so when it starts, but until somebody notices,
                  the narrowing is not doing its job.
                </p>
                <div className="row gap-4 mt-5">
                  {usable.map((n) => (
                    <Btn key={n.address} size="sm"
                         tone={h.boundTo === n.address ? 'pri' : undefined}
                         onClick={() => save.mutate({ bindTo: n.address })}>
                      Only {n.name} ({n.address})
                    </Btn>
                  ))}
                  {h.boundTo && (
                    <Btn size="sm" onClick={() => save.mutate({ bindTo: null })}>
                      Answer on every network again
                    </Btn>
                  )}
                </div>
              </div>
            )}
          </>
        )}
      </Card>
    </>
  );
}

function PortCard({ current, pending }: { current: number; pending: number | null }) {
  const qc = useQueryClient();
  const [value, setValue] = useState(String(pending ?? current));
  const [msg, setMsg] = useState<{ text: string; bad?: boolean } | null>(null);

  const save = useMutation({
    mutationFn: () => api.post('/api/admin/host/port', { port: Number(value) }),
    onSuccess: async (r) => {
      setMsg({ text: (r as { message: string }).message });
      await qc.invalidateQueries({ queryKey: ['host'] });
    },
    onError: (e) => setMsg({ text: (e as ApiError).message, bad: true }),
  });

  const n = Number(value);
  const ready = Number.isInteger(n) && n >= 1024 && n <= 65535 && n !== (pending ?? current);

  return (
    <Card title="Port" right={<Chip tone={pending != null ? 'warn' : ''}>
      {pending != null ? `${current} → ${pending}` : String(current)}</Chip>}>
      <Field label="Listen on port"
             hint="Takes effect the next time the host starts, not now — rebinding under a running server would kill this page and every device mid-action.">
        <input className="inp" inputMode="numeric" value={value}
               onChange={(e) => setValue(e.target.value.replace(/[^0-9]/g, ''))} />
      </Field>
      {msg && <div className={`note ${msg.bad ? 'crit' : 'good'} mb-5`}
                   role="status">{msg.text}</div>}
      <Btn full tone="pri" disabled={!ready || save.isPending}
           onClick={() => save.mutate()}>
        {save.isPending ? 'Saving…' : 'Save for next start'}
      </Btn>
      <div className="note mt-5">
        Change this only if something else on the PC already uses {current}. Every bookmark,
        home-screen shortcut and printed QR code carries the port in it, so moving it means
        reprinting the stickers.
      </div>
    </Card>
  );
}

const HOST_CMDS: { what: string; cmd: string }[] = [
  { what: 'Stop the host', cmd: 'Stop-ScheduledTask -TaskName FacilityFlow' },
  { what: 'Start it again', cmd: 'Start-ScheduledTask -TaskName FacilityFlow' },
  { what: 'Install it to start at boot',
    cmd: 'powershell -ExecutionPolicy Bypass -File .\\scripts\\windows\\install-host.ps1' },
  { what: 'See why it will not start', cmd: 'Get-Content .\\data\\logs\\*.log -Tail 40' },
];

function CmdList({ windows }: { windows: boolean }) {
  const [copied, setCopied] = useState<string | null>(null);
  if (!windows) {
    return (
      <div className="note">
        This host is not Windows, so the scheduled-task commands do not apply. Start it with
        {' '}<code>npm start</code> in the app folder.
      </div>
    );
  }
  return (
    <ul className="iso mt-0">
      {HOST_CMDS.map((c) => (
        <li key={c.cmd} style={{ flexWrap: 'wrap' }}>
          <span className="fill">
            <span className="block t-ui">{c.what}</span>
            <span className="tagno break-all">{c.cmd}</span>
          </span>
          <span className="sp">
            <button className="btn sm" onClick={() => {
              try {
                void navigator.clipboard?.writeText(c.cmd);
                setCopied(c.cmd);
                setTimeout(() => setCopied(null), 1400);
              } catch { /* no clipboard on an insecure origin in some browsers */ }
            }}>{copied === c.cmd ? 'Copied' : 'Copy'}</button>
          </span>
        </li>
      ))}
    </ul>
  );
}
