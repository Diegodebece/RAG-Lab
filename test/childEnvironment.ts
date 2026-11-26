import { OPERATIONAL_DEFAULTS } from "./operationalSettings.js";

// The environment of a child process a test starts (the server, the migration script): the test process's own
// environment, but with every operational setting at its test default and without a SECRET_KEY, so nothing the
// developer or an earlier test left in process.env changes what the child does. A value of undefined in
// overrides removes the variable.
export const cleanChildEnvironment = (overrides: Record<string, string | undefined> = {}): NodeJS.ProcessEnv => {
    const env: NodeJS.ProcessEnv = { ...process.env, ...OPERATIONAL_DEFAULTS };
    delete env.SECRET_KEY;

    for (const [name, value] of Object.entries(overrides)) {
        if (value === undefined) {
            delete env[name];
        } else {
            env[name] = value;
        }
    }

    return env;
};
