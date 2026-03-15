import { Elysia, t } from "elysia";
import { query } from "../db";
import { authGuard } from "./guard";

export const socialCreateRoutes = new Elysia({ prefix: "/social/create" })
  .use(authGuard)

  .post("/", async ({ userId, body, set }) => {
    const { eventType, sendTo, selectedGroupId, selectedFriendIds, title, location, date, startTime, endTime, notes } = body;
    const startAt = `${date}T${startTime}:00`;
    const endAt = `${date}T${endTime}:00`;

    if (eventType === "social") {
      let groupName: string | null = null;
      let totalInvited = 0;
      const isGroup = sendTo === "group";

      if (isGroup && selectedGroupId) {
        const { rows } = await query("SELECT name,total_members FROM groups_ WHERE id=$1", [selectedGroupId]);
        if (rows.length === 0) return new Response(JSON.stringify({ error: "Group not found" }), { status: 400 });
        groupName = rows[0].name;
        totalInvited = rows[0].total_members;
      }

      const inviteId = crypto.randomUUID();
      const attendees: Array<{ name: string; isFriend: boolean }> = [];

      if (isGroup && selectedGroupId) {
        const { rows: members } = await query("SELECT name FROM group_members WHERE group_id=$1", [selectedGroupId]);
        const { rows: friends } = await query("SELECT name FROM friends WHERE user_id=$1", [userId]);
        const friendSet = new Set(friends.map((f: any) => f.name));
        for (const m of members) attendees.push({ name: m.name, isFriend: friendSet.has(m.name) });
      } else {
        attendees.push({ name: "You", isFriend: false });
        if (selectedFriendIds?.length) {
          const ph = selectedFriendIds.map((_: any, i: number) => `$${i + 2}`).join(",");
          const { rows: friends } = await query(`SELECT name FROM friends WHERE user_id=$1 AND id IN (${ph})`, [userId, ...selectedFriendIds]);
          for (const f of friends) attendees.push({ name: f.name, isFriend: true });
        }
        totalInvited = attendees.length;
      }

      await query(
        `INSERT INTO invites (id,user_id,title,organizer,group_name,location,start_at,end_at,total_invited,is_group) VALUES ($1,$2,$3,'You',$4,$5,$6,$7,$8,$9)`,
        [inviteId, userId, title.trim(), groupName, location.trim(), startAt, endAt, totalInvited, isGroup]
      );
      for (const a of attendees) {
        await query("INSERT INTO invite_attendees (invite_id,name,status,is_friend) VALUES ($1,$2,NULL,$3)", [inviteId, a.name, a.isFriend]);
      }

      set.status = 201;
      return { success: true, id: inviteId, eventType, sendTo };

    } else {
      let groupName: string | null = null;
      let totalSentTo = 0;
      const isGroup = sendTo === "group";

      if (isGroup && selectedGroupId) {
        const { rows } = await query("SELECT name,total_members FROM groups_ WHERE id=$1", [selectedGroupId]);
        if (rows.length === 0) return new Response(JSON.stringify({ error: "Group not found" }), { status: 400 });
        groupName = rows[0].name;
        totalSentTo = rows[0].total_members;
      } else {
        totalSentTo = (selectedFriendIds?.length || 0) + 1;
      }

      const calId = crypto.randomUUID();
      await query(
        `INSERT INTO calendar_events (id,user_id,title,creator,group_name,location,start_at,end_at,notes,total_sent_to,is_group) VALUES ($1,$2,$3,'You',$4,$5,$6,$7,$8,$9,$10)`,
        [calId, userId, title.trim(), groupName, location.trim(), startAt, endAt, notes?.trim() || null, totalSentTo, isGroup]
      );

      set.status = 201;
      return { success: true, id: calId, eventType, sendTo };
    }
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
