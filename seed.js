// Creates the first admin account. Run once after loading schema.sql:
//   npm run seed
import "./lib/env.js"; // resolve .env in dev and packaged runs alike
import bcrypt from "bcryptjs";
import { pool } from "./db.js";

async function seed() {
  const username = process.env.SEED_ADMIN_USERNAME || "admin";
  const password = process.env.SEED_ADMIN_PASSWORD || "monkey123";
  const fullName = process.env.SEED_ADMIN_NAME || "Gym Admin";

  const hash = await bcrypt.hash(password, 10);

  const result = await pool.query(
    `INSERT INTO app_user (username, password_hash, full_name)
     VALUES ($1, $2, $3)
     ON CONFLICT (username) DO NOTHING
     RETURNING id`,
    [username, hash, fullName],
  );

  if (result.rowCount > 0) {
    console.log(
      `Created admin account "${username}" with password "${password}".`,
    );
    console.log("Log in, then change it with reset-password.js.");
  } else {
    console.log(`Admin "${username}" already exists. Nothing to do.`);
  }

  await pool.end();
}

seed().catch((err) => {
  console.error("Seed failed:", err.message);
  process.exit(1);
});
