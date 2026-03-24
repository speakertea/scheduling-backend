import { Pool } from "pg";

let _pool: Pool | null = null;

export function getPool(): Pool {
  if (_pool) return _pool;
  _pool = new Pool({ connectionString: process.env.DATABASE_URL });
  return _pool;
}

export async function query(sql: string, params?: any[]) {
  return getPool().query(sql, params);
}

export function generateReferralCode(): string {
  const chars = "abcdefghijklmnopqrstuvwxyz0123456789";
  let code = "";
  for (let i = 0; i < 8; i++) {
    code += chars[Math.floor(Math.random() * chars.length)];
  }
  return code;
}

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

    DO $$ BEGIN
      ALTER TABLE users ADD COLUMN IF NOT EXISTS is_admin BOOLEAN NOT NULL DEFAULT FALSE;
      ALTER TABLE users ADD COLUMN IF NOT EXISTS is_disabled BOOLEAN NOT NULL DEFAULT FALSE;
      ALTER TABLE users ADD COLUMN IF NOT EXISTS last_active_at TIMESTAMPTZ;
      ALTER TABLE users ADD COLUMN IF NOT EXISTS push_token TEXT;
      ALTER TABLE users ADD COLUMN IF NOT EXISTS username_changed_at TIMESTAMPTZ;
      ALTER TABLE users ADD COLUMN IF NOT EXISTS city TEXT;
      ALTER TABLE users ADD COLUMN IF NOT EXISTS region TEXT;
      ALTER TABLE users ADD COLUMN IF NOT EXISTS country TEXT;
      ALTER TABLE users ADD COLUMN IF NOT EXISTS latitude FLOAT;
      ALTER TABLE users ADD COLUMN IF NOT EXISTS longitude FLOAT;
      ALTER TABLE users ADD COLUMN IF NOT EXISTS last_ip TEXT;
      ALTER TABLE users ADD COLUMN IF NOT EXISTS location_updated_at TIMESTAMPTZ;
      ALTER TABLE users ADD COLUMN IF NOT EXISTS referral_code TEXT UNIQUE;
      ALTER TABLE users ADD COLUMN IF NOT EXISTS referred_by TEXT REFERENCES users(id);
    EXCEPTION WHEN OTHERS THEN NULL;
    END $$;

    DO $$ BEGIN
      ALTER TABLE users ADD CONSTRAINT users_username_unique UNIQUE (username);
    EXCEPTION WHEN duplicate_table THEN NULL;
    WHEN duplicate_object THEN NULL;
    END $$;

    CREATE TABLE IF NOT EXISTS events (
      id                  TEXT PRIMARY KEY,
      user_id             TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      title               TEXT NOT NULL,
      type                TEXT NOT NULL CHECK(type IN ('study','meetup','class')),
      start_at            TEXT NOT NULL,
      end_at              TEXT NOT NULL,
      location            TEXT,
      notes               TEXT,
      notified            BOOLEAN NOT NULL DEFAULT FALSE,
      recurrence_rule     TEXT,
      recurrence_end_date TEXT,
      parent_event_id     TEXT,
      created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    DO $$ BEGIN
      ALTER TABLE events ADD COLUMN IF NOT EXISTS user_id TEXT;
      ALTER TABLE events ADD COLUMN IF NOT EXISTS start_at TEXT;
      ALTER TABLE events ADD COLUMN IF NOT EXISTS notified BOOLEAN NOT NULL DEFAULT FALSE;
      ALTER TABLE events ADD COLUMN IF NOT EXISTS recurrence_rule TEXT;
      ALTER TABLE events ADD COLUMN IF NOT EXISTS recurrence_end_date TEXT;
      ALTER TABLE events ADD COLUMN IF NOT EXISTS parent_event_id TEXT;
      ALTER TABLE events ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW();
      ALTER TABLE events ADD COLUMN IF NOT EXISTS source_invite_id TEXT;
    EXCEPTION WHEN OTHERS THEN NULL;
    END $$;
    DO $$ BEGIN
      IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'events' AND column_name = 'user_id') THEN
        EXECUTE 'CREATE INDEX IF NOT EXISTS idx_events_user ON events(user_id)';
      END IF;
      IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'events' AND column_name = 'user_id')
         AND EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'events' AND column_name = 'start_at') THEN
        EXECUTE 'CREATE INDEX IF NOT EXISTS idx_events_start ON events(user_id, start_at)';
      END IF;
      IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'events' AND column_name = 'user_id')
         AND EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'events' AND column_name = 'updated_at') THEN
        EXECUTE 'CREATE INDEX IF NOT EXISTS idx_events_updated ON events(user_id, updated_at)';
      END IF;
    END $$;

    CREATE TABLE IF NOT EXISTS groups_ (
      id            TEXT PRIMARY KEY,
      name          TEXT NOT NULL,
      total_members INTEGER NOT NULL,
      group_photo   TEXT NOT NULL DEFAULT ''
    );
    DO $$ BEGIN
      ALTER TABLE groups_ ADD COLUMN IF NOT EXISTS group_photo TEXT NOT NULL DEFAULT '';
    EXCEPTION WHEN OTHERS THEN NULL;
    END $$;

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
      id             TEXT PRIMARY KEY,
      thread_id      TEXT,
      user_id        TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      sender_user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
      title          TEXT NOT NULL,
      organizer      TEXT NOT NULL,
      group_name     TEXT,
      location       TEXT NOT NULL,
      start_at       TEXT NOT NULL,
      end_at         TEXT NOT NULL,
      total_invited  INTEGER NOT NULL,
      is_group       BOOLEAN NOT NULL DEFAULT FALSE,
      rsvp_status    TEXT CHECK(rsvp_status IN ('yes','maybe','no')),
      created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    DO $$ BEGIN
      ALTER TABLE invites ADD COLUMN IF NOT EXISTS user_id TEXT;
      ALTER TABLE invites ADD COLUMN IF NOT EXISTS thread_id TEXT;
      ALTER TABLE invites ADD COLUMN IF NOT EXISTS sender_user_id TEXT REFERENCES users(id) ON DELETE SET NULL;
      ALTER TABLE invites ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW();
      ALTER TABLE invites ADD COLUMN IF NOT EXISTS status TEXT DEFAULT 'active';
      ALTER TABLE invites ADD COLUMN IF NOT EXISTS notes TEXT;
      ALTER TABLE invites ADD COLUMN IF NOT EXISTS created_by TEXT;
      ALTER TABLE invites ADD COLUMN IF NOT EXISTS cancelled_at TIMESTAMPTZ;
      ALTER TABLE invites ADD COLUMN IF NOT EXISTS cancel_reason TEXT;
      ALTER TABLE invites ADD COLUMN IF NOT EXISTS last_nudge_at TIMESTAMPTZ;
      ALTER TABLE invites ADD COLUMN IF NOT EXISTS nudge_count INTEGER DEFAULT 0;
      ALTER TABLE invites ADD COLUMN IF NOT EXISTS recurrence_rule TEXT;
      ALTER TABLE invites ADD COLUMN IF NOT EXISTS recurrence_end_date TEXT;
      ALTER TABLE invites ADD COLUMN IF NOT EXISTS parent_invite_id TEXT;
      ALTER TABLE invites ADD COLUMN IF NOT EXISTS recurrence_index INTEGER DEFAULT 0;
    EXCEPTION WHEN OTHERS THEN NULL;
    END $$;
    -- Backfill created_by from sender_user_id for existing rows
    UPDATE invites SET created_by = sender_user_id WHERE created_by IS NULL AND sender_user_id IS NOT NULL;
    DO $$ BEGIN
      IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'invites' AND column_name = 'user_id')
         AND EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'invites' AND column_name = 'updated_at') THEN
        EXECUTE 'CREATE INDEX IF NOT EXISTS idx_invites_user_updated ON invites(user_id, updated_at)';
      END IF;
      IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'invites' AND column_name = 'thread_id') THEN
        EXECUTE 'CREATE INDEX IF NOT EXISTS idx_invites_thread ON invites(thread_id)';
      END IF;
    END $$;

    CREATE TABLE IF NOT EXISTS invite_attendees (
      id        SERIAL PRIMARY KEY,
      invite_id TEXT NOT NULL REFERENCES invites(id) ON DELETE CASCADE,
      user_id   TEXT REFERENCES users(id) ON DELETE SET NULL,
      name      TEXT NOT NULL,
      status    TEXT CHECK(status IN ('yes','maybe','no')),
      is_friend BOOLEAN NOT NULL DEFAULT FALSE
    );
    DO $$ BEGIN
      ALTER TABLE invite_attendees ADD COLUMN IF NOT EXISTS user_id TEXT REFERENCES users(id) ON DELETE SET NULL;
      ALTER TABLE invite_attendees ADD COLUMN IF NOT EXISTS responded_at TIMESTAMPTZ;
    EXCEPTION WHEN OTHERS THEN NULL;
    END $$;
    DO $$ BEGIN
      IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'invite_attendees' AND column_name = 'user_id') THEN
        EXECUTE 'CREATE INDEX IF NOT EXISTS idx_invite_attendees_user ON invite_attendees(user_id)';
      END IF;
    END $$;

    CREATE TABLE IF NOT EXISTS calendar_events (
      id              TEXT PRIMARY KEY,
      thread_id       TEXT,
      user_id         TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      sender_user_id  TEXT REFERENCES users(id) ON DELETE SET NULL,
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
      created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    DO $$ BEGIN
      ALTER TABLE calendar_events ADD COLUMN IF NOT EXISTS user_id TEXT;
      ALTER TABLE calendar_events ADD COLUMN IF NOT EXISTS thread_id TEXT;
      ALTER TABLE calendar_events ADD COLUMN IF NOT EXISTS sender_user_id TEXT REFERENCES users(id) ON DELETE SET NULL;
      ALTER TABLE calendar_events ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW();
    EXCEPTION WHEN OTHERS THEN NULL;
    END $$;
    DO $$ BEGIN
      IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'calendar_events' AND column_name = 'user_id')
         AND EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'calendar_events' AND column_name = 'updated_at') THEN
        EXECUTE 'CREATE INDEX IF NOT EXISTS idx_calendar_events_user_updated ON calendar_events(user_id, updated_at)';
      END IF;
      IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'calendar_events' AND column_name = 'thread_id') THEN
        EXECUTE 'CREATE INDEX IF NOT EXISTS idx_calendar_events_thread ON calendar_events(thread_id)';
      END IF;
    END $$;

    CREATE TABLE IF NOT EXISTS notification_dismissals (
      id              SERIAL PRIMARY KEY,
      user_id         TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      notification_id TEXT NOT NULL,
      dismissed_date  TEXT NOT NULL,
      type            TEXT NOT NULL CHECK(type IN ('general','invite')),
      UNIQUE(user_id, notification_id, type)
    );

    CREATE TABLE IF NOT EXISTS verification_codes (
      id            SERIAL PRIMARY KEY,
      email         TEXT NOT NULL,
      code          TEXT NOT NULL,
      username      TEXT,
      name          TEXT,
      password_hash TEXT NOT NULL,
      expires_at    TIMESTAMPTZ NOT NULL,
      used          BOOLEAN NOT NULL DEFAULT FALSE,
      created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_verification_email ON verification_codes(email, code);

    DO $$ BEGIN
      ALTER TABLE verification_codes ADD COLUMN IF NOT EXISTS username TEXT;
    EXCEPTION WHEN OTHERS THEN NULL;
    END $$;

    CREATE TABLE IF NOT EXISTS refresh_sessions (
      id         TEXT PRIMARY KEY,
      user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      token_hash TEXT NOT NULL UNIQUE,
      expires_at TIMESTAMPTZ NOT NULL,
      revoked_at TIMESTAMPTZ,
      replaced_by TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    DO $$ BEGIN
      IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'refresh_sessions' AND column_name = 'user_id') THEN
        EXECUTE 'CREATE INDEX IF NOT EXISTS idx_refresh_sessions_user ON refresh_sessions(user_id)';
      END IF;
      IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'refresh_sessions' AND column_name = 'expires_at') THEN
        EXECUTE 'CREATE INDEX IF NOT EXISTS idx_refresh_sessions_expires ON refresh_sessions(expires_at)';
      END IF;
    END $$;

    CREATE TABLE IF NOT EXISTS deleted_entities (
      id          SERIAL PRIMARY KEY,
      user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      entity_type TEXT NOT NULL CHECK(entity_type IN ('event','invite','calendar_event')),
      entity_id   TEXT NOT NULL,
      payload_json TEXT,
      deleted_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    DO $$ BEGIN
      IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'deleted_entities' AND column_name = 'user_id')
         AND EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'deleted_entities' AND column_name = 'deleted_at') THEN
        EXECUTE 'CREATE INDEX IF NOT EXISTS idx_deleted_entities_user_deleted ON deleted_entities(user_id, deleted_at)';
      END IF;
    END $$;

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
    DO $$ BEGIN
      IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'friend_connections' AND column_name = 'user_id') THEN
        EXECUTE 'CREATE INDEX IF NOT EXISTS idx_friend_conn_user ON friend_connections(user_id)';
      END IF;
    END $$;

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

    CREATE TABLE IF NOT EXISTS sponsored_events (
      id                TEXT PRIMARY KEY,
      title             TEXT NOT NULL,
      description       TEXT,
      sponsor_name      TEXT,
      location          TEXT,
      event_url         TEXT,
      start_at          TEXT NOT NULL,
      end_at            TEXT NOT NULL,
      target_cities     TEXT[],
      target_regions    TEXT[],
      target_all        BOOLEAN NOT NULL DEFAULT FALSE,
      status            TEXT NOT NULL CHECK(status IN ('draft','scheduled','sent','cancelled')) DEFAULT 'draft',
      scheduled_send_at TIMESTAMPTZ,
      sent_at           TIMESTAMPTZ,
      total_targeted    INTEGER NOT NULL DEFAULT 0,
      total_sent        INTEGER NOT NULL DEFAULT 0,
      total_opened      INTEGER NOT NULL DEFAULT 0,
      total_rsvp        INTEGER NOT NULL DEFAULT 0,
      created_by        TEXT NOT NULL REFERENCES users(id),
      created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_sponsored_status ON sponsored_events(status);

    CREATE TABLE IF NOT EXISTS sponsored_event_rsvps (
      id                 TEXT PRIMARY KEY,
      sponsored_event_id TEXT NOT NULL REFERENCES sponsored_events(id) ON DELETE CASCADE,
      user_id            TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      rsvp_status        TEXT NOT NULL CHECK(rsvp_status IN ('going','interested','not_going')) DEFAULT 'interested',
      created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE(sponsored_event_id, user_id)
    );

    CREATE TABLE IF NOT EXISTS group_invite_links (
      id         TEXT PRIMARY KEY,
      group_id   TEXT NOT NULL REFERENCES groups_(id) ON DELETE CASCADE,
      code       TEXT NOT NULL UNIQUE,
      created_by TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      is_active  BOOLEAN NOT NULL DEFAULT TRUE,
      expires_at TIMESTAMPTZ,
      max_uses   INTEGER,
      use_count  INTEGER NOT NULL DEFAULT 0,
      requires_approval BOOLEAN NOT NULL DEFAULT FALSE,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    DO $$ BEGIN
      ALTER TABLE group_invite_links ADD COLUMN IF NOT EXISTS expires_at TIMESTAMPTZ;
      ALTER TABLE group_invite_links ADD COLUMN IF NOT EXISTS max_uses INTEGER;
      ALTER TABLE group_invite_links ADD COLUMN IF NOT EXISTS use_count INTEGER NOT NULL DEFAULT 0;
      ALTER TABLE group_invite_links ADD COLUMN IF NOT EXISTS requires_approval BOOLEAN NOT NULL DEFAULT FALSE;
    EXCEPTION WHEN OTHERS THEN NULL;
    END $$;
    CREATE INDEX IF NOT EXISTS idx_group_invite_links_code ON group_invite_links(code);

    CREATE TABLE IF NOT EXISTS group_join_requests (
      id         TEXT PRIMARY KEY,
      group_id   TEXT NOT NULL REFERENCES groups_(id) ON DELETE CASCADE,
      user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      link_id    TEXT REFERENCES group_invite_links(id) ON DELETE SET NULL,
      status     TEXT NOT NULL CHECK(status IN ('pending','approved','declined')) DEFAULT 'pending',
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      reviewed_at TIMESTAMPTZ,
      reviewed_by TEXT REFERENCES users(id) ON DELETE SET NULL,
      UNIQUE(group_id, user_id, status)
    );
    CREATE INDEX IF NOT EXISTS idx_group_join_requests_group ON group_join_requests(group_id, status, created_at DESC);

    CREATE TABLE IF NOT EXISTS group_notification_settings (
      id         TEXT PRIMARY KEY,
      group_id   TEXT NOT NULL REFERENCES groups_(id) ON DELETE CASCADE,
      user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      level      TEXT NOT NULL CHECK(level IN ('all','highlights','mute')) DEFAULT 'all',
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE(group_id, user_id)
    );
    CREATE INDEX IF NOT EXISTS idx_group_notification_settings_user ON group_notification_settings(user_id);

    CREATE TABLE IF NOT EXISTS sponsored_event_deliveries (
      id                 TEXT PRIMARY KEY,
      sponsored_event_id TEXT NOT NULL REFERENCES sponsored_events(id) ON DELETE CASCADE,
      user_id            TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      delivered          BOOLEAN NOT NULL DEFAULT FALSE,
      opened             BOOLEAN NOT NULL DEFAULT FALSE,
      delivered_at       TIMESTAMPTZ,
      opened_at          TIMESTAMPTZ,
      UNIQUE(sponsored_event_id, user_id)
    );
  `);

  const { rows: usersWithoutCode } = await query("SELECT id FROM users WHERE referral_code IS NULL");
  for (const user of usersWithoutCode) {
    let code = generateReferralCode();
    while (true) {
      const { rows: clash } = await query("SELECT id FROM users WHERE referral_code = $1", [code]);
      if (clash.length === 0) break;
      code = generateReferralCode();
    }
    await query("UPDATE users SET referral_code = $1 WHERE id = $2", [code, user.id]);
  }
}

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

export async function updateUserLocation(userId: string, geo: { city: string | null; region: string | null; country: string | null; latitude: number | null; longitude: number | null }, ip: string) {
  await query(
    "UPDATE users SET city=$1, region=$2, country=$3, latitude=$4, longitude=$5, last_ip=$6, location_updated_at=NOW() WHERE id=$7",
    [geo.city, geo.region, geo.country, geo.latitude, geo.longitude, ip, userId]
  );
}

export async function logApiRequest(method: string, path: string, statusCode: number, responseMs: number, userId?: string) {
  await query(
    "INSERT INTO api_request_logs (method, path, status_code, response_ms, user_id) VALUES ($1,$2,$3,$4,$5)",
    [method, path, statusCode, responseMs, userId || null]
  );
}
