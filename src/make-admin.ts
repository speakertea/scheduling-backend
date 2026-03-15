/**
 * Make a user an admin by email.
 *
 * Usage:
 *   bun run src/make-admin.ts your@email.com
 */

import { query, createTables } from "./db";

const email = process.argv[2];
if (!email) {
  console.error("Usage: bun run src/make-admin.ts <email>");
  process.exit(1);
}

await createTables();

const result = await query(
  "UPDATE users SET is_admin = TRUE WHERE email = $1 RETURNING id, email, name",
  [email.toLowerCase().trim()]
);

if (result.rows.length === 0) {
  console.error(`No user found with email: ${email}`);
  process.exit(1);
}

const user = result.rows[0];
console.log(`✅ ${user.name || user.email} is now an admin.`);
process.exit(0);
