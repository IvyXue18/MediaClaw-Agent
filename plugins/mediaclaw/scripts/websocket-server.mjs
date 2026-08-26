import crypto from "node:crypto";
import http from "node:http";

const WEBSOCKET_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";
const MAX_CLIENT_FRAME_BYTES = 1024 * 1024;
const MAX_HTTP_REQUEST_BODY_BYTES = 1024 * 1024;
const MAX_MESSAGES_PER_MINUTE = 180;

function isAllowedWebSocketOrigin(origin) {
  const normalized = String(origin || "").trim();
  return (
    !normalized ||
    normalized.startsWith("chrome-extension://") ||
    normalized.startsWith("moz-extension://")
  );
}

function encodeFrame(payload, opcode = 0x1) {
  const body = Buffer.isBuffer(payload)
    ? payload
    : Buffer.from(String(payload));
  const header = [];
  header.push(0x80 | opcode);
  if (body.length < 126) {
    header.push(body.length);
  } else if (body.length <= 0xffff) {
    header.push(126, (body.length >> 8) & 0xff, body.length & 0xff);
  } else {
    const size = Buffer.alloc(8);
    size.writeBigUInt64BE(BigInt(body.length));
    header.push(127, ...size);
  }
  return Buffer.concat([Buffer.from(header), body]);
}

function createSocketPeer(socket, handlers = {}) {
  let buffer = Buffer.alloc(0);
  let closed = false;
  let closeNotified = false;
  const messageTimes = [];

  function sendRaw(payload, opcode = 0x1) {
    if (closed || socket.destroyed) return false;
    socket.write(encodeFrame(payload, opcode));
    return true;
  }

  const peer = {
    send(payload) {
      return sendRaw(JSON.stringify(payload));
    },
    close(code = 1000, reason = "") {
      if (closed) return;
      const body = Buffer.alloc(2 + Buffer.byteLength(reason));
      body.writeUInt16BE(code, 0);
      body.write(reason, 2);
      sendRaw(body, 0x8);
      socket.end();
      closed = true;
    },
  };

  function consumeFrames() {
    while (buffer.length >= 2) {
      const first = buffer[0];
      const second = buffer[1];
      const opcode = first & 0x0f;
      const masked = Boolean(second & 0x80);
      let length = second & 0x7f;
      let offset = 2;

      if (length === 126) {
        if (buffer.length < 4) return;
        length = buffer.readUInt16BE(2);
        offset = 4;
      } else if (length === 127) {
        if (buffer.length < 10) return;
        const largeLength = buffer.readBigUInt64BE(2);
        if (largeLength > BigInt(Number.MAX_SAFE_INTEGER)) {
          peer.close(1009, "Frame too large");
          return;
        }
        length = Number(largeLength);
        offset = 10;
      }

      const maskBytes = masked ? 4 : 0;
      if (!masked || length > MAX_CLIENT_FRAME_BYTES) {
        peer.close(1009, "Invalid or oversized client frame");
        return;
      }
      const frameEnd = offset + maskBytes + length;
      if (buffer.length < frameEnd) return;
      const mask = masked ? buffer.subarray(offset, offset + 4) : null;
      const payload = Buffer.from(
        buffer.subarray(offset + maskBytes, frameEnd),
      );
      buffer = buffer.subarray(frameEnd);

      if (mask) {
        for (let index = 0; index < payload.length; index += 1) {
          payload[index] ^= mask[index % 4];
        }
      }

      if (opcode === 0x8) {
        peer.close();
        return;
      }
      if (opcode === 0x9) {
        sendRaw(payload, 0x0a);
        continue;
      }
      if (opcode !== 0x1) continue;

      const currentTime = Date.now();
      while (messageTimes.length && messageTimes[0] <= currentTime - 60_000) {
        messageTimes.shift();
      }
      if (messageTimes.length >= MAX_MESSAGES_PER_MINUTE) {
        peer.close(1008, "Message rate limit exceeded");
        return;
      }
      messageTimes.push(currentTime);

      try {
        handlers.onMessage?.(JSON.parse(payload.toString("utf8")), peer);
      } catch (error) {
        handlers.onMalformedMessage?.(error, peer);
      }
    }
  }

  socket.on("data", (chunk) => {
    buffer = Buffer.concat([buffer, Buffer.from(chunk)]);
    consumeFrames();
  });
  socket.on("close", () => {
    closed = true;
    if (!closeNotified) {
      closeNotified = true;
      handlers.onClose?.(peer);
    }
  });
  socket.on("error", (error) => {
    handlers.onError?.(error, peer);
  });

  return peer;
}

function createBunRequestMetadata(request) {
  const requestUrl = new URL(request.url);
  return {
    method: request.method,
    url: `${requestUrl.pathname}${requestUrl.search}`,
    headers: Object.fromEntries(request.headers.entries()),
  };
}

async function createBunRequestFacade(request) {
  const metadata = createBunRequestMetadata(request);
  const chunks = [];
  let size = 0;
  if (!["GET", "HEAD"].includes(request.method)) {
    const declaredLength = Number(request.headers.get("content-length") || 0);
    if (declaredLength > MAX_HTTP_REQUEST_BODY_BYTES) {
      throw new Error("bridge RPC request body is too large");
    }
    const reader = request.body?.getReader();
    if (reader) {
      while (true) {
        const {done, value} = await reader.read();
        if (done) break;
        const chunk = Buffer.from(value);
        size += chunk.length;
        if (size > MAX_HTTP_REQUEST_BODY_BYTES) {
          await reader.cancel();
          throw new Error("bridge RPC request body is too large");
        }
        chunks.push(chunk);
      }
    }
  }
  return {
    ...metadata,
    async *[Symbol.asyncIterator]() {
      for (const chunk of chunks) yield chunk;
    },
  };
}

function createBunResponseFacade() {
  let body = "";
  let status = 200;
  let headers = {};
  let headersSent = false;
  return {
    get headersSent() {
      return headersSent;
    },
    writeHead(nextStatus, nextHeaders = {}) {
      status = Number(nextStatus) || 200;
      headers = {...headers, ...nextHeaders};
      headersSent = true;
    },
    end(nextBody = "") {
      body = Buffer.isBuffer(nextBody) ? nextBody : String(nextBody ?? "");
      headersSent = true;
    },
    toResponse() {
      return new Response(body, {status, headers});
    },
  };
}

function createBunSocketPeer(socket, handlers = {}) {
  let closed = false;
  let closeNotified = false;
  const messageTimes = [];

  function reportError(error) {
    handlers.onError?.(error, peer);
  }

  const peer = {
    send(payload) {
      if (closed) return false;
      try {
        return socket.send(JSON.stringify(payload)) !== -1;
      } catch (error) {
        reportError(error);
        return false;
      }
    },
    close(code = 1000, reason = "") {
      if (closed) return;
      closed = true;
      try {
        socket.close(code, reason);
      } catch (error) {
        reportError(error);
      }
    },
  };

  return {
    peer,
    message(rawMessage) {
      const currentTime = Date.now();
      while (messageTimes.length && messageTimes[0] <= currentTime - 60_000) {
        messageTimes.shift();
      }
      if (messageTimes.length >= MAX_MESSAGES_PER_MINUTE) {
        peer.close(1008, "Message rate limit exceeded");
        return;
      }
      messageTimes.push(currentTime);
      try {
        const text = typeof rawMessage === "string"
          ? rawMessage
          : Buffer.from(rawMessage).toString("utf8");
        handlers.onMessage?.(JSON.parse(text), peer);
      } catch (error) {
        handlers.onMalformedMessage?.(error, peer);
      }
    },
    close() {
      closed = true;
      if (closeNotified) return;
      closeNotified = true;
      handlers.onClose?.(peer);
    },
  };
}

function createBunLoopbackWebSocketServer({
  port,
  path,
  serviceName,
  onHttpRequest,
  onConnection,
  onMessage,
  onClose,
  logger,
}) {
  let server = null;
  const peers = new WeakMap();

  async function handleHttpRequest(request) {
    const requestUrl = new URL(request.url);
    if (
      request.method === "GET" &&
      (requestUrl.pathname === "/health" || requestUrl.pathname === "/")
    ) {
      return Response.json({
        ok: true,
        service: serviceName,
        websocketPath: path,
      });
    }
    const responseFacade = createBunResponseFacade();
    try {
      const requestFacade = await createBunRequestFacade(request);
      if (await onHttpRequest?.(requestFacade, responseFacade)) {
        return responseFacade.toResponse();
      }
    } catch (error) {
      logger.error?.("[mediaclaw] local bridge HTTP request failed", error);
      if (!responseFacade.headersSent) {
        responseFacade.writeHead(500, {"content-type": "application/json"});
      }
      responseFacade.end(
        JSON.stringify({
          ok: false,
          error: error instanceof Error ? error.message : String(error),
        }),
      );
      return responseFacade.toResponse();
    }
    return Response.json({ok: false, error: "not_found"}, {status: 404});
  }

  return {
    async listen() {
      server = globalThis.Bun.serve({
        hostname: "127.0.0.1",
        port,
        async fetch(request, bunServer) {
          const requestUrl = new URL(request.url);
          if (requestUrl.pathname === path) {
            if (
              request.method !== "GET" ||
              !isAllowedWebSocketOrigin(request.headers.get("origin"))
            ) {
              return new Response("Forbidden", {status: 403});
            }
            const upgraded = bunServer.upgrade(request, {
              data: {request: createBunRequestMetadata(request)},
            });
            return upgraded
              ? undefined
              : new Response("WebSocket upgrade failed", {status: 400});
          }
          return await handleHttpRequest(request);
        },
        websocket: {
          maxPayloadLength: MAX_CLIENT_FRAME_BYTES,
          open(socket) {
            const state = createBunSocketPeer(socket, {
              onMessage,
              onClose,
              onMalformedMessage(error) {
                logger.error?.("[mediaclaw] invalid extension message", error);
              },
              onError(error) {
                logger.error?.("[mediaclaw] extension socket error", error);
              },
            });
            peers.set(socket, state);
            onConnection?.(state.peer, socket.data?.request);
          },
          message(socket, message) {
            peers.get(socket)?.message(message);
          },
          close(socket) {
            const state = peers.get(socket);
            peers.delete(socket);
            state?.close();
          },
        },
        error(error) {
          logger.error?.("[mediaclaw] local bridge server error", error);
          return Response.json(
            {ok: false, error: "internal_server_error"},
            {status: 500},
          );
        },
      });
      return {host: "127.0.0.1", port, path};
    },
    async close() {
      const activeServer = server;
      server = null;
      await activeServer?.stop(true);
    },
    get server() {
      return server;
    },
  };
}

function createNodeLoopbackWebSocketServer({
  port = 17373,
  path = "/extension",
  serviceName = "mediaclaw-agent-broker",
  onHttpRequest,
  onConnection,
  onMessage,
  onClose,
  logger = console,
} = {}) {
  const server = http.createServer((request, response) => {
    void handleHttpRequest(request, response);
  });

  async function handleHttpRequest(request, response) {
    if (
      request.method === "GET" &&
      (request.url === "/health" || request.url === "/")
    ) {
      response.writeHead(200, {"content-type": "application/json"});
      response.end(
        JSON.stringify({
          ok: true,
          service: serviceName,
          websocketPath: path,
        }),
      );
      return;
    }
    try {
      if (await onHttpRequest?.(request, response)) {
        return;
      }
    } catch (error) {
      logger.error?.("[mediaclaw] local bridge HTTP request failed", error);
      if (!response.headersSent) {
        response.writeHead(500, {"content-type": "application/json"});
      }
      response.end(
        JSON.stringify({
          ok: false,
          error: error instanceof Error ? error.message : String(error),
        }),
      );
      return;
    }
    response.writeHead(404, {"content-type": "application/json"});
    response.end(JSON.stringify({ok: false, error: "not_found"}));
  }

  server.on("upgrade", (request, socket) => {
    let requestUrl;
    try {
      requestUrl = new URL(request.url || "/", `http://${request.headers.host}`);
    } catch {
      socket.destroy();
      return;
    }
    if (
      requestUrl.pathname !== path ||
      String(request.headers.upgrade || "").toLowerCase() !== "websocket"
    ) {
      socket.destroy();
      return;
    }
    if (!isAllowedWebSocketOrigin(request.headers.origin)) {
      socket.destroy();
      return;
    }
    const key = String(request.headers["sec-websocket-key"] || "");
    if (!key) {
      socket.destroy();
      return;
    }
    const accept = crypto
      .createHash("sha1")
      .update(key + WEBSOCKET_GUID)
      .digest("base64");
    socket.write(
      [
        "HTTP/1.1 101 Switching Protocols",
        "Upgrade: websocket",
        "Connection: Upgrade",
        `Sec-WebSocket-Accept: ${accept}`,
        "\r\n",
      ].join("\r\n"),
    );
    const peer = createSocketPeer(socket, {
      onMessage,
      onClose,
      onMalformedMessage(error) {
        logger.error?.("[mediaclaw] invalid extension message", error);
      },
      onError(error) {
        logger.error?.("[mediaclaw] extension socket error", error);
      },
    });
    onConnection?.(peer, request);
  });

  return {
    async listen() {
      await new Promise((resolve, reject) => {
        server.once("error", reject);
        server.listen(port, "127.0.0.1", () => {
          server.off("error", reject);
          resolve();
        });
      });
      return {host: "127.0.0.1", port, path};
    },
    async close() {
      await new Promise((resolve) => server.close(resolve));
    },
    server,
  };
}

export function createLoopbackWebSocketServer(options = {}) {
  const normalized = {
    port: 17373,
    path: "/extension",
    serviceName: "mediaclaw-agent-broker",
    logger: console,
    ...options,
  };
  return typeof globalThis.Bun?.serve === "function"
    ? createBunLoopbackWebSocketServer(normalized)
    : createNodeLoopbackWebSocketServer(normalized);
}
