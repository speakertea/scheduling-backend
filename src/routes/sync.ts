import { Elysia, t } from "elysia";
import { query } from "../db";
import { authGuard } from "./guard";

const toEvent = (row: any) => ({
  id: row.id,
  title: row.title,
  type: row.type,
  startAt: row.start_at,
  endAt: row.end_at,
  location: row.location || undefined,
  notes: row.notes || undefined,
  recurrenceRule: row.recurrence_rule || undefined,
  parentEventId: row.parent_event_id || undefined,
});

async function toInvite(row: any) {
  const { rows: attendees } = await query(
    "SELECT name, status, is_friend FROM invite_attendees WHERE invite_id = $1 ORDER BY id ASC",
    [row.id]
  );

  return {
    id: row.id,
    title: row.title,
    organizer: row.organizer,
    group: row.group_name || undefined,
    location: row.location,
    startAt: row.start_at,
    endAt: row.end_at,
    totalInvited: row.total_invited,
    rsvpStatus: row.rsvp_status || null,
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

export const syncRoutes = new Elysia({ prefix: "/sync" })
  .use(authGuard)
  .get("/", async ({ userId, query: qs, set }) => {
    const since = String((qs as any).since || "").trim();
    const parsed = new Date(since);
    if (!since || Number.isNaN(parsed.getTime())) {
      set.status = 400;
      return { error: "A valid since timestamp is required." };
    }

    const [eventRows, inviteRows, calendarRows, deletedRows] = await Promise.all([
      query(
        "SELECT * FROM events WHERE user_id = $1 AND updated_at > $2 ORDER BY updated_at ASC",
        [userId, parsed.toISOString()]
      ),
      query(
        "SELECT * FROM invites WHERE user_id = $1 AND updated_at > $2 ORDER BY updated_at ASC",
        [userId, parsed.toISOString()]
      ),
      query(
        "SELECT * FROM calendar_events WHERE user_id = $1 AND updated_at > $2 ORDER BY updated_at ASC",
        [userId, parsed.toISOString()]
      ),
      query(
        `SELECT entity_type, entity_id, payload_json
         FROM deleted_entities
         WHERE user_id = $1 AND deleted_at > $2
         ORDER BY deleted_at ASC`,
        [userId, parsed.toISOString()]
      ),
    ]);

    const invites = await Promise.all(inviteRows.rows.map(toInvite));

    return {
      events: eventRows.rows.map(toEvent),
      deletedEvents: deletedRows.rows
        .filter((row: any) => row.entity_type === "event")
        .map((row: any) => ({ id: row.entity_id, ...(row.payload_json ? JSON.parse(row.payload_json) : {}) })),
      invites,
      deletedInvites: deletedRows.rows
        .filter((row: any) => row.entity_type === "invite")
        .map((row: any) => ({ id: row.entity_id })),
      calendarEvents: calendarRows.rows.map(toCalendarEvent),
      deletedCalendarEvents: deletedRows.rows
        .filter((row: any) => row.entity_type === "calendar_event")
        .map((row: any) => ({ id: row.entity_id })),
      serverTime: new Date().toISOString(),
    };
  }, {
    query: t.Object({ since: t.String() }),
  });
