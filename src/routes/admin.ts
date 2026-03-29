import { Elysia, t } from "elysia";
import { query, logAudit } from "../db";
import { adminGuard } from "./admin-guard";
import { sendSponsoredEvent } from "../sponsored-send";
import { Resend } from "resend";
import { revokeAllSessionsForUser } from "../session";
import { disconnectUser } from "../broadcast";

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
    await query("UPDATE users SET is_disabled = TRUE, token_version = token_version + 1 WHERE id = $1", [params.id]);
    await revokeAllSessionsForUser(params.id);
    disconnectUser(params.id);
    await logAudit(userId!, "disable_user", params.id);
    return { success: true };
  })

  /* Enable user */
  .post("/users/:id/enable", async ({ params, userId }) => {
    await query("UPDATE users SET is_disabled = FALSE WHERE id = $1", [params.id]);
    await logAudit(userId!, "enable_user", params.id);
    return { success: true };
  })

  /* Trigger a reset email for the user */
  .post("/users/:id/reset-password", async ({ params, userId, set }) => {
    const { rows } = await query("SELECT email FROM users WHERE id = $1", [params.id]);
    if (rows.length === 0) { set.status = 404; return { error: "User not found" }; }

    const code = Math.floor(100000 + Math.random() * 900000).toString();
    await query("UPDATE verification_codes SET used = TRUE WHERE email = $1 AND used = FALSE AND name = '__reset__'", [rows[0].email]);
    await query(
      "INSERT INTO verification_codes (email, code, name, password_hash, expires_at) VALUES ($1, $2, '__reset__', '__reset__', NOW() + INTERVAL '10 minutes')",
      [rows[0].email, code]
    );

    try {
      const resend = new Resend(process.env.RESEND_API_KEY);
      await resend.emails.send({
        from: "Collabo <verify@collabo.cloud>",
        to: rows[0].email,
        subject: "Reset your Collabo password",
        html: `
          <div style="font-family: sans-serif; max-width: 400px; margin: 0 auto; padding: 24px;">
            <h2 style="color: #0f172a; margin-bottom: 8px;">Reset your password</h2>
            <p style="color: #475569; margin-bottom: 24px;">A Collabo admin requested a password reset for your account. Enter this code in the app to choose a new password:</p>
            <div style="background: #f1f5f9; border-radius: 12px; padding: 20px; text-align: center; margin-bottom: 24px;">
              <span style="font-size: 32px; font-weight: 800; letter-spacing: 8px; color: #0f172a;">${code}</span>
            </div>
            <p style="color: #94a3b8; font-size: 13px;">This code expires in 10 minutes.</p>
          </div>
        `,
      });
    } catch {
      set.status = 500;
      return { error: "Failed to send reset email." };
    }

    await logAudit(userId!, "reset_password", params.id, `Reset email sent to ${rows[0].email}`);
    return { success: true };
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

  /* Geography analytics */
  .get("/analytics/geography", async () => {
    const [cities, regions, countries, located, unlocated] = await Promise.all([
      query(`
        SELECT city, region, country, latitude, longitude, COUNT(*)::int as user_count
        FROM users WHERE city IS NOT NULL
        GROUP BY city, region, country, latitude, longitude
        ORDER BY user_count DESC
      `),
      query(`
        SELECT region, country, COUNT(*)::int as user_count
        FROM users WHERE region IS NOT NULL
        GROUP BY region, country
        ORDER BY user_count DESC
      `),
      query(`
        SELECT country, COUNT(*)::int as user_count
        FROM users WHERE country IS NOT NULL
        GROUP BY country
        ORDER BY user_count DESC
      `),
      query("SELECT COUNT(*)::int as c FROM users WHERE city IS NOT NULL"),
      query("SELECT COUNT(*)::int as c FROM users WHERE city IS NULL"),
    ]);

    return {
      cities: cities.rows.map((r: any) => ({
        city: r.city,
        region: r.region,
        country: r.country,
        latitude: r.latitude,
        longitude: r.longitude,
        userCount: r.user_count,
      })),
      regions: regions.rows.map((r: any) => ({
        region: r.region,
        country: r.country,
        userCount: r.user_count,
      })),
      countries: countries.rows.map((r: any) => ({
        country: r.country,
        userCount: r.user_count,
      })),
      totalLocated: located.rows[0].c,
      totalUnlocated: unlocated.rows[0].c,
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

  /* ═══════════════════════════════════════════════════════
     SPONSORED EVENTS
     ═══════════════════════════════════════════════════════ */

  /* Preview reach for a targeting config */
  .get("/sponsored-events/preview-reach", async ({ query: qs }) => {
    const cities = qs.cities ? qs.cities.split(",").map((s: string) => s.trim()).filter(Boolean) : [];
    const regions = qs.regions ? qs.regions.split(",").map((s: string) => s.trim()).filter(Boolean) : [];
    const all = qs.all === "true";

    let where = "1=1";
    const params: any[] = [];
    let idx = 1;

    if (all) {
      // no extra filter
    } else {
      const conditions: string[] = [];
      if (cities.length > 0) {
        conditions.push(`city = ANY($${idx})`);
        params.push(cities);
        idx++;
      }
      if (regions.length > 0) {
        conditions.push(`region = ANY($${idx})`);
        params.push(regions);
        idx++;
      }
      if (conditions.length === 0) {
        return { totalReach: 0, breakdown: [] };
      }
      where += ` AND (${conditions.join(" OR ")})`;
    }

    const { rows: total } = await query(`SELECT COUNT(*)::int as c FROM users WHERE ${where}`, params);
    const { rows: breakdown } = await query(
      `SELECT city, COUNT(*)::int as count FROM users WHERE ${where} AND city IS NOT NULL GROUP BY city ORDER BY count DESC`,
      params
    );

    return {
      totalReach: total[0].c,
      breakdown: breakdown.map((r: any) => ({ city: r.city, count: r.count })),
    };
  })

  /* Create sponsored event */
  .post("/sponsored-events", async ({ body, userId, set }) => {
    try {
      if (!userId) { set.status = 401; return { error: "Not authenticated" }; }
      const id = crypto.randomUUID();
      const b = body as any;
      const title = b.title;
      const description = b.description || null;
      const sponsorName = b.sponsorName || b.sponsor_name || null;
      const location = b.location || null;
      const eventUrl = b.eventUrl || b.event_url || null;
      const startAt = b.startAt || b.start_at;
      const endAt = b.endAt || b.end_at;
      const targetCities = b.targetCities || b.target_cities || [];
      const targetRegions = b.targetRegions || b.target_regions || [];
      const targetAll = b.targetAll ?? b.target_all ?? false;
      const scheduledSendAt = b.scheduledSendAt || b.scheduled_send_at || null;

      if (!title || !startAt || !endAt) {
        set.status = 400;
        return { error: "title, startAt, and endAt are required" };
      }

      const now = new Date();
      let status = "draft";
      if (scheduledSendAt && new Date(scheduledSendAt) > now) {
        status = "scheduled";
      }

      // Calculate total_targeted
      let where = "1=1";
      const params: any[] = [];
      let idx = 1;
      if (targetAll) {
        // no extra filter
      } else {
        const conditions: string[] = [];
        if (targetCities?.length > 0) {
          conditions.push(`city = ANY($${idx})`);
          params.push(targetCities);
          idx++;
        }
        if (targetRegions?.length > 0) {
          conditions.push(`region = ANY($${idx})`);
          params.push(targetRegions);
          idx++;
        }
        if (conditions.length > 0) {
          where += ` AND (${conditions.join(" OR ")})`;
        }
      }
      const { rows: countRows } = await query(`SELECT COUNT(*)::int as c FROM users WHERE ${where}`, params);
      const totalTargeted = countRows[0].c;

      await query(
        `INSERT INTO sponsored_events (id, title, description, sponsor_name, location, event_url, start_at, end_at, target_cities, target_regions, target_all, status, scheduled_send_at, total_targeted, created_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)`,
        [id, title, description, sponsorName, location, eventUrl, startAt, endAt,
         targetCities, targetRegions, targetAll, status, scheduledSendAt, totalTargeted, userId]
      );

      await logAudit(userId!, "create_sponsored_event", id, `"${title}" targeting ${totalTargeted} users`);

      set.status = 201;
      return { id, status, totalTargeted };
    } catch (err: any) {
      console.error("[sponsored-create]", err);
      set.status = 500;
      return { error: err.message || "Internal server error" };
    }
  })

  /* List sponsored events */
  .get("/sponsored-events", async () => {
    const { rows } = await query(`
      SELECT se.*,
        (SELECT COUNT(*)::int FROM sponsored_event_rsvps WHERE sponsored_event_id = se.id AND rsvp_status = 'going') as going_count,
        (SELECT COUNT(*)::int FROM sponsored_event_rsvps WHERE sponsored_event_id = se.id AND rsvp_status = 'interested') as interested_count
      FROM sponsored_events se
      ORDER BY se.created_at DESC
    `);

    return {
      events: rows.map((r: any) => ({
        id: r.id,
        title: r.title,
        description: r.description,
        sponsorName: r.sponsor_name,
        location: r.location,
        eventUrl: r.event_url,
        startAt: r.start_at,
        endAt: r.end_at,
        targetCities: r.target_cities,
        targetRegions: r.target_regions,
        targetAll: r.target_all,
        status: r.status,
        scheduledSendAt: r.scheduled_send_at,
        sentAt: r.sent_at,
        totalTargeted: r.total_targeted,
        totalSent: r.total_sent,
        totalOpened: r.total_opened,
        totalRsvp: r.total_rsvp,
        goingCount: r.going_count,
        interestedCount: r.interested_count,
        createdAt: r.created_at,
      })),
    };
  })

  .get("/sponsored-events/analytics", async () => {
    const [
      summaryResult,
      trendResult,
      sponsorResult,
      campaignResult,
      geographyResult,
      statusResult,
    ] = await Promise.all([
      query(`
        SELECT
          COUNT(*)::int AS total_campaigns,
          COUNT(*) FILTER (WHERE status = 'sent')::int AS sent_campaigns,
          COUNT(*) FILTER (WHERE status = 'scheduled')::int AS scheduled_campaigns,
          COUNT(*) FILTER (WHERE status = 'draft')::int AS draft_campaigns,
          COUNT(*) FILTER (WHERE status = 'cancelled')::int AS cancelled_campaigns,
          COALESCE(SUM(total_targeted), 0)::int AS total_targeted,
          COALESCE(SUM(total_sent), 0)::int AS total_sent,
          COALESCE(SUM(total_opened), 0)::int AS total_opened,
          COALESCE(SUM(total_rsvp), 0)::int AS total_rsvp
        FROM sponsored_events
      `),
      query(`
        SELECT
          TO_CHAR(DATE_TRUNC('week', COALESCE(sent_at, created_at)), 'Mon DD') AS label,
          DATE_TRUNC('week', COALESCE(sent_at, created_at)) AS sort_date,
          COUNT(*)::int AS campaigns,
          COALESCE(SUM(total_targeted), 0)::int AS targeted,
          COALESCE(SUM(total_sent), 0)::int AS sent,
          COALESCE(SUM(total_opened), 0)::int AS opened,
          COALESCE(SUM(total_rsvp), 0)::int AS rsvp
        FROM sponsored_events
        WHERE COALESCE(sent_at, created_at) >= NOW() - INTERVAL '12 weeks'
        GROUP BY 1, 2
        ORDER BY sort_date ASC
      `),
      query(`
        SELECT
          COALESCE(NULLIF(TRIM(sponsor_name), ''), 'Collabo Direct') AS sponsor_name,
          COUNT(*)::int AS campaigns,
          COALESCE(SUM(total_sent), 0)::int AS sent,
          COALESCE(SUM(total_opened), 0)::int AS opened,
          COALESCE(SUM(total_rsvp), 0)::int AS rsvp,
          CASE WHEN COALESCE(SUM(total_sent), 0) > 0
            THEN ROUND(COALESCE(SUM(total_opened), 0)::numeric / SUM(total_sent) * 100, 1)
            ELSE 0 END AS open_rate,
          CASE WHEN COALESCE(SUM(total_sent), 0) > 0
            THEN ROUND(COALESCE(SUM(total_rsvp), 0)::numeric / SUM(total_sent) * 100, 1)
            ELSE 0 END AS rsvp_rate
        FROM sponsored_events
        GROUP BY 1
        ORDER BY sent DESC, campaigns DESC
        LIMIT 8
      `),
      query(`
        SELECT
          id,
          title,
          COALESCE(NULLIF(TRIM(sponsor_name), ''), 'Collabo Direct') AS sponsor_name,
          status,
          total_targeted,
          total_sent,
          total_opened,
          total_rsvp,
          CASE WHEN total_sent > 0 THEN ROUND(total_opened::numeric / total_sent * 100, 1) ELSE 0 END AS open_rate,
          CASE WHEN total_sent > 0 THEN ROUND(total_rsvp::numeric / total_sent * 100, 1) ELSE 0 END AS rsvp_rate
        FROM sponsored_events
        WHERE status = 'sent'
        ORDER BY rsvp_rate DESC, open_rate DESC, total_sent DESC
        LIMIT 6
      `),
      query(`
        SELECT
          COALESCE(u.city, u.region, 'Unknown') AS label,
          COUNT(*)::int AS delivered,
          COUNT(*) FILTER (WHERE sed.opened = TRUE)::int AS opened,
          COUNT(ser.id)::int AS rsvp
        FROM sponsored_event_deliveries sed
        JOIN users u ON u.id = sed.user_id
        LEFT JOIN sponsored_event_rsvps ser
          ON ser.sponsored_event_id = sed.sponsored_event_id
         AND ser.user_id = sed.user_id
         AND ser.rsvp_status IN ('going', 'interested')
        GROUP BY 1
        ORDER BY delivered DESC
        LIMIT 10
      `),
      query(`
        SELECT status, COUNT(*)::int AS count
        FROM sponsored_events
        GROUP BY status
        ORDER BY count DESC
      `),
    ]);

    const summary = summaryResult.rows[0] || {};
    const totalSent = Number(summary.total_sent || 0);
    const totalOpened = Number(summary.total_opened || 0);
    const totalRsvp = Number(summary.total_rsvp || 0);

    return {
      summary: {
        totalCampaigns: Number(summary.total_campaigns || 0),
        sentCampaigns: Number(summary.sent_campaigns || 0),
        scheduledCampaigns: Number(summary.scheduled_campaigns || 0),
        draftCampaigns: Number(summary.draft_campaigns || 0),
        cancelledCampaigns: Number(summary.cancelled_campaigns || 0),
        totalTargeted: Number(summary.total_targeted || 0),
        totalSent,
        totalOpened,
        totalRsvp,
        openRate: totalSent > 0 ? Number(((totalOpened / totalSent) * 100).toFixed(1)) : 0,
        rsvpRate: totalSent > 0 ? Number(((totalRsvp / totalSent) * 100).toFixed(1)) : 0,
        openToRsvpRate: totalOpened > 0 ? Number(((totalRsvp / totalOpened) * 100).toFixed(1)) : 0,
      },
      trends: trendResult.rows.map((row: any) => ({
        label: row.label,
        campaigns: row.campaigns,
        targeted: row.targeted,
        sent: row.sent,
        opened: row.opened,
        rsvp: row.rsvp,
      })),
      topSponsors: sponsorResult.rows.map((row: any) => ({
        sponsorName: row.sponsor_name,
        campaigns: row.campaigns,
        sent: row.sent,
        opened: row.opened,
        rsvp: row.rsvp,
        openRate: Number(row.open_rate || 0),
        rsvpRate: Number(row.rsvp_rate || 0),
      })),
      topCampaigns: campaignResult.rows.map((row: any) => ({
        id: row.id,
        title: row.title,
        sponsorName: row.sponsor_name,
        status: row.status,
        totalTargeted: row.total_targeted,
        totalSent: row.total_sent,
        totalOpened: row.total_opened,
        totalRsvp: row.total_rsvp,
        openRate: Number(row.open_rate || 0),
        rsvpRate: Number(row.rsvp_rate || 0),
      })),
      geography: geographyResult.rows.map((row: any) => ({
        label: row.label,
        delivered: row.delivered,
        opened: row.opened,
        rsvp: row.rsvp,
      })),
      statusBreakdown: statusResult.rows.map((row: any) => ({
        status: row.status,
        count: row.count,
      })),
    };
  })

  /* Sponsored event detail */
  .get("/sponsored-events/:id", async ({ params, set }) => {
    const { rows } = await query("SELECT * FROM sponsored_events WHERE id = $1", [params.id]);
    if (rows.length === 0) { set.status = 404; return { error: "Not found" }; }
    const e = rows[0];

    const [{ rows: rsvps }, { rows: deliveryStats }, { rows: cityRows }, { rows: timelineRows }] = await Promise.all([
      query(`
      SELECT rsvp_status, COUNT(*)::int as count
      FROM sponsored_event_rsvps WHERE sponsored_event_id = $1
      GROUP BY rsvp_status
    `, [params.id]),
      query(`
      SELECT COUNT(*)::int as total,
        COUNT(CASE WHEN delivered THEN 1 END)::int as delivered,
        COUNT(CASE WHEN opened THEN 1 END)::int as opened
      FROM sponsored_event_deliveries WHERE sponsored_event_id = $1
    `, [params.id]),
      query(`
      SELECT
        COALESCE(u.city, u.region, 'Unknown') AS label,
        COUNT(*)::int AS delivered,
        COUNT(*) FILTER (WHERE sed.opened = TRUE)::int AS opened,
        COUNT(ser.id)::int AS rsvp
      FROM sponsored_event_deliveries sed
      JOIN users u ON u.id = sed.user_id
      LEFT JOIN sponsored_event_rsvps ser
        ON ser.sponsored_event_id = sed.sponsored_event_id
       AND ser.user_id = sed.user_id
       AND ser.rsvp_status IN ('going', 'interested')
      WHERE sed.sponsored_event_id = $1
      GROUP BY 1
      ORDER BY delivered DESC
      LIMIT 8
    `, [params.id]),
      query(`
      SELECT
        TO_CHAR(DATE_TRUNC('day', sed.delivered_at), 'Mon DD') AS label,
        DATE_TRUNC('day', sed.delivered_at) AS sort_date,
        COUNT(*)::int AS delivered,
        COUNT(*) FILTER (WHERE sed.opened = TRUE)::int AS opened,
        COUNT(ser.id)::int AS rsvp
      FROM sponsored_event_deliveries sed
      LEFT JOIN sponsored_event_rsvps ser
        ON ser.sponsored_event_id = sed.sponsored_event_id
       AND ser.user_id = sed.user_id
       AND ser.rsvp_status IN ('going', 'interested')
      WHERE sed.sponsored_event_id = $1
      GROUP BY 1, 2
      ORDER BY sort_date ASC
    `, [params.id]),
    ]);

    const rsvpBreakdown: Record<string, number> = {};
    for (const r of rsvps) rsvpBreakdown[r.rsvp_status] = r.count;
    const delivery = (deliveryStats as any)?.rows?.[0] || { total: 0, delivered: 0, opened: 0 };

    return {
      event: {
        id: e.id, title: e.title, description: e.description,
        sponsorName: e.sponsor_name, location: e.location, eventUrl: e.event_url,
        startAt: e.start_at, endAt: e.end_at,
        targetCities: e.target_cities, targetRegions: e.target_regions, targetAll: e.target_all,
        status: e.status, scheduledSendAt: e.scheduled_send_at, sentAt: e.sent_at,
        totalTargeted: e.total_targeted, totalSent: e.total_sent,
        totalOpened: e.total_opened, totalRsvp: e.total_rsvp,
        createdAt: e.created_at,
        rsvp_going: rsvpBreakdown["going"] || 0,
        rsvp_interested: rsvpBreakdown["interested"] || 0,
        rsvp_not_going: rsvpBreakdown["not_going"] || 0,
        rsvpBreakdown,
        delivery,
        funnel: {
          targeted: e.total_targeted || 0,
          sent: e.total_sent || 0,
          opened: e.total_opened || 0,
          rsvp: e.total_rsvp || 0,
          openRate: e.total_sent > 0 ? Number(((e.total_opened / e.total_sent) * 100).toFixed(1)) : 0,
          rsvpRate: e.total_sent > 0 ? Number(((e.total_rsvp / e.total_sent) * 100).toFixed(1)) : 0,
          openToRsvpRate: e.total_opened > 0 ? Number(((e.total_rsvp / e.total_opened) * 100).toFixed(1)) : 0,
        },
        topCities: cityRows.map((row: any) => ({
          label: row.label,
          delivered: row.delivered,
          opened: row.opened,
          rsvp: row.rsvp,
        })),
        timeline: timelineRows.map((row: any) => ({
          label: row.label,
          delivered: row.delivered,
          opened: row.opened,
          rsvp: row.rsvp,
        })),
      },
    };
  })

  /* Update sponsored event (draft/scheduled only) */
  .patch("/sponsored-events/:id", async ({ params, body, set }) => {
    const { rows } = await query("SELECT status FROM sponsored_events WHERE id = $1", [params.id]);
    if (rows.length === 0) { set.status = 404; return { error: "Not found" }; }
    if (rows[0].status === "sent") { set.status = 400; return { error: "Cannot update a sent event" }; }

    const b = body as any;
    const fields: string[] = [];
    const vals: any[] = [];
    let idx = 1;

    const allowed = ["title", "description", "location", "eventUrl", "startAt", "endAt", "sponsorName", "targetAll", "scheduledSendAt"];
    const colMap: Record<string, string> = {
      title: "title", description: "description", location: "location",
      eventUrl: "event_url", startAt: "start_at", endAt: "end_at",
      sponsorName: "sponsor_name", targetAll: "target_all", scheduledSendAt: "scheduled_send_at",
    };

    for (const key of allowed) {
      if (b[key] !== undefined) {
        fields.push(`${colMap[key]} = $${idx}`);
        vals.push(b[key]);
        idx++;
      }
    }
    if (b.targetCities !== undefined) { fields.push(`target_cities = $${idx}`); vals.push(b.targetCities); idx++; }
    if (b.targetRegions !== undefined) { fields.push(`target_regions = $${idx}`); vals.push(b.targetRegions); idx++; }

    // Recalculate status
    if (b.scheduledSendAt !== undefined) {
      const sendAt = b.scheduledSendAt ? new Date(b.scheduledSendAt) : null;
      const newStatus = sendAt && sendAt > new Date() ? "scheduled" : "draft";
      fields.push(`status = $${idx}`); vals.push(newStatus); idx++;
    }

    if (fields.length === 0) return { success: true };

    vals.push(params.id);
    await query(`UPDATE sponsored_events SET ${fields.join(", ")} WHERE id = $${idx}`, vals);
    return { success: true };
  })

  /* Delete sponsored event (not sent) */
  .delete("/sponsored-events/:id", async ({ params, userId, set }) => {
    const { rows } = await query("SELECT status, title FROM sponsored_events WHERE id = $1", [params.id]);
    if (rows.length === 0) { set.status = 404; return { error: "Not found" }; }
    if (rows[0].status === "sent") { set.status = 400; return { error: "Cannot delete a sent event. Cancel it instead." }; }

    await query("DELETE FROM sponsored_events WHERE id = $1", [params.id]);
    await logAudit(userId!, "delete_sponsored_event", params.id, `Deleted "${rows[0].title}"`);
    return { success: true };
  })

  /* Send sponsored event NOW */
  .post("/sponsored-events/:id/send", async ({ params, userId, set }) => {
    const { rows } = await query("SELECT * FROM sponsored_events WHERE id = $1", [params.id]);
    if (rows.length === 0) { set.status = 404; return { error: "Not found" }; }
    if (rows[0].status === "sent") { set.status = 400; return { error: "Already sent" }; }
    if (rows[0].status === "cancelled") { set.status = 400; return { error: "Event is cancelled" }; }

    const totalSent = await sendSponsoredEvent(rows[0]);
    await logAudit(userId!, "send_sponsored_event", params.id, `Sent to ${totalSent} users`);
    return { success: true, totalSent };
  })

  /* Cancel sponsored event */
  .post("/sponsored-events/:id/cancel", async ({ params, userId, set }) => {
    const { rows } = await query("SELECT status, title FROM sponsored_events WHERE id = $1", [params.id]);
    if (rows.length === 0) { set.status = 404; return { error: "Not found" }; }

    await query("UPDATE sponsored_events SET status = 'cancelled' WHERE id = $1", [params.id]);
    await logAudit(userId!, "cancel_sponsored_event", params.id, `Cancelled "${rows[0].title}"`);
    return { success: true };
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




