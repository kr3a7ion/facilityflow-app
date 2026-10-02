-- Phones that hold the line open.
--
-- A browser cannot be woken on an offline network: service workers need a secure context
-- and web push needs a service on the internet, and this system has neither by design. A
-- native app has no such problem — it holds a socket to the host on the property wifi and
-- rings when something comes down it. That is the whole idea, and this is the server half.
--
-- Two records, kept apart on purpose.
--
-- `pairing_codes` is a short-lived scrap of paper: a code the person generates while
-- already signed in on the web, scans on their phone, and never sees again. It carries
-- identity for exactly one exchange.
--
-- `app_devices` is the lasting relationship: this phone, this person, this token. The
-- token is what the app presents afterwards, so the person never types a password into
-- the app at all and losing a phone costs one revoked row rather than a password change.

CREATE TABLE pairing_codes (
  code        TEXT PRIMARY KEY,
  property_id TEXT NOT NULL REFERENCES properties(id) ON DELETE CASCADE,
  -- Whose phone this will become. Taken from the session that asked for the code, never
  -- from the request body: a code that let you name somebody else would be a way to mint
  -- a token for their account.
  user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at  TEXT NOT NULL,
  used_at     TEXT,
  created_at  TEXT NOT NULL
);

CREATE INDEX idx_pairing_user ON pairing_codes(user_id, expires_at);

CREATE TABLE app_devices (
  id           TEXT PRIMARY KEY,
  property_id  TEXT NOT NULL REFERENCES properties(id) ON DELETE CASCADE,
  user_id      TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  -- What the person will recognise in a list when deciding which one to revoke.
  name         TEXT NOT NULL,
  platform     TEXT NOT NULL DEFAULT 'android',
  -- Stored hashed. A high-entropy random token needs no password hashing — there is
  -- nothing to brute-force — but the plain value must not sit in a file that gets copied
  -- onto a flash drive every night with the backups.
  token_hash   TEXT NOT NULL UNIQUE,
  app_version  TEXT,
  created_at   TEXT NOT NULL,
  -- Any authenticated request. Tells you the phone is alive even between connections.
  last_seen_at TEXT,
  -- Set while the app is actually holding the event stream open, cleared when it drops.
  -- This is the column that answers the question that matters: not "is the app
  -- installed" but "would this phone ring right now".
  connected_at TEXT,
  revoked_at   TEXT,
  revoked_by   TEXT REFERENCES users(id)
);

CREATE INDEX idx_app_devices_user ON app_devices(user_id, revoked_at);
CREATE INDEX idx_app_devices_property ON app_devices(property_id, connected_at);
