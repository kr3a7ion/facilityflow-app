# FacilityFlow — how the department runs it

This is the book for the people who use FacilityFlow, not the people who install it.
It is written by role: find yours, read that section, and skim the rest so you know
what the person on the other end of a job is looking at.

If you are setting the system up for the first time, the **Start here** checklist on the
Overview screen is the shortest path — it lists what is still missing, why each one
matters, and takes you to the screen that fixes it.

---

## The idea in one page

A **job** is the unit of work. Somebody raises it, a supervisor assigns it to a person,
that person accepts it, does it, writes down what they did, and somebody else verifies
it. Every step has a name against it and a time, and none of it can be edited afterwards.

Three rules hold the whole thing up. They will occasionally be inconvenient, and each one
exists because the alternative is a system nobody can trust:

1. **You cannot verify your own work.** If you completed a job, somebody else signs it
   off. Otherwise completion figures are self-reported and mean nothing.
2. **A job can only be assigned to somebody marked present today.** That is the entire
   reason the roster exists. It stops work being assigned to people who are not there.
3. **The record is append-only.** The audit log, the stock ledger, the generator logbook
   and the job history cannot be edited or deleted by anyone, including an administrator.
   A mistake is corrected by a new entry that explains itself, not by quietly changing
   the old one.

The system runs on one PC in the office and everything else is a browser. There is no
internet involved. If the host PC is off, nothing works — which is why the **Host PC**
tab matters and why backups get taken off that machine.

### Priorities and the clock

Every job gets a priority when it is raised, and the priority sets two deadlines:

| Priority | Means | Respond within | Resolve within |
|---|---|---|---|
| **P1** | Emergency | 15 minutes | 4 hours |
| **P2** | Urgent | 1 hour | 24 hours |
| **P3** | Routine | 4 hours | 3 days |
| **P4** | Scheduled | 24 hours | 7 days |

*Respond* means somebody accepted it. *Resolve* means it was completed.

**Late jobs chase themselves.** Past the response deadline the team lead is notified; past
the resolve deadline the supervisor is; a P1 at twice its deadline goes to the head of
department. Nobody has to remember to check. Putting a job **on hold** stops the clock —
that is what hold is for, and why it asks for a reason.

These targets are not in the code. A supervisor can change them under **Admin → Settings**,
and the change applies to jobs raised afterwards, never retrospectively.

---

## Everybody, first day

1. Sign in with the username and temporary password you were given.
2. **You will be made to change the password before you can go any further.** The one you
   were given was typed by somebody else, so until you change it the log cannot honestly
   say a job was closed by you. Choose something you will actually remember — three
   unrelated words beat one word with a digit on the end.
3. On a phone, open the address in your browser and choose **Add to Home Screen**. It then
   behaves like an app: no address bar, opens straight to your jobs.
4. If the type is too small, press the **Aa** button at the top. Three sizes, remembered on
   that device. On a phone it is also in the **More** sheet.
5. The **speaker** button turns alert sounds on and off, per device.

**Technicians and team leads cannot turn their alerts off.** The control shows a small
padlock and says so. This is not distrust — being told a job is yours is part of the job,
and the alternative is a supervisor assigning a P1 at two in the morning to a phone that
was silenced last week and forgotten about. Everybody else may silence their own: a
supervisor in a meeting, a finance officer in a quiet office.

One thing worth knowing, because it catches people out: **a browser will not play any
sound until the page has been touched at least once since it loaded.** A phone that has
been in a pocket all morning is silent whatever its setting says. Tapping the screen — or
the speaker button itself — is what lets the next alert through. The bell and the job
board always show the work; only the noise depends on this.

Supervisors and above can see the state of every account under **Admin → Users → Who can
hear an alert**: who is reachable, who has switched theirs off, and whose screen has not
been touched yet. When it matters, ring them rather than trusting the chime.

### The phone app — Android only

A website cannot ring a phone that is in a pocket. There is no way around that: browsers
only allow background alerts over HTTPS, and waking a closed browser needs a push service
on the internet, which this property deliberately does not have.

**FacilityFlow Alerts** is a small Android app that does what the website cannot. It holds
a connection to the host over the office wifi and rings — through a phone set to silent,
with the screen off and the app closed — the moment a job is assigned to you. The
notification has an **Accept** button that works from the lock screen, and accepting there
is the same as accepting on the website: the ringing stops everywhere at once.

To set it up: **More → Ring my phone** on your own account, install the app, scan the
square. You never type a password into it.

Three things to know:

- **It only works on the property wifi.** Out of range, the phone is deaf.
- **Turn battery optimisation off for it when it asks**, and on a Tecno, Infinix, Xiaomi,
  Oppo or Vivo also allow it to auto-start. Those phones shut background apps down within
  hours otherwise. The app's own setup screen links straight to the right settings page.
- **iPhones cannot run it.** Apple does not allow a background connection like this
  without its own push service, which needs internet. iPhone users keep the website open
  and rely on the duty tablet, which is why the duty tablet exists.

Because a phone can always be killed by its own manufacturer, the host watches rather than
assumes: a paired phone that stops holding its connection shows as **"Phone app not
running"** on the same screen. Chase those — it is the warning that somebody is unreachable
before an outage proves it.

To change your password later: the **padlock** in the bottom-left on a computer, or
**More → Change password** on a phone. You never need to ask an administrator to reset it
unless you are locked out — and a reset hands your new password to a third person, so
changing it yourself is better.

---

## The duty screen

**More → Duty screen**, or the shield beside your name on a computer. A supervisor or team
lead can set one up; it does not need an administrator.

One screen — a tablet in the plant room, the desk PC at the front office — left signed in
and awake, that rings for **anything nobody has accepted**, whoever it belongs to.

It is not instead of anybody's phone. It is underneath it, and it exists because of three
things the phone app cannot fix:

- an **iPhone**, which cannot run the alert app at all;
- an Android handset whose manufacturer **froze the background service** despite every
  permission being granted;
- a phone **left in a van**.

### Setting one up

1. Open FacilityFlow on the tablet and sign in as the account that covers the shift.
2. **More → Duty screen**, give it a name that says where it is — *Plant room tablet* —
   and press **Use this screen**.
3. Set the tablet to never sleep, and leave it plugged in.

A strip appears along the bottom. Quiet when everything is accepted; red, and sounding,
when something has passed its response time with nobody picking it up.

**It cannot be muted while it is the duty screen.** A duty screen that can be silenced is
one that will be, and then the department believes it is covered when it is not.

### Knowing it is still alive

The screen reports itself every time it reads the board. The same dialog lists every duty
screen on the property and when each was last heard from — anything over five minutes shows
in red as **not reporting**. That is the difference between a quiet night and a tablet
somebody unplugged, and it is the whole reason the list exists.

---

## The property's own certificate

**Admin → Host PC → This property's own certificate.** Off until you turn it on.

Plain HTTP always keeps working — nothing in the building moves. Turning this on serves
**HTTPS as well**, on the next port up, using a certificate the property signs for itself.

### Why bother

A browser only treats a page as a *secure context* over HTTPS. Without one there are no
background notifications and no camera API — which is the entire reason the phone app had
to exist. There is nobody to buy a certificate from for `192.168.1.50`, so the property
becomes its own authority: one root generated on the host PC, installed on the department's
devices, signing a certificate for the addresses this PC actually answers on.

### Installing the root on a phone

1. On the device, open **http://<host address>:4700/ca.crt** and open the file it downloads.
2. **Android** asks what the certificate is for — choose *Wi-Fi* or *VPN and apps*.
3. **iPhone** needs a second step, and this is the one everybody misses:
   **Settings → General → About → Certificate Trust Settings**, and switch it on there.
   Installed is not the same as trusted.
4. **Check the fingerprint.** The Host PC screen shows the root's fingerprint; the phone
   shows one too. They must match. Installing a root is handing a key to whatever handed
   it to you — this step is what makes that safe.

### Things it handles by itself

- **The certificate expires in just under a year** — Apple refuses anything longer, even
  for a root you installed yourself — and renews automatically well before it runs out.
- **If this PC's address changes**, the old certificate no longer matches and every device
  gets a warning. Restart the host and a new one covering the new address is made. The root
  does not change, so nothing needs reinstalling on anybody's phone.

---

## Checking in when you are away

**Admin → Host PC → Checking in from outside.** Off until somebody deliberately turns it
on, and the panel records who did.

The department's whole premise is a system that needs no internet. This is the one door
through that premise, so it is worth understanding exactly what it is.

### What it does and does not do

The switch does **not** create the connection. It decides whether the system accepts
anything arriving through one. The connection itself is **cloudflared** — a free Cloudflare
program installed on the host PC as a service, which dials *out* to Cloudflare and gives
you an address that works from anywhere. No port forwarding on the building's router, no
static IP from the ISP, nothing listening on the public internet.

In front of it goes **Cloudflare Access**, with a list of the exact email addresses allowed
— a named list of people, not a whole domain. Anyone not on it never reaches the sign-in
page.

The property network is untouched by all of it. Everybody on site keeps using
`http://192.168.x.x:4700` exactly as they do now, and the department works with the
internet down.

### The rules, in the order somebody meets them

1. **The door has to be open.** A tunnel left running reaches nothing while the switch is
   off.
2. **The person has to be allowed through it** — the `remote.access` permission. As shipped
   that is the administrator, the head of department and supervisors. A technician cannot
   sign in from outside at all.
3. **Changing anything needs `remote.write` as well.** A role can be given the ability to
   look from outside without the ability to approve from outside. You chose that
   supervisors and above get both.
4. **An account still on the password it was issued cannot sign in from outside**, full
   stop. A known password and a public address is the one combination that must not exist.
   The panel names anybody in that state so it can be fixed before they travel.
5. **A remote session times out faster** than one on site — 20 minutes of doing nothing by
   default.

### What the record shows

Every action taken from outside is marked **remote** in the audit log, as is the session
itself. So "who approved this, and were they on site" is always answerable. Opening and
closing the door each get their own entry, and so does a sign-in that was refused.

---

## Importing the unit list

**Apartments → Import a unit list.** Pick the CSV or JSON file you already have. You do not
need to re-order the columns, rename them, or delete the ones the system does not want.

The system reads the header row, says which column it thinks is which, and shows you what
would land before anything is written. Correct any guess from the dropdowns and the preview
updates.

What it looks for, and the names it recognises:

| What it needs | Column names it will find on its own |
|---|---|
| **Unit number** (required) | unit_no, unit, unit number, number, no, flat, apartment, room, door no |
| **Block or building** | block, building, wing, tower, house |
| **Unit name** | name, unit name, alias, label |
| **Floor** | floor_label, floor, level, storey |
| **Bedrooms** | bedrooms, beds, bedroom, br |
| **Type** | type, unit type, category, class |

Anything else in the file — door-lock addresses, card counts, internal reference numbers —
is listed on screen as *left alone* and never read.

Two things worth knowing:

- **A unit number only has to be unique inside its block.** `004` in the main building and
  `004` in Studio A Wing are two different flats and both are imported. A system that
  insisted on one `004` per property would throw most of a real unit list away.
- **A row with no block, on a property that uses them**, is matched to the one unit that
  carries that number. If several blocks have that number there is no honest answer, so it
  is skipped and named on screen rather than guessed at.

Each unit also becomes a place, named the way people speak: **Seville (MAIN BUILDING ·
003)**. That is what a technician reads on the job card.

Re-importing the same file adds nothing and tells you how many it skipped, so there is no
harm in running it again after the list changes.

---

## Reaching people

Two controls sit in the top bar for supervisors, the head of department and the
administrator. A team lead gets the first one, for their own team.

### Ring somebody's device

The bell beside the clock. Pick a person, say why in four words, press Ring.

- Their phone and their browser sound on the **alarm volume** and keep asking until they
  answer — whatever their notification sound is set to. A person who has muted alerts has
  muted *being told about work*; they have not opted out of a supervisor trying to reach
  them.
- **You are told what it reached.** "Ringing Ifeoma on 1 device" means something sounded.
  *"Ifeoma has nothing listening right now"* means nothing did, and you should go and find
  her — that answer is the reason the feature is worth having.
- Not more than once a minute per person. A phone that can be made to ring continuously is
  a phone somebody switches off.
- Who rang whom, and whether they answered, goes in the audit log.

### The emergency alert

The red **Emergency** button. Choose what kind — fire, power, water, security, medical,
other — say what is happening in one line, and say where.

- It takes over the screen of **every person signed in and every paired phone**, sounds on
  repeat, and ignores everybody's sound setting.
- It cannot be dismissed, only **acknowledged**. "I closed it" and "I saw it" have to be
  the same action or the next part is a guess.
- **Then you get the roll call**: who has acknowledged, who has not, by name. In a real
  incident the question is never "did I send it" — it is "who has seen it".
- One live alert per category at a time, so acknowledgements cannot split between two fire
  alerts.
- It stays up until somebody **stands it down**, which is recorded with who and when. An
  alert that is never stood down is one people stop trusting.
- Nothing about it can be deleted or edited afterwards — the record survives even a
  direct change to the database.

---

## Technician

**Your screen is Jobs.** It shows what is assigned to you and nothing else.

### The loop

1. **You are told.** When a supervisor assigns you a job, the bell in the top bar gains a
   dot and — if sound is on — it chimes. A P1 sounds different from everything else, on
   purpose. Open the bell to see what arrived and tap it to go straight to the job.
2. **Accept it.** This stops the response clock. Do it when you have actually seen it, not
   at the end of the day in a batch — the time is recorded.
3. **Start it** when you begin work.
4. **Put it on hold** if you are waiting for a part, access to a room, or somebody else.
   Pick the reason. This stops the clock, which protects you: a job waiting three days for
   a part is not a job you were late on.
5. **Complete it**, and say what you did. The system will not let you finish without it.
   "Replaced the bearing and re-balanced the impeller" is a record; "fixed" is not, and in
   six months when the same fan fails again, the difference is whether anybody can tell
   it is the same fault.
6. Your supervisor verifies it. If it comes back to you, you are told why.

### On the job

- **Photos.** Take them before and after. Use the camera button on the job — on a phone it
  opens the camera directly.
- **Parts.** Issue them against the job from Stores, not from memory. The job's record is
  only true if the parts went on it. You will not see what they cost, and you do not need
  to — issuing them correctly is what makes the figure right for whoever does.
- **Labour.** Log your minutes. It is the other half of the same record.
- **When your work is signed off, you are told.** The bell says so and the chime is a
  settled one rather than the urgent one. You do not have to go and check.
- **If your device rings**, it is a person, not a job: a supervisor or your team lead
  needs you now. Press **I am here** — it stops the ringing and tells them you are coming.
- **If the red alert covers your screen**, read it and press **I have seen this**. That is
  how the supervisor knows who is accounted for. It is the one message you cannot silence,
  and the one you should never have to.
- **QR stickers.** Every asset has one. Scanning it with your phone camera opens that
  asset — its history, its manuals, the jobs raised against it before. Faster than
  searching, and it is how you find out the same pump failed twice last year.

### Generators — the daily round

Under **Power & Diesel → Generator log**. This is the hardback book by the plant-room door,
and it is the earliest warning the department gets: a set rarely fails without first
running hot, or losing oil pressure, for a week beforehand.

Once per shift, per set — **including sets that did not run**, because a flat battery, a
leak or an empty day tank is found on that round rather than during the outage:

- **Hour meter** — off the engine, not the clock.
- **Day tank** — litres, or percent if that is what the gauge shows.
- **Coolant temperature, oil pressure, battery volts** — off the panel.
- **Volts and amps on each phase, frequency, load** — while it is running under load.
- **Remarks** — the knocking, the black smoke, the smell of coolant. No gauge shows this
  and it is the most useful line in the book.

**Leave a box blank if you cannot safely read that gauge.** The system would rather have
four honest numbers than six invented ones. When you save, it tells you immediately if
anything is out of range for that set, and what to check. A reading that needs acting on
also notifies the supervisor without anybody being asked to look.

### Clamp readings

Under **Power & Diesel → Log clamp reading**. Clamp the incomer and the building's load
stops being a guess — which is what tells the department which generator to start and
whether it would run cold. Feeders are recorded for diagnosis and never added to the
building total; get that flag wrong and the load reads double.

---

## Team lead

Everything a technician does, plus:

- **Assign within your team.** Your job board shows your own work and your team's.
- **Verify your team's work** — as long as you did not complete it yourself.
- **Raise requisitions** when the store does not hold what you need. You see your own and
  what was decided about them, not the department's.
- You are the **first escalation**: when a job passes its response deadline without being
  accepted, you are the one notified.
- **You are told when your team finishes a job**, because signing it off is yours to do.

You do not see costs anywhere — not on a job, not on the shelf, not on a requisition. That
is deliberate and it is a setting, not a limit of the system: an administrator can change
it for this role under Admin → Roles.

Your job is the gap between the supervisor and the floor. If a job has been sitting
unaccepted, you will hear about it before the supervisor does — which is the point.

---

## Supervisor

You own the day. Four screens, in this order.

### 1. Morning — the roster

**Roster → mark present or absent.** Nothing else you do today works until this is done:
the assignment screen only offers people marked present. Marking somebody absent asks for
a reason, and that becomes the availability record.

The roster is availability only. It is not payroll, it does not track leave entitlement or
overtime, and it is not a clock-in device. It answers one question: *who is on the floor
right now.*

To plan ahead: **Edit** the week, fill patterns against people, then **Publish**. A drafted
week is invisible to the team — publishing is what makes it real.

### 2. Through the day — the board

**Jobs.** Priority is the left edge; the SLA column is the only thing you need to scan.
Your filters:

- **Unassigned** — work nobody owns yet. This should be empty by mid-morning.
- **Breached** — past its deadline. Each one needs a decision, not a look.
- **Awaiting verify** — somebody finished and is waiting on you.
- **On hold** — the clock is stopped. Check these daily or they become permanent.

**Assigning:** open the job, choose a person or a team. If somebody is not offered, they
are not marked present. Reassigning tells the person it left their board, so nobody keeps
working on something that moved.

**Verifying:** read what they wrote. If it is not right, send it back with a reason — they
are told exactly why, and the reopen is counted. Repeated reopens on the same asset are
a maintenance problem, not a discipline problem, and the asset history will show it.

### 3. Diesel and power

- **Deliveries need two signatures** — the person receiving and a witness. This is
  deliberate and it is not negotiable in the software.
- **Dips** — litres, or millimetres if the tank has a calibration chart.
- **Reconciliation** — opening dip, plus deliveries, minus what the sets burned, against
  the closing dip. Past the tolerance the period is flagged and somebody explains it in
  writing. This is the number that finds diesel theft.
- **Generator runs** — hours off the meter, fuel before and after. Three consecutive runs
  burning more than expected raise a PPM job automatically: injectors, air filter or fuel
  filter, before the set fails during an outage.
- **The generator log** — check at the end of each shift that every set was logged. The
  card tells you how many of how many, and flags anything out of range.

### 4. Planned work

**Planned Work.** Servicing that happens because a schedule said so, not because something
broke. This is the half of maintenance that stops the department being reactive, and the
**reactive share** on the Overview is how you prove it is working.

Checklists turn "serviced the genset" into a signed record of what was actually checked. A
failed critical item tells you it deserves a follow-up job.

### Also yours

- **Permits** — hot work, electrical isolation, work at height. Issued by you, requested by
  whoever is doing the work.
- **Handover** — the shift record, with jobs carried over.
- **Purchases** — recorded against a job number, which is what makes a job cost true.

---

## Head of department / manager

You are read-only on nearly everything operational and that is deliberate — the value of
the record is that the people doing the work maintain it. What is yours:

### The Overview, every morning

- **Open jobs** and **breaching SLA** — the health of the day.
- **PPM compliance** — planned work completed on time. Below 80% and the department is
  firefighting.
- **Reactive share** — what proportion of work was unplanned. This should fall over
  months. It is the single best measure of whether the department is getting on top of
  the estate.
- **MTTR and first-time fix** — how long jobs take, and how often they come back.
- **Cost per kWh** — what generated power actually costs, against the grid tariff. This is
  the number to take upstairs: it is the whole business case for solar, a smaller standby
  set, or a load-shedding policy, and before this system nobody in the department could
  produce it on demand.

Switch the whole dashboard between **last 30 days** and a **calendar month** with the
toggle — rolling for the morning meeting, calendar for the report you take upstairs.

### Money

**Costs & Budget.** Cost centres, a monthly budget against each, and what has been spent.
Also: contracts expiring inside 60 days, cost per apartment, and the assets costing the
most to keep. Past roughly half of replacement value, the repair-or-replace argument
writes itself.

### Approvals

Spend above the supervisor's limit comes to you, as do purchase approvals and budget
changes.

### What to ask for

The system answers these without anybody preparing anything:

- Which apartments cost us the most this year?
- Which assets are we repeatedly repairing?
- How much diesel went missing last month?
- Did the generators get logged every day?
- Who verified this job, and when?

---

## Storekeeper

**Stores.** Four movements, and every one of them is permanent:

- **Receive** — stock in, against a supplier and a document.
- **Issue** — stock out, against a job. Never against nothing.
- **Adjust** — a correction, with a reason. Visible forever.
- **Count** — freeze what the system thinks is on the shelf, then walk the store and
  record what is really there. The difference is the finding.

You cannot approve a requisition you raised yourself.

You **do** see what things cost — you have to, since receiving stock means entering a unit
price and the average cost is re-weighted from it. That is where your money access ends:
no budgets, no job costs, no expenses.

**Minimum levels** are worth setting on everything you actually keep. The Overview warns
the department when something is at or below minimum, which is how a filter stops running
out unnoticed.

---

## Finance officer

**Costs & Budget**, plus read-only on operational records so a cost can be traced to the
job it came from.

- Cost centres and monthly budgets
- Expenses — raise and approve
- Purchases against job numbers
- Vendors and contracts, with renewal dates

You can export anything you can read, as CSV, from **Admin → Exports**. An export needs
both the export permission and read access to the screen the data came from.

---

## Requester — front office, housekeeping

You have one job and one screen.

**Raise a fault the moment you see it.** A note in a book is not a job. You get a reference
number you can quote when a guest or a colleague asks, and you can see how far it has got
without ringing anybody.

You see only what you raised. You cannot assign, verify, or see costs — that is correct,
not a mistake.

---

## System administrator

Keep this to one or two people and **never use it as a daily account**. If you also work
on the floor, have a second account with your real role and use that.

**Admin** is grouped into four:

- **Start here** — the setup checklist. It reports real counts from the database, not
  ticked boxes, and only shows steps your role can act on.
- **Set up once** — Staff, Users, Roles, Places, Shifts, Supplies.
- **Settings** — SLA targets, trades, hold reasons, fuel tolerance; CSV exports.
- **The machine** — Host PC, Backups, Audit log.

### Accounts

Named accounts only. The audit log is worthless the moment three people share a username.

**Link every operational account to a person on the staff list.** A technician whose
account is not linked signs in to an empty board and assumes the system is broken — the
Users tab flags these and offers to fix them. Jobs are assigned to a *person*, not a login.

Changing somebody's role takes effect the next time they load a screen. Nobody needs to be
deleted and recreated to be promoted, and deleting would orphan every job pointing at them.

You cannot change your own role — that is how an administrator locks themselves out of the
only screen that could undo it.

### Retire or delete

Staff, Users, Roles and Places each have both.

- **Retire** (or **Disable**, for an account) is the everyday answer. The record leaves every
  list and picker, everything that refers to it keeps reading correctly, and **Show
  retired** brings it back.
- **Delete** removes the record for good, and is only for something created by mistake —
  a person typed twice, a place under the wrong block, an account nobody ever signed in
  to. If *anything* points at the record — a job, a roster day, an action in the audit log —
  the system refuses, says what is in the way, and suggests retiring instead. The roles the
  system ships with and the site itself can never be deleted.

Every deletion is in the audit log, with what the record held.

Custom roles are made under **Roles → New role**, usually by copying the role that is
nearly right and ticking what is different. Places are renamed or moved with **Edit**; a
place cannot be moved inside one of its own children.

### Roles

Nine roles, each a set of permissions you can edit. Changing a role changes what a whole
group of people can do, so it is audited with before and after. Three things to know:

- A permission can be held **narrowly** — "their own jobs", "their team's jobs" — and the
  Roles tab shows which. Ticking an extra box never widens a narrow grant.
- The administrator role always holds everything and cannot be edited.
- When you pick a role while creating an account, the box under the dropdown tells you
  what it means in practice, including whether that person will see money.

#### Who sees money

The department's rule is that costs belong to the people whose job they are. Two
permissions carry it:

| Permission | What it opens |
|---|---|
| **cost.read** | Every naira figure outside the finance screen — shelf value and average cost in Stores, estimates on requisitions, unit price on a diesel delivery, replacement value and lifetime cost on an asset, cost per kWh. |
| **requisition.read** | Requisitions. Held at **own** scope it shows the ones that person raised and what was decided; at **all** it shows the department's. |

As shipped:

| Role | Sees money | Sees requisitions |
|---|---|---|
| System administrator | yes | all |
| Head of department | yes | all |
| Supervisor | yes | all |
| Finance officer | yes | all |
| Storekeeper | yes — they type the costs in when receiving | all |
| Auditor | yes — read-only, by definition | all |
| Team lead | **no** | their own only |
| Technician | **no** | their own only |
| Requester | **no** | none |

A technician still checks whether a part is on the shelf, still reads an asset's service
history, still sees how many litres were delivered. What a thing cost is simply not in
the answer the server sends — not hidden on the screen, **absent**, so there is nothing
to find by poking at the page. The same applies to an export: a person with the export
right and no cost right downloads the same file with the money columns missing.

If the property wants it differently — a trusted team lead who orders their own spares,
say — tick **cost.read** on that role under Admin → Roles. It is a setting, not a
release.

### Host PC

- **Which network the department reaches this PC on.** A host PC is rarely on one network:
  it has a cable, wifi, and — if anybody installed VirtualBox, Docker or WSL — two or three
  adapters that look exactly like a network and reach nobody. Pick the cable if there is
  one: it keeps its address when the PC sleeps and will not roam to another access point
  overnight.
- **Ask whoever runs your network to reserve that address for this PC** before printing it
  on anything. If it is handed out by DHCP it will change, and every bookmark, home-screen
  shortcut and printed QR sticker breaks on the same morning.
- **The QR code** on that tab is what goes on the notice board.
- **Starts at boot** — until this is set up, the system only runs while somebody has a
  window open on the host PC.

### Backups

One a day, automatically, onto the same disk. **That is not a backup** — it survives a
mistake, not a dead machine, a theft or a fire. Download one to a flash drive weekly and
keep it somewhere else. The Host PC tab tells you how old the newest one is.

Restoring is staged and applied on the next restart, because swapping the database file
under a running server is not survivable.

### Audit log

Every consequential action, with who, when, and the before and after. It cannot be edited
or deleted by anyone, including you.

---

## When something goes wrong

**"My phone can't reach it."**
Check the phone is on the same network as the host PC — the Host PC tab names it. Then
check the host PC is on and the address has not changed. If the address changed, the
department needs the new one; reserve it so it stops happening.

**"It says I must change my password and I can't get past it."**
That is correct. Change it. If you have forgotten the temporary one, an administrator can
reset it.

**"I'm locked out."**
Eight wrong attempts locks an account for fifteen minutes. Wait, or ask an administrator.

**"I can't assign anybody."**
They are not marked present on today's roster. Mark them, or the roster week was never
published.

**"A technician sees nothing on their board."**
Their account is probably not linked to their staff record. **Admin → Users** flags this
and offers to link it in one click.

**"The system is gone."**
The host PC is off, asleep, or was restarted and the boot service was never set up. Check
the PC first. Nothing is lost — the database is a file on that machine, and the backups
are beside it.

---

## What this system deliberately does not do

Worth knowing so nobody waits for it:

- **No payroll, leave or overtime.** Shifts are availability only.
- **No internet.** No email, no SMS, no cloud. Notifications are in-app.
- **No guest or tenant access.** This is the maintenance department's system.
- **No editing history.** Ever, by anyone.
