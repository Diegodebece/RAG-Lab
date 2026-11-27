// The numbers of a sweep: where the evidence of a question ranks among the matches, whether it is inside the top k, and whether the whole
// of it is inside what the answer model would read (the top k matches plus their neighbors). Pure functions over the matches the API gave.

// a match as the harness keeps it: the chunk and its cosine similarity; the matches come best first, so the first is rank 1
export interface Match {
    chunkIndex: number;
    score: number;
}

// One passage of the evidence: each occurrence of the quote in the text is the list of the chunks it touches (a quote that crosses
// a cut touches two).
export interface Passage {
    occurrences: number[][];
}

// the matches whose score is at least minScore, in order: what a search with that minimum would have kept
export const applyMinScore = (matches: Match[], minScore: number): Match[] => matches.filter((match) => match.score >= minScore);

// The rank (1 is the first match) of the first match that is a chunk of any occurrence of any passage, or null when none is.
export const findRank = (matches: Match[], passages: Passage[]): number | null => {
    const evidence = new Set(passages.flatMap((passage) => passage.occurrences.flat()));
    const position = matches.findIndex((match) => evidence.has(match.chunkIndex));

    return position === -1 ? null : position + 1;
};

export const hitAtK = (matches: Match[], passages: Passage[], k: number): boolean => {
    const rank = findRank(matches, passages);

    return rank !== null && rank <= k;
};

// whether every passage has an occurrence whose chunks are all in the set
const coversEveryPassage = (covered: Set<number>, passages: Passage[]): boolean =>
    passages.every((passage) => passage.occurrences.some((chunks) => chunks.every((chunk) => covered.has(chunk))));

// whether every passage has an occurrence whose chunks are all among the first k matches
export const fullAtK = (matches: Match[], passages: Passage[], k: number): boolean =>
    coversEveryPassage(new Set(matches.slice(0, k).map((match) => match.chunkIndex)), passages);

// the same, with the chunks up to `window` away from each of the first k matches too: what the answer model reads
export const contextAtK = (matches: Match[], passages: Passage[], k: number, window: number): boolean => {
    const covered = new Set<number>();

    for (const match of matches.slice(0, k)) {
        for (let chunk = match.chunkIndex - window; chunk <= match.chunkIndex + window; chunk += 1) {
            covered.add(chunk);
        }
    }

    return coversEveryPassage(covered, passages);
};

// The value at rank ceil(percent / 100 * n) of the values sorted up, counting from 1 (nearest rank: always one of the values). The
// list it is given is not changed. Written as percent * n / 100 so a whole percent gives an exact rank.
export const nearestRankPercentile = (values: number[], percent: number): number => {
    if (values.length === 0) {
        throw new RangeError("A percentile needs at least one value");
    }

    const sorted = [...values].sort((first, second) => first - second);
    const rank = Math.min(Math.max(Math.ceil((percent * sorted.length) / 100), 1), sorted.length);

    return sorted[rank - 1];
};

// the highest score of the matches, or null for none
export const topScore = (matches: Match[]): number | null =>
    matches.length === 0 ? null : matches.reduce((highest, match) => Math.max(highest, match.score), -Infinity);
