import { Elysia, t } from "elysia";
import { query } from "../db";
import { authGuard } from "./guard";

export const peopleRoutes = new Elysia({ prefix: "/people" })
  .use(authGuard)

  /* ──────────────────────────────────────────────
     FRIENDS
  ────────────────────────────────────────────── */

  // List friends
  .get("/friends", async ({ userId }) => {
    const { rows } = await query(
      `SELECT u.id, u.name, u.email, u.username, u.profile_picture AS "profilePicture", u.last_active_at AS "lastActiveAt"
       FROM friend_connections fc
       JOIN users u ON u.id = fc.friend_user_id
       WHERE fc.user_id = $1
       ORDER BY u.name ASC`,
      [userId]
    );
    return rows;
  })

  // Send friend request
  .post("/friends/request", async ({ userId, body, set }) => {
    const { toUsername } = body;

    // Find target user by username (case-insensitive)
    const { rows: targets } = await query(
      "SELECT id, name, username FROM users WHERE LOWER(username) = LOWER($1) AND is_disabled = FALSE",
      [toUsername]
    );
    if (targets.length === 0) {
      set.status = 404;
      return { error: "User not found." };
    }
    const target = targets[0];

    if (target.id === userId) {
      set.status = 400;
      return { error: "You cannot send a friend request to yourself." };
    }

    // Already friends (either direction)
    const { rows: existing } = await query(
      "SELECT id FROM friend_connections WHERE (user_id = $1 AND friend_user_id = $2) OR (user_id = $2 AND friend_user_id = $1)",
      [userId, target.id]
    );
    if (existing.length > 0) {
      set.status = 409;
      return { error: "You are already friends with this user." };
    }

    // Pending request already exists (either direction)
    const { rows: pending } = await query(
      "SELECT id, from_user_id FROM friend_requests WHERE ((from_user_id = $1 AND to_user_id = $2) OR (from_user_id = $2 AND to_user_id = $1)) AND status = 'pending'",
      [userId, target.id]
    );
    if (pending.length > 0) {
      set.status = 409;
      return { error: "A friend request between you and this user already exists." };
    }

    const id = crypto.randomUUID();
    await query(
      "INSERT INTO friend_requests (id, from_user_id, to_user_id) VALUES ($1, $2, $3)",
      [id, userId, target.id]
    );
    set.status = 201;
    return { id, toUser: { id: target.id, name: target.name, username: target.username } };
  }, {
    body: t.Object({ toUsername: t.String() }),
  })

  // Incoming pending requests
  .get("/friends/requests", async ({ userId }) => {
    const { rows } = await query(
      `SELECT fr.id, fr.created_at AS "createdAt",
              u.id AS "fromId", u.name AS "fromName", u.username AS "fromUsername", u.profile_picture AS "fromProfilePicture"
       FROM friend_requests fr
       JOIN users u ON u.id = fr.from_user_id
       WHERE fr.to_user_id = $1 AND fr.status = 'pending'
       ORDER BY fr.created_at DESC`,
      [userId]
    );
    return rows.map((r) => ({
      id: r.id,
      createdAt: r.createdAt,
      fromUser: { id: r.fromId, name: r.fromName, username: r.fromUsername, profilePicture: r.fromProfilePicture },
    }));
  })

  // Outgoing pending requests
  .get("/friends/requests/sent", async ({ userId }) => {
    const { rows } = await query(
      `SELECT fr.id, fr.created_at AS "createdAt",
              u.id AS "toId", u.name AS "toName", u.username AS "toUsername", u.profile_picture AS "toProfilePicture"
       FROM friend_requests fr
       JOIN users u ON u.id = fr.to_user_id
       WHERE fr.from_user_id = $1 AND fr.status = 'pending'
       ORDER BY fr.created_at DESC`,
      [userId]
    );
    return rows.map((r) => ({
      id: r.id,
      createdAt: r.createdAt,
      toUser: { id: r.toId, name: r.toName, username: r.toUsername, profilePicture: r.toProfilePicture },
    }));
  })

  // Accept friend request
  .post("/friends/requests/:id/accept", async ({ userId, params, set }) => {
    const { rows } = await query(
      "SELECT id, from_user_id FROM friend_requests WHERE id = $1 AND to_user_id = $2 AND status = 'pending'",
      [params.id, userId]
    );
    if (rows.length === 0) {
      set.status = 404;
      return { error: "Friend request not found." };
    }
    const req = rows[0];

    // Create bidirectional friend connections
    await query(
      "INSERT INTO friend_connections (id, user_id, friend_user_id) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING",
      [crypto.randomUUID(), req.from_user_id, userId]
    );
    await query(
      "INSERT INTO friend_connections (id, user_id, friend_user_id) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING",
      [crypto.randomUUID(), userId, req.from_user_id]
    );

    await query("UPDATE friend_requests SET status = 'accepted' WHERE id = $1", [params.id]);
    return { success: true };
  })

  // Decline friend request
  .post("/friends/requests/:id/decline", async ({ userId, params, set }) => {
    const { rows } = await query(
      "SELECT id FROM friend_requests WHERE id = $1 AND to_user_id = $2 AND status = 'pending'",
      [params.id, userId]
    );
    if (rows.length === 0) {
      set.status = 404;
      return { error: "Friend request not found." };
    }
    await query("UPDATE friend_requests SET status = 'declined' WHERE id = $1", [params.id]);
    return { success: true };
  })

  // Unfriend
  .delete("/friends/:friendUserId", async ({ userId, params, set }) => {
    const result = await query(
      "DELETE FROM friend_connections WHERE (user_id = $1 AND friend_user_id = $2) OR (user_id = $2 AND friend_user_id = $1)",
      [userId, params.friendUserId]
    );
    if ((result.rowCount ?? 0) === 0) {
      set.status = 404;
      return { error: "Friend not found." };
    }
    return { success: true };
  })

  // Search users
  .get("/search", async ({ userId, query: qs, set }) => {
    const q = (qs as any).q as string | undefined;
    if (!q || q.trim().length < 1) {
      set.status = 400;
      return { error: "Query parameter 'q' is required." };
    }
    const search = `%${q.trim()}%`;

    const { rows } = await query(
      `SELECT u.id, u.name, u.username, u.profile_picture AS "profilePicture"
       FROM users u
       WHERE u.id != $1 AND u.is_disabled = FALSE
         AND (u.username ILIKE $2 OR u.name ILIKE $2)
       ORDER BY u.name ASC
       LIMIT 20`,
      [userId, search]
    );

    if (rows.length === 0) return [];

    const userIds = rows.map((r: any) => r.id);

    // Batch-fetch friendship status
    const { rows: connections } = await query(
      `SELECT friend_user_id FROM friend_connections WHERE user_id = $1 AND friend_user_id = ANY($2::text[])`,
      [userId, userIds]
    );
    const friendSet = new Set(connections.map((r: any) => r.friend_user_id));

    const { rows: sentReqs } = await query(
      `SELECT to_user_id FROM friend_requests WHERE from_user_id = $1 AND to_user_id = ANY($2::text[]) AND status = 'pending'`,
      [userId, userIds]
    );
    const sentSet = new Set(sentReqs.map((r: any) => r.to_user_id));

    const { rows: recvReqs } = await query(
      `SELECT from_user_id FROM friend_requests WHERE to_user_id = $1 AND from_user_id = ANY($2::text[]) AND status = 'pending'`,
      [userId, userIds]
    );
    const receivedSet = new Set(recvReqs.map((r: any) => r.from_user_id));

    return rows.map((r: any) => ({
      id: r.id,
      name: r.name,
      username: r.username,
      profilePicture: r.profilePicture,
      relationship: friendSet.has(r.id)
        ? "friends"
        : sentSet.has(r.id)
        ? "request_sent"
        : receivedSet.has(r.id)
        ? "request_received"
        : "none",
    }));
  })

  /* ──────────────────────────────────────────────
     GROUPS
  ────────────────────────────────────────────── */

  // List groups user belongs to
  .get("/groups", async ({ userId }) => {
    const { rows } = await query(
      `SELECT g.id, g.name, gm.role,
              (SELECT COUNT(*) FROM group_memberships WHERE group_id = g.id)::int AS "memberCount"
       FROM group_memberships gm
       JOIN groups_ g ON g.id = gm.group_id
       WHERE gm.user_id = $1
       ORDER BY g.name ASC`,
      [userId]
    );
    return rows;
  })

  // Create group
  .post("/groups", async ({ userId, body, set }) => {
    const name = body.name.trim();
    if (!name) { set.status = 400; return { error: "Group name is required." }; }

    const groupId = crypto.randomUUID();
    await query(
      "INSERT INTO groups_ (id, name, total_members) VALUES ($1, $2, 1)",
      [groupId, name]
    );
    await query(
      "INSERT INTO group_memberships (id, group_id, user_id, role) VALUES ($1, $2, $3, 'admin')",
      [crypto.randomUUID(), groupId, userId]
    );
    set.status = 201;
    return { id: groupId, name, memberCount: 1, role: "admin" };
  }, {
    body: t.Object({ name: t.String() }),
  })

  // Group detail
  .get("/groups/:id", async ({ userId, params, set }) => {
    const { rows: groups } = await query(
      "SELECT id, name FROM groups_ WHERE id = $1",
      [params.id]
    );
    if (groups.length === 0) { set.status = 404; return { error: "Group not found." }; }
    const group = groups[0];

    const { rows: members } = await query(
      `SELECT u.id, u.name, u.username, u.profile_picture AS "profilePicture", gm.role, gm.joined_at AS "joinedAt"
       FROM group_memberships gm
       JOIN users u ON u.id = gm.user_id
       WHERE gm.group_id = $1
       ORDER BY gm.joined_at ASC`,
      [params.id]
    );

    const currentMember = members.find((m: any) => m.id === userId);
    return {
      id: group.id,
      name: group.name,
      memberCount: members.length,
      currentUserRole: currentMember?.role ?? null,
      members,
    };
  })

  // Join group
  .post("/groups/:id/join", async ({ userId, params, set }) => {
    const { rows: groups } = await query("SELECT id FROM groups_ WHERE id = $1", [params.id]);
    if (groups.length === 0) { set.status = 404; return { error: "Group not found." }; }

    const { rows: existing } = await query(
      "SELECT id FROM group_memberships WHERE group_id = $1 AND user_id = $2",
      [params.id, userId]
    );
    if (existing.length > 0) {
      set.status = 409;
      return { error: "You are already a member of this group." };
    }

    await query(
      "INSERT INTO group_memberships (id, group_id, user_id, role) VALUES ($1, $2, $3, 'member')",
      [crypto.randomUUID(), params.id, userId]
    );
    await query(
      "UPDATE groups_ SET total_members = (SELECT COUNT(*) FROM group_memberships WHERE group_id = $1) WHERE id = $1",
      [params.id]
    );
    return { success: true };
  })

  // Leave group
  .post("/groups/:id/leave", async ({ userId, params, set }) => {
    const { rows: membership } = await query(
      "SELECT role FROM group_memberships WHERE group_id = $1 AND user_id = $2",
      [params.id, userId]
    );
    if (membership.length === 0) { set.status = 404; return { error: "You are not a member of this group." }; }

    if (membership[0].role === "admin") {
      const { rows: otherAdmins } = await query(
        "SELECT id FROM group_memberships WHERE group_id = $1 AND user_id != $2 AND role = 'admin'",
        [params.id, userId]
      );
      if (otherAdmins.length === 0) {
        const { rows: otherMembers } = await query(
          "SELECT id FROM group_memberships WHERE group_id = $1 AND user_id != $2",
          [params.id, userId]
        );
        if (otherMembers.length > 0) {
          set.status = 400;
          return { error: "You must transfer admin role before leaving." };
        }
      }
    }

    await query("DELETE FROM group_memberships WHERE group_id = $1 AND user_id = $2", [params.id, userId]);
    await query(
      "UPDATE groups_ SET total_members = (SELECT COUNT(*) FROM group_memberships WHERE group_id = $1) WHERE id = $1",
      [params.id]
    );
    return { success: true };
  })

  // Delete group (admin only)
  .delete("/groups/:id", async ({ userId, params, set }) => {
    const { rows: membership } = await query(
      "SELECT role FROM group_memberships WHERE group_id = $1 AND user_id = $2",
      [params.id, userId]
    );
    if (membership.length === 0 || membership[0].role !== "admin") {
      set.status = 403;
      return { error: "Only group admins can delete the group." };
    }
    await query("DELETE FROM groups_ WHERE id = $1", [params.id]);
    return { success: true };
  })

  // Remove member (admin only)
  .post("/groups/:id/members/:userId/remove", async ({ userId, params, set }) => {
    const { rows: membership } = await query(
      "SELECT role FROM group_memberships WHERE group_id = $1 AND user_id = $2",
      [params.id, userId]
    );
    if (membership.length === 0 || membership[0].role !== "admin") {
      set.status = 403;
      return { error: "Only group admins can remove members." };
    }
    if (params.userId === userId) {
      set.status = 400;
      return { error: "Use the leave endpoint to remove yourself." };
    }
    await query(
      "DELETE FROM group_memberships WHERE group_id = $1 AND user_id = $2",
      [params.id, params.userId]
    );
    await query(
      "UPDATE groups_ SET total_members = (SELECT COUNT(*) FROM group_memberships WHERE group_id = $1) WHERE id = $1",
      [params.id]
    );
    return { success: true };
  })

  // Update member role (admin only)
  .patch("/groups/:id/members/:userId/role", async ({ userId, params, body, set }) => {
    const { rows: membership } = await query(
      "SELECT role FROM group_memberships WHERE group_id = $1 AND user_id = $2",
      [params.id, userId]
    );
    if (membership.length === 0 || membership[0].role !== "admin") {
      set.status = 403;
      return { error: "Only group admins can change member roles." };
    }
    const { rows: target } = await query(
      "SELECT id FROM group_memberships WHERE group_id = $1 AND user_id = $2",
      [params.id, params.userId]
    );
    if (target.length === 0) {
      set.status = 404;
      return { error: "Member not found in this group." };
    }
    await query(
      "UPDATE group_memberships SET role = $1 WHERE group_id = $2 AND user_id = $3",
      [body.role, params.id, params.userId]
    );
    return { success: true };
  }, {
    body: t.Object({ role: t.Union([t.Literal("admin"), t.Literal("member")]) }),
  });
