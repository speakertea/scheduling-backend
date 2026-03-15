import { Pool } from "pg";

let _pool: Pool | null = null;

export function getPool(): Pool {
  if (_pool) return _pool;
  _pool = new Pool({ connectionString: process.env.DATABASE_URL });
  return _pool;
}

/** Shorthand for a single query */
export async function query(sql: string, params?: any[]) {
  return getPool().query(sql, params);
}

/* ------------------------------------------------------------------ */
/*  Schema                                                             */
/* ------------------------------------------------------------------ */

export async function createTables() {
  await query(`
    CREATE TABLE IF NOT EXISTS users (
      id              TEXT PRIMARY KEY,
      email           TEXT UNIQUE NOT NULL,
      password_hash   TEXT NOT NULL,
      username        TEXT NOT NULL DEFAULT '@yourusername',
      name            TEXT NOT NULL DEFAULT 'Your Name',
      about_me        TEXT NOT NULL DEFAULT '',
      profile_picture TEXT NOT NULL DEFAULT '',
      is_admin        BOOLEAN NOT NULL DEFAULT FALSE,
      is_disabled     BOOLEAN NOT NULL DEFAULT FALSE,
      last_active_at  TIMESTAMPTZ,
      created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    -- Add columns to existing tables if they don't exist
    DO $$ BEGIN
      ALTER TABLE users ADD COLUMN IF NOT EXISTS is_admin BOOLEAN NOT NULL DEFAULT FALSE;
      ALTER TABLE users ADD COLUMN IF NOT EXISTS is_disabled BOOLEAN NOT NULL DEFAULT FALSE;
      ALTER TABLE users ADD COLUMN IF NOT EXISTS last_active_at TIMESTAMPTZ;
    EXCEPTION WHEN OTHERS THEN NULL;
    END $$;

    CREATE TABLE IF NOT EXISTS events (
      id         TEXT PRIMARY KEY,
      user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      title      TEXT NOT NULL,
      type       TEXT NOT NULL CHECK(type IN ('study','meetup','class')),
      start_at   TEXT NOT NULL,
      end_at     TEXT NOT NULL,
      location   TEXT,
      notes      TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_events_user ON events(user_id);
    CREATE INDEX IF NOT EXISTS idx_events_start ON events(user_id, start_at);

    CREATE TABLE IF NOT EXISTS groups_ (
      id            TEXT PRIMARY KEY,
      name          TEXT NOT NULL,
      total_members INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS group_members (
      id       TEXT PRIMARY KEY,
      group_id TEXT NOT NULL REFERENCES groups_(id) ON DELETE CASCADE,
      name     TEXT NOT NULL,
      role     TEXT NOT NULL CHECK(role IN ('admin','member'))
    );

    CREATE TABLE IF NOT EXISTS friends (
      id      TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      name    TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS invites (
      id            TEXT PRIMARY KEY,
      user_id       TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      title         TEXT NOT NULL,
      organizer     TEXT NOT NULL,
      group_name    TEXT,
      location      TEXT NOT NULL,
      start_at      TEXT NOT NULL,
      end_at        TEXT NOT NULL,
      total_invited INTEGER NOT NULL,
      is_group      BOOLEAN NOT NULL DEFAULT FALSE,
      rsvp_status   TEXT CHECK(rsvp_status IN ('yes','maybe','no')),
      created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS invite_attendees (
      id        SERIAL PRIMARY KEY,
      invite_id TEXT NOT NULL REFERENCES invites(id) ON DELETE CASCADE,
      name      TEXT NOT NULL,
      status    TEXT CHECK(status IN ('yes','maybe','no')),
      is_friend BOOLEAN NOT NULL DEFAULT FALSE
    );

    CREATE TABLE IF NOT EXISTS calendar_events (
      id              TEXT PRIMARY KEY,
      user_id         TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      title           TEXT NOT NULL,
      creator         TEXT NOT NULL,
      group_name      TEXT,
      location        TEXT NOT NULL,
      start_at        TEXT NOT NULL,
      end_at          TEXT NOT NULL,
      notes           TEXT,
      total_sent_to   INTEGER NOT NULL,
      is_group        BOOLEAN NOT NULL DEFAULT FALSE,
      accept_status   TEXT CHECK(accept_status IN ('accepted','declined')),
      reminder_times  TEXT,
      created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS notification_dismissals (
      id              SERIAL PRIMARY KEY,
      user_id         TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      notification_id TEXT NOT NULL,
      dismissed_date  TEXT NOT NULL,
      type            TEXT NOT NULL CHECK(type IN ('general','invite')),
      UNIQUE(user_id, notification_id, type)
    );

    CREATE TABLE IF NOT EXISTS verification_codes (
      id         SERIAL PRIMARY KEY,
      email      TEXT NOT NULL,
      code       TEXT NOT NULL,
      name       TEXT,
      password_hash TEXT NOT NULL,
      expires_at TIMESTAMPTZ NOT NULL,
      used       BOOLEAN NOT NULL DEFAULT FALSE,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_verification_email ON verification_codes(email, code);

    CREATE TABLE IF NOT EXISTS audit_logs (
      id         SERIAL PRIMARY KEY,
      admin_id   TEXT NOT NULL,
      action     TEXT NOT NULL,
      target_id  TEXT,
      details    TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_audit_created ON audit_logs(created_at DESC);

    CREATE TABLE IF NOT EXISTS api_request_logs (
      id            SERIAL PRIMARY KEY,
      method        TEXT NOT NULL,
      path          TEXT NOT NULL,
      status_code   INTEGER,
      response_ms   INTEGER,
      user_id       TEXT,
      created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_api_logs_created ON api_request_logs(created_at DESC);
  `);
}

/* ------------------------------------------------------------------ */
/*  Seed mock data for a new user                                      */
/* ------------------------------------------------------------------ */

export async function seedUserData(userId: string) {
  const { rows: gc } = await query("SELECT COUNT(*)::int as c FROM groups_");
  if (gc[0].c === 0) await seedGroups();

  const { rows: fc } = await query("SELECT COUNT(*)::int as c FROM friends WHERE user_id = $1", [userId]);
  if (fc[0].c === 0) await seedFriends(userId);

  const { rows: ec } = await query("SELECT COUNT(*)::int as c FROM events WHERE user_id = $1", [userId]);
  if (ec[0].c === 0) await seedEvents(userId);

  const { rows: ic } = await query("SELECT COUNT(*)::int as c FROM invites WHERE user_id = $1", [userId]);
  if (ic[0].c === 0) await seedInvites(userId);

  const { rows: cc } = await query("SELECT COUNT(*)::int as c FROM calendar_events WHERE user_id = $1", [userId]);
  if (cc[0].c === 0) await seedCalendarEvents(userId);
}

async function seedGroups() {
  const groups = [
    { id: "g1", name: "CS 201 Winter 2024", total: 24, members: [
      { id: "m1", name: "Grace Chen", role: "admin" }, { id: "m2", name: "David Kim", role: "member" },
      { id: "m3", name: "Sarah Johnson", role: "member" }, { id: "m4", name: "You", role: "member" },
      { id: "m5", name: "Emma Wilson", role: "member" }, { id: "m6", name: "Liam Chen", role: "member" },
      { id: "m7", name: "Alex Martinez", role: "member" },
    ]},
    { id: "g2", name: "Product Builders", total: 8, members: [
      { id: "m10", name: "Alex Martinez", role: "admin" }, { id: "m11", name: "Jamie Lee", role: "member" },
      { id: "m12", name: "You", role: "member" }, { id: "m13", name: "Taylor Swift", role: "member" },
    ]},
    { id: "g3", name: "Campus Study Crew", total: 12, members: [
      { id: "m20", name: "Morgan Taylor", role: "admin" }, { id: "m21", name: "Casey Brown", role: "member" },
      { id: "m22", name: "You", role: "member" }, { id: "m23", name: "Riley Davis", role: "member" },
      { id: "m24", name: "Jordan Park", role: "member" },
    ]},
    { id: "g4", name: "Weekend Meetup Circle", total: 15, members: [
      { id: "m30", name: "Marisol Garcia", role: "admin" }, { id: "m31", name: "Quinn Smith", role: "member" },
      { id: "m32", name: "You", role: "member" },
    ]},
  ];
  for (const g of groups) {
    await query("INSERT INTO groups_ (id, name, total_members) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING", [g.id, g.name, g.total]);
    for (const m of g.members) {
      await query("INSERT INTO group_members (id, group_id, name, role) VALUES ($1,$2,$3,$4) ON CONFLICT DO NOTHING", [m.id, g.id, m.name, m.role]);
    }
  }
}

async function seedFriends(userId: string) {
  const friends = ["Grace Chen", "David Kim", "Marisol Garcia", "Alex Martinez", "Taylor Swift", "Morgan Taylor"];
  for (let i = 0; i < friends.length; i++) {
    await query("INSERT INTO friends (id, user_id, name) VALUES ($1,$2,$3)", [`f${i + 1}`, userId, friends[i]]);
  }
}

async function seedEvents(userId: string) {
  const now = new Date();
  const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 15, 0);
  const todayEnd = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 16, 0);
  const tmrStart = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1, 10, 30);
  const tmrEnd = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1, 12, 0);

  await query("INSERT INTO events (id,user_id,title,type,start_at,end_at,location) VALUES ($1,$2,$3,$4,$5,$6,$7)",
    ["seed-1", userId, "CS Study Session", "study", todayStart.toISOString(), todayEnd.toISOString(), "Library"]);
  await query("INSERT INTO events (id,user_id,title,type,start_at,end_at,location) VALUES ($1,$2,$3,$4,$5,$6,$7)",
    ["seed-2", userId, "Coffee Meetup", "meetup", tmrStart.toISOString(), tmrEnd.toISOString(), null]);
}

async function seedInvites(userId: string) {
  const invites = [
    { id: "gi1", title: "CS 201 Study Session", org: "Grace Chen", group: "CS 201 Winter 2024",
      loc: "Library Room 304", start: "2026-01-05T14:00:00", end: "2026-01-05T17:00:00", total: 24, isGroup: true, rsvp: null,
      att: [{ n:"Grace Chen",s:"yes",f:true },{ n:"David Kim",s:"yes",f:true },{ n:"Sarah Johnson",s:"yes",f:false },
            { n:"Emma Wilson",s:"yes",f:false },{ n:"Alex Martinez",s:"maybe",f:true },{ n:"Jamie Lee",s:"maybe",f:false },
            { n:"Morgan Taylor",s:"no",f:true },{ n:"Casey Brown",s:null,f:false }]},
    { id: "gi2", title: "Group Project Kickoff", org: "Alex Martinez", group: "Product Builders",
      loc: "Innovation Lab", start: "2026-01-06T18:30:00", end: "2026-01-06T20:00:00", total: 8, isGroup: true, rsvp: null,
      att: [{ n:"Alex Martinez",s:"yes",f:true },{ n:"Jamie Lee",s:"yes",f:false },{ n:"Taylor Swift",s:"maybe",f:true },{ n:"Jordan Park",s:null,f:false }]},
    { id: "gi3", title: "Weekly Team Sync", org: "Morgan Taylor", group: "Campus Study Crew",
      loc: "Student Center", start: "2026-01-04T12:00:00", end: "2026-01-04T13:00:00", total: 12, isGroup: true, rsvp: "yes",
      att: [{ n:"Morgan Taylor",s:"yes",f:true },{ n:"Casey Brown",s:"yes",f:false },{ n:"Riley Davis",s:"yes",f:false },{ n:"Sam Wilson",s:"no",f:false }]},
    { id: "gi4", title: "Fall Study Wrap-Up", org: "Grace Chen", group: "CS 201 Winter 2024",
      loc: "Library Room 201", start: "2025-12-01T17:00:00", end: "2025-12-01T18:30:00", total: 24, isGroup: true, rsvp: "no",
      att: [{ n:"Grace Chen",s:"yes",f:true },{ n:"You",s:"no",f:false },{ n:"David Kim",s:"maybe",f:true }]},
    { id: "gi5", title: "Sprint Demo Night", org: "You", group: "Product Builders",
      loc: "Design Studio", start: "2026-01-12T18:00:00", end: "2026-01-12T20:00:00", total: 8, isGroup: true, rsvp: null,
      att: [{ n:"You",s:null,f:false },{ n:"Alex Martinez",s:"yes",f:true },{ n:"Jamie Lee",s:"maybe",f:false },{ n:"Taylor Swift",s:null,f:true }]},
    { id: "gi6", title: "Study Hall Planning", org: "You", group: "Campus Study Crew",
      loc: "Student Center", start: "2026-01-09T16:00:00", end: "2026-01-09T17:00:00", total: 12, isGroup: true, rsvp: null,
      att: [{ n:"You",s:null,f:false },{ n:"Morgan Taylor",s:"yes",f:true },{ n:"Riley Davis",s:"maybe",f:false }]},
    { id: "fi1", title: "Sunday Brunch", org: "Marisol Garcia", group: null,
      loc: "Maple Café", start: "2026-01-05T11:00:00", end: "2026-01-05T13:00:00", total: 4, isGroup: false, rsvp: null,
      att: [{ n:"Marisol Garcia",s:"yes",f:true },{ n:"Taylor Swift",s:"yes",f:true },{ n:"David Kim",s:"maybe",f:true },{ n:"Grace Chen",s:null,f:true }]},
    { id: "fi2", title: "Coffee & Catch Up", org: "David Kim", group: null,
      loc: "Downtown Roasters", start: "2026-01-07T10:00:00", end: "2026-01-07T11:30:00", total: 3, isGroup: false, rsvp: "maybe",
      att: [{ n:"David Kim",s:"yes",f:true },{ n:"Alex Martinez",s:"yes",f:true },{ n:"Morgan Taylor",s:null,f:true }]},
    { id: "fi3", title: "Movie Night", org: "Alex Martinez", group: null,
      loc: "Downtown Cinema", start: "2025-11-20T19:00:00", end: "2025-11-20T21:30:00", total: 3, isGroup: false, rsvp: "yes",
      att: [{ n:"Alex Martinez",s:"yes",f:true },{ n:"You",s:"yes",f:false },{ n:"Taylor Swift",s:"no",f:true }]},
    { id: "fi4", title: "Rooftop Hang", org: "You", group: null,
      loc: "Skyline Terrace", start: "2026-01-11T19:30:00", end: "2026-01-11T22:00:00", total: 5, isGroup: false, rsvp: null,
      att: [{ n:"You",s:null,f:false },{ n:"Grace Chen",s:"yes",f:true },{ n:"David Kim",s:"maybe",f:true },{ n:"Alex Martinez",s:"no",f:true }]},
  ];

  for (const inv of invites) {
    await query(
      `INSERT INTO invites (id,user_id,title,organizer,group_name,location,start_at,end_at,total_invited,is_group,rsvp_status) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
      [inv.id, userId, inv.title, inv.org, inv.group, inv.loc, inv.start, inv.end, inv.total, inv.isGroup, inv.rsvp]
    );
    for (const a of inv.att) {
      await query("INSERT INTO invite_attendees (invite_id,name,status,is_friend) VALUES ($1,$2,$3,$4)", [inv.id, a.n, a.s, a.f]);
    }
  }
}

async function seedCalendarEvents(userId: string) {
  const events = [
    { id:"gc1",title:"CS 201 Midterm Exam",creator:"Sarah Johnson",group:"CS 201 Winter 2024",loc:"Engineering Building Room 201",
      start:"2026-01-15T14:00:00",end:"2026-01-15T16:00:00",notes:"Covers chapters 1-5. Bring calculator and student ID.",total:24,isGroup:true,accept:null,rem:null },
    { id:"gc2",title:"Project Proposal Due",creator:"Alex Martinez",group:"Product Builders",loc:"Submit online via Canvas",
      start:"2026-01-10T23:59:00",end:"2026-01-10T23:59:00",notes:"Final draft. Max 5 pages.",total:8,isGroup:true,accept:"accepted",rem:'["1day","1hour"]' },
    { id:"gc3",title:"Weekly Class - CS 201",creator:"Grace Chen",group:"CS 201 Winter 2024",loc:"Science Hall 105",
      start:"2026-01-07T14:00:00",end:"2026-01-07T15:30:00",notes:"Topic: Data Structures.",total:24,isGroup:true,accept:"accepted",rem:'["30min"]' },
    { id:"gc4",title:"CS 201 Review Session",creator:"Grace Chen",group:"CS 201 Winter 2024",loc:"Engineering Building Room 120",
      start:"2025-12-02T15:00:00",end:"2025-12-02T16:00:00",notes:"Practice questions.",total:24,isGroup:true,accept:"declined",rem:null },
    { id:"fc1",title:"Gym Session",creator:"David Kim",group:null,loc:"Campus Rec Center",
      start:"2026-01-08T06:00:00",end:"2026-01-08T07:30:00",notes:"Morning workout!",total:2,isGroup:false,accept:null,rem:null },
    { id:"fc2",title:"Taylor's Birthday",creator:"Marisol Garcia",group:null,loc:"All day",
      start:"2026-01-20T00:00:00",end:"2026-01-20T23:59:00",notes:"Planning surprise party.",total:5,isGroup:false,accept:"accepted",rem:'["1week","1day"]' },
    { id:"fc3",title:"Coffee Catch Up",creator:"Marisol Garcia",group:null,loc:"Maple Cafe",
      start:"2025-11-18T09:00:00",end:"2025-11-18T10:00:00",notes:"Catch-up after class.",total:2,isGroup:false,accept:"accepted",rem:'["1day"]' },
  ];

  for (const e of events) {
    await query(
      `INSERT INTO calendar_events (id,user_id,title,creator,group_name,location,start_at,end_at,notes,total_sent_to,is_group,accept_status,reminder_times)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
      [e.id, userId, e.title, e.creator, e.group, e.loc, e.start, e.end, e.notes, e.total, e.isGroup, e.accept, e.rem]
    );
  }
}

/* ------------------------------------------------------------------ */
/*  Admin utilities                                                    */
/* ------------------------------------------------------------------ */

export async function logAudit(adminId: string, action: string, targetId?: string, details?: string) {
  await query(
    "INSERT INTO audit_logs (admin_id, action, target_id, details) VALUES ($1,$2,$3,$4)",
    [adminId, action, targetId || null, details || null]
  );
}

export async function updateLastActive(userId: string) {
  await query("UPDATE users SET last_active_at = NOW() WHERE id = $1", [userId]);
}

export async function makeAdmin(email: string) {
  const result = await query("UPDATE users SET is_admin = TRUE WHERE email = $1", [email.toLowerCase().trim()]);
  return (result.rowCount ?? 0) > 0;
}

export async function logApiRequest(method: string, path: string, statusCode: number, responseMs: number, userId?: string) {
  await query(
    "INSERT INTO api_request_logs (method, path, status_code, response_ms, user_id) VALUES ($1,$2,$3,$4,$5)",
    [method, path, statusCode, responseMs, userId || null]
  );
}
