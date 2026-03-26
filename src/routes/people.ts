import { Elysia, t } from "elysia";
import { query } from "../db";
import { authGuard } from "./guard";
import {
  sendGroupFriendInviteOutcomePush,
  sendGroupFriendInvitePush,
  sendGroupJoinRequestPush,
  sendJoinRequestOutcomePush,
} from "../notifications";

type BusyRange = {
  start: Date;
  end: Date;
};

function generateInviteCode(): string {
  const chars = "abcdefghijklmnopqrstuvwxyz0123456789";
  let code = "";
  for (let i = 0; i < 8; i++) code += chars[Math.floor(Math.random() * chars.length)];
  return code;
}

function clampPositiveInt(value: unknown, fallback: number, max = 365) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(Math.max(Math.round(parsed), 1), max);
}

function buildGroupSuggestions(rangesByUser: Map<string, BusyRange[]>, memberIds: string[], durationMinutes: number) {
  const suggestions: Array<{ startAt: string; endAt: string; availableCount: number; unavailableCount: number }> = [];
  const durationMs = durationMinutes * 60_000;
  const now = new Date();
  const base = new Date(now);
  base.setMinutes(base.getMinutes() < 30 ? 30 : 60, 0, 0);

  for (let dayOffset = 0; dayOffset < 7; dayOffset += 1) {
    const dayStart = new Date(base);
    dayStart.setDate(base.getDate() + dayOffset);
    dayStart.setHours(8, 0, 0, 0);
    const dayEnd = new Date(dayStart);
    dayEnd.setHours(22, 0, 0, 0);

    for (let cursor = new Date(dayStart); cursor.getTime() + durationMs <= dayEnd.getTime(); cursor = new Date(cursor.getTime() + 30 * 60_000)) {
      if (cursor.getTime() < now.getTime()) continue;
      const slotEnd = new Date(cursor.getTime() + durationMs);
      let availableCount = 0;

      for (const memberId of memberIds) {
        const ranges = rangesByUser.get(memberId) ?? [];
        const busy = ranges.some((range) => range.start < slotEnd && range.end > cursor);
        if (!busy) availableCount += 1;
      }

      if (availableCount === 0) continue;

      suggestions.push({
        startAt: cursor.toISOString(),
        endAt: slotEnd.toISOString(),
        availableCount,
        unavailableCount: memberIds.length - availableCount,
      });
    }
  }

  return suggestions
    .sort((a, b) => {
      if (b.availableCount !== a.availableCount) return b.availableCount - a.availableCount;
      return new Date(a.startAt).getTime() - new Date(b.startAt).getTime();
    })
    .slice(0, 5);
}

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
      `SELECT g.id, g.name, g.group_photo AS "groupPhoto", gm.role,
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
      "INSERT INTO groups_ (id, name, total_members, group_photo) VALUES ($1, $2, 1, '')",
      [groupId, name]
    );
    await query(
      "INSERT INTO group_memberships (id, group_id, user_id, role) VALUES ($1, $2, $3, 'admin')",
      [crypto.randomUUID(), groupId, userId]
    );
    set.status = 201;
    return { id: groupId, name, groupPhoto: "", memberCount: 1, role: "admin" };
  }, {
    body: t.Object({ name: t.String() }),
  })

  .get("/group-invites", async ({ userId }) => {
    const { rows } = await query(
      `SELECT gfi.id,
              gfi.created_at AS "createdAt",
              g.id AS "groupId",
              g.name AS "groupName",
              g.group_photo AS "groupPhoto",
              inviter.id AS "invitedById",
              inviter.name AS "invitedByName",
              inviter.username AS "invitedByUsername",
              inviter.profile_picture AS "invitedByProfilePicture"
       FROM group_friend_invites gfi
       JOIN groups_ g ON g.id = gfi.group_id
       JOIN users inviter ON inviter.id = gfi.invited_by_user_id
       WHERE gfi.invited_user_id = $1 AND gfi.status = 'pending'
       ORDER BY gfi.created_at DESC`,
      [userId]
    );

    return rows.map((row: any) => ({
      id: row.id,
      createdAt: row.createdAt,
      group: {
        id: row.groupId,
        name: row.groupName,
        groupPhoto: row.groupPhoto,
      },
      invitedBy: {
        id: row.invitedById,
        name: row.invitedByName,
        username: row.invitedByUsername,
        profilePicture: row.invitedByProfilePicture,
      },
    }));
  })

  .post("/group-invites/:inviteId/accept", async ({ userId, params, set }) => {
    const { rows: invites } = await query(
      `SELECT gfi.group_id, gfi.invited_by_user_id, g.name AS "groupName"
       FROM group_friend_invites gfi
       JOIN groups_ g ON g.id = gfi.group_id
       WHERE gfi.id = $1 AND gfi.invited_user_id = $2 AND gfi.status = 'pending'`,
      [params.inviteId, userId]
    );
    if (invites.length === 0) {
      set.status = 404;
      return { error: "Group invite not found." };
    }

    const invite = invites[0];
    await query(
      `INSERT INTO group_memberships (id, group_id, user_id, role)
       VALUES ($1, $2, $3, 'member')
       ON CONFLICT (group_id, user_id) DO NOTHING`,
      [crypto.randomUUID(), invite.group_id, userId]
    );
    await query(
      `UPDATE group_friend_invites
       SET status = 'accepted', responded_at = NOW(), responded_by = $1
       WHERE group_id = $2 AND invited_user_id = $1 AND status = 'pending'`,
      [userId, invite.group_id]
    );
    await query(
      `UPDATE group_join_requests
       SET status = 'approved', reviewed_at = NOW(), reviewed_by = $1
       WHERE group_id = $2 AND user_id = $1 AND status = 'pending'`,
      [userId, invite.group_id]
    );
    await query(
      "UPDATE groups_ SET total_members = (SELECT COUNT(*) FROM group_memberships WHERE group_id = $1) WHERE id = $1",
      [invite.group_id]
    );

    const { rows: userRows } = await query("SELECT name FROM users WHERE id = $1", [userId]);
    const invitedUserName = userRows[0]?.name || "Someone";
    await sendGroupFriendInviteOutcomePush(invite.invited_by_user_id, {
      accepted: true,
      groupName: invite.groupName,
      invitedUserName,
    });

    return { success: true, groupId: invite.group_id, groupName: invite.groupName };
  })

  .post("/group-invites/:inviteId/decline", async ({ userId, params, set }) => {
    const { rows: invites } = await query(
      `SELECT gfi.group_id, gfi.invited_by_user_id, g.name AS "groupName"
       FROM group_friend_invites gfi
       JOIN groups_ g ON g.id = gfi.group_id
       WHERE gfi.id = $1 AND gfi.invited_user_id = $2 AND gfi.status = 'pending'`,
      [params.inviteId, userId]
    );
    if (invites.length === 0) {
      set.status = 404;
      return { error: "Group invite not found." };
    }

    const invite = invites[0];
    await query(
      `UPDATE group_friend_invites
       SET status = 'declined', responded_at = NOW(), responded_by = $1
       WHERE id = $2 AND invited_user_id = $1 AND status = 'pending'`,
      [userId, params.inviteId]
    );

    const { rows: userRows } = await query("SELECT name FROM users WHERE id = $1", [userId]);
    const invitedUserName = userRows[0]?.name || "Someone";
    await sendGroupFriendInviteOutcomePush(invite.invited_by_user_id, {
      accepted: false,
      groupName: invite.groupName,
      invitedUserName,
    });

    return { success: true };
  })

  // Group detail
  .get("/groups/:id", async ({ userId, params, set }) => {
    const { rows: groups } = await query(
      "SELECT id, name, group_photo AS \"groupPhoto\" FROM groups_ WHERE id = $1",
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
      groupPhoto: group.groupPhoto,
      memberCount: members.length,
      currentUserRole: currentMember?.role ?? null,
      members,
    };
  })

  .patch("/groups/:id/photo", async ({ userId, params, body, set }) => {
    const { rows: membership } = await query(
      "SELECT role FROM group_memberships WHERE group_id = $1 AND user_id = $2",
      [params.id, userId]
    );
    if (membership.length === 0 || membership[0].role !== "admin") {
      set.status = 403;
      return { error: "Only group admins can update the group photo." };
    }

    const groupPhoto = body.groupPhoto.trim();
    await query("UPDATE groups_ SET group_photo = $1 WHERE id = $2", [groupPhoto, params.id]);
    return { success: true, groupPhoto };
  }, {
    body: t.Object({ groupPhoto: t.String() }),
  })

  .get("/groups/:id/invitable-friends", async ({ userId, params, set }) => {
    const { rows: membership } = await query(
      "SELECT role FROM group_memberships WHERE group_id = $1 AND user_id = $2",
      [params.id, userId]
    );
    if (membership.length === 0 || membership[0].role !== "admin") {
      set.status = 403;
      return { error: "Only group admins can invite friends." };
    }

    const { rows } = await query(
      `SELECT u.id, u.name, u.username, u.profile_picture AS "profilePicture",
              EXISTS(
                SELECT 1
                FROM group_friend_invites gfi
                WHERE gfi.group_id = $2
                  AND gfi.invited_user_id = u.id
                  AND gfi.status = 'pending'
              ) AS "pendingInvite"
       FROM friend_connections fc
       JOIN users u ON u.id = fc.friend_user_id
       WHERE fc.user_id = $1
         AND NOT EXISTS (
           SELECT 1 FROM group_memberships gm WHERE gm.group_id = $2 AND gm.user_id = u.id
         )
       ORDER BY u.name ASC`,
      [userId, params.id]
    );

    return rows;
  })

  .post("/groups/:id/friend-invites", async ({ userId, params, body, set }) => {
    const { rows: membership } = await query(
      "SELECT role FROM group_memberships WHERE group_id = $1 AND user_id = $2",
      [params.id, userId]
    );
    if (membership.length === 0 || membership[0].role !== "admin") {
      set.status = 403;
      return { error: "Only group admins can invite friends." };
    }
    if (body.targetUserId === userId) {
      set.status = 400;
      return { error: "You cannot invite yourself." };
    }

    const { rows: friendRows } = await query(
      `SELECT u.id, u.name
       FROM friend_connections fc
       JOIN users u ON u.id = fc.friend_user_id
       WHERE fc.user_id = $1 AND fc.friend_user_id = $2 AND u.is_disabled = FALSE`,
      [userId, body.targetUserId]
    );
    if (friendRows.length === 0) {
      set.status = 404;
      return { error: "Friend not found." };
    }

    const { rows: memberRows } = await query(
      "SELECT id FROM group_memberships WHERE group_id = $1 AND user_id = $2",
      [params.id, body.targetUserId]
    );
    if (memberRows.length > 0) {
      set.status = 409;
      return { error: "This friend is already in the group." };
    }

    const { rows: pendingRows } = await query(
      "SELECT id FROM group_friend_invites WHERE group_id = $1 AND invited_user_id = $2 AND status = 'pending'",
      [params.id, body.targetUserId]
    );
    if (pendingRows.length > 0) {
      set.status = 409;
      return { error: "This friend already has a pending invite." };
    }

    const { rows: groupRows } = await query("SELECT name FROM groups_ WHERE id = $1", [params.id]);
    if (groupRows.length === 0) {
      set.status = 404;
      return { error: "Group not found." };
    }

    const { rows: inviterRows } = await query("SELECT name FROM users WHERE id = $1", [userId]);
    const inviteId = crypto.randomUUID();
    await query(
      `INSERT INTO group_friend_invites (id, group_id, invited_user_id, invited_by_user_id)
       VALUES ($1, $2, $3, $4)`,
      [inviteId, params.id, body.targetUserId, userId]
    );

    await sendGroupFriendInvitePush(body.targetUserId, {
      groupName: groupRows[0].name,
      invitedByName: inviterRows[0]?.name || "Someone",
    });

    set.status = 201;
    return {
      id: inviteId,
      invitedUserId: body.targetUserId,
      status: "pending",
    };
  }, {
    body: t.Object({ targetUserId: t.String() }),
  })

  .get("/groups/:id/suggest-times", async ({ userId, params, query: qs, set }) => {
    const { rows: membership } = await query(
      "SELECT user_id FROM group_memberships WHERE group_id = $1",
      [params.id]
    );
    if (membership.length === 0 || !membership.some((row: any) => row.user_id === userId)) {
      set.status = 403;
      return { error: "You must be a member of this group." };
    }

    const memberIds = membership.map((row: any) => row.user_id);
    const durationMinutes = clampPositiveInt((qs as any)?.durationMinutes, 60, 240);
    const until = new Date();
    until.setDate(until.getDate() + 7);

    const { rows: events } = await query(
      `SELECT user_id, start_at, end_at
       FROM events
       WHERE user_id = ANY($1::text[])
         AND start_at < $2
         AND end_at > $3`,
      [memberIds, until.toISOString(), new Date().toISOString()]
    );

    const rangesByUser = new Map<string, BusyRange[]>();
    for (const row of events as any[]) {
      const start = new Date(row.start_at);
      const end = new Date(row.end_at);
      if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) continue;
      const existing = rangesByUser.get(row.user_id) ?? [];
      existing.push({ start, end });
      rangesByUser.set(row.user_id, existing);
    }

    return {
      durationMinutes,
      memberCount: memberIds.length,
      suggestions: buildGroupSuggestions(rangesByUser, memberIds, durationMinutes),
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
  })

  /* ──────────────────────────────────────────────
     GROUP INVITE LINKS
  ────────────────────────────────────────────── */

  // List active invite links for a group with creator info (members see all)
  .get("/groups/:id/invite-links", async ({ userId, params, set }) => {
    const { rows: membership } = await query(
      "SELECT role FROM group_memberships WHERE group_id = $1 AND user_id = $2",
      [params.id, userId]
    );
    if (membership.length === 0) {
      set.status = 403;
      return { error: "You must be a member of this group." };
    }

    const { rows } = await query(
      `SELECT gl.id, gl.code, gl.created_at,
              gl.expires_at AS "expiresAt", gl.max_uses AS "maxUses", gl.use_count AS "useCount",
              gl.requires_approval AS "requiresApproval", gl.is_active AS "isActive",
              u.id AS creator_id, u.name AS creator_name, u.username AS creator_username
       FROM group_invite_links gl
       JOIN users u ON u.id = gl.created_by
       WHERE gl.group_id = $1 AND gl.is_active = TRUE
       ORDER BY gl.created_at DESC`,
      [params.id]
    );
    return rows.map((r: any) => ({
      id: r.id,
      code: r.code,
      link: `https://collabo.cloud/join/${r.code}`,
      createdAt: r.created_at,
      expiresAt: r.expiresAt,
      maxUses: r.maxUses,
      useCount: r.useCount,
      requiresApproval: r.requiresApproval,
      isActive: r.isActive,
      createdBy: { id: r.creator_id, name: r.creator_name, username: r.creator_username },
    }));
  })

  // Revoke a specific invite link by link id (admin only)
  .delete("/groups/:id/invite-links/:linkId", async ({ userId, params, set }) => {
    const { rows: membership } = await query(
      "SELECT role FROM group_memberships WHERE group_id = $1 AND user_id = $2",
      [params.id, userId]
    );
    if (membership.length === 0 || membership[0].role !== "admin") {
      set.status = 403;
      return { error: "Only group admins can revoke specific invite links." };
    }
    const { rows } = await query(
      "UPDATE group_invite_links SET is_active = FALSE WHERE id = $1 AND group_id = $2 RETURNING id",
      [params.linkId, params.id]
    );
    if (rows.length === 0) {
      set.status = 404;
      return { error: "Invite link not found." };
    }
    return { success: true };
  })

  // Generate (or retrieve existing) invite link for a group — any member can share
  .post("/groups/:id/invite-link", async ({ userId, params, body, set }) => {
    const { rows: membership } = await query(
      "SELECT role FROM group_memberships WHERE group_id = $1 AND user_id = $2",
      [params.id, userId]
    );
    if (membership.length === 0) {
      set.status = 403;
      return { error: "You must be a member of this group." };
    }

    const expiresInDays = body.expiresInDays ? clampPositiveInt(body.expiresInDays, 7, 90) : null;
    const maxUses = body.maxUses ? clampPositiveInt(body.maxUses, 10, 500) : null;
    const requiresApproval = Boolean(body.requiresApproval);
    const rotate = Boolean(body.rotate);

    if (rotate) {
      await query(
        "UPDATE group_invite_links SET is_active = FALSE WHERE group_id = $1 AND is_active = TRUE",
        [params.id]
      );
    } else {
      const { rows: existing } = await query(
        `SELECT code, expires_at AS "expiresAt", max_uses AS "maxUses", use_count AS "useCount", requires_approval AS "requiresApproval"
         FROM group_invite_links
         WHERE group_id = $1 AND is_active = TRUE
         ORDER BY created_at DESC
         LIMIT 1`,
        [params.id]
      );
      if (
        existing.length > 0 &&
        existing[0].expiresAt === null &&
        existing[0].maxUses === null &&
        existing[0].requiresApproval === requiresApproval &&
        expiresInDays === null &&
        maxUses === null
      ) {
        return { code: existing[0].code, link: `https://collabo.cloud/join/${existing[0].code}` };
      }
    }

    // Generate unique code
    let code = generateInviteCode();
    while (true) {
      const { rows: clash } = await query("SELECT id FROM group_invite_links WHERE code = $1", [code]);
      if (clash.length === 0) break;
      code = generateInviteCode();
    }

    const expiresAt = expiresInDays ? new Date(Date.now() + expiresInDays * 86_400_000).toISOString() : null;
    await query(
      `INSERT INTO group_invite_links (id, group_id, code, created_by, expires_at, max_uses, requires_approval)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [crypto.randomUUID(), params.id, code, userId, expiresAt, maxUses, requiresApproval]
    );
    set.status = 201;
    return { code, link: `https://collabo.cloud/join/${code}`, expiresAt, maxUses, requiresApproval };
  }, {
    body: t.Object({
      expiresInDays: t.Optional(t.Nullable(t.Numeric())),
      maxUses: t.Optional(t.Nullable(t.Numeric())),
      requiresApproval: t.Optional(t.Boolean()),
      rotate: t.Optional(t.Boolean()),
    }),
  })

  .get("/groups/:id/join-requests", async ({ userId, params, set }) => {
    const { rows: membership } = await query(
      "SELECT role FROM group_memberships WHERE group_id = $1 AND user_id = $2",
      [params.id, userId]
    );
    if (membership.length === 0 || membership[0].role !== "admin") {
      set.status = 403;
      return { error: "Only group admins can review join requests." };
    }

    const { rows } = await query(
      `SELECT gjr.id, gjr.created_at AS "createdAt",
              u.id AS "userId", u.name, u.username, u.profile_picture AS "profilePicture"
       FROM group_join_requests gjr
       JOIN users u ON u.id = gjr.user_id
       WHERE gjr.group_id = $1 AND gjr.status = 'pending'
       ORDER BY gjr.created_at ASC`,
      [params.id]
    );
    return rows.map((row: any) => ({
      id: row.id,
      createdAt: row.createdAt,
      user: {
        id: row.userId,
        name: row.name,
        username: row.username,
        profilePicture: row.profilePicture,
      },
    }));
  })

  .post("/groups/:id/join-requests/:requestId/approve", async ({ userId, params, set }) => {
    const { rows: membership } = await query(
      "SELECT role FROM group_memberships WHERE group_id = $1 AND user_id = $2",
      [params.id, userId]
    );
    if (membership.length === 0 || membership[0].role !== "admin") {
      set.status = 403;
      return { error: "Only group admins can approve join requests." };
    }

    const { rows: requests } = await query(
      `SELECT user_id, link_id
       FROM group_join_requests
       WHERE id = $1 AND group_id = $2 AND status = 'pending'`,
      [params.requestId, params.id]
    );
    if (requests.length === 0) {
      set.status = 404;
      return { error: "Join request not found." };
    }

    const request = requests[0];
    const { rows: groupRows } = await query("SELECT name FROM groups_ WHERE id = $1", [params.id]);
    const groupName = groupRows[0]?.name || "this group";
    await query(
      `INSERT INTO group_memberships (id, group_id, user_id, role)
       VALUES ($1, $2, $3, 'member')
       ON CONFLICT (group_id, user_id) DO NOTHING`,
      [crypto.randomUUID(), params.id, request.user_id]
    );
    await query(
      `UPDATE group_join_requests
       SET status = 'approved', reviewed_at = NOW(), reviewed_by = $1
       WHERE id = $2`,
      [userId, params.requestId]
    );
    if (request.link_id) {
      await query("UPDATE group_invite_links SET use_count = use_count + 1 WHERE id = $1", [request.link_id]);
    }
    await query(
      "UPDATE groups_ SET total_members = (SELECT COUNT(*) FROM group_memberships WHERE group_id = $1) WHERE id = $1",
      [params.id]
    );
    await sendJoinRequestOutcomePush(request.user_id, { approved: true, groupName });
    return { success: true };
  })

  .post("/groups/:id/join-requests/:requestId/decline", async ({ userId, params, set }) => {
    const { rows: membership } = await query(
      "SELECT role FROM group_memberships WHERE group_id = $1 AND user_id = $2",
      [params.id, userId]
    );
    if (membership.length === 0 || membership[0].role !== "admin") {
      set.status = 403;
      return { error: "Only group admins can decline join requests." };
    }
    const { rows: requestRows } = await query(
      "SELECT user_id FROM group_join_requests WHERE id = $1 AND group_id = $2 AND status = 'pending'",
      [params.requestId, params.id]
    );
    if (requestRows.length === 0) {
      set.status = 404;
      return { error: "Join request not found." };
    }
    const { rows: groupRows } = await query("SELECT name FROM groups_ WHERE id = $1", [params.id]);
    const groupName = groupRows[0]?.name || "this group";
    const result = await query(
      `UPDATE group_join_requests
       SET status = 'declined', reviewed_at = NOW(), reviewed_by = $1
       WHERE id = $2 AND group_id = $3 AND status = 'pending'`,
      [userId, params.requestId, params.id]
    );
    if ((result.rowCount ?? 0) === 0) {
      set.status = 404;
      return { error: "Join request not found." };
    }
    await sendJoinRequestOutcomePush(requestRows[0].user_id, { approved: false, groupName });
    return { success: true };
  })

  .get("/groups/:id/notification-settings", async ({ userId, params, set }) => {
    const { rows: membership } = await query(
      "SELECT id FROM group_memberships WHERE group_id = $1 AND user_id = $2",
      [params.id, userId]
    );
    if (membership.length === 0) {
      set.status = 403;
      return { error: "You must be a member of this group." };
    }
    const { rows } = await query(
      "SELECT level FROM group_notification_settings WHERE group_id = $1 AND user_id = $2",
      [params.id, userId]
    );
    return { level: rows[0]?.level ?? "all" };
  })

  .patch("/groups/:id/notification-settings", async ({ userId, params, body, set }) => {
    const { rows: membership } = await query(
      "SELECT id FROM group_memberships WHERE group_id = $1 AND user_id = $2",
      [params.id, userId]
    );
    if (membership.length === 0) {
      set.status = 403;
      return { error: "You must be a member of this group." };
    }
    await query(
      `INSERT INTO group_notification_settings (id, group_id, user_id, level)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (group_id, user_id)
       DO UPDATE SET level = EXCLUDED.level, updated_at = NOW()`,
      [crypto.randomUUID(), params.id, userId, body.level]
    );
    return { success: true, level: body.level };
  }, {
    body: t.Object({ level: t.Union([t.Literal("all"), t.Literal("highlights"), t.Literal("mute")]) }),
  })

  // Revoke all invite links for a group (admin only)
  .delete("/groups/:id/invite-link", async ({ userId, params, set }) => {
    const { rows: membership } = await query(
      "SELECT role FROM group_memberships WHERE group_id = $1 AND user_id = $2",
      [params.id, userId]
    );
    if (membership.length === 0 || membership[0].role !== "admin") {
      set.status = 403;
      return { error: "Only group admins can revoke invite links." };
    }
    await query(
      "UPDATE group_invite_links SET is_active = FALSE WHERE group_id = $1 AND is_active = TRUE",
      [params.id]
    );
    return { success: true };
  })

  /* ──────────────────────────────────────────────
     JOIN VIA INVITE LINK
  ────────────────────────────────────────────── */

  // Join a group via invite code
  .post("/join/:code", async ({ userId, params, set }) => {
    const { rows: links } = await query(
      `SELECT gl.id, gl.group_id, g.name AS group_name, gl.requires_approval AS "requiresApproval",
              gl.expires_at AS "expiresAt", gl.max_uses AS "maxUses", gl.use_count AS "useCount"
       FROM group_invite_links gl
       JOIN groups_ g ON g.id = gl.group_id
       WHERE gl.code = $1 AND gl.is_active = TRUE`,
      [params.code]
    );
    if (links.length === 0) {
      set.status = 404;
      return { error: "Invite link is invalid or has been revoked." };
    }
    const { id: linkId, group_id, group_name, requiresApproval, expiresAt, maxUses, useCount } = links[0];

    if (expiresAt && new Date(expiresAt).getTime() <= Date.now()) {
      set.status = 410;
      return { error: "Invite link has expired." };
    }
    if (maxUses !== null && useCount >= maxUses) {
      set.status = 410;
      return { error: "Invite link has reached its limit." };
    }

    // Already a member?
    const { rows: existing } = await query(
      "SELECT id FROM group_memberships WHERE group_id = $1 AND user_id = $2",
      [group_id, userId]
    );
    if (existing.length > 0) {
      return { alreadyMember: true, groupId: group_id, groupName: group_name };
    }

    if (requiresApproval) {
      const { rows: pending } = await query(
        "SELECT id FROM group_join_requests WHERE group_id = $1 AND user_id = $2 AND status = 'pending'",
        [group_id, userId]
      );
      if (pending.length === 0) {
        await query(
          `INSERT INTO group_join_requests (id, group_id, user_id, link_id, status)
           VALUES ($1, $2, $3, $4, 'pending')`,
          [crypto.randomUUID(), group_id, userId, linkId]
        );
        const { rows: requesterRows } = await query("SELECT name FROM users WHERE id = $1", [userId]);
        const requesterName = requesterRows[0]?.name || "Someone";
        const { rows: adminRows } = await query(
          "SELECT user_id FROM group_memberships WHERE group_id = $1 AND role = 'admin'",
          [group_id]
        );
        await sendGroupJoinRequestPush(
          group_id,
          requesterName,
          group_name,
          adminRows.map((row: any) => row.user_id).filter((adminId: string) => adminId !== userId)
        );
      }
      return { pendingApproval: true, groupId: group_id, groupName: group_name };
    }

    await query(
      "INSERT INTO group_memberships (id, group_id, user_id, role) VALUES ($1, $2, $3, 'member')",
      [crypto.randomUUID(), group_id, userId]
    );
    await query("UPDATE group_invite_links SET use_count = use_count + 1 WHERE id = $1", [linkId]);
    await query(
      "UPDATE groups_ SET total_members = (SELECT COUNT(*) FROM group_memberships WHERE group_id = $1) WHERE id = $1",
      [group_id]
    );
    set.status = 201;
    return { success: true, groupId: group_id, groupName: group_name };
  });
