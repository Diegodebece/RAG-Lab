import type { Server } from "node:http";
import type { Pool, PoolClient } from "pg";

// Stops the HTTP server without cutting the requests in progress: it stops accepting connections, closes the idle
// ones, ends the event streams (they would never finish on their own) and waits for the requests still running.
// Whatever is left after timeoutMs is closed, so the process always gets to exit.
export const closeServerGracefully = async (server: Server, endStreams: () => void, timeoutMs: number): Promise<void> => {
    const closed = new Promise<void>((resolve) => {
        server.close(() => resolve());
    });

    server.closeIdleConnections();
    endStreams();

    const forceClose = setTimeout(() => server.closeAllConnections(), timeoutMs);
    await closed;
    clearTimeout(forceClose);
};

// The connections the pool has lent and not yet got back. pg's public Pool API only counts them (totalCount minus
// idleCount) and fires "acquire"/"release" events for the ones lent from now on; it cannot list the ones lent
// before this code looked, and a stuck request is exactly one of those. So the pool's own lists are read here:
// the only place that depends on pg-pool's private fields, kept to the two arrays this needs.
const getCheckedOutClients = (pool: Pool): PoolClient[] => {
    // untyped boundary: pg-pool keeps all its clients in _clients and the idle ones, wrapped, in _idle
    const internals = pool as unknown as { _clients?: unknown; _idle?: unknown };

    if (!Array.isArray(internals._clients) || !Array.isArray(internals._idle)) {
        return [];
    }

    const idle = new Set<unknown>(internals._idle.map((item: { client?: unknown }) => item.client));
    return (internals._clients as PoolClient[]).filter((client) => !idle.has(client));
};

// Ends the pool: idle connections close at once, and connections that are lent out close when their request gives
// them back. A request stuck on a database that stopped answering never gives its connection back, so after
// timeoutMs those connections are destroyed (the query they run fails) and the function resolves anyway: it never
// rejects, so the process can always exit.
export const closePoolGracefully = async (pool: Pool, timeoutMs: number): Promise<void> => {
    // end() rejects only when the pool was already ended, and then there is nothing left to wait for
    const ended = pool.end().then(() => true, () => true);

    const waitFor = async (ms: number): Promise<boolean> => {
        let timer: NodeJS.Timeout | undefined;
        const timedOut = new Promise<boolean>((resolve) => {
            timer = setTimeout(() => resolve(false), ms);
        });

        try {
            return await Promise.race([ended, timedOut]);
        } finally {
            clearTimeout(timer);
        }
    };

    if (await waitFor(timeoutMs)) {
        return;
    }

    for (const client of getCheckedOutClients(pool)) {
        try {
            // release(true) removes the client from the pool and closes its connection; with a query running,
            // pg destroys the socket instead of waiting for an answer that will not come
            client.release(true);
        } catch {
            // already released by its request in the meantime: nothing left to destroy
        }
    }

    // destroying the sockets finishes the pool's end within moments; if it does not, the process exits anyway
    await waitFor(1000);
};
