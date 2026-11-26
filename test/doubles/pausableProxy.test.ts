import { after, describe, it } from "node:test";
import assert from "node:assert/strict";
import { connect, createServer } from "node:net";
import type { AddressInfo, Socket } from "node:net";
import { startPausableProxy, urlThroughProxy } from "./pausableProxy.js";

// The double itself: the tests that use it trust these behaviors.
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

// an echo server: whatever it receives, it sends back
const echo = createServer((socket) => {
    socket.on("data", (chunk) => socket.write(chunk));
    socket.on("error", () => {});
});
await new Promise<void>((resolve) => echo.listen(0, "127.0.0.1", resolve));
const proxy = await startPausableProxy({ host: "127.0.0.1", port: (echo.address() as AddressInfo).port });

after(async () => {
    await proxy.close();
    await new Promise<void>((resolve) => {
        echo.close(() => resolve());
    });
});

const openClient = async (): Promise<{ socket: Socket; received: () => string }> => {
    const socket = connect(proxy.port, "127.0.0.1");
    let received = "";
    socket.on("data", (chunk) => { received += chunk.toString(); });
    socket.on("error", () => {});
    await new Promise<void>((resolve) => socket.once("connect", () => resolve()));
    return { socket, received: () => received };
};

describe("pausable proxy", () => {
    it("forwards data in both directions until it is paused", { timeout: 5000 }, async () => {
        const client = await openClient();

        client.socket.write("ping");
        await sleep(200);

        assert.equal(client.received(), "ping");
        client.socket.destroy();
    });

    it("keeps connections open but forwards nothing while paused, and delivers it after resume", { timeout: 5000 }, async () => {
        const client = await openClient();
        proxy.pause();

        client.socket.write("held");
        await sleep(300);
        assert.equal(client.received(), "", "nothing came back while paused");
        assert.equal(client.socket.destroyed, false, "the connection is still open");

        proxy.resume();
        await sleep(200);
        assert.equal(client.received(), "held");
        client.socket.destroy();
    });

    it("destroys the open connections when closed", { timeout: 5000 }, async () => {
        const other = await startPausableProxy({ host: "127.0.0.1", port: (echo.address() as AddressInfo).port });
        const socket = connect(other.port, "127.0.0.1");
        socket.on("error", () => {});
        await new Promise<void>((resolve) => socket.once("connect", () => resolve()));

        const closed = new Promise<void>((resolve) => socket.once("close", () => resolve()));
        await other.close();

        await Promise.race([closed, sleep(2000).then(() => assert.fail("the connection stayed open"))]);
    });

    it("rewrites a connection string to go through the proxy, keeping the credentials and the database", () => {
        assert.equal(
            urlThroughProxy("postgres://user:pw@127.0.0.1:25432/some_test", 40000),
            "postgres://user:pw@127.0.0.1:40000/some_test"
        );
    });
});
