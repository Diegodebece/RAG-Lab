import type { Pool } from "pg";
import { pool } from "../config/db.config.js";

interface RoleRights {
    isSuperuser: boolean;
    canCreateRoles: boolean;
    canCreateDatabases: boolean;
    canCreateInPublic: boolean;
    ownsObjectsInPublic: boolean;
}

// What the role this pool connects as can do beyond reading and changing rows. The API needs nothing more, so a role
// that can is a mistake in DATABASE_URL (the owner's URL, most likely) and any flaw in a route would reach the whole
// database through it. The check is by capability, not by name: a role that can do none of this is accepted.
// Objects: tables, partitioned tables, views, materialized views, foreign tables and sequences.
export const getDatabaseRoleProblemsService = async (targetPool: Pool = pool): Promise<string[]> => {
    const { rows } = await targetPool.query<RoleRights>(
        `SELECT r.rolsuper AS "isSuperuser",
                r.rolcreaterole AS "canCreateRoles",
                r.rolcreatedb AS "canCreateDatabases",
                has_schema_privilege(r.oid, 'public', 'CREATE') AS "canCreateInPublic",
                EXISTS (
                    SELECT 1 FROM pg_class c
                    WHERE c.relnamespace = 'public'::regnamespace
                      AND c.relowner = r.oid
                      AND c.relkind IN ('r', 'p', 'v', 'm', 'f', 'S')
                ) AS "ownsObjectsInPublic"
         FROM pg_roles r
         WHERE r.rolname = current_user`
    );

    const rights = rows[0];
    const problems: string[] = [];

    // current_user is always a row of pg_roles; an empty answer would be a database that hides it, which is not an
    // API role either
    if (!rights) {
        return ["the role cannot be inspected"];
    }

    if (rights.isSuperuser) {
        problems.push("the role is a superuser");
    }

    if (rights.canCreateRoles) {
        problems.push("the role can create roles");
    }

    if (rights.canCreateDatabases) {
        problems.push("the role can create databases");
    }

    if (rights.canCreateInPublic) {
        problems.push("the role can create objects in the public schema");
    }

    if (rights.ownsObjectsInPublic) {
        problems.push("the role owns tables in the public schema");
    }

    return problems;
};
