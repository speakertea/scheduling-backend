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

/** Generates an 8-character lowercase alphanumeric referral code */
export function generateReferralCode(): string {
  const chars = "abcdefghijklmnopqrstuvwxyz0123456789";
  let code = "";
  for (let i = 0; i < 8; i++) {
    code += chars[Math.floor(Math.random() * chars.length)];
  }
  return code;
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
      push_token      TEXT,
      created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    -- Add columns to existing tables if they don't exist
    DO $$ BEGIN
      ALTER TABLE users ADD COLUMN IF NOT EXISTS is_admin BOOLEAN NOT NULL DEFAULT FALSE;
      ALTER TABLE users ADD COLUMN IF NOT EXISTS is_disabled BOOLEAN NOT NULL DEFAULT FALSE;
      ALTER TABLE users ADD COLUMN IF NOT EXISTS last_active_at TIMESTAMPTZ;
      ALTER TABLE users ADD COLUMN IF NOT EXISTS push_token TEXT;
    EXCEPTION WHEN OTHERS THEN NULL;
    END $$;

    DO $$ BEGIN
      ALTER TABLE users ADD COLUMN IF NOT EXISTS username_changed_at TIMESTAMPTZ;
    EXCEPTION WHEN OTHERS THEN NULL;
    END $$;

    DO $$ BEGIN
      ALTER TABLE users ADD CONSTRAINT users_username_unique UNIQUE (username);
    EXCEPTION WHEN duplicate_table THEN NULL;
    END $$;

    DO $$ BEGIN
      ALTER TABLE users ADD COLUMN IF NOT EXISTS referral_code TEXT UNIQUE;
      ALTER TABLE users ADD COLUMN IF NOT EXISTS referred_by TEXT REFERENCES users(id);
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
      notified   BOOLEAN NOT NULL DEFAULT FALSE,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_events_user ON events(user_id);
    CREATE INDEX IF NOT EXISTS idx_events_start ON events(user_id, start_at);

    DO $$ BEGIN
      ALTER TABLE events ADD COLUMN IF NOT EXISTS notified BOOLEAN NOT NULL DEFAULT FALSE;
    EXCEPTION WHEN OTHERS THEN NULL;
    END $$;

    DO $$ BEGIN
      ALTER TABLE events ADD COLUMN IF NOT EXISTS recurrence_rule TEXT;
      ALTER TABLE events ADD COLUMN IF NOT EXISTS recurrence_end_date TEXT;
      ALTER TABLE events ADD COLUMN IF NOT EXISTS parent_event_id TEXT;
    EXCEPTION WHEN OTHERS THEN NULL;
    END $$;

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

    CREATE TABLE IF NOT EXISTS friend_connections (
      id             TEXT PRIMARY KEY,
      user_id        TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      friend_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE(user_id, friend_user_id)
    );
    CREATE INDEX IF NOT EXISTS idx_friend_conn_user ON friend_connections(user_id);

    CREATE TABLE IF NOT EXISTS friend_requests (
      id           TEXT PRIMARY KEY,
      from_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      to_user_id   TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      status       TEXT NOT NULL CHECK(status IN ('pending','accepted','declined')) DEFAULT 'pending',
      created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE(from_user_id, to_user_id)
    );

    CREATE TABLE IF NOT EXISTS group_memberships (
      id        TEXT PRIMARY KEY,
      group_id  TEXT NOT NULL REFERENCES groups_(id) ON DELETE CASCADE,
      user_id   TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      role      TEXT NOT NULL CHECK(role IN ('admin','member')) DEFAULT 'member',
      joined_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE(group_id, user_id)
    );
  `);

  // Backfill referral_code for any users that don't have one yet
  const { rows: usersWithoutCode } = await query("SELECT id FROM users WHERE referral_code IS NULL");
  for (const u of usersWithoutCode) {
    let code = generateReferralCode();
    // Retry on collision
    while (true) {
      const { rows: clash } = await query("SELECT id FROM users WHERE referral_code = $1", [code]);
      if (clash.length === 0) break;
      code = generateReferralCode();
    }
    await query("UPDATE users SET referral_code = $1 WHERE id = $2", [code, u.id]);
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
