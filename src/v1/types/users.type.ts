export type UserRole = "user" | "admin";

export type UserStatus = "active" | "disabled";

// what the API returns about a user; never includes the password hash or the token version
export interface User {
    id: string;
    email: string;
    role: UserRole;
    status: UserStatus;
    createdAt: Date;
}

// the whole row, only for checking a password and signing a token; must never be returned
export interface UserRecord extends User {
    passwordHash: string;
    tokenVersion: number;
}
