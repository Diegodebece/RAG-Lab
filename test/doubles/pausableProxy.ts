import { connect, createServer } from "node:net";
import type { AddressInfo, Socket } from "node:net";

// A TCP proxy between a test and a real server (the test database, for example) that can go silent: after
// pause() the connections stay open but no byte travels in either direction, like a network that drops
// packets or a server that froze. The code under test sees a connection that is established but never answers.
export interface PausableProxy {
    // the port the proxy listens on, on 127.0.0.1
    port: number;
    // stops forwarding data on every open connection, and on the ones opened later
    pause: () => void;
    // forwards what was held back, and everything from now on
    resume: () => void;
    // destroys every connection and stops listening
    close: () => Promise<void>;
}

export const startPausableProxy = async (target: { host: string; port: number }): Promise<PausableProxy> => {
    const sockets = new Set<Socket>();
    let paused = false;
    let held: (() => void)[] = [];

    const forward = (from: Socket, to: Socket): void => {
        from.on("data", (chunk: Buffer) => {
            const send = (): void => {
                to.write(chunk);
            };

            if (paused) {
                held.push(send);
            } else {
                send();
            }
        });
    };

    const server = createServer((client) => {
        const upstream = connect(target.port, target.host);
        sockets.add(client);
        sockets.add(upstream);

        forward(client, upstream);
        forward(upstream, client);

        const closeBoth = (): void => {
            client.destroy();
            upstream.destroy();
        };
        client.on("error", closeBoth);
        upstream.on("error", closeBoth);
        client.on("close", closeBoth);
        upstream.on("close", closeBoth);
    });

    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));

    return {
        port: (server.address() as AddressInfo).port,
        pause: () => {
            paused = true;
        },
        resume: () => {
            paused = false;
            const flush = held;
            held = [];
            flush.forEach((send) => send());
        },
        close: () => new Promise<void>((resolve) => {
            server.close(() => resolve());

            for (const socket of sockets) {
                socket.destroy();
            }
        })
    };
};

// The same connection string, pointed at the proxy instead of the server behind it.
export const urlThroughProxy = (connectionString: string, proxyPort: number): string => {
    const url = new URL(connectionString);
    url.hostname = "127.0.0.1";
    url.port = String(proxyPort);
    return url.toString();
};
