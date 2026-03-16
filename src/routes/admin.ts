import { Elysia, t } from "elysia";
import bcrypt from "bcryptjs";
import { query, logAudit } from "../db";
import { adminGuard } from "./admin-guard";

export const adminRoutes = new Elysia({ prefix: "/admin" })
  .use(adminGuard)

  /* ═══════════════════════════════════════════════════════
     TIER 1: Overview & User Management
     ═══════════════════════════════════════════════════════ */

  /* Live stats cards */
  .get("/stats", async () => {
    const [totalUsers, totalEvents, newToday, newWeek, newMonth, activeWeek] = await Promise.all([
      query("SELECT COUNT(*)::int as c FROM users"),
      query("SELECT COUNT(*)::int as c FROM events"),
      query("SELECT COUNT(*)::int as c FROM users WHERE created_at >= NOW() - INTERVAL '1 day'"),
      query("SELECT COUNT(*)::int as c FROM users WHERE created_at >= NOW() - INTERVAL '7 days'"),
      query("SELECT COUNT(*)::int as c FROM users WHERE created_at >= NOW() - INTERVAL '30 days'"),
      query("SELECT COUNT(*)::int as c FROM users WHERE last_active_at >= NOW() - INTERVAL '7 days'"),
    ]);

    return {
      totalUsers: totalUsers.rows[0].c,
      totalEvents: totalEvents.rows[0].c,
      newUsersToday: newToday.rows[0].c,
      newUsersThisWeek: newWeek.rows[0].c,
      newUsersThisMonth: newMonth.rows[0].c,
      activeUsersThisWeek: activeWeek.rows[0].c,
    };
  })

  /* List all users */
  .get("/users", async ({ query: qs }) => {
    const page = parseInt(qs.page || "1");
    const limit = parseInt(qs.limit || "50");
    const search = qs.search || "";
    const offset = (page - 1) * limit;

    let where = "WHERE 1=1";
    const params: any[] = [];
    let idx = 1;

    if (search) {
      where += ` AND (LOWER(email) LIKE $${idx} OR LOWER(name) LIKE $${idx} OR LOWER(username) LIKE $${idx})`;
      params.push(`%${search.toLowerCase()}%`);
      idx++;
    }

    const countResult = await query(`SELECT COUNT(*)::int as c FROM users ${where}`, params);
    const total = countResult.rows[0].c;

    const usersResult = await query(
      `SELECT u.id, u.email, u.username, u.name, u.profile_picture, u.is_admin, u.is_disabled, u.last_active_at, u.created_at,
              (SELECT COUNT(*)::int FROM events WHERE user_id = u.id) as event_count,
              (SELECT COUNT(*)::int FROM invites WHERE user_id = u.id) as invite_count
       FROM users u ${where}
       ORDER BY u.created_at DESC
       LIMIT $${idx} OFFSET $${idx + 1}`,
      [...params, limit, offset]
    );

    return {
      users: usersResult.rows.map((u: any) => ({
        id: u.id,
        email: u.email,
        username: u.username,
        name: u.name,
        profilePicture: u.profile_picture,
        isAdmin: u.is_admin,
        isDisabled: u.is_disabled,
        lastActiveAt: u.last_active_at,
        createdAt: u.created_at,
        eventCount: u.event_count,
        inviteCount: u.invite_count,
      })),
      total,
      page,
      totalPages: Math.ceil(total / limit),
    };
  })

  /* Individual user detail */
  .get("/users/:id", async ({ params, set }) => {
    const { rows: users } = await query(
      `SELECT id, email, username, name, about_me, profile_picture, is_admin, is_disabled, last_active_at, created_at FROM users WHERE id = $1`,
      [params.id]
    );
    if (users.length === 0) { set.status = 404; return { error: "User not found" }; }
    const u = users[0];

    const [events, invites, calEvents] = await Promise.all([
      query("SELECT id, title, type, start_at, end_at, location, created_at FROM events WHERE user_id = $1 ORDER BY start_at DESC LIMIT 20", [params.id]),
      query("SELECT id, title, organizer, group_name, location, start_at, rsvp_status, is_group, created_at FROM invites WHERE user_id = $1 ORDER BY created_at DESC LIMIT 20", [params.id]),
      query("SELECT id, title, creator, group_name, location, start_at, accept_status, is_group, created_at FROM calendar_events WHERE user_id = $1 ORDER BY created_at DESC LIMIT 20", [params.id]),
    ]);

    return {
      id: u.id, email: u.email, username: u.username, name: u.name,
      aboutMe: u.about_me, profilePicture: u.profile_picture,
      isAdmin: u.is_admin, isDisabled: u.is_disabled,
      lastActiveAt: u.last_active_at, createdAt: u.created_at,
      events: events.rows,
      invites: invites.rows,
      calendarEvents: calEvents.rows,
    };
  })

  /* Disable user */
  .post("/users/:id/disable", async ({ params, userId, set }) => {
    if (params.id === userId) { set.status = 400; return { error: "Cannot disable yourself" }; }
    await query("UPDATE users SET is_disabled = TRUE WHERE id = $1", [params.id]);
    await logAudit(userId!, "disable_user", params.id);
    return { success: true };
  })

  /* Enable user */
  .post("/users/:id/enable", async ({ params, userId }) => {
    await query("UPDATE users SET is_disabled = FALSE WHERE id = $1", [params.id]);
    await logAudit(userId!, "enable_user", params.id);
    return { success: true };
  })

  /* Reset user password (sends them a temporary one via email — for now just resets to a known value) */
  .post("/users/:id/reset-password", async ({ params, userId, set }) => {
    const { rows } = await query("SELECT email FROM users WHERE id = $1", [params.id]);
    if (rows.length === 0) { set.status = 404; return { error: "User not found" }; }

    const tempPassword = crypto.randomUUID().slice(0, 12);
    const hash = bcrypt.hashSync(tempPassword, 10);
    await query("UPDATE users SET password_hash = $1 WHERE id = $2", [hash, params.id]);
    await logAudit(userId!, "reset_password", params.id, `Temp password issued`);

    return { success: true, tempPassword, email: rows[0].email };
  })

  /* Delete user and all their data */
  .delete("/users/:id", async ({ params, userId, set }) => {
    if (params.id === userId) { set.status = 400; return { error: "Cannot delete yourself" }; }
    const { rows } = await query("SELECT email FROM users WHERE id = $1", [params.id]);
    if (rows.length === 0) { set.status = 404; return { error: "User not found" }; }

    await query("DELETE FROM users WHERE id = $1", [params.id]);
    await logAudit(userId!, "delete_user", params.id, `Deleted user ${rows[0].email}`);
    return { success: true };
  })

  /* Grant admin */
  .post("/users/:id/make-admin", async ({ params, userId }) => {
    await query("UPDATE users SET is_admin = TRUE WHERE id = $1", [params.id]);
    await logAudit(userId!, "grant_admin", params.id);
    return { success: true };
  })

  /* Revoke admin */
  .post("/users/:id/revoke-admin", async ({ params, userId, set }) => {
    if (params.id === userId) { set.status = 400; return { error: "Cannot revoke your own admin" }; }
    await query("UPDATE users SET is_admin = FALSE WHERE id = $1", [params.id]);
    await logAudit(userId!, "revoke_admin", params.id);
    return { success: true };
  })

  /* ═══════════════════════════════════════════════════════
     TIER 2: Analytics & Engagement
     ═══════════════════════════════════════════════════════ */

  /* Sign-ups over time (daily for last 30 days) */
  .get("/analytics/growth", async () => {
    const { rows: signups } = await query(`
      SELECT DATE(created_at) as date, COUNT(*)::int as count
      FROM users
      WHERE created_at >= NOW() - INTERVAL '30 days'
      GROUP BY DATE(created_at)
      ORDER BY date ASC
    `);

    const { rows: dailyActive } = await query(`
      SELECT DATE(last_active_at) as date, COUNT(DISTINCT id)::int as count
      FROM users
      WHERE last_active_at >= NOW() - INTERVAL '30 days'
      GROUP BY DATE(last_active_at)
      ORDER BY date ASC
    `);

    return { signups, dailyActive };
  })

  /* Engagement metrics */
  .get("/analytics/engagement", async () => {
    const [avgEvents, eventTypes, peakHours, topUsers] = await Promise.all([
      query(`
        SELECT COALESCE(AVG(cnt), 0)::float as avg_events_per_user
        FROM (SELECT COUNT(*)::int as cnt FROM events GROUP BY user_id) sub
      `),
      query(`
        SELECT type, COUNT(*)::int as count
        FROM events
        GROUP BY type
        ORDER BY count DESC
      `),
      query(`
        SELECT EXTRACT(HOUR FROM start_at::timestamp) as hour, COUNT(*)::int as count
        FROM events
        GROUP BY hour
        ORDER BY count DESC
        LIMIT 24
      `),
      query(`
        SELECT u.id, u.name, u.email, COUNT(e.id)::int as event_count
        FROM users u
        LEFT JOIN events e ON e.user_id = u.id
        GROUP BY u.id, u.name, u.email
        ORDER BY event_count DESC
        LIMIT 10
      `),
    ]);

    return {
      avgEventsPerUser: avgEvents.rows[0]?.avg_events_per_user || 0,
      eventTypes: eventTypes.rows,
      peakHours: peakHours.rows,
      topUsers: topUsers.rows,
    };
  })

  /* Invite analytics */
  .get("/analytics/invites", async () => {
    const [rsvpRates, activeGroups, groupSizes] = await Promise.all([
      query(`
        SELECT
          COUNT(*)::int as total,
          COUNT(CASE WHEN rsvp_status = 'yes' THEN 1 END)::int as accepted,
          COUNT(CASE WHEN rsvp_status = 'maybe' THEN 1 END)::int as maybe,
          COUNT(CASE WHEN rsvp_status = 'no' THEN 1 END)::int as declined,
          COUNT(CASE WHEN rsvp_status IS NULL THEN 1 END)::int as pending
        FROM invites
      `),
      query(`
        SELECT group_name, COUNT(*)::int as invite_count
        FROM invites
        WHERE group_name IS NOT NULL
        GROUP BY group_name
        ORDER BY invite_count DESC
      `),
      query(`
        SELECT name, total_members FROM groups_ ORDER BY total_members DESC
      `),
    ]);

    return {
      rsvpRates: rsvpRates.rows[0],
      activeGroups: activeGroups.rows,
      groupSizes: groupSizes.rows,
    };
  })

  /* Referral analytics */
  .get("/analytics/referrals", async () => {
    const [topReferrersResult, totalUsersResult, totalReferredResult, totalOrganicResult] = await Promise.all([
      query(`
        SELECT u.name, u.username, u.referral_code as "referralCode", COUNT(r.id)::int as "referredCount"
        FROM users u
        LEFT JOIN users r ON r.referred_by = u.id
        GROUP BY u.id, u.name, u.username, u.referral_code
        ORDER BY "referredCount" DESC
        LIMIT 10
      `),
      query("SELECT COUNT(*)::int as c FROM users"),
      query("SELECT COUNT(*)::int as c FROM users WHERE referred_by IS NOT NULL"),
      query("SELECT COUNT(*)::int as c FROM users WHERE referred_by IS NULL"),
    ]);

    const totalUsers = totalUsersResult.rows[0].c;
    const totalReferred = totalReferredResult.rows[0].c;
    const totalOrganic = totalOrganicResult.rows[0].c;
    const referralRate = totalUsers > 0 ? totalReferred / totalUsers : 0;

    return {
      topReferrers: topReferrersResult.rows,
      totalUsers,
      totalReferred,
      totalOrganic,
      referralRate,
    };
  })

  /* ═══════════════════════════════════════════════════════
     TIER 3: System Health & Audit
     ═══════════════════════════════════════════════════════ */

  /* System health */
  .get("/system/health", async () => {
    const [dbSize, tableRows, recentErrors, avgResponse] = await Promise.all([
      query("SELECT pg_database_size(current_database())::bigint as size"),
      query(`
        SELECT relname as table_name, n_live_tup::int as row_count
        FROM pg_stat_user_tables
        ORDER BY n_live_tup DESC
      `),
      query(`
        SELECT COUNT(*)::int as count
        FROM api_request_logs
        WHERE status_code >= 500 AND created_at >= NOW() - INTERVAL '24 hours'
      `),
      query(`
        SELECT COALESCE(AVG(response_ms), 0)::int as avg_ms
        FROM api_request_logs
        WHERE created_at >= NOW() - INTERVAL '1 hour'
      `),
    ]);

    const sizeBytes = dbSize.rows[0]?.size || 0;
    const sizeMB = (Number(sizeBytes) / (1024 * 1024)).toFixed(2);

    return {
      databaseSizeMB: sizeMB,
      tableRows: tableRows.rows,
      errorsLast24h: recentErrors.rows[0]?.count || 0,
      avgResponseMsLastHour: avgResponse.rows[0]?.avg_ms || 0,
    };
  })

  /* API request logs */
  .get("/system/requests", async ({ query: qs }) => {
    const limit = parseInt(qs.limit || "100");
    const { rows } = await query(
      "SELECT method, path, status_code, response_ms, user_id, created_at FROM api_request_logs ORDER BY created_at DESC LIMIT $1",
      [limit]
    );
    return rows;
  })

  /* Audit log */
  .get("/audit-log", async ({ query: qs }) => {
    const page = parseInt(qs.page || "1");
    const limit = parseInt(qs.limit || "50");
    const offset = (page - 1) * limit;

    const { rows: total } = await query("SELECT COUNT(*)::int as c FROM audit_logs");
    const { rows } = await query(`
      SELECT a.id, a.action, a.target_id, a.details, a.created_at,
             u.email as admin_email, u.name as admin_name
      FROM audit_logs a
      LEFT JOIN users u ON u.id = a.admin_id
      ORDER BY a.created_at DESC
      LIMIT $1 OFFSET $2
    `, [limit, offset]);

    return {
      logs: rows,
      total: total[0].c,
      page,
      totalPages: Math.ceil(total[0].c / limit),
    };
  });
