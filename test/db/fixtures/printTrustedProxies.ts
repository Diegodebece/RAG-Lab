// Run by test/db/testSetup.test.ts in a child process, after test/setup.ts: prints the proxy setting of the real app.
const { app } = await import("../../../src/app.js");
const { pool } = await import("../../../src/v1/config/db.config.js");

console.log(JSON.stringify(app.get("trust proxy")));
await pool.end();
