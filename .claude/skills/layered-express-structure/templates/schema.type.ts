// How the database's schema compares with the migration files of this checkout
export interface MigrationState {
    // in the files and recorded in the database
    applied: string[];
    // in the files but not yet recorded: npm run migrate applies them
    pending: string[];
    // recorded in the database but not in the files: the database belongs to another checkout or project
    unknown: string[];
    // tables the public schema already has when there is no schema_migrations table: the database was not made
    // by this project's migrations, so it looks like another project's. Empty once schema_migrations exists.
    foreignTables: string[];
}
