import { execSync } from "node:child_process";
import { rmSync } from "node:fs";
import path from "node:path";

/** Fresh SQLite test DB with all migrations applied. */
export default function setup() {
  const db = path.resolve(__dirname, "../prisma/test.db");
  rmSync(db, { force: true });
  rmSync(`${db}-journal`, { force: true });
  execSync("npx prisma migrate deploy", {
    stdio: "inherit",
    env: { ...process.env, DATABASE_URL: "file:./test.db" },
  });
  return () => rmSync(db, { force: true });
}
