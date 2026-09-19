// Reset a login password.
//
// NOTE: passwords are stored as bcrypt hashes (one-way) — they CANNOT be
// decrypted. To recover access you set a NEW password, which is what this does.
//
// Usage (password via env is preferred — a CLI arg is visible in shell history
// and the process list):
//   RESET_USERNAME=admin RESET_PASSWORD='new-strong-pass' node reset-password.js
//   node reset-password.js <username> <newPassword>
import './lib/env.js'; // resolve .env in dev and packaged runs alike
import bcrypt from 'bcryptjs';
import { pool } from './db.js';

async function main() {
  const username = process.argv[2] || process.env.RESET_USERNAME;
  const password = process.argv[3] || process.env.RESET_PASSWORD;

  if (!username || !password) {
    console.error('Usage: node reset-password.js <username> <newPassword>');
    console.error('   or: RESET_USERNAME=… RESET_PASSWORD=… node reset-password.js');
    process.exit(1);
  }

  const hash = await bcrypt.hash(password, 10);
  const { rowCount } = await pool.query(
    'UPDATE app_user SET password_hash = $1 WHERE username = $2',
    [hash, username]
  );

  if (rowCount === 0) {
    console.error(`No account named "${username}". Existing users:`);
    const { rows } = await pool.query('SELECT username FROM app_user ORDER BY username');
    rows.forEach((r) => console.error(`  - ${r.username}`));
    process.exitCode = 1;
  } else {
    console.log(`Password for "${username}" has been reset.`);
  }

  await pool.end();
}

main().catch((err) => {
  console.error('Reset failed:', err.message);
  process.exit(1);
});
