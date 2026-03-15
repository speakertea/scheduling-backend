import { Elysia, t } from "elysia";
import { query } from "../db";
import { authGuard } from "./guard";

export const inviteRoutes = new Elysia({ prefix: "/invites" })
  .use(authGuard)

  .get("/", async ({ userId, query: qs }) => {
    let sql = "SELECT * FROM invites WHERE user_id=$1";
    const params: any[] = [userId];
    if (qs.type === "group") sql += " AND is_group=TRUE";
    else if (qs.type === "friend") sql += " AND is_group=FALSE";
    sql += " ORDER BY start_at DESC";

    const { rows: invites } = await query(sql, params);
    const results = [];
    for (const inv of invites) {
      const { rows: att } = await query("SELECT name,status,is_friend FROM invite_attendees WHERE invite_id=$1", [inv.id]);
      results.push({
        id: inv.id, title: inv.title, organizer: inv.organizer, group: inv.group_name || undefined,
        location: inv.location, startAt: inv.start_at, endAt: inv.end_at, totalInvited: inv.total_invited,
        rsvpStatus: inv.rsvp_status || null,
        attendees: att.map((a: any) => ({ name: a.name, status: a.status || null, isFriend: a.is_friend })),
      });
    }
    return results;
  })

  .patch("/:id/rsvp", async ({ userId, params, body }) => {
    const { status } = body;
    const { rows } = await query("SELECT * FROM invites WHERE id=$1 AND user_id=$2", [params.id, userId]);
    if (rows.length === 0) return new Response(JSON.stringify({ error: "Invite not found" }), { status: 404 });
    const inv = rows[0];

    await query("UPDATE invites SET rsvp_status=$1 WHERE id=$2", [status, inv.id]);

    const { rows: you } = await query("SELECT id FROM invite_attendees WHERE invite_id=$1 AND name='You'", [inv.id]);
    if (you.length > 0) await query("UPDATE invite_attendees SET status=$1 WHERE invite_id=$2 AND name='You'", [status, inv.id]);
    else await query("INSERT INTO invite_attendees (invite_id,name,status,is_friend) VALUES ($1,'You',$2,FALSE)", [inv.id, status]);

    if (status === "yes") {
      const { rows: ex } = await query("SELECT id FROM events WHERE user_id=$1 AND title=$2 AND start_at=$3", [userId, inv.title, inv.start_at]);
      if (ex.length === 0) {
        await query(
          "INSERT INTO events (id,user_id,title,type,start_at,end_at,location,notes) VALUES ($1,$2,$3,'meetup',$4,$5,$6,$7)",
          [crypto.randomUUID(), userId, inv.title, inv.start_at, inv.end_at, inv.location,
           `Organized by ${inv.organizer}${inv.group_name ? ` • ${inv.group_name}` : ""}`]
        );
      }
    }

    return { success: true, rsvpStatus: status };
  }, {
    body: t.Object({
      status: t.Union([t.Literal("yes"), t.Literal("maybe"), t.Literal("no"), t.Null()]),
    }),
  });
