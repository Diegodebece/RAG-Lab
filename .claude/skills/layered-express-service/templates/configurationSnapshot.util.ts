import { createHash } from "node:crypto";
import type { ConfigurationSnapshot } from "../types/configuration.type.js";

const isPlainObject = (value: object): value is Record<string, unknown> => {
    const prototype = Object.getPrototypeOf(value);
    return prototype === Object.prototype || prototype === null;
};

// The text of a value as JSON with the keys sorted at every level and no spaces, so the same configuration always gives
// the same text (and the same hash) whatever order its keys arrived in. Only what JSON can hold is accepted: a value
// that JSON.stringify would silently drop or turn into null (undefined, a function, NaN, an infinity, a hole in an array) is an error here,
// because a snapshot that lost a value would hash like one that never had it.
export const toCanonicalJson = (value: unknown): string => {
    if (value === null) {
        return "null";
    }

    switch (typeof value) {
        case "string":
            return JSON.stringify(value);
        case "boolean":
            return value ? "true" : "false";
        case "number":
            if (!Number.isFinite(value)) {
                throw new TypeError("A configuration snapshot cannot hold NaN or an infinity");
            }
            return JSON.stringify(value);
        case "object": {
            if (Array.isArray(value)) {
                // a hole is not a value JSON can hold: map would skip it and the join would write nothing in its place
                for (let index = 0; index < value.length; index += 1) {
                    if (!Object.hasOwn(value, index)) {
                        throw new TypeError("A configuration snapshot cannot hold an array with holes");
                    }
                }

                return `[${value.map(toCanonicalJson).join(",")}]`;
            }

            if (!isPlainObject(value)) {
                throw new TypeError("A configuration snapshot can hold only plain objects");
            }

            const members = Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${toCanonicalJson(value[key])}`);
            return `{${members.join(",")}}`;
        }
        default:
            throw new TypeError(`A configuration snapshot cannot hold a value of type ${typeof value}`);
    }
};

// SHA-256 of the text as UTF-8, in lowercase hexadecimal
export const hashSnapshotText = (text: string): string => createHash("sha256").update(text, "utf8").digest("hex");

// A copy of the snapshot that nothing can change: the snapshot and its settings are frozen, so a question that runs
// with it cannot alter what it later stores as the configuration it used.
export const freezeSnapshot = (snapshot: ConfigurationSnapshot): Readonly<ConfigurationSnapshot> =>
    Object.freeze({ version: snapshot.version, settings: Object.freeze({ ...snapshot.settings }) });
