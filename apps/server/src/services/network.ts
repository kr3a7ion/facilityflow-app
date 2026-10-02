/**
 * Which network the department actually reaches this PC on.
 *
 * Until now every non-internal IPv4 address the PC had was collected into one list,
 * labelled "On the wifi" whether it was wifi or not, and the first one in that list
 * became the QR code somebody printed and taped to the plant-room wall. On a bare PC
 * that happens to work. On a real one — with VirtualBox, or WSL, or Hyper-V, or a phone
 * tethered once last month — Node hands back `192.168.56.1` or a `172.x` vEthernet
 * address just as readily, and the code on the wall points at an adapter no phone can
 * reach. Nothing on screen would have explained why.
 *
 * So this names each adapter, says what kind it is, and picks one. The rule from the
 * host service holds here too: report what can be established and say so plainly when it
 * cannot. A setup screen that guesses is worse than one that admits it does not know,
 * because somebody will print the guess.
 */
import os from 'node:os';
import { execFile } from 'node:child_process';

const PROBE_MS = 4000;

export type Kind = 'ethernet' | 'wifi' | 'virtual' | 'other';

export interface Nic {
  /** The adapter's own name, as the operating system calls it. */
  name: string;
  address: string;
  netmask: string;
  mac: string;
  kind: Kind;
  /** 169.254.x.x — the address a PC gives itself when nothing answered. */
  linkLocal: boolean;
  /** An RFC1918 address, which is what a LAN looks like. */
  privateRange: boolean;
  /** Wifi only, Windows only, when it can be read. */
  ssid: string | null;
  /** Whether this address was handed out by DHCP, and so can change. */
  dhcp: boolean | null;
  /** True when this is the one to hand out. Exactly one, or none at all. */
  recommended: boolean;
  /** Why it is or is not usable, in the department's words. Null when unremarkable. */
  note: string | null;
  usable: boolean;
}

export interface NetworkView {
  nics: Nic[];
  /** The address to hand out, chosen or recommended. Null when there is nothing to give. */
  advertise: string | null;
  /** Set when the administrator picked this rather than it being the obvious one. */
  chosen: boolean;
  /** Windows only: the wifi network this PC is joined to right now. */
  ssid: string | null;
  platform: string;
}

function run(cmd: string, args: string[]): Promise<string> {
  return new Promise((resolve) => {
    const child = execFile(cmd, args, { timeout: PROBE_MS, windowsHide: true },
      (err, stdout) => resolve(err ? '' : String(stdout ?? '')));
    child.on('error', () => resolve(''));
  });
}

/**
 * What kind of adapter this is, from its name.
 *
 * There is no portable API for "is this wifi", so this reads the names the operating
 * system uses. The virtual list is the one that earns its keep: those adapters are
 * indistinguishable from a real LAN card by address alone — `192.168.56.1` looks exactly
 * like a network — and they are the single most common reason a correct-looking address
 * reaches nothing.
 */
export function classify(name: string): Kind {
  const n = name.toLowerCase();

  // Checked first: "vEthernet (WSL)" contains "ethernet", and a VirtualBox adapter on a
  // machine with no real NIC would otherwise be recommended to the whole department.
  if (/vethernet|virtualbox|vmware|vmnet|hyper-v|docker|veth|virbr|^br-|loopback|npcap|tailscale|zerotier|tap-windows|openvpn|wireguard|utun|awdl|llw|bluetooth|wi-fi direct|microsoft wi-fi direct|local area connection\*/.test(n)) {
    return 'virtual';
  }
  if (/wi-?fi|wlan|wlp|wifi|airport|^en[01]$/.test(n)) return 'wifi';
  if (/ethernet|^eth\d|^enp|^eno|^ens|^en\d|thunderbolt bridge/.test(n)) return 'ethernet';
  return 'other';
}

/** RFC1918 — the ranges a private network is built from. */
function isPrivate(ip: string): boolean {
  const p = ip.split('.').map(Number);
  if (p.length !== 4 || p.some((x) => Number.isNaN(x))) return false;
  const [a, b] = p as [number, number, number, number];
  return a === 10
    || (a === 172 && b >= 16 && b <= 31)
    || (a === 192 && b === 168);
}

/**
 * The wifi network this PC is on, so the person setting up can say "the phones have to
 * be on this one too" — which is most of the answer to "why can't my phone see it".
 */
async function currentSsid(): Promise<string | null> {
  if (process.platform !== 'win32') return null;
  const out = await run('netsh', ['wlan', 'show', 'interfaces']);
  // Deliberately loose: the label is localised on a non-English Windows, and a wrong
  // guess here is worse than no answer.
  const m = /^\s*SSID\s*:\s*(.+?)\s*$/im.exec(out);
  return m?.[1] ?? null;
}

/**
 * Which addresses came from DHCP.
 *
 * This is the difference between an address worth printing and one that is right until
 * the PC is next restarted. One call for every adapter rather than one per adapter, so
 * the screen is not waiting on four separate probes.
 */
async function dhcpByInterface(): Promise<Map<string, boolean>> {
  const map = new Map<string, boolean>();
  if (process.platform !== 'win32') return map;
  const out = await run('netsh', ['interface', 'ipv4', 'show', 'config']);
  let current: string | null = null;
  for (const line of out.split(/\r?\n/)) {
    const head = /^Configuration for interface "(.+)"\s*$/.exec(line);
    if (head?.[1]) { current = head[1]; continue; }
    const dhcp = /^\s*DHCP enabled:\s*(Yes|No)\s*$/i.exec(line);
    if (dhcp?.[1] && current) map.set(current, /yes/i.test(dhcp[1]));
  }
  return map;
}

/**
 * Rank the adapters and pick one.
 *
 * Ethernet above wifi, and not because it is faster: a cable keeps its address when the
 * PC sleeps and does not roam onto another access point overnight, and every bookmark on
 * every phone in the department depends on that address staying still.
 */
function score(n: Omit<Nic, 'recommended' | 'note' | 'usable' | 'kind'> & { kind: Kind }): number {
  if (n.linkLocal) return 0;            // nothing answered; this address reaches nobody
  if (n.kind === 'virtual') return 1;   // looks like a network, is not one
  if (!n.privateRange) return 20;       // a public address on a host PC is a surprise worth not printing
  if (n.kind === 'ethernet') return 100;
  if (n.kind === 'wifi') return 70;
  return 40;
}

function noteFor(n: Nic): string | null {
  if (n.linkLocal) {
    return 'This PC gave itself this address because nothing answered — the cable is out, or the network is down. Nothing can reach it here.';
  }
  if (n.kind === 'virtual') {
    return 'A virtual adapter belonging to other software on this PC, not a real network. It looks like an address and reaches nobody.';
  }
  if (!n.privateRange) {
    return 'Not a private network address. Check this is really the office network before handing it out.';
  }
  if (n.kind === 'wifi') {
    return 'Wifi works, but a cable is steadier for the host: it keeps its address when the PC sleeps and will not roam to another access point overnight.';
  }
  return null;
}

/** One adapter address as the operating system reports it, before any judgement. */
export interface RawAddr { name: string; address: string; netmask: string; mac: string }

/**
 * The judgement, separated from the machine it is about, so the ranking can be tested
 * against the PC a department actually has rather than only the one this runs on.
 */
export function buildView(
  raw: RawAddr[], ssid: string | null, dhcp: Map<string, boolean>, saved?: string | null,
): NetworkView {
  const nics: Nic[] = raw.map((r) => {
    const kind = classify(r.name);
    const linkLocal = r.address.startsWith('169.254.');
    const nic: Nic = {
      name: r.name, address: r.address, netmask: r.netmask, mac: r.mac, kind, linkLocal,
      privateRange: isPrivate(r.address),
      ssid: kind === 'wifi' ? ssid : null,
      dhcp: dhcp.has(r.name) ? dhcp.get(r.name)! : null,
      recommended: false, note: null,
      usable: !linkLocal && kind !== 'virtual',
    };
    nic.note = noteFor(nic);
    return nic;
  });

  nics.sort((a, b) => score(b) - score(a) || a.name.localeCompare(b.name));

  // An administrator's choice outranks the ranking, but only while it still exists: a
  // saved address that has since changed must not leave the department with nothing.
  const savedNic = saved ? nics.find((n) => n.address === saved) : undefined;
  const best = nics.find((n) => score(n) >= 20);
  const pick = savedNic ?? best;
  if (pick) pick.recommended = true;

  return {
    nics,
    advertise: pick?.address ?? null,
    chosen: !!savedNic,
    ssid,
    platform: process.platform,
  };
}

export async function networkView(saved?: string | null): Promise<NetworkView> {
  const [ssid, dhcp] = await Promise.all([currentSsid(), dhcpByInterface()]);

  const raw: RawAddr[] = [];
  for (const [name, list] of Object.entries(os.networkInterfaces())) {
    for (const ni of list ?? []) {
      if (ni.family !== 'IPv4' || ni.internal) continue;
      raw.push({ name, address: ni.address, netmask: ni.netmask, mac: ni.mac });
    }
  }
  return buildView(raw, ssid, dhcp, saved);
}
