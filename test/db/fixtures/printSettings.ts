import { OPERATIONAL_DEFAULTS } from "../../operationalSettings.js";

// Run by test/db/testSetup.test.ts in a child process, after test/setup.ts: prints the operational settings
// the app would read, as JSON.
console.log(JSON.stringify(Object.fromEntries(Object.keys(OPERATIONAL_DEFAULTS).map((name) => [name, process.env[name] ?? null]))));
