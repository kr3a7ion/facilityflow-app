import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import forge from 'node-forge';

/**
 * A certificate for a building with no internet.
 *
 * The LAN is served over plain HTTP, and that one fact decides a surprising amount: a
 * browser only treats a page as a *secure context* over HTTPS, and without a secure
 * context there are no service workers, no background notifications, and no camera API.
 * It is why the phone app had to exist at all.
 *
 * There is no certificate authority to buy a certificate from for `192.168.1.50`, so the
 * property becomes its own: a root generated once on the host PC, installed on the
 * department's phones and computers, and used to sign a certificate for the addresses this
 * PC actually answers on. Those devices then get a real padlock; anybody else gets a
 * warning, which is correct — they have no reason to trust this building's root.
 *
 * Generated in pure JavaScript rather than by shelling out to `openssl`, because the host
 * is a Windows PC in a plant room and openssl is not on it.
 */

export interface CertPaths {
  dir: string;
  caCert: string;
  caKey: string;
  hostCert: string;
  hostKey: string;
}

export function certPaths(dataDir: string): CertPaths {
  const dir = path.join(dataDir, 'tls');
  return {
    dir,
    caCert: path.join(dir, 'ca.crt'),
    caKey: path.join(dir, 'ca.key'),
    hostCert: path.join(dir, 'host.crt'),
    hostKey: path.join(dir, 'host.key'),
  };
}

/**
 * 397 days.
 *
 * Apple enforces a 398-day maximum on certificate lifetime — on iPhones, for privately
 * installed roots too — and a certificate that Safari silently refuses is worse than no
 * certificate at all, because nobody can tell why. Renewed automatically well before it
 * runs out, so the department never meets this number.
 */
const HOST_DAYS = 397;
const CA_YEARS = 10;
/** Renew when less than this is left, so a yearly expiry is never a morning emergency. */
const RENEW_WITHIN_DAYS = 45;

function days(n: number): number { return n * 24 * 60 * 60 * 1000; }

function serial(): string {
  // Positive, and random enough that two hosts never collide.
  return '00' + crypto.randomBytes(16).toString('hex');
}

function isIpv4(s: string): boolean {
  return /^\d{1,3}(\.\d{1,3}){3}$/.test(s);
}

function makeCa(propertyName: string): { certPem: string; keyPem: string } {
  const keys = forge.pki.rsa.generateKeyPair(2048);
  const cert = forge.pki.createCertificate();
  cert.publicKey = keys.publicKey;
  cert.serialNumber = serial();
  cert.validity.notBefore = new Date(Date.now() - days(1));
  cert.validity.notAfter = new Date(Date.now() + days(365 * CA_YEARS));

  // Named for the property, because this is what somebody sees in their phone's trust
  // settings two years from now and has to recognise.
  const attrs = [
    { name: 'commonName', value: `${propertyName} Maintenance Root` },
    { name: 'organizationName', value: propertyName },
    { shortName: 'OU', value: 'FacilityFlow' },
  ];
  cert.setSubject(attrs);
  cert.setIssuer(attrs);
  cert.setExtensions([
    { name: 'basicConstraints', cA: true, critical: true },
    { name: 'keyUsage', keyCertSign: true, cRLSign: true, critical: true },
    { name: 'subjectKeyIdentifier' },
  ]);
  cert.sign(keys.privateKey, forge.md.sha256.create());
  return {
    certPem: forge.pki.certificateToPem(cert),
    keyPem: forge.pki.privateKeyToPem(keys.privateKey),
  };
}

function makeHostCert(
  ca: { certPem: string; keyPem: string }, propertyName: string, names: string[]
): { certPem: string; keyPem: string } {
  const caCert = forge.pki.certificateFromPem(ca.certPem);
  const caKey = forge.pki.privateKeyFromPem(ca.keyPem);

  const keys = forge.pki.rsa.generateKeyPair(2048);
  const cert = forge.pki.createCertificate();
  cert.publicKey = keys.publicKey;
  cert.serialNumber = serial();
  cert.validity.notBefore = new Date(Date.now() - days(1));
  cert.validity.notAfter = new Date(Date.now() + days(HOST_DAYS));
  cert.setSubject([{ name: 'commonName', value: names[0] ?? 'facilityflow' }]);
  cert.setIssuer(caCert.subject.attributes);

  /*
   * Every address the department might type, as a subject alternative name.
   *
   * Browsers have ignored commonName for years; a certificate without the right SAN is a
   * certificate that fails with an error about the name not matching, which reads to
   * everybody as "it is broken". IP addresses need type 7 and names type 2 — and a DHCP
   * lease change means the right set can change, which is why the caller passes them in
   * and the file is regenerated when they move.
   */
  const altNames = names.map((n) => (isIpv4(n) ? { type: 7, ip: n } : { type: 2, value: n }));
  cert.setExtensions([
    { name: 'basicConstraints', cA: false, critical: true },
    { name: 'keyUsage', digitalSignature: true, keyEncipherment: true, critical: true },
    { name: 'extKeyUsage', serverAuth: true },
    { name: 'subjectAltName', altNames },
    { name: 'authorityKeyIdentifier', keyIdentifier: caCert.generateSubjectKeyIdentifier().getBytes() },
  ]);
  cert.sign(caKey, forge.md.sha256.create());
  return {
    certPem: forge.pki.certificateToPem(cert),
    keyPem: forge.pki.privateKeyToPem(keys.privateKey),
  };
}

/** The names a certificate on disk actually covers, so a changed address is noticed. */
export function namesOf(certPem: string): string[] {
  try {
    const cert = forge.pki.certificateFromPem(certPem);
    const ext = cert.getExtension('subjectAltName') as
      { altNames?: { type: number; value?: string; ip?: string }[] } | undefined;
    return (ext?.altNames ?? []).map((a) => a.ip ?? a.value ?? '').filter(Boolean);
  } catch {
    return [];
  }
}

export function expiryOf(certPem: string): Date | null {
  try {
    return forge.pki.certificateFromPem(certPem).validity.notAfter;
  } catch {
    return null;
  }
}

export interface EnsureResult {
  paths: CertPaths;
  key: string;
  cert: string;
  caPem: string;
  /** What happened, so the boot log can say it in one line rather than being silent. */
  action: 'reused' | 'created' | 'renewed' | 'readdressed';
  expiresAt: Date;
  names: string[];
}

/**
 * Make sure there is a usable certificate, and return it.
 *
 * Four outcomes, and the host says which: it was already fine, there was nothing and one
 * was made, it was running out and was renewed, or this PC's addresses changed and it no
 * longer covered them. The last one is the common one — a DHCP lease moves and a
 * certificate for the old address fails in a way that looks like the system is broken.
 *
 * The root is only generated once and is never replaced by any of this, because replacing
 * it means walking round the building reinstalling it on every phone.
 */
export function ensureCertificates(
  dataDir: string, propertyName: string, names: string[]
): EnsureResult {
  const paths = certPaths(dataDir);
  fs.mkdirSync(paths.dir, { recursive: true });

  let ca: { certPem: string; keyPem: string };
  if (fs.existsSync(paths.caCert) && fs.existsSync(paths.caKey)) {
    ca = {
      certPem: fs.readFileSync(paths.caCert, 'utf8'),
      keyPem: fs.readFileSync(paths.caKey, 'utf8'),
    };
  } else {
    ca = makeCa(propertyName);
    fs.writeFileSync(paths.caCert, ca.certPem);
    // The private key of the thing every department phone trusts. Readable by this user
    // only, on the platforms that honour it.
    fs.writeFileSync(paths.caKey, ca.keyPem, { mode: 0o600 });
  }

  const wanted = [...new Set(names.filter(Boolean))];
  let action: EnsureResult['action'] = 'reused';

  if (fs.existsSync(paths.hostCert) && fs.existsSync(paths.hostKey)) {
    const pem = fs.readFileSync(paths.hostCert, 'utf8');
    const expires = expiryOf(pem);
    const covered = new Set(namesOf(pem));
    const missing = wanted.filter((n) => !covered.has(n));
    if (!expires || expires.getTime() - Date.now() < days(RENEW_WITHIN_DAYS)) action = 'renewed';
    else if (missing.length > 0) action = 'readdressed';
  } else {
    action = 'created';
  }

  if (action !== 'reused') {
    const host = makeHostCert(ca, propertyName, wanted);
    fs.writeFileSync(paths.hostCert, host.certPem);
    fs.writeFileSync(paths.hostKey, host.keyPem, { mode: 0o600 });
  }

  const certPem = fs.readFileSync(paths.hostCert, 'utf8');
  return {
    paths,
    cert: certPem,
    key: fs.readFileSync(paths.hostKey, 'utf8'),
    caPem: ca.certPem,
    action,
    expiresAt: expiryOf(certPem) ?? new Date(),
    names: namesOf(certPem),
  };
}

/**
 * The fingerprint of the root, in the form a phone shows when it asks you to confirm it.
 *
 * Reading six pairs of hex off a screen and matching them is the only thing standing
 * between installing the department's root and installing somebody else's.
 */
export function caFingerprint(caPem: string): string {
  const der = forge.asn1.toDer(
    forge.pki.certificateToAsn1(forge.pki.certificateFromPem(caPem))
  ).getBytes();
  const hash = crypto.createHash('sha256').update(Buffer.from(der, 'binary')).digest('hex');
  return (hash.match(/.{2}/g) ?? []).join(':').toUpperCase();
}
