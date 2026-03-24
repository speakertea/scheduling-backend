import { Elysia, t } from "elysia";
import { query } from "../db";
import { authGuard } from "./guard";
import { sanitizeTitle, sanitizeLocation, sanitizeNotes } from "../utils";
import { broadcastToUser } from "../broadcast";
import { sendGroupInvitePush } from "../notifications";

async function buildInviteResponse(inviteId: string) {
  const { rows } = await query("SELECT * FROM invites WHERE id = $1", [inviteId]);
  const invite = rows[0];
  const { rows: attendees } = await query(
    "SELECT name, status, is_friend FROM invite_attendees WHERE invite_id = $1 ORDER BY id ASC",
    [inviteId]
  );
  return {
    id: invite.id,
    title: invite.title,
    organizer: invite.organizer,
    group: invite.group_name || undefined,
    location: invite.location,
    startAt: invite.start_at,
    endAt: invite.end_at,
    totalInvited: invite.total_invited,
    rsvpStatus: invite.rsvp_status || null,
    attendees: attendees.map((attendee: any) => ({
      name: attendee.name,
      status: attendee.status || null,
      isFriend: attendee.is_friend,
    })),
  };
}

const toCalendarEvent = (row: any) => ({
  id: row.id,
  title: row.title,
  creator: row.creator,
  group: row.group_name || undefined,
  location: row.location,
  startAt: row.start_at,
  endAt: row.end_at,
  notes: row.notes || undefined,
  totalSentTo: row.total_sent_to,
  acceptStatus: row.accept_status || null,
  reminderSettings: row.reminder_times ? { times: JSON.parse(row.reminder_times) } : null,
});

export const socialCreateRoutes = new Elysia({ prefix: "/social/create" })
  .use(authGuard)

  .post("/", async ({ userId, body, set }) => {
    const { eventType, sendTo, selectedGroupId, selectedFriendIds, title: rawTitle, location: rawLocation, date, startTime, endTime, notes: rawNotes } = body;
    const title = sanitizeTitle(rawTitle);
    const location = sanitizeLocation(rawLocation);
    const notes = rawNotes ? sanitizeNotes(rawNotes) : undefined;
    const startAt = `${date}T${startTime}:00`;
    const endAt = `${date}T${endTime}:00`;
    const isGroup = sendTo === "group";

    const { rows: senderRows } = await query("SELECT id, name FROM users WHERE id = $1", [userId]);
    const sender = senderRows[0];
    if (!sender) return new Response(JSON.stringify({ error: "User not found" }), { status: 404 });

    let groupName: string | null = null;
    let recipients: Array<{ id: string; name: string; isFriend: boolean }> = [];

    if (isGroup) {
      const { rows: groups } = await query("SELECT id, name FROM groups_ WHERE id = $1", [selectedGroupId]);
      if (groups.length === 0) return new Response(JSON.stringify({ error: "Group not found" }), { status: 400 });
      groupName = groups[0].name;
      const { rows: members } = await query(
        `SELECT u.id, u.name,
                EXISTS(SELECT 1 FROM friend_connections fc WHERE fc.user_id = $2 AND fc.friend_user_id = u.id) AS is_friend
         FROM group_memberships gm
         JOIN users u ON u.id = gm.user_id
         WHERE gm.group_id = $1`,
        [selectedGroupId, userId]
      );
      recipients = members.map((member: any) => ({ id: member.id, name: member.name, isFriend: !!member.is_friend }));
    } else {
      const friendIds = selectedFriendIds || [];
      if (friendIds.length > 0) {
        const { rows: friends } = await query(
          `SELECT u.id, u.name
           FROM friend_connections fc
           JOIN users u ON u.id = fc.friend_user_id
           WHERE fc.user_id = $1 AND fc.friend_user_id = ANY($2::text[])`,
          [userId, friendIds]
        );
        recipients = friends.map((friend: any) => ({ id: friend.id, name: friend.name, isFriend: true }));
      }
      recipients = [{ id: sender.id, name: sender.name, isFriend: false }, ...recipients.filter((friend) => friend.id !== sender.id)];
    }

    if (isGroup && !recipients.some((recipient) => recipient.id === sender.id)) {
      recipients = [{ id: sender.id, name: sender.name, isFriend: false }, ...recipients];
    }

    const uniqueRecipients = Array.from(new Map(recipients.map((recipient) => [recipient.id, recipient])).values());
    const totalRecipients = Math.max(uniqueRecipients.length, 1);

    if (eventType === "social") {
      const threadId = crypto.randomUUID();
      const createdInviteIds: string[] = [];

      for (const recipient of uniqueRecipients) {
        const inviteId = crypto.randomUUID();
        const organizer = recipient.id === sender.id ? "You" : sender.name;
        const rsvpStatus = recipient.id === sender.id ? null : null;

        await query(
          `INSERT INTO invites (id, thread_id, user_id, sender_user_id, created_by, title, organizer, group_name, location, start_at, end_at, total_invited, is_group, rsvp_status, notes)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)`,
          [inviteId, threadId, recipient.id, sender.id, sender.id, title, organizer, groupName, location, startAt, endAt, totalRecipients, isGroup, rsvpStatus, notes || null]
        );

        for (const attendee of uniqueRecipients) {
          await query(
            "INSERT INTO invite_attendees (invite_id, user_id, name, status, is_friend) VALUES ($1, $2, $3, $4, $5)",
            [inviteId, attendee.id, attendee.id === sender.id && recipient.id === sender.id ? "You" : attendee.name, null, attendee.isFriend]
          );
        }

        createdInviteIds.push(inviteId);
      }

      for (let index = 0; index < uniqueRecipients.length; index++) {
        const payload = await buildInviteResponse(createdInviteIds[index]);
        broadcastToUser(uniqueRecipients[index].id, { type: "invite_upsert", payload });
      }

      if (isGroup && selectedGroupId && groupName) {
        await sendGroupInvitePush(
          selectedGroupId,
          uniqueRecipients.filter((recipient) => recipient.id !== sender.id).map((recipient) => recipient.id),
          { groupName, title, startAt, type: "social" }
        );
      }

      set.status = 201;
      return { success: true, threadId, eventType, sendTo };
    }

    const threadId = crypto.randomUUID();
    const createdCalendarRows: any[] = [];
    for (const recipient of uniqueRecipients) {
      const id = crypto.randomUUID();
      const creator = recipient.id === sender.id ? "You" : sender.name;
      await query(
        `INSERT INTO calendar_events (id, thread_id, user_id, sender_user_id, title, creator, group_name, location, start_at, end_at, notes, total_sent_to, is_group)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
        [id, threadId, recipient.id, sender.id, title, creator, groupName, location, startAt, endAt, notes || null, totalRecipients, isGroup]
      );
      const { rows } = await query("SELECT * FROM calendar_events WHERE id = $1", [id]);
      createdCalendarRows.push(rows[0]);
    }

    for (const row of createdCalendarRows) {
      broadcastToUser(row.user_id, { type: "calendar_event_upsert", payload: toCalendarEvent(row) });
    }

    if (isGroup && selectedGroupId && groupName) {
      await sendGroupInvitePush(
        selectedGroupId,
        uniqueRecipients.filter((recipient) => recipient.id !== sender.id).map((recipient) => recipient.id),
        { groupName, title, startAt, type: "calendar" }
      );
    }

    set.status = 201;
    return { success: true, threadId, eventType, sendTo };
  }, {
    body: t.Object({
      eventType: t.Union([t.Literal("social"), t.Literal("calendar")]),
      sendTo: t.Union([t.Literal("group"), t.Literal("friends")]),
      selectedGroupId: t.Union([t.String(), t.Null()]),
      selectedFriendIds: t.Array(t.String()),
      title: t.String(),
      location: t.String(),
      date: t.String(),
      startTime: t.String(),
      endTime: t.String(),
      notes: t.Optional(t.String()),
    }),
  });
