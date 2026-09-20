export function readDbConfig(env = process.env) {
  return {
    host: env.PGHOST,
    port: Number(env.PGPORT) || 5432,
    database: env.PGDATABASE,
    user: env.PGUSER,
    password: env.PGPASSWORD,
    ...(env.PGSSL === '1' || env.PGSSL === 'true'
      ? { ssl: { rejectUnauthorized: true } }
      : {}),
  };
}