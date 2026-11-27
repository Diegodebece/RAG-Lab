import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { freezeSnapshot, hashSnapshotText, toCanonicalJson } from "../../src/v1/utils/configurationSnapshot.util.js";
import { DEFAULT_SETTINGS, DEFAULT_SNAPSHOT, DEFAULT_SNAPSHOT_HASH, DEFAULT_SNAPSHOT_TEXT, canonicalText, sha256Hex } from "../configurationFixtures.js";

// A snapshot is stored next to a question's metrics, and its hash says whether two questions used the same
// configuration, so the text it is hashed from has to be the same whatever order the keys came in.

describe("toCanonicalJson", () => {
    it("writes the keys sorted at every level, with no spaces", () => {
        const text = toCanonicalJson({ b: 1, a: { d: [{ z: 1, y: 2 }, 3], c: "x y" } });

        assert.equal(text, "{\"a\":{\"c\":\"x y\",\"d\":[{\"y\":2,\"z\":1},3]},\"b\":1}");
    });

    it("keeps the order of a list", () => {
        assert.equal(toCanonicalJson({ list: [3, 1, 2] }), "{\"list\":[3,1,2]}");
    });

    it("writes the default snapshot as the literal text the tests expect", () => {
        assert.equal(toCanonicalJson(DEFAULT_SNAPSHOT), DEFAULT_SNAPSHOT_TEXT);
    });

    it("gives the same text whatever order the keys arrived in", () => {
        const forward = { version: 1, settings: { topK: 5, answerLanguage: "es", temperature: 0.5 } };
        const backward = { settings: { temperature: 0.5, answerLanguage: "es", topK: 5 }, version: 1 };

        assert.equal(toCanonicalJson(forward), toCanonicalJson(backward));
        assert.equal(toCanonicalJson(forward), canonicalText(forward));
    });

    it("writes text and numbers as JSON does, without escaping non-ASCII characters it does not have to", () => {
        const value = { name: `caf${String.fromCodePoint(0xe9)}`, quote: "a\"b", zero: 0, decimal: 0.3 };

        assert.equal(toCanonicalJson(value), canonicalText(value));
    });

    it("refuses undefined, whole or as a value", () => {
        assert.throws(() => toCanonicalJson(undefined as never));
        assert.throws(() => toCanonicalJson({ a: undefined } as never));
        assert.throws(() => toCanonicalJson({ a: [1, undefined] } as never));
    });

    it("refuses a function, whole or as a value", () => {
        assert.throws(() => toCanonicalJson((() => 1) as never));
        assert.throws(() => toCanonicalJson({ a: () => 1 } as never));
        assert.throws(() => toCanonicalJson({ a: { b: [() => 1] } } as never));
    });

    it("refuses NaN and both infinities, at any depth", () => {
        for (const value of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
            assert.throws(() => toCanonicalJson(value as never), String(value));
            assert.throws(() => toCanonicalJson({ a: value } as never), String(value));
            assert.throws(() => toCanonicalJson({ a: { b: [value] } } as never), String(value));
        }
    });
});

describe("hashSnapshotText", () => {
    it("is the SHA-256 of the UTF-8 text, in lowercase hexadecimal, computed independently with node:crypto", () => {
        for (const text of ["", "abc", DEFAULT_SNAPSHOT_TEXT, `caf${String.fromCodePoint(0xe9, 0x1f600)}`]) {
            const hash = hashSnapshotText(text);

            assert.match(hash, /^[0-9a-f]{64}$/);
            assert.equal(hash, sha256Hex(text), JSON.stringify(text));
        }
    });

    it("gives the known SHA-256 of 'abc', and a fixed literal for the default snapshot", () => {
        assert.equal(hashSnapshotText("abc"), "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
        assert.equal(hashSnapshotText(DEFAULT_SNAPSHOT_TEXT), DEFAULT_SNAPSHOT_HASH);
    });

    it("gives the same hash for the same snapshot written with its keys in another order", () => {
        const forward = { version: 1, settings: { ...DEFAULT_SETTINGS } };
        const backward = { settings: Object.fromEntries(Object.entries(DEFAULT_SETTINGS).reverse()), version: 1 };

        assert.equal(hashSnapshotText(toCanonicalJson(forward)), hashSnapshotText(toCanonicalJson(backward)));
        assert.equal(hashSnapshotText(toCanonicalJson(forward)), DEFAULT_SNAPSHOT_HASH);
    });

    it("changes when one setting changes", () => {
        const changed = { version: 1, settings: { ...DEFAULT_SETTINGS, topK: 4 } };

        assert.notEqual(hashSnapshotText(toCanonicalJson(changed)), DEFAULT_SNAPSHOT_HASH);
    });
});

describe("freezeSnapshot", () => {
    it("freezes the snapshot and its settings, so assigning a setting throws a TypeError", () => {
        const frozen = freezeSnapshot({ version: 1, settings: { ...DEFAULT_SETTINGS } } as never);
        const snapshot = frozen as unknown as { version: number; settings: Record<string, unknown> };

        assert.ok(Object.isFrozen(snapshot), "the snapshot");
        assert.ok(Object.isFrozen(snapshot.settings), "its settings");
        assert.throws(() => { snapshot.settings.topK = 99; }, TypeError);
        assert.throws(() => { snapshot.settings.extra = 1; }, TypeError);
        assert.throws(() => { snapshot.version = 2; }, TypeError);
        assert.equal(snapshot.settings.topK, 3, "nothing was changed");
    });

    it("keeps the values it was given", () => {
        const frozen = freezeSnapshot({ version: 1, settings: { ...DEFAULT_SETTINGS } } as never);

        assert.deepEqual(frozen, DEFAULT_SNAPSHOT);
    });
});
