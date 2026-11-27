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

    // an array with a hole is not what JSON can hold: JSON.stringify writes null for the hole, and a join would write
    // nothing, so a snapshot with a hole would hash like one that had a different value there
    it("refuses an array with holes, the way it refuses undefined, whole or as a value", () => {
        const leadingHole: unknown[] = new Array(2);
        leadingHole[1] = 1;
        const trailingHole: unknown[] = new Array(2);
        trailingHole[0] = 1;
        const onlyHoles: unknown[] = new Array(3);

        for (const sparse of [leadingHole, trailingHole, onlyHoles]) {
            assert.ok(Object.keys(sparse).length < sparse.length, "the array under test does have a hole");
            assert.throws(() => toCanonicalJson(sparse as never), JSON.stringify(sparse));
            assert.throws(() => toCanonicalJson({ a: sparse } as never));
            assert.throws(() => toCanonicalJson({ a: { b: [sparse] } } as never));
        }

        assert.equal(toCanonicalJson([1, 2]), "[1,2]", "a full array is still fine");
        assert.equal(toCanonicalJson([]), "[]", "and so is an empty one");
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

// A search runs with the six settings of retrieval and nothing else (the answer settings do not apply to it), so what it stores
// and hashes is { kind: "retrieval", version, settings: <those six> }. Two searches that differ only in an answer setting are
// the same search and have one hash. The function is loaded by name inside the tests, so the tests above do not depend on it.
const snapshotModule = await import("../../src/v1/utils/configurationSnapshot.util.js");

const RETRIEVAL_KEYS = ["chunkSize", "embeddingModel", "minScore", "neighborWindow", "retrievalMode", "topK"];

const fullSnapshot = (changes: Record<string, string | number> = {}) => ({ version: 1, settings: { ...DEFAULT_SETTINGS, ...changes } });

describe("toRetrievalSnapshot", () => {
    it("holds exactly kind, version and the six retrieval settings, and none of the five answer settings", () => {
        const retrieval = snapshotModule.toRetrievalSnapshot(fullSnapshot({ topK: 5, temperature: 0.7 }) as never);

        assert.deepEqual(Object.keys(retrieval).sort(), ["kind", "settings", "version"]);
        assert.equal(retrieval.kind, "retrieval");
        assert.equal(retrieval.version, 1);
        assert.deepEqual(Object.keys(retrieval.settings).sort(), RETRIEVAL_KEYS);
        assert.deepEqual(retrieval.settings, {
            chunkSize: 1000, embeddingModel: "qwen3-embedding:0.6b", retrievalMode: "vector", topK: 5, minScore: 0.3, neighborWindow: 1
        });

        for (const answerKey of ["smallModel", "temperature", "maxTokens", "answerLanguage", "answerMode"]) {
            assert.equal(Object.hasOwn(retrieval.settings, answerKey), false, answerKey);
        }
    });

    it("is frozen, with its settings: assigning anything throws a TypeError", () => {
        const retrieval = snapshotModule.toRetrievalSnapshot(fullSnapshot() as never) as unknown as { kind: string; version: number; settings: Record<string, unknown> };

        assert.ok(Object.isFrozen(retrieval), "the snapshot");
        assert.ok(Object.isFrozen(retrieval.settings), "its settings");
        assert.throws(() => { retrieval.settings.topK = 99; }, TypeError);
        assert.throws(() => { retrieval.settings.temperature = 1; }, TypeError);
        assert.throws(() => { retrieval.kind = "answer"; }, TypeError);
        assert.equal(retrieval.settings.topK, 3, "nothing was changed");
    });

    it("copies the six keys by own property: a key that exists only on the prototype is not read", () => {
        const inherited = Object.create({ topK: 30 }) as Record<string, unknown>;
        Object.assign(inherited, { chunkSize: 1000, embeddingModel: "qwen3-embedding:0.6b", retrievalMode: "vector", minScore: 0.3, neighborWindow: 1 });

        const retrieval = snapshotModule.toRetrievalSnapshot({ version: 1, settings: inherited } as never);

        assert.equal(Object.hasOwn(retrieval.settings, "topK"), false, "the inherited topK was not copied");
    });

    it("gives the same hash for two full snapshots that differ only in an answer setting, such as temperature", () => {
        const hashOf = (snapshot: ReturnType<typeof fullSnapshot>): string =>
            hashSnapshotText(toCanonicalJson(snapshotModule.toRetrievalSnapshot(snapshot as never)));

        assert.equal(hashOf(fullSnapshot({ temperature: 0 })), hashOf(fullSnapshot({ temperature: 0.9 })));
        assert.equal(hashOf(fullSnapshot({ answerLanguage: "en" })), hashOf(fullSnapshot({ answerLanguage: "es", maxTokens: 5, answerMode: "structured" })));
    });

    it("gives different hashes when a retrieval setting differs: topK, chunk size, minimum score and neighbor window (the other two have one allowed value)", () => {
        const hashOf = (snapshot: ReturnType<typeof fullSnapshot>): string =>
            hashSnapshotText(toCanonicalJson(snapshotModule.toRetrievalSnapshot(snapshot as never)));
        const base = hashOf(fullSnapshot());

        assert.notEqual(hashOf(fullSnapshot({ topK: 4 })), hashOf(fullSnapshot({ topK: 5 })));

        const changes: Record<string, string | number>[] = [{ chunkSize: 500 }, { minScore: 0.4 }, { neighborWindow: 2 }, { topK: 4 }];

        for (const change of changes) {
            assert.notEqual(hashOf(fullSnapshot(change)), base, JSON.stringify(change));
        }
    });

    it("hashes to the SHA-256 of the canonical text of { kind, version, settings }, computed here on its own", () => {
        const retrieval = snapshotModule.toRetrievalSnapshot(fullSnapshot({ topK: 7, minScore: 0.45 }) as never);
        const expectedText = canonicalText({
            kind: "retrieval",
            version: 1,
            settings: { chunkSize: 1000, embeddingModel: "qwen3-embedding:0.6b", retrievalMode: "vector", topK: 7, minScore: 0.45, neighborWindow: 1 }
        });

        assert.equal(toCanonicalJson(retrieval), expectedText);
        assert.equal(hashSnapshotText(expectedText), sha256Hex(expectedText));
        assert.equal(hashSnapshotText(toCanonicalJson(retrieval)), sha256Hex(expectedText));
        assert.match(hashSnapshotText(toCanonicalJson(retrieval)), /^[0-9a-f]{64}$/);
    });

    it("writes the default retrieval snapshot as this literal text, so its hash changes only when the values of version 1 change", () => {
        const retrieval = snapshotModule.toRetrievalSnapshot(fullSnapshot() as never);

        assert.equal(
            toCanonicalJson(retrieval),
            "{\"kind\":\"retrieval\",\"settings\":{\"chunkSize\":1000,\"embeddingModel\":\"qwen3-embedding:0.6b\",\"minScore\":0.3,\"neighborWindow\":1,\"retrievalMode\":\"vector\",\"topK\":3},\"version\":1}"
        );
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
