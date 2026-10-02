import { useEffect, useState } from 'react';
import QRCode from 'qrcode';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, ApiError } from '../lib/api';
import { Btn, Chip, Loading, Modal, Empty } from './Bits';
import { when } from '../lib/format';

interface Device {
  id: string; name: string; platform: string; app_version: string | null;
  created_at: string; last_seen_at: string | null; connected_at: string | null;
}

/**
 * Pair a phone with the alert app.
 *
 * Done by the person themselves, from a browser where they are already signed in, which
 * is what makes it safe — the code carries the identity of that session, so nobody can
 * enrol a phone against an account they could not already use. It also means no password
 * is ever typed into the app, and a lost phone costs one revoked row instead of a
 * password change that signs them out of everything.
 */
export function PairPhone({ onClose }: { onClose: () => void }) {
  const qc = useQueryClient();
  const [svg, setSvg] = useState('');
  const [code, setCode] = useState<{ code: string; expiresAt: string; payload: string } | null>(null);

  const list = useQuery<{ devices: Device[] }>({
    queryKey: ['my-devices'], queryFn: () => api.get('/api/me/devices'),
    // While this is open the person is pairing: the new phone should appear by itself.
    refetchInterval: 4000,
  });

  const make = useMutation({
    mutationFn: () => api.post<{ code: string; expiresAt: string; payload: string }>('/api/me/pairing-code'),
    onSuccess: setCode,
  });

  const drop = useMutation({
    mutationFn: (id: string) => api.del(`/api/me/devices/${id}`),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['my-devices'] }),
  });

  useEffect(() => {
    if (!code) { setSvg(''); return; }
    let cancelled = false;
    // Generated in the browser. The host has no route to the internet, so a code from an
    // image service would be a permanently broken square.
    QRCode.toString(code.payload, { type: 'svg', errorCorrectionLevel: 'M', margin: 0,
                                    color: { dark: '#000000', light: '#ffffff' } })
      .then((out) => { if (!cancelled) setSvg(out); })
      .catch(() => { if (!cancelled) setSvg(''); });
    return () => { cancelled = true; };
  }, [code]);

  const devices = list.data?.devices ?? [];
  const err = make.error as ApiError | null;

  return (
    <Modal title="Ring my phone" onClose={onClose}>
      <div className="note" style={{ marginBottom: 14 }}>
        With the app installed, your phone rings when a job is assigned to you — with the
        screen off and the app closed. Without it, this website can only alert you while it
        is open on the screen.
      </div>

      {!code ? (
        <>
          <ol className="pairsteps">
            <li>Install <b>FacilityFlow Alerts</b> on the phone. The installer is on the
                Host&nbsp;PC tab, or ask an administrator.</li>
            <li>Press the button below and scan the square with the app.</li>
            <li>Allow notifications, and turn <b>off</b> battery optimisation for it when
                the app asks — otherwise the phone will stop it running after a few hours.</li>
          </ol>
          <Btn tone="pri" style={{ width: '100%' }} disabled={make.isPending}
               onClick={() => make.mutate()}>
            {make.isPending ? 'Preparing…' : 'Show my pairing code'}
          </Btn>
        </>
      ) : (
        <div style={{ textAlign: 'center' }}>
          {svg && (
            <div style={{ width: 196, height: 196, margin: '0 auto 12px', background: '#fff',
                          padding: 10, borderRadius: 10, border: '1px solid var(--line)' }}
                 dangerouslySetInnerHTML={{ __html: svg }} />
          )}
          <p style={{ fontFamily: 'var(--mono)', fontSize: '1.375rem', fontWeight: 600,
                      letterSpacing: '.12em', margin: '0 0 4px' }}>{code.code}</p>
          <p className="sub" style={{ margin: '0 0 14px' }}>
            Scan it, or type it into the app. It stops working in ten minutes and can only
            be used once.
          </p>
          <Btn style={{ width: '100%' }} onClick={() => make.mutate()}>Get a fresh code</Btn>
        </div>
      )}

      {err && <div className="note crit" style={{ marginTop: 12 }} role="alert">{err.message}</div>}

      <div style={{ marginTop: 18 }}>
        <p className="eyebrow" style={{ marginBottom: 8 }}>Phones paired to you</p>
        {list.isLoading ? <Loading rows={2} />
          : devices.length === 0
            ? <Empty title="None yet"
                     hint="Pair one and it appears here. Unpair it if you sell the phone or lose it — the app on it stops working immediately." />
            : (
              <div className="niclist">
                {devices.map((d) => (
                  <div key={d.id} className="nic dead">
                    <span className="nname">
                      {d.name}
                      {d.connected_at
                        ? <Chip tone="ok" lamp>Listening</Chip>
                        : <Chip tone="warn" lamp>Not running</Chip>}
                    </span>
                    <span className="nnote">
                      {d.platform}{d.app_version ? ` · v${d.app_version}` : ''} ·{' '}
                      {d.connected_at
                        ? 'connected now'
                        : d.last_seen_at ? `last heard from ${when(d.last_seen_at)}` : 'never connected'}
                    </span>
                    <span className="naddr">
                      <Btn size="sm" tone="danger" disabled={drop.isPending}
                           onClick={() => drop.mutate(d.id)}>Unpair</Btn>
                    </span>
                  </div>
                ))}
              </div>
            )}
      </div>
    </Modal>
  );
}
