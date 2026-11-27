import { chunkText } from "../v1/utils/chunkText.util.js";

// Where the annotated evidence of a question sits in the chunks of an index. The harness cuts the document with the server's own
// chunker (which collapses all whitespace), finds the quote in the text with its whitespace collapsed the same way, and asks which
// chunks the quote touches. The matching is exact and case-sensitive: a quote that is not found is listed, never matched loosely.
// Offsets count UTF-16 code units in the collapsed text, and an end is exclusive.

export interface Span {
    start: number;
    end: number;
}

// NFC (what the server stores), trimmed, every run of whitespace one space: the text as the chunker reads it. The split is the
// chunker's own, so the no-break space and the line separator count as whitespace here exactly as they do there.
export const normalizeForMatching = (text: string): string => text.normalize("NFC").trim().split(/\s+/).join(" ");

// The span of each chunk that chunkText(text, chunkSize) makes, in the collapsed text. The chunks are cut from the collapsed text,
// and each one is found right after the one before it: at the next character when a long word was cut in pieces, or after the single
// space that joined two words.
export const computeChunkSpans = (text: string, chunkSize: number): Span[] => {
    const collapsed = normalizeForMatching(text);
    const spans: Span[] = [];
    let position = 0;

    for (const chunk of chunkText(collapsed, chunkSize)) {
        const start = collapsed[position] === " " ? position + 1 : position;

        if (!collapsed.startsWith(chunk, start)) {
            throw new Error("A chunk was not found where the chunker's own cut says it is");
        }

        spans.push({ start, end: start + chunk.length });
        position = start + chunk.length;
    }

    return spans;
};

// Every occurrence of the quote in the text, both collapsed, in order (overlapping ones too). An empty quote has none.
export const findEvidenceOccurrences = (text: string, quote: string): Span[] => {
    const collapsed = normalizeForMatching(text);
    const wanted = normalizeForMatching(quote);
    const occurrences: Span[] = [];

    if (wanted === "") {
        return occurrences;
    }

    let from = collapsed.indexOf(wanted);

    while (from !== -1) {
        occurrences.push({ start: from, end: from + wanted.length });
        from = collapsed.indexOf(wanted, from + 1);
    }

    return occurrences;
};

// The indexes of the chunks whose span shares at least one character with the occurrence, in order. Spans that only touch at an end
// do not overlap.
export const chunksOverlapping = (spans: Span[], occurrence: Span): number[] =>
    spans.flatMap((span, index) => (span.start < occurrence.end && occurrence.start < span.end ? [index] : []));
