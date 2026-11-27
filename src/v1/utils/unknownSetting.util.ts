// How many characters of an unknown setting key an error repeats. A body may carry a key of many thousands of
// characters, and it must not become an answer, a log line or a stored detail of the same size.
const MAX_ECHOED_KEY_LENGTH = 64;

const ELLIPSIS = String.fromCodePoint(0x2026);

// The text of the error for a key that is not a setting: the key as it was given up to 64 characters, and past that its
// first 64 followed by an ellipsis. Characters are counted as code points, so a pair of surrogates is never cut in half.
export const unknownSettingMessage = (key: string): string => {
    const characters = Array.from(key);

    if (characters.length <= MAX_ECHOED_KEY_LENGTH) {
        return `Unknown setting: ${key}`;
    }

    return `Unknown setting: ${characters.slice(0, MAX_ECHOED_KEY_LENGTH).join("")}${ELLIPSIS}`;
};
