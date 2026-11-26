import type { Pool } from "pg";
import { pool } from "../config/db.config.js";

interface RoleRights {
    isSuperuser: boolean;
    canCreateRoles: boolean;
    canCreateDatabases: boolean;
    canCreateInPublic: boolean;
    canCreateInDatabase: boolean;
    ownsObjectsInPublic: boolean;
    isMemberOfRoles: boolean;
    actsAsAnotherRole: boolean;
}

// What the role this pool connects as can do beyond reading and changing rows. The API needs nothing more, so a role
// that can is a mistake in DATABASE_URL (the owner's URL, most likely) and any flaw in a route would reach the whole
// database through it. The check is by capability, not by name: a role that can do none of this is accepted.
// Objects: tables, partitioned tables, views, materialized views, foreign tables and sequences.
// The rights are read for current_user, the role the session acts as. A session that acts as another role than the one
// that logged in (the "role" connection option, or SET ROLE) would show these checks a harmless role while the rights
// of the login stay behind it, so that is a problem of its own; so is being a member of any role, which brings that
// role's rights (and may let the session take them with SET ROLE).
export const getDatabaseRoleProblemsService = async (targetPool: Pool = pool): Promise<string[]> => {
    const { rows } = await targetPool.query<RoleRights>(
        `SELECT r.rolsuper AS "isSuperuser",
                r.rolcreaterole AS "canCreateRoles",
                r.rolcreatedb AS "canCreateDatabases",
                has_schema_privilege(r.oid, 'public', 'CREATE') AS "canCreateInPublic",
                has_database_privilege(r.oid, current_database(), 'CREATE') AS "canCreateInDatabase",
                EXISTS (SELECT 1 FROM pg_auth_members m WHERE m.member = r.oid) AS "isMemberOfRoles",
                session_user <> current_user AS "actsAsAnotherRole",
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

    if (rights.canCreateInDatabase) {
        problems.push("the role can create objects in the database");
    }

    if (rights.ownsObjectsInPublic) {
        problems.push("the role owns tables in the public schema");
    }

    if (rights.isMemberOfRoles) {
        problems.push("the role is a member of another role");
    }

    if (rights.actsAsAnotherRole) {
        problems.push("the session acts as another role than the one that logged in");
    }

    return problems;
};
