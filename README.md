# FacilityFlow

Offline maintenance and facility management for a hospitality property. One database,
one host PC, browser clients on the office LAN. No internet dependency.

**Phases 0–7 complete, server and client.** Identity and permissions, places and
assets, work orders with SLA and escalation, availability-based rosters and handover,
preventive maintenance, generators and diesel reconciliation, stores, departmental
finance, safety permits and utility meters, reporting — and a React client covering
every module, served by the same process. Nothing in the system is API-only.

---

## The phone app

**[app/](app/)** is a Flutter Android app that rings a technician's phone with the screen
off — the thing a web page on an offline LAN cannot do. `app/README.md` explains why, how
to build it, and the Android battery-manager traps that will otherwise silently stop it.
The server half (pairing, device tokens, the event stream) ships here and is covered by
the smoke suite; the app itself has not been compiled.

## For the department

**[docs/OPERATING.md](docs/OPERATING.md)** is the manual for the people who use this:
the daily rhythm, and a section per role — technician, team lead, supervisor, head of
department, storekeeper, finance, requester, administrator. Hand that to the department.
This file is for whoever installs and maintains it.

## Run it

```bash
npm install          # Node 22+
npm run seed         # a whole demo property, see below
npm run build        # client then server
npm start            # http://localhost:4700 — API and UI on one address
npm run smoke        # 584 end-to-end checks against throwaway databases
```

For client work, `npm run dev` (server, port 4700) and `npm run dev:web` (Vite on
5173, proxying `/api` to it) in two terminals.

The seed builds a property you can actually demo: 30 apartments in 3 blocks, 14
assets including 3 gensets with burn profiles, 2 fuel tanks with 14 days of dips,
6 spare-part lines, 4 cost centres with budgets and a month of spend that puts diesel
over, 3 vendors and 2 AMCs, 5 PPM schedules, a live permit with a lock still on, two
incidents, a published roster with today marked, and a job board carrying a breached
P1, two jobs on hold and one awaiting verification.

Sign in as any of `admin`, `hod`, `grace` (supervisor), `musa` (team lead),
`ifeoma` (technician), `halima` (storekeeper), `finance`, `front` (requester) —
password `facilityflow-demo`. Sign in as two of them and watch the same endpoint
answer differently. **Admin** is in the sidebar under *Configuration*: users, roles,
staff, shift patterns, places, supplies and tanks, SLA targets, backups and CSV exports.

### Starting clean, with your own property

The seed is a demo, not a starting point. To run this for real:

1. Stop the server.
2. Delete the `data` folder next to `package.json`.
3. Start it again — **do not run `npm run seed`**.

With an empty database the app opens the first-run wizard instead of a login box, and you
create the property and its first administrator yourself. That wizard refuses to run a
second time, so it can never be a way to mint another admin.

It also creates one thing you would otherwise have to discover you needed: the **site**
at the root of the location tree. A job has to hang off an asset, an apartment or a
place, and a fresh database has none of any kind — so without it the first thing anybody
tries to do on a new install is the one thing they cannot. Everything below the site
(blocks, floors, the generator house, the roof plant) is typed in under Admin → Places.

## The host

### Windows — the office PC that stays on

**Double-click `FacilityFlow.cmd`.** It is a menu — install and build, start, install as a
boot service, stop, show the address to hand out, back up, change the port, run the checks
— so nobody in the department has to open PowerShell or type a command to run their own
system. It reports at the top whether the app is built, whether it is running, and whether
it starts at boot, so the state of the machine is never a guess.

It exists because the Admin screen cannot do this job: that page is served *by* the server,
so a "start" button could only ever appear when it was not needed, and changing the port
would kill the page that asked for it. Anything that has to survive the server being down
belongs on the PC, not in the browser.

The underlying script is still there for anyone who prefers it. One command, from an
**Administrator** PowerShell in this folder, after `npm install` and `npm run build`:

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\windows\install-host.ps1
```

It registers a Scheduled Task that starts the server at boot — before anyone logs in —
opens the port on the private network, starts it immediately and prints the LAN address
to hand out. A second trigger checks every five minutes and restarts the server if the
process has died, so a crash at 2pm does not take the department down until somebody
notices.

Scheduled Tasks rather than a service wrapper like NSSM: it is already on every Windows
machine, which is the point when the host has no route to the internet.

Logs land in `data\logs\host-<date>.log`. To stop it: `Stop-ScheduledTask -TaskName
FacilityFlow`. To remove it entirely, `uninstall-host.ps1` in the same folder — it takes
the task and firewall rule away and does not touch `data\`.

The watchdog also means a restore applies within five minutes without anyone touching the
host: stage it from the Admin screen, then `Stop-ScheduledTask -TaskName FacilityFlow` —
the next check brings the server back up on the restored snapshot.

Note the `.\` — PowerShell refuses to run a script from the current folder without an
explicit path, so a bare `install-host.ps1` fails with *"not recognized as the name of a
cmdlet"*. That is the shell's security default, not a problem with the file.

These scripts were written against the documented PowerShell and Scheduled Task
behaviour but have not been executed on a Windows machine — the rest of the system has
CI, this has not. Read the output on first run.

### Why there is no desktop app

There was an Electron shell here, meant to be an operator console on the host PC. It has
been deleted, and the reason is worth keeping because it will come up again.

**A GUI app only runs while somebody is logged in.** It cannot start the server before
login — and "the night shift arrives at 22:00 and the system is up, though nobody has
touched that PC since the day supervisor logged out" is the actual requirement. The
scheduled task meets it; an Electron window structurally cannot. Worse, the two would
fight: both binding port 4700, one of them silently losing.

Everything the console was scoped for now exists somewhere better:

| The console was going to show | Where it lives now |
|---|---|
| Status — port, uptime, who is on | Admin → Host PC |
| The LAN address to hand out | Admin → Host PC, with a QR code to scan |
| Backup history | Admin → Backups, plus download and restore |
| Start, stop, restart | `FacilityFlow.cmd`, options 2–4 |
| Start at boot | The scheduled task, before login, with a watchdog |

What Electron would still have added is a start button rather than a keypress — not worth
an `electron-rebuild` of `better-sqlite3` on every machine, a second install path to keep
working, and 300 lines that had never once been run.

**If this is ever sold** and a buyer should not have to install Node, the answer is
bundling Node and the built server behind an installer (Inno Setup or MSI), not Electron —
shipping a whole Chromium to run a server whose UI is already in the buyer's browser is
150–200 MB spent on nothing. Note that `better-sqlite3` is a native module, so it ships
alongside rather than embedded; that is the fiddly part of any single-file approach, and
it is a problem worth solving in front of a real buyer rather than in advance.

---

## The client

`apps/web` — React, Vite, TanStack Query. Fifteen screens: login and the first-run
wizard, overview, job board, job card, planned work, roster, power and diesel,
apartments, assets, stores, safety, costs and budget, handover, admin. Responsive down
to 390px, where the job board becomes cards, modals become bottom sheets and a tab bar
replaces the sidebar.

**Permits, handovers and job cards print.** They are documents somebody signs and carries
to the job, so there is a print stylesheet that drops the app chrome, lays the page out
for A4 in black on white, and adds the signature lines the paper copy needs. **Asset
labels** print the same way — a sheet of QR stickers, generated in the browser with no
network call, that scan straight to an asset's job history.

**Alerts make a sound.** A new notification and a newly breached P1 have deliberately
different tones, synthesised in the browser rather than shipped as audio files. It is per
device, on by default, and the speaker icon in the header turns it off — the store's
tablet wants it, the HOD's laptop in a meeting does not.

**Admin → Host PC reports the machine.** The port it is on, every address to hand out with
a QR code somebody can scan to join, whether the boot service is actually registered,
whether the firewall rule survived, uptime, how old the newest backup is, free disk. On
Windows the service and firewall answers are queried for real; anywhere else, and whenever
a query fails, it says **unknown** rather than guessing — a status screen that guesses is
worse than none, because somebody acts on it. The port can be changed there, saved for the
next start, never applied live.

**Every list screen is scoped to a month.** Jobs, spend, stock movements, permits,
incidents and the audit log all open on the current month with a stepper above them, and
the month lives in the URL so a link to August opens on August. This is not tidiness: a
property three years in has tens of thousands of rows behind those lists and the host is
one office PC. Two things are never hidden by it — **an open job and a live permit carry
over into whatever month is on screen**, because a P1 raised in July and still running is
exactly what nobody may lose sight of. `?period=strict` turns the carry-over off when you
want a genuine month-by-month report.

**The job board switches between rows and cards.** The toggle sits beside *Raise job* and
is remembered per device. Rows for a laptop and a supervisor scanning SLA; cards for a
tablet at the store counter, where P1 is a red edge you find without reading anything.

Three decisions worth knowing:

**No CSS framework.** The design system is a single hand-written stylesheet carried
over unchanged from the approved prototype, so what was signed off is what renders.
Tailwind can be added later without touching the markup.

**Fonts are bundled, not linked.** Google Fonts would look right on a developer laptop
and silently fall back to system faces on an office LAN with no route to the internet.
The three families ship with the build.

**The UI is permission-driven, not role-driven.** Every control is gated on a code from
`/api/me`, so a technician has no verify button rather than one that fails, and people
land on the first screen their role can actually open.

The server serves the built client and falls back to `index.html` for client routes,
leaving `/api/*` alone — one address for every device on the wifi.

## The rules the system actually enforces

These are the reason the software exists rather than a spreadsheet. Each has a test.

| Rule | Where |
|---|---|
| A job can only be assigned to someone **marked present today** | `services/roster.ts` · `workOrders.assign` |
| The person who **completes** a job never **verifies** it — checked in the service *and* by a table constraint | `workOrders.verify` · `0004` |
| Time **on hold is excluded from the SLA**, so a store with no filters does not become a technician's problem | `workOrders.slaState` |
| Deadlines are **computed once at creation and stored**, so editing the SLA matrix cannot rewrite history | `workOrders.create` |
| A late job **escalates on its own**: response deadline → team lead, resolve → supervisor, a P1 at twice its deadline → HOD | `services/escalation.ts` |
| PPM next-due is measured **from the due date, not the completion date**, so schedules do not drift later every cycle | `ppm.onWorkOrderVerified` |
| PPM compliance counts **work that has actually fallen due** — a job raised for next month is not a failure, an overdue one counts before anyone closes it, and nothing judged reports “—”, not 0% | `ppm.compliance` |
| Three consecutive generator runs above the deviation threshold **raise a job automatically** — injectors, air filter, fuel filter — before the set fails in an outage | `fuel.recordRun` |
| Clamp readings become a load: **√3 × V × I × PF** for a three-phase supply, computed once and **stored with the reading**, so changing a supply's nominal voltage next year cannot silently move last quarter's kW | `load.compute` · `0009` |
| Phase imbalance is the **departure from the mean** (the NEMA definition), not max-minus-min, which reads about twice as alarming and has people chasing a board that is barely off | `load.compute` |
| A **feeder never counts toward the building total** — it sits below an incomer that is already counted, and adding it counts the same amps twice | `load.loadNow` · `0009` |
| A clamp reading older than **four hours is history, not "now"** — it is shown, marked stale, and left out of the total rather than quietly passed off as the current load | `load.loadNow` |
| The recommended generator is the **smallest set that carries the load without running below a third of its rating** — every unused kVA is diesel burned making heat, and a cold diesel glazes its bores | `load.gensetOptions` |
| A three-phase supply **refuses a single-phase reading**: a load worked out from one phase is wrong by however far the board is out of balance, which is the thing worth knowing | `load.recordClamp` |
| A diesel delivery needs **two different signatures**, and received litres come from the dips, not the invoice | `fuel.recordDelivery` · `0006` |
| Dips convert through a **per-tank calibration chart**; a horizontal cylinder is not linear and treating it as linear is a standing 5–8% error | `fuel.litresFromDip` |
| Fuel variance is measured **against throughput**, not against the closing balance | `fuel.reconcile` |
| The person who **raises** a requisition, an expense or a permit never approves or issues it | `stores` · `money` · `safety` |
| Stock cannot go negative, and `current_qty` is a cache that can always be **rebuilt from the ledger** | `stores.move` · `recomputeBalances` |
| A stock count **snapshots the shelf when it opens**, posts each variance as a ledger movement rather than a silent edit, and leaves untouched lines alone so a half-finished walk writes nothing off | `stores.openCount` · `postCount` |
| A roster fill **overwrites rather than duplicates**, and a drafted week stays invisible to the team until it is published | `routes/people.ts` |
| A permit cannot close with a **live isolation point** | `routes/safety.ts` |
| A planned job cannot be **completed with critical checklist steps unrecorded**, and the refusal names them | `routes/jobs.ts` |
| An import **collapses units repeated in the pasted list** rather than dying on a unique constraint and rolling back the good rows | `routes/registry.ts` |
| `audit_log`, `work_order_events` and `stock_movements` are **append-only in the database**, enforced by triggers | `0001` · `0004` · `0007` |
| The port is **saved, never applied live** — rebinding under a running server would kill the request that asked for it and strand every other device mid-action | `routes/admin.ts` |
| A corrupt or hand-edited `host.json` is **ignored rather than fatal** — the department cannot fix JSON at 6am, and a host that will not start is the worse failure | `config.readHostFile` |
| Host status reports **unknown** rather than guessing when the boot service or firewall cannot be queried | `services/host.ts` |
| Setup creates the **site** at the root of the location tree, so the first job on a brand-new install has somewhere to land | `routes/setup.ts` |
| An applied migration that has been edited **stops the server**, rather than letting field databases diverge | `db/migrate.ts` |
| A restore is **staged and applied at boot**, never swapped under a live WAL connection, and the current database is copied out of the way first — so restoring the wrong snapshot is survivable | `db/backup.ts` · `main.ts` |
| A snapshot is **opened and integrity-checked before it can be staged**; a corrupt file is refused rather than written over a working database | `backup.stageRestore` |
| Money is **integer kobo**; a float throws | `lib/money.ts` |
| A CSV export **escapes cells beginning `=`, `+`, `-` or `@`**, so opening one in Excel cannot execute something somebody typed into a job title — and it ships a BOM and CRLF so Nigerian names and the ₦ sign survive | `lib/csv.ts` |
| An export needs `report.export` **and** the permission guarding the screen its data came from — it is never a side door around a read right | `routes/exports.ts` |
| A month is a **half-open range in the property's own timezone** — Lagos midnight, not UTC midnight, and `>= from AND < to`, because a `BETWEEN` on ISO text drops whatever was recorded in the last second of the month | `lib/time.ts` |
| An uploaded file's **declared type is not evidence** — the first bytes are checked, and SVG is not accepted at all | `services/attachments.ts` |
| Attachments **inherit the permission of what they hang off** — there is no separate "can see photos" right to drift out of step | `services/attachments.ts` |
| Resetting a password **signs that person out of every device** and forces a change | `routes/admin.ts` |
| The **administrator role cannot be edited down**, and role changes are audited with the codes before and after | `routes/admin.ts` |
| A malformed **SLA matrix is refused**, and editing it never rewrites a deadline somebody was already judged against | `routes/admin.ts` |

## Layout

```
apps/server/src
  config.ts        data dir (anchored to the repo, not the shell's cwd), port, policy
  app.ts           fastify instance, principal resolution, error shape
  main.ts          entry point; prints the LAN addresses to hand out
  smoke.ts         85 checks — schema, auth, RBAC, audit, backup and restore
  smoke.modules.ts 499 checks — every rule in the table above, through HTTP,
                   plus the payload shape each screen depends on
apps/web/src
  lib/             fetch wrapper, formatting, session context
  components/      shell, status strip, shared pieces
  pages/           login · setup · overview · jobs · job card · ppm · roster
                   power · apartments · assets · stores · safety · money
                   handover · admin
  db/
    connection.ts  pragmas that matter: foreign_keys, WAL, busy_timeout
    migrate.ts     numbered SQL, checksummed, transactional
    backup.ts      VACUUM INTO + integrity check + retention
    seed.ts        the demo property
    migrations/    0001 core · 0002 people & places · 0003 assets · 0004 work orders
                   0005 PPM · 0006 power & fuel · 0007 stores & finance · 0008 safety
  auth/            permission catalogue, argon2id, sessions, requirePermission(code)
  services/
    workOrders.ts  the lifecycle state machine and SLA
    jobs.ts        composition: verifying a PPM job advances its schedule
    escalation.ts  the sweep and in-app notifications
    ppm.ts         calendar and meter triggers, anti-drift, compliance
    fuel.ts        dip charts, deliveries, runs, engine health, reconciliation
    stores.ts      the movement ledger, issue-to-job, requisitions
    reports.ts     the KPI set
    scheduler.ts   background work, catching up on boot
  routes/          health · setup · auth · me · admin · registry · people · jobs
                   ppm · power · stores · money · safety · reports
```

## API

66 tables, 61 permission codes, 9 roles. Every route checks a permission **code**,
never a role name — "the HOD wants team leads to issue permits now" is a settings
change, not a release.

Every list that grows without limit takes **`?month=YYYY-MM`** and defaults to the
current month in the property's timezone, answering with the range it used so the screen
can label it honestly.

```
GET  /api/health                     GET  /api/me
POST /api/setup                      POST /api/auth/login | logout | password
GET  /api/locations                  POST /api/apartments/import   (dry run supported)
GET  /api/assets?tag=GEN-01          POST /api/assets/:id/reading
GET  /api/roster                     POST /api/roster/mark          (present | absent)
GET  /api/handover/draft             POST /api/handover/:id/acknowledge
GET  /api/jobs                       POST /api/jobs/:id/assign | accept | start | hold
                                          | resume | complete | verify | reopen | cancel
GET  /api/jobs/assignable            POST /api/jobs/:id/labour | parts | comment
POST /api/requests/:id/convert       POST /api/ppm/generate
GET  /api/ppm/compliance             POST /api/ppm/schedules
POST /api/fuel/tanks/:id/dip         POST /api/fuel/deliveries      (two signatures)
POST /api/gensets/runs               GET  /api/fuel/reconcile
POST /api/power/clamp                GET  /api/power/load           (which set to start)
GET  /api/power/sources              POST /api/power/sources        (incomers · CT ratios)
GET  /api/stock                      POST /api/jobs/:id/parts
POST /api/requisitions/:id/decide    POST /api/purchases | expenses
POST /api/permits/:id/issue | close  POST /api/incidents
GET  /api/reports/dashboard          POST /api/reports/escalate
```

## Environment

| Variable | Default | Notes |
|---|---|---|
| `FF_DATA_DIR` | `<repo>/data` | Database, attachments and backups |
| `FF_PORT` | `4700` | Needs one inbound firewall rule on the host |
| `FF_HOST` | `0.0.0.0` | Bind to the LAN, not just localhost |
| `FF_SESSION_DAYS` | `7` | Cookie and session lifetime |
| `FF_BACKUP_KEEP` | `14` | Snapshots retained |
| `FF_LOG_LEVEL` | `info` | Fastify log level |

`FF_PORT` beats `data/host.json` beats the default. The scheduled task sets no environment,
so on the office PC the file is what decides — which is what makes the port changeable from
a screen at all.

## Photos

Capture uses `<input type="file" accept="image/*" capture="environment">`, not
`getUserMedia`. The camera API needs a secure origin; the host is reached over plain
HTTP on a LAN address, so `getUserMedia` works on a developer laptop at `localhost`
and fails on every phone.

Photos are resized in the browser to 1600px on the long edge at JPEG 0.8 before they
are sent — roughly 250 KB instead of 4 MB. Twenty jobs a day at three shots each is
otherwise about 2 GB a month across the wifi and into every nightly backup. EXIF
orientation is honoured, so photos taken sideways do not arrive sideways.

Files live on disk under `attachments/<yyyy>/<mm>/`; only the pointer, checksum and
size live in SQLite, which is what keeps the backup fast.

## Backups, and getting back from a bad day

`data/` is the whole business record — database, photos, backups. Back that folder up and
you have backed up everything.

Snapshots are written with `VACUUM INTO`, then reopened and integrity-checked, so a
corrupt one is caught the day it happens rather than on the day it is needed. **The host
takes one a day on its own** — on boot and on the twelve-hour sweep, skipping the day if
one already exists, because an office PC switched off at night would otherwise go a week
without the timer ever firing, and because "remember to click Back up now" is not a plan
that survives a busy month. `FF_BACKUP_KEEP` decides how many are kept.

Admin → Backups lists them, and every one can be **downloaded**. Do that. A snapshot
sitting on the same disk as the database survives a mistake, but not a dead machine, a
theft or a fire — and those are the cases worth planning for.

Restoring is deliberately three steps:

1. **Stage it.** Pick a snapshot, type `RESTORE`. The file is integrity-checked, the live
   database is copied to `pre-restore-<timestamp>.db`, and the snapshot is parked as
   `restore-pending.db`. Nothing has changed yet, and it can still be cancelled.
2. **Restart the server.** Boot applies the staged file *before* anything opens the
   database — swapping a SQLite file under a live WAL connection is how one bad day
   becomes two.
3. **Check.** The old database is still in `backups/` as `pre-restore-…`. Those are never
   pruned by the retention sweep, which only touches `facilityflow-*.db`.

The whole round trip has a test: back up, change something, stage, apply the way boot
does, reopen, and confirm the change is gone.

## Next

Everything in the original brief is built and has a screen. What is left is genuinely
optional:

- **A second property.** Everything is scoped by `property_id` already, so this is a
  switcher and a seed, not a migration.
- **Scheduled exports.** The CSVs are on demand and now take a month, so "September's
  spend" is two clicks. Nobody has asked for one to land in a folder every Monday yet;
  the scheduler that takes the daily backup is where it would go.
- **Power factor by measurement.** Load is computed at the supply's assumed power factor
  — 0.8 unless somebody types otherwise, which is the number genset ratings are quoted
  against. A clamp meter that reads true PF would tighten every kW figure on the Power
  screen; the field is already on the reading and stored with it.
