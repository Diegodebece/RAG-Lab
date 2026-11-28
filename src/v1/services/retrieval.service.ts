import { pool } from "../config/db.config.js";
import type { ChunkText, ScoredChunk } from "../types/chunks.type.js";
import type { Fragment } from "../types/runs.type.js";
import { buildFragments, getNeighborIndexes } from "../utils/fragments.util.js";

// the question-time settings the search itself reads, from the resolved configuration
interface FragmentOptions {
    topK: number;
    minScore: number;
    neighborWindow: number;
}

// The fragments for a question: the closest chunks of one index (the best `topK` with a cosine similarity of at least
// `minScore`) followed by their neighbors within the window. An empty list means no chunk was close enough. Ported from RAG Web,
// whose query searched a document with fixed values; here the search is over one index, and topK and minScore come from the
// configuration. The search is exact: it scans the index's chunks with no vector index (layer 4's decision D12 is measured by
// the retrieval harness, not guessed). The owner and the status are checked again in the query, as defence in depth: the caller
// found the index through the document's owner, and this never trusts that alone.
export const findFragmentsService = async (userId: string, indexId: string, questionVector: number[], options: FragmentOptions): Promise<Fragment[]> => {
    const vector = JSON.stringify(questionVector);

    // <=> is the cosine distance, so 1 - distance is the similarity; ties keep the document's order. PostgreSQL treats NaN as greater
    // than every number, so a chunk whose distance is NaN (a norm that under- or overflows float4: only the owner can store one) would
    // pass the minimum and be returned with a score that JSON writes as null: it is left out here, and buildFragments refuses any
    // score that is still not finite.
    const { rows: matches } = await pool.query<ScoredChunk>(
        `SELECT c.chunk_index AS "chunkIndex", c.text, (1 - (c.embedding <=> $3::vector))::float8 AS score
         FROM chunks c
         JOIN document_indexes di ON di.id = c.index_id
         JOIN documents d ON d.id = di.document_id
         WHERE c.index_id = $1 AND d.user_id = $2 AND di.status = 'ready' AND c.embedding IS NOT NULL
           AND NOT ((c.embedding <=> $3::vector) = 'NaN'::float8)
           AND 1 - (c.embedding <=> $3::vector) >= $4
         ORDER BY c.embedding <=> $3::vector, c.chunk_index
         LIMIT $5`,
        [indexId, userId, vector, options.minScore, options.topK]
    );

    if (matches.length === 0) {
        return [];
    }

    // the matches already proved the index is the user's and ready
    const { rows: neighbors } = await pool.query<ChunkText>(
        "SELECT chunk_index AS \"chunkIndex\", text FROM chunks WHERE index_id = $1 AND chunk_index = ANY($2::int[])",
        [indexId, getNeighborIndexes(matches, options.neighborWindow)]
    );

    return buildFragments(matches, neighbors, options.neighborWindow);
};
