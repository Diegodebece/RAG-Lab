import type { ChunkText, ScoredChunk } from "../types/chunks.type.js";
import type { Fragment } from "../types/runs.type.js";

// The chunk positions of one match that are its neighbors, in document order: m-window ... m-1, m+1 ... m+window (decision D7:
// at window 1 this is RAG Web's order, previous then next; the order at window 2 was never measured).
const neighborPositionsOf = (chunkIndex: number, window: number): number[] => {
    const positions: number[] = [];

    for (let distance = window; distance >= 1; distance -= 1) {
        positions.push(chunkIndex - distance);
    }

    for (let distance = 1; distance <= window; distance += 1) {
        positions.push(chunkIndex + distance);
    }

    return positions;
};

// Chunk positions within `window` of each match that are not matches themselves, once each, in the order of their first
// appearance. Positions past the end of the document are not filtered here; looking them up simply finds nothing.
export const getNeighborIndexes = (matches: Pick<ChunkText, "chunkIndex">[], window: number): number[] => {
    const matchIndexes = new Set(matches.map((match) => match.chunkIndex));
    const neighborIndexes = new Set<number>();

    for (const match of matches) {
        for (const index of neighborPositionsOf(match.chunkIndex, window)) {
            if (index >= 0 && !matchIndexes.has(index)) {
                neighborIndexes.add(index);
            }
        }
    }

    return [...neighborIndexes];
};

// Matches first (best score first), then the neighbors of each match within the window, without duplicates. At window 1 it is the
// order of RAG1 and RAG Web, so the ids F1..Fn the model sees are the ones it was evaluated with.
export const buildFragments = (matches: ScoredChunk[], neighbors: ChunkText[], window: number): Fragment[] => {
    const neighborsByIndex = new Map(neighbors.map((neighbor) => [neighbor.chunkIndex, neighbor]));
    const included = new Set(matches.map((match) => match.chunkIndex));
    const ordered: Omit<Fragment, "id">[] = matches.map((match) => ({
        chunkIndex: match.chunkIndex,
        text: match.text,
        retrieval: "match",
        score: match.score
    }));

    for (const match of matches) {
        for (const index of neighborPositionsOf(match.chunkIndex, window)) {
            const neighbor = neighborsByIndex.get(index);

            if (neighbor === undefined || included.has(index)) {
                continue;
            }

            ordered.push({ chunkIndex: neighbor.chunkIndex, text: neighbor.text, retrieval: "neighbor" });
            included.add(index);
        }
    }

    return ordered.map((fragment, position) => ({ id: `F${position + 1}`, ...fragment }));
};
