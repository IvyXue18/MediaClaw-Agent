import assert from "node:assert/strict";
import {spawn} from "node:child_process";
import {chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile} from "node:fs/promises";
import {connect} from "node:net";
import {tmpdir} from "node:os";
import path from "node:path";
import test from "node:test";

function createLineReader(stream) {
  let buffer = "";
  const messages = [];
  const waiters = [];

  function flush() {
    while (true) {
      const newline = buffer.indexOf("\n");
      if (newline < 0) return;
      const line = buffer.slice(0, newline).trim();
      buffer = buffer.slice(newline + 1);
      if (!line) continue;
      const message = JSON.parse(line);
      messages.push(message);
      for (const waiter of [...waiters]) {
        if (!waiter.predicate(message)) continue;
        waiters.splice(waiters.indexOf(waiter), 1);
        waiter.resolve(message);
      }
    }
  }

  stream.on("data", (chunk) => {
    buffer += chunk.toString("utf8");
    flush();
  });

  return {
    waitFor(predicate, timeoutMs = 10_000) {
      const existing = messages.find(predicate);
      if (existing) return Promise.resolve(existing);
      return new Promise((resolve, reject) => {
        const waiter = {predicate, resolve};
        waiters.push(waiter);
        const timer = setTimeout(() => {
          const index = waiters.indexOf(waiter);
          if (index >= 0) waiters.splice(index, 1);
          reject(
            new Error(
              `Timed out waiting for MCP response; received=${messages
                .map((item) => item.id ?? item.method ?? item.type ?? "unknown")
                .join(",")}`,
            ),
          );
        }, timeoutMs);
        waiter.resolve = (message) => {
          clearTimeout(timer);
          resolve(message);
        };
      });
    },
  };
}

function waitForText(stream, pattern, timeoutMs = 5000) {
  return new Promise((resolve, reject) => {
    let text = "";
    const timer = setTimeout(() => {
      cleanup();
      reject(
        new Error(
          `Timed out waiting for ${pattern}. Output: ${text.trim() || "(empty)"}`,
        ),
      );
    }, timeoutMs);
    function onData(chunk) {
      text += chunk.toString("utf8");
      if (pattern.test(text)) {
        cleanup();
        resolve(text);
      }
    }
    function cleanup() {
      clearTimeout(timer);
      stream.off("data", onData);
    }
    stream.on("data", onData);
  });
}

async function waitForJsonFile(filePath, predicate, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const value = JSON.parse(await readFile(filePath, "utf8"));
      if (predicate(value)) return value;
    } catch {
      // The broker may be between its temporary write and atomic rename.
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`Timed out waiting for JSON state at ${filePath}`);
}

function sendChunkedResult(socket, {taskId, task, response}, chunkSize = 16_384) {
  const serialized = JSON.stringify({task, response});
  const transferId = `${taskId}:test:${serialized.length}`;
  const chunkCount = Math.ceil(serialized.length / chunkSize);
  socket.send(
    JSON.stringify({
      type: "task.result.start",
      taskId,
      transferId,
      chunkCount,
      charLength: serialized.length,
    }),
  );
  for (let index = 0; index < chunkCount; index += 1) {
    socket.send(
      JSON.stringify({
        type: "task.result.chunk",
        taskId,
        transferId,
        index,
        data: serialized.slice(index * chunkSize, (index + 1) * chunkSize),
      }),
    );
  }
  socket.send(
    JSON.stringify({
      type: "task.result.end",
      taskId,
      transferId,
      chunkCount,
      charLength: serialized.length,
    }),
  );
}

function expectRejectedWebSocketOrigin(port) {
  return new Promise((resolve, reject) => {
    let response = "";
    const socket = connect(port, "127.0.0.1", () => {
      socket.write(
        [
          "GET /extension HTTP/1.1",
          `Host: 127.0.0.1:${port}`,
          "Upgrade: websocket",
          "Connection: Upgrade",
          "Sec-WebSocket-Key: dGVzdC1tZWRpYWNsYXc=",
          "Sec-WebSocket-Version: 13",
          "Origin: https://untrusted.example",
          "",
          "",
        ].join("\r\n"),
      );
    });
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new Error("Timed out waiting for invalid Origin rejection"));
    }, 2_000);
    socket.on("data", (chunk) => {
      response += chunk.toString("utf8");
    });
    socket.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    socket.on("close", () => {
      clearTimeout(timer);
      assert.doesNotMatch(response, /101 Switching Protocols/);
      resolve();
    });
  });
}

test("Codex MCP bridge exposes paired async tasks and complete plugin records", async (t) => {
  const port = 18000 + Math.floor(Math.random() * 1000);
  const serverPath = path.resolve(
    "plugins/mediaclaw/scripts/mcp-server.mjs",
  );
  const agentStateDir = await mkdtemp(path.join(tmpdir(), "mediaclaw-agent-test-"));
  const fakeBinDir = path.join(agentStateDir, "fake-bin");
  await mkdir(fakeBinDir);
  const fakeCodexPath = path.join(
    fakeBinDir,
    process.platform === "win32" ? "codex.cmd" : "codex",
  );
  await writeFile(
    fakeCodexPath,
    process.platform === "win32"
      ? "@echo off\r\nif \"%1 %2\"==\"plugin list\" (echo mediaclaw@mediaclaw-agent  installed, enabled  0.3.2  C:\\fake) else (echo upgraded)\r\n"
      : "#!/bin/sh\nif [ \"$1 $2\" = \"plugin list\" ]; then\n  echo 'mediaclaw@mediaclaw-agent  installed, enabled  0.3.2  /tmp/fake'\nelse\n  echo 'upgraded'\nfi\n",
    "utf8",
  );
  if (process.platform !== "win32") await chmod(fakeCodexPath, 0o755);
  t.after(() => rm(agentStateDir, {recursive: true, force: true}));
  const child = spawn(process.execPath, [serverPath], {
    env: {
      ...process.env,
      MEDIACLAW_AGENT_PORT: String(port),
      MEDIACLAW_AGENT_STATE_DIR: agentStateDir,
      MEDIACLAW_AGENT_ADAPTER_TTL_MS: "500",
      MEDIACLAW_AGENT_ADAPTER_SWEEP_MS: "100",
      MEDIACLAW_AGENT_BROKER_IDLE_MS: "500",
      MEDIACLAW_AGENT_UPDATE_MANIFEST_URL:
        "data:application/json,%5B%7B%22tag_name%22%3A%22v0.3.2%22%2C%22draft%22%3Afalse%7D%5D",
      PATH: `${fakeBinDir}${path.delimiter}${process.env.PATH || ""}`,
    },
    stdio: ["pipe", "pipe", "pipe"],
  });
  t.after(() => {
    child.kill("SIGTERM");
  });
  const reader = createLineReader(child.stdout);
  await waitForText(child.stderr, /Adapter connected/);
  if (process.platform !== "win32") {
    assert.equal((await stat(agentStateDir)).mode & 0o777, 0o700);
    assert.equal(
      (await stat(path.join(agentStateDir, "hosts", "codex", "device-identity.json"))).mode & 0o777,
      0o600,
    );
  }
  await expectRejectedWebSocketOrigin(port);

  child.stdin.write(
    `${JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {protocolVersion: "2025-11-25"},
    })}\n`,
  );
  const initialized = await reader.waitFor((message) => message.id === 1);
  assert.equal(initialized.result.serverInfo.name, "mediaclaw-agent-adapter");
  assert.deepEqual(initialized.result.serverInfo.icons[0].sizes, ["128x128"]);
  assert.equal(initialized.result.serverInfo.icons[0].mimeType, "image/png");
  assert.deepEqual(
    Buffer.from(
      initialized.result.serverInfo.icons[0].src.replace(
        "data:image/png;base64,",
        "",
      ),
      "base64",
    ),
    await readFile(
      path.resolve("plugins/mediaclaw/assets/logo.png"),
    ),
  );
  assert.equal(initialized.result.capabilities.tasks, undefined);

  child.stdin.write(
    `${JSON.stringify({
      jsonrpc: "2.0",
      id: 4,
      method: "tools/call",
      params: {
        name: "mediaclaw_connection_status",
        arguments: {},
      },
    })}\n`,
  );
  const connectionStatus = await reader.waitFor((message) => message.id === 4);
  assert.equal(
    connectionStatus.result.structuredContent.bridge.listening,
    true,
  );
  assert.equal(connectionStatus.result.structuredContent.bridge.port, port);
  assert.equal(connectionStatus.result.structuredContent.connected, false);
  assert.equal(
    connectionStatus.result.structuredContent.agentUpdate.status,
    "update_available",
  );
  assert.equal(
    connectionStatus.result.structuredContent.agentUpdate.currentVersion,
    "0.3.1",
  );
  assert.equal(
    connectionStatus.result.structuredContent.agentUpdate.latestVersion,
    "0.3.2",
  );
  assert.equal(
    connectionStatus.result.structuredContent.agentUpdate.approvalRequired,
    true,
  );
  assert.match(
    connectionStatus.result.structuredContent.agentUpdate.approvalId,
    /^update_/,
  );
  assert.equal(
    connectionStatus.result.structuredContent.agentUpdate.execution.userRunsCommands,
    false,
  );
  assert.equal(
    connectionStatus.result.structuredContent.agentUpdate.continuation.createNewTask,
    false,
  );
  assert.equal(
    connectionStatus.result.structuredContent.agentUpdate.continuation.restartHostRequired,
    true,
  );
  assert.match(connectionStatus.result.content[0].text, /agentUpdate/);

  child.stdin.write(
    `${JSON.stringify({
      jsonrpc: "2.0",
      id: 4001,
      method: "tools/call",
      params: {
        name: "mediaclaw_manage_agent_update",
        arguments: {
          decision: "reject",
          approvalId:
            connectionStatus.result.structuredContent.agentUpdate.approvalId,
        },
      },
    })}\n`,
  );
  const rejectedUpdate = await reader.waitFor((message) => message.id === 4001);
  assert.equal(rejectedUpdate.result.structuredContent.ok, true);
  assert.equal(
    rejectedUpdate.result.structuredContent.changedInstallation,
    false,
  );
  assert.equal(
    rejectedUpdate.result.structuredContent.agentUpdate.status,
    "dismissed",
  );

  child.stdin.write(
    `${JSON.stringify({
      jsonrpc: "2.0",
      id: 4002,
      method: "tools/call",
      params: {
        name: "mediaclaw_connection_status",
        arguments: {},
      },
    })}\n`,
  );
  const dismissedStatus = await reader.waitFor((message) => message.id === 4002);
  assert.equal(
    dismissedStatus.result.structuredContent.agentUpdate.status,
    "dismissed",
  );

  const socket = new WebSocket(`ws://127.0.0.1:${port}/extension`);
  t.after(() => socket.close());
  let resolveRecoveredAck;
  let resolveHandshake;
  let collectionPlanTaskStarts = 0;
  let assetReadTaskStarts = 0;
  let transientDetailAttempts = 0;
  let transientScanAttempts = 0;
  let permanentDetailAttempts = 0;
  let captchaScanAttempts = 0;
  let detailCaptchaAttempts = 0;
  let cooldownScanAttempts = 0;
  let loginScanAttempts = 0;
  const recoveredAck = new Promise((resolve) => {
    resolveRecoveredAck = resolve;
  });
  const handshakeCompleted = new Promise((resolve) => {
    resolveHandshake = resolve;
  });
  socket.addEventListener("message", async (event) => {
    const message = JSON.parse(String(event.data));
    if (
      message.type === "task.result.ack" &&
      message.taskId === "capture-recovered"
    ) {
      resolveRecoveredAck(message);
      return;
    }
    if (message.type === "broker.hello") {
      const device = message.devices[0];
      socket.send(
        JSON.stringify({
          type: "session.challenge",
          challenge: {
            purpose: "pairing",
            deviceId: device.deviceId,
            challengeId: "test-challenge",
            nonce: "test-nonce",
            extensionId: "test-extension",
            protocolVersion: "3",
            expiresAt: Date.now() + 60_000,
          },
        }),
      );
      return;
    }
    if (message.type === "session.proof") {
      socket.send(
        JSON.stringify({
          type: "extension.hello",
          protocolVersion: "3",
          deviceId: message.deviceId,
          sessionId: "test-session",
          extensionId: "test-extension",
          extensionVersion: "0.3",
        }),
      );
      resolveHandshake();
      return;
    }
    if (message.type !== "task.start") return;
    // Real extension work is asynchronous. Yield once so the Broker can finish
    // registering the task before the simulated extension returns its result.
    await new Promise((resolve) => setTimeout(resolve, 10));
    if (message.task.mode === "data_pool_assets") {
      assetReadTaskStarts += 1;
      assert.equal(message.task.options.operation, "get");
      assert.equal(message.task.options.view, "sections");
      assert.deepEqual(message.task.options.sections, ["identity", "comments"]);
      assert.deepEqual(message.task.options.page, {
        path: "comments.items",
        cursor: "0",
        limit: 100,
      });
      setTimeout(() => {
        socket.send(
          JSON.stringify({
            type: "task.result",
            taskId: message.taskId,
            response: {
              ok: true,
              data: {
                rawCaptureResult: {
                  ok: true,
                  type: "agent_asset",
                  data: {
                    ok: true,
                    assetId: message.task.options.assetId,
                    source: "local.data_pool",
                    type: "capture_record",
                    asset: {
                      operation: "read_local_asset",
                      didCapture: false,
                      manifest: {
                        availableSections: {
                          comments: {savedCount: 1000, platformCount: 2450},
                        },
                      },
                      comments: {
                        savedCount: 1000,
                        platformCount: 2450,
                        items: [{commentId: "comment-1", content: "本地评论"}],
                      },
                    },
                  },
                },
              },
            },
          }),
        );
      }, 80);
      return;
    }
    if (message.task.mode === "profile_posts") {
      if (message.task.profileUrl.includes("collection-detail-captcha-test")) {
        const records = Array.from({length: 101}, (_, index) => {
          const number = index + 1;
          return {
            id: `rec-plan-detail-captcha-${number}`,
            recordType: "blogger_notes",
            normalizedPayload: {
              items: [
                {
                  noteId: `plan-detail-captcha-${number}`,
                  title: `详情验证码样本 ${number}`,
                  url: `https://www.xiaohongshu.com/explore/plan-detail-captcha-${number}`,
                  bloggerUrl: message.task.profileUrl,
                  author: "方案博主",
                  noteType: "video",
                },
              ],
            },
          };
        });
        socket.send(
          JSON.stringify({
            type: "task.result",
            taskId: message.taskId,
            response: {
              ok: true,
              data: {
                captureResult: {
                  recordIds: records.map((record) => record.id),
                  records,
                  stats: {itemCount: records.length},
                },
              },
            },
          }),
        );
        return;
      }
      if (message.task.profileUrl.includes("collection-captcha-test")) {
        captchaScanAttempts += 1;
        socket.send(
          JSON.stringify({
            type: "task.result",
            taskId: message.taskId,
            response: {
              ok: false,
              error: {
                code: "CAPTCHA_REQUIRED",
                message: "请先在浏览器完成验证码",
              },
            },
          }),
        );
        return;
      }
      if (message.task.profileUrl.includes("collection-cooldown-test")) {
        cooldownScanAttempts += 1;
        socket.send(
          JSON.stringify({
            type: "task.result",
            taskId: message.taskId,
            response: {
              ok: false,
              error: {
                code: "AGENT_CAPTURE_CONTINUOUS_LIMIT_REACHED",
                message: "平台要求等待后继续",
                risk: {nextAllowedAt: "2099-01-01T00:00:00.000Z"},
              },
            },
          }),
        );
        return;
      }
      if (message.task.profileUrl.includes("collection-login-test")) {
        loginScanAttempts += 1;
        socket.send(
          JSON.stringify({
            type: "task.result",
            taskId: message.taskId,
            response: {
              ok: false,
              error: {
                code: "LOGIN_REQUIRED",
                message: "请先在浏览器恢复账号登录",
              },
            },
          }),
        );
        return;
      }
      if (message.task.profileUrl.includes("collection-scan-retry-test")) {
        transientScanAttempts += 1;
        if (transientScanAttempts === 1) {
          socket.send(
            JSON.stringify({
              type: "task.result",
              taskId: message.taskId,
              response: {
                ok: false,
                error: {
                  code: "PROFILE_PAGE_LOAD_FAILED",
                  message: "主页首次加载超时",
                },
              },
            }),
          );
          return;
        }
        const item = {
          noteId: "plan-scan-retry",
          title: "主页扫描重试样本",
          url: "https://www.xiaohongshu.com/explore/plan-scan-retry",
          bloggerUrl: message.task.profileUrl,
          author: "方案博主",
          noteType: "image",
        };
        const record = {
          id: "rec-plan-scan-retry",
          recordType: "blogger_notes",
          normalizedPayload: {items: [item]},
        };
        socket.send(
          JSON.stringify({
            type: "task.result",
            taskId: message.taskId,
            response: {
              ok: true,
              data: {
                captureResult: {
                  recordIds: [record.id],
                  records: [record],
                  stats: {itemCount: 1},
                },
              },
            },
          }),
        );
        return;
      }
      if (message.task.profileUrl.includes("collection-retry-test")) {
        const item = {
          noteId: "plan-retry",
          title: "详情重试样本",
          url: "https://www.xiaohongshu.com/explore/plan-retry",
          bloggerUrl: message.task.profileUrl,
          author: "方案博主",
          noteType: "video",
        };
        const record = {
          id: "rec-plan-retry",
          recordType: "blogger_notes",
          normalizedPayload: {items: [item]},
        };
        socket.send(
          JSON.stringify({
            type: "task.result",
            taskId: message.taskId,
            response: {
              ok: true,
              data: {
                captureResult: {
                  recordIds: [record.id],
                  records: [record],
                  stats: {itemCount: 1},
                },
              },
            },
          }),
        );
        return;
      }
      if (message.task.profileUrl.includes("collection-failure-test")) {
        const item = {
          noteId: "plan-failure",
          title: "详情解析失败样本",
          url: "https://www.xiaohongshu.com/explore/plan-failure",
          author: "方案博主",
          noteType: "video",
        };
        const record = {
          id: "rec-plan-failure",
          recordType: "blogger_notes",
          normalizedPayload: {items: [item]},
        };
        socket.send(
          JSON.stringify({
            type: "task.result",
            taskId: message.taskId,
            response: {
              ok: true,
              data: {
                captureResult: {
                  recordIds: [record.id],
                  records: [record],
                  stats: {itemCount: 1},
                },
              },
            },
          }),
        );
        return;
      }
      if (message.task.profileUrl.includes("collection-plan-test")) {
        collectionPlanTaskStarts += 1;
        const items = [
          {
            noteId: "plan-video-1",
            title: "方案视频一",
            url: "https://www.xiaohongshu.com/explore/plan-video-1",
            author: "方案博主",
            likes: 1200,
            collects: 300,
            comments: 50,
            noteType: "video",
          },
          {
            noteId: "plan-image-1",
            title: "方案图文一",
            url: "https://www.xiaohongshu.com/explore/plan-image-1",
            author: "方案博主",
            likes: 800,
            collects: 220,
            comments: 30,
            noteType: "image",
          },
          {
            noteId: "plan-video-2",
            title: "方案视频二",
            url: "https://www.xiaohongshu.com/explore/plan-video-2",
            author: "方案博主",
            likes: 600,
            collects: 180,
            comments: 20,
            noteType: "video",
          },
        ];
        const records = items.map((item) => ({
          id: `rec-${item.noteId}`,
          recordType: "blogger_notes",
          normalizedPayload: {items: [item]},
        }));
        socket.send(
          JSON.stringify({
            type: "task.result",
            taskId: message.taskId,
            response: {
              ok: true,
              data: {
                captureResult: {
                  recordIds: records.map((record) => record.id),
                  records,
                  stats: {itemCount: records.length},
                },
              },
            },
          }),
        );
        return;
      }
      if (message.task.profileUrl.includes("recent-test")) {
        const items = Array.from({length: 8}, (_, index) => ({
          noteId: `recent-${index + 1}`,
          title: `近期作品 ${index + 1}`,
          url: `https://www.xiaohongshu.com/explore/recent-${index + 1}`,
          author: "近期博主",
          likes: [200, 8000, 500, 3000, 100, 1200, 600, 400][index],
          collects: 80 - index,
          comments: 20 - index,
          noteType: "image",
        }));
        socket.send(
          JSON.stringify({
            type: "task.result",
            taskId: message.taskId,
            response: {
              ok: true,
              data: {
                captureResult: {
                  records: [{normalizedPayload: {items}}],
                },
              },
            },
          }),
        );
      }
      return;
    }
    if (message.task.mode === "stored_style_profiles") {
      assert.deepEqual(message.task.resultSinks, ["local_agent"]);
      assert.equal(message.task.featureKey, "asset.style_profile");
      if (message.task.options.operation === "list") {
        socket.send(
          JSON.stringify({
            type: "task.result",
            taskId: message.taskId,
            response: {
              ok: true,
              data: {
                rawCaptureResult: {
                  ok: true,
                  type: "stored_style_profiles",
                  data: {
                    source: "remote",
                    profiles: [
                      {
                        profileId: "style-codex",
                        bloggerName: "Codex 研究所",
                        platform: "xiaohongshu",
                        sampleCount: 24,
                      },
                    ],
                  },
                },
              },
            },
          }),
        );
        return;
      }
      sendChunkedResult(socket, {
        taskId: message.taskId,
        task: message.task,
        response: {
          ok: true,
          data: {
            rawCaptureResult: {
              ok: true,
              type: "stored_style_profile",
              data: {
                source: "remote",
                matchStatus: "matched",
                matchedBy: "bloggerName",
                profile: {
                  profileId: "style-codex",
                  bloggerName: "Codex 研究所",
                  platform: "xiaohongshu",
                  effectiveAnalysisSource: "editableJson",
                  styleAnalysis: {
                    languageStyle: {tone: "直接、具体"},
                    structure: ["先结论", "再证据"],
                    largeEvidence: "真实风格证据".repeat(20_000),
                  },
                  sampleSummary: {sampleCount: 24},
                },
              },
            },
          },
        },
      });
      return;
    }
    if (message.task.mode === "profile_info") {
      if (message.task.profileUrl.includes("collection-plan-test")) {
        collectionPlanTaskStarts += 1;
      }
      const profileId = message.task.profileUrl.split("/").pop();
      socket.send(
        JSON.stringify({
          type: "task.result",
          taskId: message.taskId,
          response: {
            ok: true,
            data: {
              captureResult: {
                recordIds: [`rec-profile-${profileId}`],
                records: [
                  {
                    recordType: "blogger_profile",
                    normalizedPayload: {
                      bloggerId: profileId,
                      bloggerName:
                        profileId === "creator-a" ? "创作者 A" : "测试博主",
                      bloggerUrl: message.task.profileUrl,
                      description: "专注 AI 工具实测",
                      followersCount: 12000,
                      likedAndCollectedCount: 320000,
                    },
                  },
                ],
              },
            },
          },
        }),
      );
      return;
    }
    if (message.task.mode === "data_pool_query") {
      assert.deepEqual(message.task.resultSinks, ["local_agent"]);
      assert.equal(message.task.featureKey, "asset.data_pool");
      const isGet = message.task.options.operation === "get";
      const isTranscript = message.task.options.operation === "transcript";
      socket.send(
        JSON.stringify({
          type: "task.result",
          taskId: message.taskId,
          response: {
            ok: true,
            data: {
              rawCaptureResult: {
                ok: true,
                type: isGet
                  ? "data_pool_record"
                  : isTranscript
                    ? "video_transcript"
                    : "data_pool_query",
                data: isGet
                  ? {
                      operation: "get",
                      recordId: message.task.options.recordId,
                      record: {
                        id: message.task.options.recordId,
                        recordType: "single_note",
                        normalizedPayload: {title: "数据池详情"},
                      },
                    }
                  : isTranscript
                    ? {
                        status: "done",
                        recordId: message.task.options.recordId,
                        text: "已有视频逐字稿",
                        hasMore: false,
                      }
                  : {
                      operation: "query",
                      totalCount: 1,
                      offset: 0,
                      limit: 50,
                      hasMore: false,
                      records: [
                        {
                          id: "rec-note-demo",
                          recordType: "single_note",
                          title: "数据池笔记",
                        },
                      ],
                    },
              },
            },
          },
        }),
      );
      return;
    }
    if (message.task.mode === "enhance_records") {
      assert.deepEqual(message.task.resultSinks, ["local_agent"]);
      assert.equal(message.task.featureKey, "capture.enhancement");
      assert.equal(message.task.options.confirmation.confirmed, true);
      if (
        message.task.options.confirmation.source ===
        "mediaclaw_confirm_profile_collection"
      ) {
        collectionPlanTaskStarts += 1;
      }
      if (
        message.task.options.recordIds.some((recordId) =>
          recordId.startsWith("rec-plan-detail-captcha-"),
        )
      ) {
        detailCaptchaAttempts += 1;
        socket.send(
          JSON.stringify({
            type: "task.result",
            taskId: message.taskId,
            response: {
              ok: false,
              error: {
                code: "CAPTCHA_REQUIRED",
                message: "详情采集需要先完成验证码",
              },
            },
          }),
        );
        return;
      }
      if (message.task.options.recordIds.includes("rec-plan-failure")) {
        permanentDetailAttempts += 1;
        socket.send(
          JSON.stringify({
            type: "task.result",
            taskId: message.taskId,
            response: {
              ok: true,
              data: {
                rawCaptureResult: {
                  ok: true,
                  type: "detail_enhancement",
                  data: {
                    successCount: 0,
                    failedCount: 1,
                    recordIds: [],
                    records: [],
                    results: [
                      {
                        ok: false,
                        recordId: "rec-plan-failure",
                        error: {
                          code: "DETAIL_PARSE_FAILED",
                          message: "详情页面加载后未解析到目标内容",
                        },
                      },
                    ],
                  },
                },
              },
            },
          }),
        );
        return;
      }
      if (message.task.options.recordIds.includes("rec-plan-retry")) {
        transientDetailAttempts += 1;
        assert.equal(message.task.options.commentsMaxDetectedItems, 45);
        if (transientDetailAttempts === 1) {
          socket.send(
            JSON.stringify({
              type: "task.result",
              taskId: message.taskId,
              response: {
                ok: true,
                data: {
                  rawCaptureResult: {
                    ok: true,
                    type: "detail_enhancement",
                    data: {
                      successCount: 0,
                      failedCount: 1,
                      recordIds: [],
                      records: [],
                      results: [{
                        ok: false,
                        recordId: "rec-plan-retry",
                        reason: "DETAIL_PARSE_FAILED",
                        message: "详情节点暂未加载",
                      }],
                    },
                  },
                },
              },
            }),
          );
          return;
        }
      }
      const enhancedRecords = message.task.options.recordIds.map((recordId) => ({
        id: recordId,
        recordType: "blogger_notes",
        status: "ready",
        normalizedPayload: {
          title: "增强采集后的完整笔记",
          content: "完整正文",
          imageUrls: ["https://example.com/enhanced.jpg"],
          likes: 321,
        },
        rawPayload: {source: "plugin-detail-owner"},
      }));
      socket.send(
        JSON.stringify({
          type: "task.result",
          taskId: message.taskId,
          response: {
            ok: true,
            data: {
              rawCaptureResult: {
                ok: true,
                type: "detail_enhancement",
                data: {
                  successCount: enhancedRecords.length,
                  failedCount: 0,
                  recordIds: message.task.options.recordIds,
                  records: enhancedRecords,
                },
              },
            },
          },
        }),
      );
      return;
    }
    if (
      message.task.mode === "extract_image_text" ||
      message.task.mode === "extract_video_transcript"
    ) {
      assert.deepEqual(message.task.resultSinks, ["local_agent"]);
      const isVideo = message.task.mode === "extract_video_transcript";
      const isQuote = isVideo && message.task.options.meteredAction === "quote";
      const quoteRecordIds = Array.isArray(message.task.options.recordIds)
        ? message.task.options.recordIds
        : [];
      const quoteIsAlreadyExtracted = quoteRecordIds.includes(
        "rec-note-single-video-existing",
      );
      socket.send(
        JSON.stringify({
          type: "task.result",
          taskId: message.taskId,
          response: {
            ok: true,
            data: {
              rawCaptureResult: {
                ok: true,
                type: isVideo
                  ? "video_transcript_extraction"
                  : "image_text_extraction",
                data: isQuote
                  ? {
                      status: "quoted",
                      quoteId: "quote-test-1",
                      recordIds: quoteRecordIds,
                      ...(quoteIsAlreadyExtracted
                        ? {
                            items: quoteRecordIds.map((recordId) => ({
                              recordId,
                              alreadyExtracted: true,
                              estimatedCredits: 0,
                            })),
                            totalEstimatedCredits: 0,
                            remainingCredits: 100,
                          }
                        : {}),
                      totalDurationMs: 60_000,
                      estimatedCredits: quoteIsAlreadyExtracted ? 0 : 2,
                      balance: 100,
                      expiresAt: Date.now() + 60_000,
                    }
                  : {
                      status: "done",
                      quoteId: message.task.options.quoteId,
                      recordIds: ["rec-video-demo"],
                      ...(!isVideo
                        ? {recordId: message.task.options.recordId}
                        : {}),
                      text: isVideo ? "视频逐字稿" : "图片中的文案",
                      ...(isVideo ? {costCredits: 2} : {imageCount: 2}),
                    },
              },
            },
          },
        }),
      );
      return;
    }
    if (
      message.task.mode === "search_results" &&
      message.task.options?.operation === "expand_keywords"
    ) {
      assert.equal(message.task.limit, 27);
      socket.send(
        JSON.stringify({
          type: "task.result",
          taskId: message.taskId,
          response: {
            ok: true,
            data: {
              expandedKeywords: [
                ...Array.from(
                  {length: 249},
                  (_, index) => `${message.task.keyword} 长尾词 ${index + 1}`,
                ),
                `${message.task.keyword} 长尾词 1`,
              ],
              stats: {
                totalFound: 250,
                duplicatesRemoved: 1,
              },
            },
          },
        }),
      );
      return;
    }
    if (message.task.mode === "current_note") {
      const id = message.task.targetUrl.split("/").pop();
      const isVideoNote = id.includes("video");
      if (id.startsWith("deep-")) {
        assert.equal(message.task.featureKey, "capture.detail_batch");
        assert.deepEqual(message.task.options.confirmation, {
          confirmed: true,
          source: "mediaclaw_deep_collect",
        });
      }
      socket.send(
        JSON.stringify({
          type: "task.result",
          taskId: message.taskId,
          response: {
            ok: true,
            data: {
              captureResult: {
                recordIds: [`rec-note-${id}`],
                records: [
                  {
                    recordType: "single_note",
                    normalizedPayload: {
                      noteId: id,
                      title: `详情 ${id}`,
                      url: message.task.targetUrl,
                      author: "测试作者",
                      content: `正文 ${id}`,
                      tags: ["Codex", "AI"],
                      likes: 1000,
                      collects: 200,
                      comments: 30,
                      lastEditedAt: "2026-07-20",
                      noteType: isVideoNote ? "video" : "image",
                      imageUrls: isVideoNote
                        ? []
                        : [
                            "https://example.com/1.jpg",
                            "https://example.com/2.jpg",
                          ],
                      ...(isVideoNote
                        ? {
                            videoUrl: "https://example.com/video.mp4",
                            durationMs: 60_000,
                          }
                        : {}),
                    },
                  },
                ],
              },
            },
          },
        }),
      );
      return;
    }
    if (message.task.mode === "comments") {
      assert.ok(
        [
          "capture.comments",
          "capture.comments_preview",
          "capture.comments_full",
        ].includes(message.task.featureKey),
      );
      const comments = Array.from({length: message.task.limit}, (_, index) => ({
        commentId: `comment-${index + 1}`,
        content: `评论正文 ${index + 1}`,
        userName: `用户 ${index + 1}`,
        userId: `user-${index + 1}`,
        publishTime: "2026-07-24",
        ipLocation: "上海",
        likes: index,
      }));
      sendChunkedResult(socket, {
        taskId: message.taskId,
        task: message.task,
        response: {
          ok: true,
          data: {
            captureResult: {
              records: [
                {
                  recordType: "comments",
                  normalizedPayload: {
                    detailPayload: {commentsCleanedItems: comments},
                  },
                },
              ],
              stats: {itemCount: comments.length},
            },
            transportPadding: "不会进入分析结果".repeat(20_000),
          },
        },
      });
      return;
    }
    assert.equal(message.task.mode, "search_results");
    assert.equal(
      message.task.limit,
      message.task.keyword === "AI工具" ? 20 : 80,
    );
    assert.equal(message.task.options.detailCapture, false);
    if (message.task.keyword === "Codex") {
      assert.equal(message.task.options.prepareKeywordStrategy, true);
      assert.equal(message.task.options.timeRange, "6m");
      assert.equal(message.task.options.sortBy, "likes");
      const items = Array.from({length: 12}, (_, index) => ({
        noteId: `codex-${index + 1}`,
        title: `Codex 选题 ${index + 1}`,
        url: `https://www.xiaohongshu.com/explore/codex-${index + 1}`,
        author: `作者 ${index + 1}`,
        likes: (12 - index) * 1000,
        collects: (12 - index) * 100,
        comments: 12 - index,
        publishDate: `2026-07-${String(index + 1).padStart(2, "0")}`,
        noteType: index % 2 === 0 ? "image" : "video",
      }));
      socket.send(
        JSON.stringify({
          type: "task.result",
          taskId: message.taskId,
          response: {
            ok: true,
            data: {
              captureResult: {
                records: [
                  {
                    normalizedPayload: {items},
                  },
                ],
                diagnostics: {
                  keywordStrategyPreparation: {
                    appliedSort: true,
                    appliedRecency: true,
                    appliedNoteType: true,
                    requested: {
                      sortBy: "likes",
                      timeRange: "6m",
                      contentType: "all",
                    },
                  },
                },
              },
            },
          },
        }),
      );
      return;
    }
    if (message.task.keyword === "AI工具") {
      const items = [
        {
          noteId: "benchmark-a-1",
          title: "AI 工具实测 1",
          url: "https://www.xiaohongshu.com/explore/benchmark-a-1",
          author: "创作者 A",
          authorUrl:
            "https://www.xiaohongshu.com/user/profile/creator-a",
          likes: 12000,
          collects: 1500,
          comments: 320,
          noteType: "image",
        },
        {
          noteId: "benchmark-a-2",
          title: "AI 工具实测 2",
          url: "https://www.xiaohongshu.com/explore/benchmark-a-2",
          author: "创作者 A",
          authorUrl:
            "https://www.xiaohongshu.com/user/profile/creator-a",
          likes: 8000,
          collects: 900,
          comments: 180,
          noteType: "image",
        },
        {
          noteId: "benchmark-b-1",
          title: "AI 效率技巧",
          url: "https://www.xiaohongshu.com/explore/benchmark-b-1",
          author: "创作者 B",
          authorUrl:
            "https://www.xiaohongshu.com/user/profile/creator-b",
          likes: 6000,
          collects: 800,
          comments: 100,
          noteType: "video",
        },
      ];
      socket.send(
        JSON.stringify({
          type: "task.result",
          taskId: message.taskId,
          response: {
            ok: true,
            data: {
              captureResult: {
                records: [{normalizedPayload: {items}}],
                diagnostics: {
                  keywordStrategyPreparation: {
                    appliedSort: true,
                    appliedRecency: true,
                    appliedNoteType: true,
                  },
                },
              },
            },
          },
        }),
      );
      return;
    }
    if (message.task.keyword === "露营") {
      assert.equal(message.task.options.prepareKeywordStrategy, true);
      assert.equal(message.task.options.strictFilters, true);
      assert.equal(message.task.options.timeRange, "any");
      assert.equal(message.task.options.sortBy, "default");
      assert.equal(message.task.options.contentType, "all");
      assert.equal(message.task.options.videoDuration, "all");
      assert.equal(message.task.options.searchScope, "all");
      assert.equal(message.task.options.locationScope, "all");
    }
    socket.send(
      JSON.stringify({
        type: "task.progress",
        taskId: message.taskId,
        progress: {
          status: "running",
          stage: "scrolling",
          processedCount: 40,
          totalCount: 80,
        },
      }),
    );
    sendChunkedResult(socket, {
      taskId: message.taskId,
      task: message.task,
      response: {
          ok: true,
          data: {
            ok: true,
            captureResult: {
              records: [
                {
                  normalizedPayload: {
                    items: [
                      {
                        noteId: "note-1",
                        title: "露营装备清单",
                        url: "https://www.xiaohongshu.com/explore/note-1",
                        coverImageUrl: "https://example.com/cover.jpg",
                        author: "户外小陈",
                        likes: 328,
                        noteType: "image",
                        content: "不应进入快速扫描结果的长正文",
                      },
                    ],
                  },
                },
              ],
              stats: {itemCount: 1, totalCount: 1},
            },
          },
        },
      },
    );
  });
  await new Promise((resolve, reject) => {
    socket.addEventListener("open", resolve, {once: true});
    socket.addEventListener("error", reject, {once: true});
  });
  await handshakeCompleted;
  await new Promise((resolve) => setTimeout(resolve, 25));

  child.stdin.write(
    `${JSON.stringify({
      jsonrpc: "2.0",
      id: 2,
      method: "tools/call",
      params: {
        name: "mediaclaw_scan_keyword",
        arguments: {keyword: "露营"},
      },
    })}\n`,
  );
  const response = await reader.waitFor((message) => message.id === 2);
  assert.equal(response.result.structuredContent.task.status, "completed");
  assert.deepEqual(
    response.result.structuredContent.result.records[0].normalizedPayload.items[0],
    {
      noteId: "note-1",
      title: "露营装备清单",
      url: "https://www.xiaohongshu.com/explore/note-1",
      coverImageUrl: "https://example.com/cover.jpg",
      author: "户外小陈",
      likes: 328,
      noteType: "image",
      content: "不应进入快速扫描结果的长正文",
    },
  );
  assert.match(JSON.stringify(response.result), /不应进入快速扫描结果的长正文/);

  child.stdin.write(
    `${JSON.stringify({
      jsonrpc: "2.0",
      id: 204,
      method: "tools/call",
      params: {
        name: "mediaclaw_capture_search_basic",
        arguments: {
          keyword: "平台校验",
          platform: "douyin",
          sortBy: "comments",
        },
      },
    })}\n`,
  );
  const unsupportedPlatformFilter = await reader.waitFor(
    (message) => message.id === 204,
  );
  assert.match(
    JSON.stringify(unsupportedPlatformFilter),
    /douyin 不支持筛选参数 sortBy=comments/,
  );

  child.stdin.write(
    `${JSON.stringify({
      jsonrpc: "2.0",
      id: 205,
      method: "tools/call",
      params: {
        name: "mediaclaw_capture_search_basic",
        arguments: {keyword: "时间校验", timeRange: "30d"},
      },
    })}\n`,
  );
  const unsupportedTimeFilter = await reader.waitFor(
    (message) => message.id === 205,
  );
  assert.match(
    JSON.stringify(unsupportedTimeFilter),
    /不支持的筛选参数 timeRange=30d/,
  );

  child.stdin.write(
    `${JSON.stringify({
      jsonrpc: "2.0",
      id: 6,
      method: "tools/call",
      params: {
        name: "mediaclaw_capture_comments",
        arguments: {
          url: "https://www.xiaohongshu.com/explore/note-1",
          limit: 20,
        },
      },
    })}\n`,
  );
  const commentsResponse = await reader.waitFor((message) => message.id === 6);
  assert.equal(commentsResponse.result.structuredContent.result.count, 20);
  assert.equal(
    commentsResponse.result.structuredContent.result.comments[0].content,
    "评论正文 1",
  );
  assert.equal(
    commentsResponse.result.structuredContent.result.comments[19].likes,
    19,
  );
  assert.doesNotMatch(
    JSON.stringify(commentsResponse.result),
    /不会进入分析结果/,
  );

  child.stdin.write(
    `${JSON.stringify({
      jsonrpc: "2.0",
      id: 61,
      method: "tools/call",
      params: {
        name: "mediaclaw_capture_comments_full",
        arguments: {
          url: "https://www.xiaohongshu.com/explore/note-1",
          limit: 60,
        },
      },
    })}\n`,
  );
  const fullCommentsResponse = await reader.waitFor(
    (message) => message.id === 61,
  );
  assert.equal(fullCommentsResponse.result.structuredContent.result.count, 60);

  child.stdin.write(
    `${JSON.stringify({
      jsonrpc: "2.0",
      id: 62,
      method: "tools/call",
      params: {
        name: "mediaclaw_deep_collect",
        arguments: {
          urls: [
            "https://www.xiaohongshu.com/explore/deep-1",
            "https://www.xiaohongshu.com/explore/deep-2",
          ],
        },
      },
    })}\n`,
  );
  const deepCollectResponse = await reader.waitFor(
    (message) => message.id === 62,
  );
  assert.equal(
    deepCollectResponse.result.structuredContent.result.successCount,
    2,
  );

  child.stdin.write(
    `${JSON.stringify({
      jsonrpc: "2.0",
      id: 7,
      method: "tools/list",
      params: {},
    })}\n`,
  );
  const toolList = await reader.waitFor((message) => message.id === 7);
  const toolNames = toolList.result.tools.map((tool) => tool.name);
  const contract = JSON.parse(
    await readFile(
      path.resolve(
        "plugins/mediaclaw/contracts/mcp-v1.json",
      ),
      "utf8",
    ),
  );
  assert.deepEqual(
    [...toolNames].sort(),
    contract.tools.map((tool) => tool.name).sort(),
  );
  assert.ok(toolNames.includes("mediaclaw_expand_keywords"));
  assert.ok(toolNames.includes("mediaclaw_research_keyword_topics"));
  assert.ok(toolNames.includes("mediaclaw_research_longtail_keywords"));
  assert.ok(toolNames.includes("mediaclaw_research_account_hits"));
  assert.ok(toolNames.includes("mediaclaw_capture_account_profile"));
  assert.ok(toolNames.includes("mediaclaw_prepare_profile_collection"));
  assert.ok(toolNames.includes("mediaclaw_confirm_profile_collection"));
  const prepareProfileCollectionTool = toolList.result.tools.find(
    (tool) => tool.name === "mediaclaw_prepare_profile_collection",
  );
  const confirmProfileCollectionTool = toolList.result.tools.find(
    (tool) => tool.name === "mediaclaw_confirm_profile_collection",
  );
  assert.match(prepareProfileCollectionTool.description, /不启动浏览器/);
  assert.equal(
    prepareProfileCollectionTool.inputSchema.required.includes(
      "requestedFields",
    ),
    false,
  );
  assert.match(prepareProfileCollectionTool.description, /默认优先 not_needed/);
  assert.deepEqual(confirmProfileCollectionTool.inputSchema.required, [
    "planId",
  ]);
  assert.ok(toolNames.includes("mediaclaw_research_benchmark_accounts"));
  assert.ok(toolNames.includes("mediaclaw_research_single_note"));
  assert.ok(toolNames.includes("mediaclaw_capture_comments_full"));
  const singleCommentTool = toolList.result.tools.find(
    (tool) => tool.name === "mediaclaw_capture_comments",
  );
  assert.equal(singleCommentTool.inputSchema.properties.limit.maximum, 500);
  const basicSearchTool = toolList.result.tools.find(
    (tool) => tool.name === "mediaclaw_capture_search_basic",
  );
  assert.equal(basicSearchTool.inputSchema.properties.limit.maximum, 300);
  assert.deepEqual(
    basicSearchTool.inputSchema.properties.timeRange.enum,
    ["any", "1d", "7d", "6m"],
  );
  assert.deepEqual(
    basicSearchTool.inputSchema.properties.sortBy.enum,
    ["default", "latest", "likes", "comments", "collects"],
  );
  assert.deepEqual(
    basicSearchTool.inputSchema.properties.videoDuration.enum,
    ["all", "under_1m", "between_1m_5m", "over_5m"],
  );
  assert.deepEqual(
    basicSearchTool.inputSchema.properties.searchScope.enum,
    ["all", "seen", "unseen", "followed"],
  );
  assert.deepEqual(
    basicSearchTool.inputSchema.properties.locationScope.enum,
    ["all", "city", "nearby"],
  );
  assert.ok(toolNames.includes("mediaclaw_query_data_pool"));
  assert.ok(toolNames.includes("mediaclaw_preview_clear_data"));
  assert.ok(toolNames.includes("mediaclaw_confirm_clear_data"));
  assert.ok(toolNames.includes("mediaclaw_get_data_pool_record"));
  assert.ok(toolNames.includes("mediaclaw_get_video_transcript"));
  assert.ok(toolNames.includes("mediaclaw_extract_image_text"));
  assert.ok(toolNames.includes("mediaclaw_quote_video_transcript"));
  assert.ok(toolNames.includes("mediaclaw_confirm_video_transcript"));
  assert.ok(toolNames.includes("mediaclaw_list_assets"));
  assert.ok(toolNames.includes("mediaclaw_get_asset"));
  const getAssetTool = toolList.result.tools.find(
    (tool) => tool.name === "mediaclaw_get_asset",
  );
  assert.deepEqual(getAssetTool.inputSchema.properties.view.enum, [
    "sections",
    "raw",
  ]);
  assert.ok(
    getAssetTool.inputSchema.properties.sections.items.enum.includes(
      "comments",
    ),
  );
  assert.ok(
    getAssetTool.inputSchema.properties.sections.items.enum.includes(
      "reportFrameworks",
    ),
  );
  assert.ok(
    getAssetTool.inputSchema.properties.sections.items.enum.includes(
      "samples",
    ),
  );
  assert.ok(
    getAssetTool.inputSchema.properties.page.properties.path.enum.includes(
      "extractedContent.transcript.text",
    ),
  );
  assert.ok(
    getAssetTool.inputSchema.properties.page.properties.path.enum.includes(
      "report.ideaBank",
    ),
  );
  assert.ok(
    getAssetTool.inputSchema.properties.page.properties.path.enum.includes(
      "samples",
    ),
  );
  assert.match(getAssetTool.description, /不会重新采集/);
  const assetReadArguments = {
    assetId: "local.data_pool|capture_record|rec-local-comments",
    sections: ["identity", "comments"],
    page: {path: "comments.items", cursor: "0", limit: 100},
    async: true,
  };
  child.stdin.write(
    `${JSON.stringify({
      jsonrpc: "2.0",
      id: 7001,
      method: "tools/call",
      params: {name: "mediaclaw_get_asset", arguments: assetReadArguments},
    })}\n`,
  );
  const firstAssetRead = await reader.waitFor((message) => message.id === 7001);
  child.stdin.write(
    `${JSON.stringify({
      jsonrpc: "2.0",
      id: 7002,
      method: "tools/call",
      params: {name: "mediaclaw_get_asset", arguments: assetReadArguments},
    })}\n`,
  );
  const repeatedAssetRead = await reader.waitFor((message) => message.id === 7002);
  assert.equal(
    firstAssetRead.result.structuredContent.task.taskId,
    repeatedAssetRead.result.structuredContent.task.taskId,
  );
  assert.match(
    firstAssetRead.result.structuredContent.task.statusMessage,
    /本地已保存资产.*不会重新采集/,
  );
  await new Promise((resolve) => setTimeout(resolve, 120));
  assert.equal(assetReadTaskStarts, 1);
  child.stdin.write(
    `${JSON.stringify({
      jsonrpc: "2.0",
      id: 7003,
      method: "tools/call",
      params: {
        name: "mediaclaw_task_status",
        arguments: {taskId: firstAssetRead.result.structuredContent.task.taskId},
      },
    })}\n`,
  );
  const completedAssetRead = await reader.waitFor((message) => message.id === 7003);
  assert.equal(completedAssetRead.result.structuredContent.task.status, "completed");
  assert.equal(
    completedAssetRead.result.structuredContent.result.asset.comments.savedCount,
    1000,
  );
  assert.equal(
    completedAssetRead.result.structuredContent.result.asset.comments.platformCount,
    2450,
  );
  assert.match(
    completedAssetRead.result.structuredContent.task.statusMessage,
    /本地已保存资产读取完成/,
  );
  assert.ok(toolNames.includes("mediaclaw_list_paired_devices"));
  assert.ok(toolNames.includes("mediaclaw_list_style_profiles"));
  assert.ok(toolNames.includes("mediaclaw_get_style_profile"));
  assert.ok(toolNames.includes("mediaclaw_query_dataset"));
  const transcriptSchemas = toolList.result.tools
    .filter((tool) =>
      [
        "mediaclaw_quote_video_transcript",
        "mediaclaw_confirm_video_transcript",
      ].includes(tool.name),
    )
    .map((tool) => tool.inputSchema);
  assert.doesNotMatch(
    JSON.stringify(transcriptSchemas),
    /apiKey|provider|localModel|transcriptionMode|confirmCharge|"mode"/i,
  );

  child.stdin.write(
    `${JSON.stringify({
      jsonrpc: "2.0",
      id: 8,
      method: "tools/call",
      params: {
        name: "mediaclaw_expand_keywords",
        arguments: {seedKeyword: "Codex"},
      },
    })}\n`,
  );
  const expansionResponse = await reader.waitFor((message) => message.id === 8);
  assert.equal(
    expansionResponse.result.structuredContent.result.expandedKeywords.length,
    249,
  );
  assert.equal(
    expansionResponse.result.structuredContent.result.expandedKeywords[248],
    "Codex 长尾词 249",
  );

  child.stdin.write(
    `${JSON.stringify({
      jsonrpc: "2.0",
      id: 9,
      method: "tools/call",
      params: {
        name: "mediaclaw_research_longtail_keywords",
        arguments: {seedKeyword: "Codex"},
      },
    })}\n`,
  );
  const longtailResponse = await reader.waitFor((message) => message.id === 9);
  assert.equal(
    longtailResponse.result.structuredContent.result.recommendedMethodId,
    "keyword-longtail-demand-v1",
  );
  assert.equal(
    longtailResponse.result.structuredContent.result.recommendedMethodVersion,
    "2.0.0",
  );
  assert.equal(
    longtailResponse.result.structuredContent.result.coverage.uniqueCount,
    249,
  );
  assert.equal(
    longtailResponse.result.structuredContent.result.records.length,
    249,
  );

  child.stdin.write(
    `${JSON.stringify({
      jsonrpc: "2.0",
      id: 10,
      method: "tools/call",
      params: {
        name: "mediaclaw_research_keyword_topics",
        arguments: {
          keyword: "Codex",
          limit: 80,
        },
      },
    })}\n`,
  );
  const topicResponse = await reader.waitFor(
    (message) => message.id === 10,
    10_000,
  );
  const topicResult = topicResponse.result.structuredContent.result;
  assert.equal(topicResult.recommendedMethodId, "keyword-topic-trends-v1");
  assert.equal(topicResult.recommendedMethodVersion, "2.0.0");
  assert.deepEqual(topicResult.recommendedMethod, {
    id: "keyword-topic-trends-v1",
    version: "2.0.0",
  });
  assert.equal(topicResult.coverage.actualCount, 12);
  assert.equal(topicResult.coverage.actualDetailSampleCount, 0);
  assert.equal(topicResult.accessLevel, "basic_list");
  assert.equal(topicResult.upgrade.featureKey, "capture.enhancement");
  assert.equal(
    topicResult.upgrade.positioning,
    "evidence_upgrade_not_agent_analysis",
  );
  assert.equal(topicResult.upgrade.actionLabel, "选择记录并补采详情");
  assert.match(topicResult.upgrade.message, /基础列表可以直接用于分析/);
  assert.equal(topicResult.upgrade.suggestOnlyWhen.length, 3);
  assert.equal(topicResult.upgrade.maxSampleCount, 100);
  assert.equal(topicResult.detailFailures.length, 0);
  assert.deepEqual(topicResult.representativeSamples, []);
  assert.equal(topicResult.computedMetrics.maxLikes, 12000);
  assert.equal(topicResponse.result.structuredContent.progress, null);

  child.stdin.write(
    `${JSON.stringify({
      jsonrpc: "2.0",
      id: 11,
      method: "tools/call",
      params: {
        name: "mediaclaw_query_dataset",
        arguments: {
          datasetId: topicResult.datasetId,
          limit: 5,
          sortBy: "likes",
        },
      },
    })}\n`,
  );
  const datasetResponse = await reader.waitFor((message) => message.id === 11);
  assert.equal(datasetResponse.result.structuredContent.totalCount, 12);
  assert.equal(datasetResponse.result.structuredContent.records.length, 5);
  assert.equal(datasetResponse.result.structuredContent.records[0].likes, 12000);

  child.stdin.write(
    `${JSON.stringify({
      jsonrpc: "2.0",
      id: 12,
      method: "tools/call",
      params: {
        name: "mediaclaw_research_account_hits",
        arguments: {
          profileUrl:
            "https://www.xiaohongshu.com/user/profile/recent-test",
          scanLimit: 8,
          recentPostLimit: 5,
          resultLimit: 3,
        },
      },
    })}\n`,
  );
  const accountHitsResponse = await reader.waitFor(
    (message) => message.id === 12,
  );
  const accountHits = accountHitsResponse.result.structuredContent.result;
  assert.equal(accountHits.recommendedMethodId, "account-recent-hits-v1");
  assert.equal(accountHits.recommendedMethodVersion, "2.0.0");
  assert.equal(accountHits.coverage.recencyBasis, "profile_page_order");
  assert.equal(accountHits.topPosts.length, 3);
  assert.equal(accountHits.topPosts[0].id, "recent-2");
  assert.equal(accountHits.topPosts[0].likes, 8000);
  assert.equal(accountHits.topPosts[0].recentRank, 2);

  child.stdin.write(
    `${JSON.stringify({
      jsonrpc: "2.0",
      id: 13,
      method: "tools/call",
      params: {
        name: "mediaclaw_list_style_profiles",
        arguments: {},
      },
    })}\n`,
  );
  const styleListResponse = await reader.waitFor((message) => message.id === 13);
  const styleList = styleListResponse.result.structuredContent.result;
  assert.equal(styleList.count, 1);
  assert.equal(styleList.profiles[0].profileId, "style-codex");

  child.stdin.write(
    `${JSON.stringify({
      jsonrpc: "2.0",
      id: 14,
      method: "tools/call",
      params: {
        name: "mediaclaw_get_style_profile",
        arguments: {query: "Codex 研究所"},
      },
    })}\n`,
  );
  const styleGetResponse = await reader.waitFor((message) => message.id === 14);
  const savedStyle = styleGetResponse.result.structuredContent.result;
  assert.equal(savedStyle.matchStatus, "matched");
  assert.equal(savedStyle.profile.bloggerName, "Codex 研究所");
  assert.equal(
    savedStyle.profile.styleAnalysis.languageStyle.tone,
    "直接、具体",
  );
  assert.ok(savedStyle.profile.styleAnalysis.largeEvidence.length > 100_000);

  child.stdin.write(
    `${JSON.stringify({
      jsonrpc: "2.0",
      id: 141,
      method: "tools/call",
      params: {
        name: "mediaclaw_get_style_profile",
        arguments: {query: "Codex 研究所", async: true},
        task: {ttl: 60_000},
      },
    })}\n`,
  );
  const asyncStyleGetResponse = await reader.waitFor(
    (message) => message.id === 141,
  );
  assert.equal(asyncStyleGetResponse.result.structuredContent.ok, true);
  assert.match(
    asyncStyleGetResponse.result.structuredContent.taskId,
    /^capture_/,
  );
  assert.equal(
    asyncStyleGetResponse.result.structuredContent.task.status,
    "working",
  );

  child.stdin.write(
    `${JSON.stringify({
      jsonrpc: "2.0",
      id: 15,
      method: "tools/call",
      params: {
        name: "mediaclaw_capture_account_profile",
        arguments: {
          profileUrl:
            "https://www.xiaohongshu.com/user/profile/creator-a",
        },
      },
    })}\n`,
  );
  const profileResponse = await reader.waitFor((message) => message.id === 15);
  assert.equal(
    profileResponse.result.structuredContent.result.profile.bloggerName,
    "创作者 A",
  );
  assert.equal(
    profileResponse.result.structuredContent.result.profile.followersCount,
    12000,
  );

  child.stdin.write(
    `${JSON.stringify({
      jsonrpc: "2.0",
      id: 151,
      method: "tools/call",
      params: {
        name: "mediaclaw_prepare_profile_collection",
        arguments: {
          userGoal: "采集这个主页所有视频的详情",
          profileUrl:
            "https://www.xiaohongshu.com/user/profile/collection-plan-test",
          purpose: "full_collection",
          contentType: "video",
          coverage: "all_available",
          maxItems: 3,
          requestedFields: [
            "account_profile",
            "title",
            "post_page_url",
            "publish_time",
            "engagement_metrics",
            "content_text",
            "media_urls",
          ],
        },
      },
    })}\n`,
  );
  const preparedProfileCollection = await reader.waitFor(
    (message) => message.id === 151,
  );
  const profileCollectionPlan =
    preparedProfileCollection.result.structuredContent.plan;
  assert.equal(
    preparedProfileCollection.result.structuredContent.collectionStarted,
    false,
  );
  assert.equal(profileCollectionPlan.status, "awaiting_confirmation");
  assert.equal(profileCollectionPlan.intent.contentType, "video");
  assert.equal(profileCollectionPlan.collectionScope.detailTargetLimit, 3);
  assert.equal(profileCollectionPlan.browserActions.maximumDetailPageVisits, 3);
  assert.equal(profileCollectionPlan.riskNotice.level, "normal");
  assert.equal(profileCollectionPlan.riskNotice.label, "普通确认");
  assert.equal(profileCollectionPlan.riskNotice.warnings.length, 0);
  assert.match(profileCollectionPlan.confirmation.prompt, /确认后才会开始采集/);
  assert.equal(collectionPlanTaskStarts, 0);

  child.stdin.write(
    `${JSON.stringify({
      jsonrpc: "2.0",
      id: 1511,
      method: "tools/call",
      params: {
        name: "mediaclaw_prepare_profile_collection",
        arguments: {
          userGoal: "完整采集这个账号约 372 条作品的基础清单",
          profileUrl:
            "https://www.xiaohongshu.com/user/profile/collection-plan-test",
          purpose: "full_collection",
          contentType: "all",
          coverage: "all_available",
          maxItems: 372,
          requestedFields: ["title", "post_page_url"],
        },
      },
    })}\n`,
  );
  const preparedLargeProfileCollection = await reader.waitFor(
    (message) => message.id === 1511,
  );
  const largeProfileCollectionPlan =
    preparedLargeProfileCollection.result.structuredContent.plan;
  assert.deepEqual(largeProfileCollectionPlan.browserActions.scanBatches, [
    300,
    72,
  ]);
  assert.equal(largeProfileCollectionPlan.intent.operationMode, "full_archive");
  assert.equal(largeProfileCollectionPlan.archive.enabled, true);
  assert.equal(largeProfileCollectionPlan.archive.failureRetryPasses, 1);
  assert.equal(
    largeProfileCollectionPlan.archive.fullRecordQuery.arguments.filters
      .contentType,
    "all",
  );
  assert.equal(largeProfileCollectionPlan.recommendation.requestedCount, 372);
  assert.equal(largeProfileCollectionPlan.recommendation.userScopePreserved, true);
  assert.equal(largeProfileCollectionPlan.riskNotice.level, "yellow");
  assert.equal(largeProfileCollectionPlan.riskNotice.label, "黄色风险提示");
  assert.match(
    largeProfileCollectionPlan.confirmation.prompt,
    /300 \+ 72/,
  );
  assert.equal(collectionPlanTaskStarts, 0);

  child.stdin.write(
    `${JSON.stringify({
      jsonrpc: "2.0",
      id: 1513,
      method: "tools/call",
      params: {
        name: "mediaclaw_prepare_profile_collection",
        arguments: {
          userGoal: "采集 372 条作品用于账号内容分析",
          profileUrl:
            "https://www.xiaohongshu.com/user/profile/collection-plan-test",
          purpose: "account_analysis",
          analysisTranscriptDecision: "recommend",
          analysisTranscriptReason: "需要比较代表视频的口播结构和语言表达",
          contentType: "all",
          coverage: "all_available",
          maxItems: 372,
          requestedFields: ["title", "post_page_url", "engagement_metrics"],
        },
      },
    })}\n`,
  );
  const preparedAnalysisCollection = await reader.waitFor(
    (message) => message.id === 1513,
  );
  const analysisCollectionPlan =
    preparedAnalysisCollection.result.structuredContent.plan;
  assert.equal(analysisCollectionPlan.recommendation.recommendedCount, 50);
  assert.equal(analysisCollectionPlan.recommendation.followsRecommendation, false);
  assert.equal(analysisCollectionPlan.recommendation.userScopePreserved, true);
  assert.equal(analysisCollectionPlan.riskNotice.level, "yellow");
  assert.equal(analysisCollectionPlan.riskNotice.changesRequestedScope, false);
  assert.match(
    analysisCollectionPlan.confirmation.prompt,
    /建议先采 50 条.*仍按 372 条执行/,
  );
  assert.equal(analysisCollectionPlan.collectionScope.detailTargetLimit, 15);
  assert.equal(
    analysisCollectionPlan.analysisContract.evidenceBaseline.transcripts,
    8,
  );
  assert.ok(analysisCollectionPlan.requestedFields.includes("content_text"));
  assert.ok(analysisCollectionPlan.requestedFields.includes("video_transcript"));
  assert.ok(
    analysisCollectionPlan.analysisContract.fieldPolicy.autoAddedFields.includes(
      "video_transcript",
    ),
  );
  assert.equal(collectionPlanTaskStarts, 0);

  child.stdin.write(
    `${JSON.stringify({
      jsonrpc: "2.0",
      id: 15131,
      method: "tools/call",
      params: {
        name: "mediaclaw_prepare_profile_collection",
        arguments: {
          userGoal: "帮我分析这个账号",
          profileUrl:
            "https://www.xiaohongshu.com/user/profile/account-analysis-contract-test",
          purpose: "account_analysis",
          analysisTranscriptDecision: "recommend",
          analysisTranscriptReason: "需要完成工作台同构的视频内容机制分析",
          contentType: "all",
          coverage: "all_available",
          requestedFields: [
            "account_profile",
            "title",
            "post_page_url",
            "cover",
            "publish_time",
            "engagement_metrics",
            "content_text",
            "media_urls",
            "comments",
            "video_transcript",
          ],
        },
      },
    })}\n`,
  );
  const preparedWorkbenchParityAnalysis = await reader.waitFor(
    (message) => message.id === 15131,
  );
  const workbenchParityPlan =
    preparedWorkbenchParityAnalysis.result.structuredContent.plan;
  assert.equal(workbenchParityPlan.collectionScope.detailTargetLimit, 15);
  assert.equal(workbenchParityPlan.riskNotice.estimates.listItems, 50);
  assert.equal(workbenchParityPlan.riskNotice.estimates.detailPageVisits, 15);
  assert.equal(workbenchParityPlan.riskNotice.estimates.comments, 450);
  assert.equal(workbenchParityPlan.riskNotice.level, "normal");
  assert.equal(
    workbenchParityPlan.analysisContract.evidenceBaseline.transcripts,
    8,
  );
  assert.equal(
    workbenchParityPlan.analysisContract.evidenceBaseline.covers,
    12,
  );
  assert.equal(
    workbenchParityPlan.analysisContract.representativeSelection,
    "workbench_high5_typical6_low4",
  );
  assert.match(workbenchParityPlan.confirmation.prompt, /最多 15 个详情页/);
  assert.doesNotMatch(workbenchParityPlan.confirmation.prompt, /50 个详情页/);
  assert.equal(collectionPlanTaskStarts, 0);

  child.stdin.write(
    `${JSON.stringify({
      jsonrpc: "2.0",
      id: 15132,
      method: "tools/call",
      params: {
        name: "mediaclaw_prepare_profile_collection",
        arguments: {
          userGoal: "帮我分析这个账号",
          profileUrl:
            "https://www.xiaohongshu.com/user/profile/account-analysis-auto-fields",
          purpose: "account_analysis",
          analysisTranscriptDecision: "recommend",
          analysisTranscriptReason: "需要分析代表视频的口播、叙事和节奏机制",
          contentType: "all",
          coverage: "all_available",
        },
      },
    })}\n`,
  );
  const preparedAutomaticAnalysis = await reader.waitFor(
    (message) => message.id === 15132,
  );
  const automaticAnalysisPlan =
    preparedAutomaticAnalysis.result.structuredContent.plan;
  assert.equal(automaticAnalysisPlan.recommendation.requestedCount, 50);
  assert.equal(automaticAnalysisPlan.collectionScope.detailTargetLimit, 15);
  assert.equal(
    automaticAnalysisPlan.analysisContract.evidenceBaseline.transcripts,
    8,
  );
  assert.deepEqual(
    automaticAnalysisPlan.analysisContract.fieldPolicy.userRequestedFields,
    [],
  );
  assert.ok(automaticAnalysisPlan.requestedFields.includes("cover"));
  assert.ok(automaticAnalysisPlan.requestedFields.includes("content_text"));
  assert.ok(automaticAnalysisPlan.requestedFields.includes("video_transcript"));
  assert.equal(collectionPlanTaskStarts, 0);

  child.stdin.write(
    `${JSON.stringify({
      jsonrpc: "2.0",
      id: 15133,
      method: "tools/call",
      params: {
        name: "mediaclaw_prepare_profile_collection",
        arguments: {
          userGoal: "只看这个账号的选题和标题表现",
          profileUrl:
            "https://www.xiaohongshu.com/user/profile/account-analysis-no-transcript",
          purpose: "account_analysis",
          contentType: "all",
          coverage: "all_available",
          analysisTranscriptDecision: "not_needed",
          analysisTranscriptReason:
            "当前问题只比较标题、选题和互动分布，逐字稿不会改变结论",
        },
      },
    })}\n`,
  );
  const preparedNoTranscriptAnalysis = await reader.waitFor(
    (message) => message.id === 15133,
  );
  const noTranscriptAnalysisPlan =
    preparedNoTranscriptAnalysis.result.structuredContent.plan;
  assert.equal(
    noTranscriptAnalysisPlan.analysisContract.evidenceBaseline.transcripts,
    0,
  );
  assert.equal(
    noTranscriptAnalysisPlan.requestedFields.includes("video_transcript"),
    false,
  );
  assert.equal(
    noTranscriptAnalysisPlan.analysisContract.fieldPolicy.transcriptTrigger,
    "not_needed",
  );
  assert.equal(collectionPlanTaskStarts, 0);

  for (const riskCase of [
    {
      id: 1514,
      maxItems: 21,
      commentsPerItemLimit: undefined,
      requestedFields: ["title", "content_text"],
      expectedLevel: "yellow",
      expectedWarning: /21 个详情页/,
    },
    {
      id: 1515,
      maxItems: 20,
      commentsPerItemLimit: 300,
      requestedFields: ["title", "comments"],
      expectedLevel: "red",
      expectedWarning: /6000 条评论/,
    },
    {
      id: 1516,
      maxItems: 1001,
      commentsPerItemLimit: undefined,
      requestedFields: ["title", "post_page_url"],
      expectedLevel: "red",
      expectedWarning: /超过 15 分钟 1000 条/,
    },
  ]) {
    child.stdin.write(
      `${JSON.stringify({
        jsonrpc: "2.0",
        id: riskCase.id,
        method: "tools/call",
        params: {
          name: "mediaclaw_prepare_profile_collection",
          arguments: {
            userGoal: "验证账号采集风险分级",
            profileUrl:
              "https://www.xiaohongshu.com/user/profile/collection-risk-test",
            purpose: "full_collection",
            contentType: "all",
            coverage: "all_available",
            maxItems: riskCase.maxItems,
            ...(riskCase.commentsPerItemLimit
              ? {commentsPerItemLimit: riskCase.commentsPerItemLimit}
              : {}),
            requestedFields: riskCase.requestedFields,
          },
        },
      })}\n`,
    );
    const preparedRiskCollection = await reader.waitFor(
      (message) => message.id === riskCase.id,
    );
    const riskPlan = preparedRiskCollection.result.structuredContent.plan;
    assert.equal(riskPlan.riskNotice.level, riskCase.expectedLevel);
    assert.match(
      riskPlan.riskNotice.warnings.join("；"),
      riskCase.expectedWarning,
    );
    assert.equal(
      preparedRiskCollection.result.structuredContent.collectionStarted,
      false,
    );
  }

  child.stdin.write(
    `${JSON.stringify({
      jsonrpc: "2.0",
      id: 152,
      method: "tools/call",
      params: {
        name: "mediaclaw_confirm_profile_collection",
        arguments: {planId: profileCollectionPlan.planId},
      },
    })}\n`,
  );
  const confirmedProfileCollection = await reader.waitFor(
    (message) => message.id === 152,
  );
  const profileCollectionResult =
    confirmedProfileCollection.result.structuredContent.result;
  assert.equal(
    confirmedProfileCollection.result.structuredContent.task.ttl,
    7 * 24 * 60 * 60 * 1000,
  );
  assert.equal(profileCollectionResult.workflow, "profile_collection");
  assert.equal(profileCollectionResult.goalStatus, "completed");
  assert.equal(profileCollectionResult.coverage.actualScannedCount, 3);
  assert.equal(profileCollectionResult.coverage.matchedCount, 2);
  assert.equal(profileCollectionResult.coverage.detailRequestedCount, 2);
  assert.equal(profileCollectionResult.coverage.detailSuccessCount, 2);
  assert.equal(profileCollectionResult.records.length, 2);
  assert.equal(profileCollectionResult.records[0].previewOnly, true);
  assert.match(
    profileCollectionResult.records[0].assetId,
    /^local\.data_pool\|capture_record\|/,
  );
  assert.equal("normalizedPayload" in profileCollectionResult.records[0], false);
  assert.equal("rawPayload" in profileCollectionResult.records[0], false);
  assert.ok(JSON.stringify(profileCollectionResult.records).length < 10_000);
  assert.match(profileCollectionResult.archiveJobId, /^archive_/);
  assert.equal(
    profileCollectionResult.archive.archiveJobId,
    profileCollectionResult.archiveJobId,
  );
  assert.equal(profileCollectionResult.archive.taskRetentionDays, 7);
  assert.equal(profileCollectionResult.archive.storedRecordCount, 2);
  assert.equal(
    profileCollectionResult.archive.fullRecordQuery.arguments.filters
      .contentType,
    "video",
  );
  assert.equal(
    profileCollectionResult.archive.fullRecordRead.tool,
    "mediaclaw_get_asset",
  );
  assert.deepEqual(
    profileCollectionResult.executionLog.map((step) => step.id),
    [
      "profile_info",
      "profile_inventory",
      "content_filter",
      "detail_enhancement",
      "coverage_audit",
    ],
  );
  assert.equal(collectionPlanTaskStarts, 3);

  child.stdin.write(
    `${JSON.stringify({
      jsonrpc: "2.0",
      id: 153,
      method: "tools/call",
      params: {
        name: "mediaclaw_confirm_profile_collection",
        arguments: {planId: profileCollectionPlan.planId},
      },
    })}\n`,
  );
  const reusedProfileCollectionPlan = await reader.waitFor(
    (message) => message.id === 153,
  );
  assert.equal(
    reusedProfileCollectionPlan.result.structuredContent.error.code,
    "PROFILE_COLLECTION_PLAN_ALREADY_USED",
  );
  assert.equal(collectionPlanTaskStarts, 3);

  child.stdin.write(
    `${JSON.stringify({
      jsonrpc: "2.0",
      id: 1512,
      method: "tools/call",
      params: {
        name: "mediaclaw_confirm_profile_collection",
        arguments: {planId: largeProfileCollectionPlan.planId},
      },
    })}\n`,
  );
  const confirmedLargeProfileCollection = await reader.waitFor(
    (message) => message.id === 1512,
  );
  const largeProfileCollectionResult =
    confirmedLargeProfileCollection.result.structuredContent.result;
  assert.equal(largeProfileCollectionResult.goalStatus, "completed");
  assert.equal(largeProfileCollectionResult.coverage.requestedScanCount, 372);
  assert.equal(largeProfileCollectionResult.coverage.scanBatchCount, 2);
  assert.deepEqual(
    largeProfileCollectionResult.executionLog[0].batches.map(
      (batch) => batch.requestedCount,
    ),
    [300, 72],
  );
  assert.equal(collectionPlanTaskStarts, 5);

  child.stdin.write(
    `${JSON.stringify({
      jsonrpc: "2.0",
      id: 154,
      method: "tools/call",
      params: {
        name: "mediaclaw_prepare_profile_collection",
        arguments: {
          userGoal: "采集这条视频详情并保留失败原因",
          profileUrl:
            "https://www.xiaohongshu.com/user/profile/collection-failure-test",
          purpose: "full_collection",
          contentType: "video",
          coverage: "all_available",
          maxItems: 1,
          requestedFields: ["title", "post_page_url", "content_text"],
        },
      },
    })}\n`,
  );
  const preparedFailureCollection = await reader.waitFor(
    (message) => message.id === 154,
  );
  const failurePlanId =
    preparedFailureCollection.result.structuredContent.plan.planId;
  child.stdin.write(
    `${JSON.stringify({
      jsonrpc: "2.0",
      id: 155,
      method: "tools/call",
      params: {
        name: "mediaclaw_confirm_profile_collection",
        arguments: {planId: failurePlanId},
      },
    })}\n`,
  );
  const failedDetailCollection = await reader.waitFor(
    (message) => message.id === 155,
  );
  const failedDetailResult =
    failedDetailCollection.result.structuredContent.result;
  assert.equal(failedDetailResult.goalStatus, "partial");
  assert.equal(failedDetailResult.coverage.detailFailedCount, 1);
  assert.equal(
    failedDetailResult.failureSummary.detailItems[0].classification,
    "page_load_or_parse_failure",
  );
  assert.equal(failedDetailResult.failureSummary.quantityLimitFailureCount, 0);
  assert.equal(failedDetailResult.retrySummary.detail.attemptedPasses, 1);
  assert.equal(failedDetailResult.retrySummary.detail.unresolvedRecordCount, 1);
  assert.equal(permanentDetailAttempts, 2);
  assert.match(failedDetailResult.limitations.join("；"), /不属于数量上限/);

  child.stdin.write(
    `${JSON.stringify({
      jsonrpc: "2.0",
      id: 156,
      method: "tools/call",
      params: {
        name: "mediaclaw_prepare_profile_collection",
        arguments: {
          userGoal: "完整归档这条视频，详情失败时自动重试，并采集 45 条评论",
          profileUrl:
            "https://www.xiaohongshu.com/user/profile/collection-retry-test",
          purpose: "full_collection",
          contentType: "video",
          coverage: "all_available",
          maxItems: 1,
          commentsPerItemLimit: 45,
          requestedFields: [
            "title",
            "post_page_url",
            "content_text",
            "comments",
          ],
        },
      },
    })}\n`,
  );
  const preparedRetryCollection = await reader.waitFor(
    (message) => message.id === 156,
  );
  const retryPlanId =
    preparedRetryCollection.result.structuredContent.plan.planId;
  child.stdin.write(
    `${JSON.stringify({
      jsonrpc: "2.0",
      id: 157,
      method: "tools/call",
      params: {
        name: "mediaclaw_confirm_profile_collection",
        arguments: {planId: retryPlanId},
      },
    })}\n`,
  );
  const retriedDetailCollection = await reader.waitFor(
    (message) => message.id === 157,
  );
  const retriedDetailResult =
    retriedDetailCollection.result.structuredContent.result;
  assert.equal(retriedDetailResult.goalStatus, "completed");
  assert.equal(retriedDetailResult.coverage.detailSuccessCount, 1);
  assert.equal(retriedDetailResult.coverage.detailFailedCount, 0);
  assert.equal(retriedDetailResult.retrySummary.detail.attemptedPasses, 1);
  assert.equal(retriedDetailResult.retrySummary.detail.recoveredRecordCount, 1);
  assert.equal(retriedDetailResult.failureSummary.detailItems.length, 0);
  assert.equal(transientDetailAttempts, 2);

  child.stdin.write(
    `${JSON.stringify({
      jsonrpc: "2.0",
      id: 158,
      method: "tools/call",
      params: {
        name: "mediaclaw_prepare_profile_collection",
        arguments: {
          userGoal: "完整归档账号基础清单，主页加载失败时继续重试",
          profileUrl:
            "https://www.xiaohongshu.com/user/profile/collection-scan-retry-test",
          purpose: "full_collection",
          contentType: "all",
          coverage: "all_available",
          maxItems: 1,
          requestedFields: ["title", "post_page_url"],
        },
      },
    })}\n`,
  );
  const preparedScanRetryCollection = await reader.waitFor(
    (message) => message.id === 158,
  );
  const scanRetryPlanId =
    preparedScanRetryCollection.result.structuredContent.plan.planId;
  child.stdin.write(
    `${JSON.stringify({
      jsonrpc: "2.0",
      id: 159,
      method: "tools/call",
      params: {
        name: "mediaclaw_confirm_profile_collection",
        arguments: {planId: scanRetryPlanId},
      },
    })}\n`,
  );
  const retriedScanCollection = await reader.waitFor(
    (message) => message.id === 159,
  );
  const retriedScanResult =
    retriedScanCollection.result.structuredContent.result;
  assert.equal(retriedScanResult.goalStatus, "completed");
  assert.equal(retriedScanResult.coverage.actualScannedCount, 1);
  assert.equal(retriedScanResult.retrySummary.scan.attemptedPasses, 1);
  assert.equal(retriedScanResult.retrySummary.scan.recoveredBatchCount, 1);
  assert.equal(retriedScanResult.failureSummary.scanBatches.length, 0);
  assert.equal(transientScanAttempts, 2);

  child.stdin.write(
    `${JSON.stringify({
      jsonrpc: "2.0",
      id: 1591,
      method: "tools/call",
      params: {
        name: "mediaclaw_prepare_profile_collection",
        arguments: {
          userGoal: "归档 101 条视频详情，详情页验证码时暂停",
          profileUrl:
            "https://www.xiaohongshu.com/user/profile/collection-detail-captcha-test",
          purpose: "full_collection",
          contentType: "video",
          coverage: "all_available",
          maxItems: 101,
          failureRetryPasses: 2,
          requestedFields: ["title", "post_page_url", "content_text"],
        },
      },
    })}\n`,
  );
  const preparedDetailCaptchaCollection = await reader.waitFor(
    (message) => message.id === 1591,
  );
  assert.equal(
    preparedDetailCaptchaCollection.result.structuredContent.plan.riskNotice
      .level,
    "red",
  );
  const detailCaptchaPlanId =
    preparedDetailCaptchaCollection.result.structuredContent.plan.planId;
  child.stdin.write(
    `${JSON.stringify({
      jsonrpc: "2.0",
      id: 1592,
      method: "tools/call",
      params: {
        name: "mediaclaw_confirm_profile_collection",
        arguments: {planId: detailCaptchaPlanId},
      },
    })}\n`,
  );
  const pausedDetailCaptchaCollection = await reader.waitFor(
    (message) => message.id === 1592,
  );
  const pausedDetailCaptchaPayload =
    pausedDetailCaptchaCollection.result.structuredContent;
  assert.equal(pausedDetailCaptchaPayload.task.status, "input_required");
  assert.equal(
    pausedDetailCaptchaPayload.result.executionInterruption.stage,
    "detail_enhancement",
  );
  assert.equal(
    pausedDetailCaptchaPayload.result.coverage.detailAttemptedCount,
    100,
  );
  assert.equal(
    pausedDetailCaptchaPayload.result.coverage.detailFailedCount,
    100,
  );
  assert.equal(
    pausedDetailCaptchaPayload.result.coverage.detailUnattemptedCount,
    1,
  );
  assert.equal(detailCaptchaAttempts, 1);

  child.stdin.write(
    `${JSON.stringify({
      jsonrpc: "2.0",
      id: 160,
      method: "tools/call",
      params: {
        name: "mediaclaw_prepare_profile_collection",
        arguments: {
          userGoal: "完整归档账号基础清单，验证码时暂停等待处理",
          profileUrl:
            "https://www.xiaohongshu.com/user/profile/collection-captcha-test",
          purpose: "full_collection",
          contentType: "all",
          coverage: "all_available",
          maxItems: 1,
          failureRetryPasses: 2,
          requestedFields: ["title", "post_page_url"],
        },
      },
    })}\n`,
  );
  const preparedCaptchaCollection = await reader.waitFor(
    (message) => message.id === 160,
  );
  const captchaPlanId =
    preparedCaptchaCollection.result.structuredContent.plan.planId;
  child.stdin.write(
    `${JSON.stringify({
      jsonrpc: "2.0",
      id: 161,
      method: "tools/call",
      params: {
        name: "mediaclaw_confirm_profile_collection",
        arguments: {planId: captchaPlanId},
      },
    })}\n`,
  );
  const pausedCaptchaCollection = await reader.waitFor(
    (message) => message.id === 161,
  );
  const pausedCaptchaPayload =
    pausedCaptchaCollection.result.structuredContent;
  assert.equal(pausedCaptchaPayload.task.status, "input_required");
  assert.equal(pausedCaptchaPayload.result.goalStatus, "paused_for_user_action");
  assert.equal(
    pausedCaptchaPayload.result.nextAction.action,
    "complete_browser_verification",
  );
  assert.equal(
    pausedCaptchaPayload.result.nextAction.preservesCompletedRecords,
    true,
  );
  assert.equal(
    pausedCaptchaPayload.result.nextAction.doesNotMeanUnsupported,
    true,
  );
  assert.doesNotMatch(pausedCaptchaPayload.task.statusMessage, /做不了/);
  assert.match(pausedCaptchaPayload.task.statusMessage, /采集已暂停/);
  assert.equal(captchaScanAttempts, 1);

  child.stdin.write(
    `${JSON.stringify({
      jsonrpc: "2.0",
      id: 162,
      method: "tools/call",
      params: {
        name: "mediaclaw_prepare_profile_collection",
        arguments: {
          userGoal: "验证码处理后继续采集另一个小范围账号",
          profileUrl:
            "https://www.xiaohongshu.com/user/profile/collection-after-captcha-test",
          purpose: "full_collection",
          contentType: "all",
          coverage: "all_available",
          maxItems: 1,
          requestedFields: ["title", "post_page_url"],
        },
      },
    })}\n`,
  );
  const preparedAfterCaptcha = await reader.waitFor(
    (message) => message.id === 162,
  );
  const afterCaptchaRisk =
    preparedAfterCaptcha.result.structuredContent.plan.riskNotice;
  assert.equal(afterCaptchaRisk.level, "red");
  assert.equal(afterCaptchaRisk.recentSignals.length > 0, true);
  assert.match(afterCaptchaRisk.warnings.join("；"), /近期.*验证码/);

  child.stdin.write(
    `${JSON.stringify({
      jsonrpc: "2.0",
      id: 163,
      method: "tools/call",
      params: {
        name: "mediaclaw_prepare_profile_collection",
        arguments: {
          userGoal: "平台冷却时暂停并告诉我何时继续",
          profileUrl:
            "https://www.xiaohongshu.com/user/profile/collection-cooldown-test",
          purpose: "full_collection",
          contentType: "all",
          coverage: "all_available",
          maxItems: 1,
          failureRetryPasses: 2,
          requestedFields: ["title", "post_page_url"],
        },
      },
    })}\n`,
  );
  const preparedCooldownCollection = await reader.waitFor(
    (message) => message.id === 163,
  );
  child.stdin.write(
    `${JSON.stringify({
      jsonrpc: "2.0",
      id: 164,
      method: "tools/call",
      params: {
        name: "mediaclaw_confirm_profile_collection",
        arguments: {
          planId:
            preparedCooldownCollection.result.structuredContent.plan.planId,
        },
      },
    })}\n`,
  );
  const pausedCooldownCollection = await reader.waitFor(
    (message) => message.id === 164,
  );
  const pausedCooldownPayload =
    pausedCooldownCollection.result.structuredContent;
  assert.equal(pausedCooldownPayload.task.status, "input_required");
  assert.equal(
    pausedCooldownPayload.result.nextAction.action,
    "wait_for_platform_cooldown",
  );
  assert.equal(
    pausedCooldownPayload.result.nextAction.nextAllowedAt,
    "2099-01-01T00:00:00.000Z",
  );
  assert.match(pausedCooldownPayload.task.statusMessage, /不表示插件做不了/);
  assert.equal(cooldownScanAttempts, 1);

  child.stdin.write(
    `${JSON.stringify({
      jsonrpc: "2.0",
      id: 165,
      method: "tools/call",
      params: {
        name: "mediaclaw_prepare_profile_collection",
        arguments: {
          userGoal: "登录失效时暂停并保留已完成数据",
          profileUrl:
            "https://www.xiaohongshu.com/user/profile/collection-login-test",
          purpose: "full_collection",
          contentType: "all",
          coverage: "all_available",
          maxItems: 1,
          failureRetryPasses: 2,
          requestedFields: ["title", "post_page_url"],
        },
      },
    })}\n`,
  );
  const preparedLoginCollection = await reader.waitFor(
    (message) => message.id === 165,
  );
  child.stdin.write(
    `${JSON.stringify({
      jsonrpc: "2.0",
      id: 166,
      method: "tools/call",
      params: {
        name: "mediaclaw_confirm_profile_collection",
        arguments: {
          planId: preparedLoginCollection.result.structuredContent.plan.planId,
        },
      },
    })}\n`,
  );
  const pausedLoginCollection = await reader.waitFor(
    (message) => message.id === 166,
  );
  const pausedLoginPayload = pausedLoginCollection.result.structuredContent;
  assert.equal(pausedLoginPayload.task.status, "input_required");
  assert.equal(
    pausedLoginPayload.result.nextAction.action,
    "restore_browser_login",
  );
  assert.equal(
    pausedLoginPayload.result.nextAction.preservesCompletedRecords,
    true,
  );
  assert.match(pausedLoginPayload.task.statusMessage, /恢复账号登录/);
  assert.equal(loginScanAttempts, 1);

  child.stdin.write(
    `${JSON.stringify({
      jsonrpc: "2.0",
      id: 16,
      method: "tools/call",
      params: {
        name: "mediaclaw_query_data_pool",
        arguments: {recordType: "single_note"},
      },
    })}\n`,
  );
  const poolResponse = await reader.waitFor((message) => message.id === 16);
  assert.equal(poolResponse.result.structuredContent.result.totalCount, 1);
  assert.equal(
    poolResponse.result.structuredContent.result.records[0].id,
    "rec-note-demo",
  );

  child.stdin.write(
    `${JSON.stringify({
      jsonrpc: "2.0",
      id: 17,
      method: "tools/call",
      params: {
        name: "mediaclaw_get_data_pool_record",
        arguments: {recordId: "rec-note-demo"},
      },
    })}\n`,
  );
  const poolRecordResponse = await reader.waitFor(
    (message) => message.id === 17,
  );
  assert.equal(
    poolRecordResponse.result.structuredContent.result.record.id,
    "rec-note-demo",
  );

  child.stdin.write(
    `${JSON.stringify({
      jsonrpc: "2.0",
      id: 18,
      method: "tools/call",
      params: {
        name: "mediaclaw_extract_image_text",
        arguments: {recordId: "rec-note-demo"},
      },
    })}\n`,
  );
  const imageTextResponse = await reader.waitFor(
    (message) => message.id === 18,
  );
  assert.equal(
    imageTextResponse.result.structuredContent.result.text,
    "图片中的文案",
  );

  child.stdin.write(
    `${JSON.stringify({
      jsonrpc: "2.0",
      id: 19,
      method: "tools/call",
      params: {
        name: "mediaclaw_quote_video_transcript",
        arguments: {recordIds: ["rec-video-demo"]},
      },
    })}\n`,
  );
  const transcriptQuote = await reader.waitFor(
    (message) => message.id === 19,
  );
  assert.equal(
    transcriptQuote.result.structuredContent.result.status,
    "quoted",
  );
  assert.equal(
    transcriptQuote.result.structuredContent.result.estimatedCredits,
    2,
  );
  assert.equal(
    transcriptQuote.result.structuredContent.result.quoteId,
    "quote-test-1",
  );

  child.stdin.write(
    `${JSON.stringify({
      jsonrpc: "2.0",
      id: 190,
      method: "tools/call",
      params: {
        name: "mediaclaw_confirm_video_transcript",
        arguments: {quoteId: "quote-test-1"},
      },
    })}\n`,
  );
  const confirmedTranscript = await reader.waitFor(
    (message) => message.id === 190,
  );
  assert.equal(
    confirmedTranscript.result.structuredContent.result.status,
    "done",
  );
  assert.equal(
    confirmedTranscript.result.structuredContent.result.text,
    "视频逐字稿",
  );

  child.stdin.write(
    `${JSON.stringify({
      jsonrpc: "2.0",
      id: 191,
      method: "tools/call",
      params: {
        name: "mediaclaw_enhance_records",
        arguments: {
          recordIds: ["rec-note-demo"],
          confirmed: true,
        },
      },
    })}\n`,
  );
  const enhancedRecordResponse = await reader.waitFor(
    (message) => message.id === 191,
  );
  const enhancedRecord =
    enhancedRecordResponse.result.structuredContent.result.records[0];
  assert.equal(enhancedRecord.normalizedPayload.content, "完整正文");
  assert.equal(enhancedRecord.rawPayload.source, "plugin-detail-owner");

  child.stdin.write(
    `${JSON.stringify({
      jsonrpc: "2.0",
      id: 20,
      method: "tools/call",
      params: {
        name: "mediaclaw_research_benchmark_accounts",
        arguments: {
          keyword: "AI工具",
          scanLimit: 20,
          candidateLimit: 2,
        },
      },
    })}\n`,
  );
  const benchmarkResponse = await reader.waitFor(
    (message) => message.id === 20,
  );
  const benchmark = benchmarkResponse.result.structuredContent.result;
  assert.equal(
    benchmark.recommendedMethodId,
    "benchmark-account-discovery-v1",
  );
  assert.equal(benchmark.recommendedMethodVersion, "2.0.0");
  assert.equal(benchmark.candidates.length, 2);
  assert.equal(benchmark.candidates[0].author, "创作者 A");
  assert.equal(benchmark.candidates[0].postCount, 2);
  assert.equal(benchmark.candidates[0].profile.followersCount, 12000);
  assert.equal(
    benchmarkResponse.result.structuredContent.progress.processedCount,
    2,
  );

  child.stdin.write(
    `${JSON.stringify({
      jsonrpc: "2.0",
      id: 21,
      method: "tools/call",
      params: {
        name: "mediaclaw_research_single_note",
        arguments: {
          url: "https://www.xiaohongshu.com/explore/single-research",
          includeComments: true,
          includeMediaText: true,
          analysisTranscriptDecision: "not_needed",
          analysisTranscriptReason: "图文作品使用 OCR，不需要视频逐字稿",
        },
      },
    })}\n`,
  );
  const singleNoteResponse = await reader.waitFor(
    (message) => message.id === 21,
  );
  const singleNote = singleNoteResponse.result.structuredContent.result;
  assert.equal(singleNote.recommendedMethodId, "single-note-breakdown-v1");
  assert.equal(singleNote.recommendedMethodVersion, "3.0.0");
  assert.equal(singleNote.coverage.commentCount, 30);
  assert.equal(singleNote.mediaText.text, "图片中的文案");
  assert.equal(singleNote.coverage.recordId, "rec-note-single-research");

  child.stdin.write(
    `${JSON.stringify({
      jsonrpc: "2.0",
      id: 211,
      method: "tools/call",
      params: {
        name: "mediaclaw_research_single_note",
        arguments: {
          url: "https://www.douyin.com/video/single-video-research",
          platform: "douyin",
          includeComments: false,
          includeMediaText: true,
          analysisTranscriptDecision: "recommend",
          analysisTranscriptReason: "需要分析视频实际口播结构",
        },
      },
    })}\n`,
  );
  const singleVideoResponse = await reader.waitFor(
    (message) => message.id === 211,
  );
  const singleVideo = singleVideoResponse.result.structuredContent.result;
  assert.equal(singleVideo.mediaText.status, "quoted");
  assert.equal(singleVideo.mediaText.quoteId, "quote-test-1");
  assert.equal(singleVideo.mediaText.nextConfirmation.required, true);
  assert.equal(singleVideo.coverage.transcriptConfirmationRequired, true);
  assert.equal(singleVideo.coverage.transcriptEstimatedCredits, 2);

  child.stdin.write(
    `${JSON.stringify({
      jsonrpc: "2.0",
      id: 212,
      method: "tools/call",
      params: {
        name: "mediaclaw_research_single_note",
        arguments: {
          url: "https://www.douyin.com/video/single-video-existing",
          platform: "douyin",
          includeComments: false,
          includeMediaText: true,
          analysisTranscriptDecision: "recommend",
          analysisTranscriptReason: "需要分析视频实际口播结构",
        },
      },
    })}\n`,
  );
  const existingVideoResponse = await reader.waitFor(
    (message) => message.id === 212,
  );
  const existingVideo = existingVideoResponse.result.structuredContent.result;
  assert.equal(existingVideo.mediaText.status, "already_available");
  assert.equal(existingVideo.mediaText.text, "已有视频逐字稿");
  assert.equal(existingVideo.mediaText.chargedCredits, 0);
  assert.equal(existingVideo.coverage.transcriptConfirmationRequired, false);

  child.stdin.write(
    `${JSON.stringify({
      jsonrpc: "2.0",
      id: 213,
      method: "tools/call",
      params: {
        name: "mediaclaw_research_single_note",
        arguments: {
          url: "https://www.douyin.com/video/single-video-not-needed",
          platform: "douyin",
          includeComments: false,
          analysisTranscriptDecision: "not_needed",
          analysisTranscriptReason: "当前只比较标题、发布时间和互动指标",
        },
      },
    })}\n`,
  );
  const noTranscriptVideoResponse = await reader.waitFor(
    (message) => message.id === 213,
  );
  const noTranscriptVideo =
    noTranscriptVideoResponse.result.structuredContent.result;
  assert.equal(noTranscriptVideo.mediaText.status, "not_needed");
  assert.equal(noTranscriptVideo.mediaText.chargedCredits, 0);
  assert.equal(noTranscriptVideo.coverage.transcriptConfirmationRequired, false);
  assert.equal(noTranscriptVideo.coverage.transcriptDecision, "not_needed");

  const satellite = spawn(process.execPath, [serverPath], {
    env: {...process.env, MEDIACLAW_AGENT_PORT: String(port)},
    stdio: ["pipe", "pipe", "pipe"],
  });
  t.after(() => {
    satellite.kill("SIGTERM");
  });
  const satelliteReader = createLineReader(satellite.stdout);
  await waitForText(satellite.stderr, /Adapter connected to shared Broker/);
  satellite.stdin.write(
    `${JSON.stringify({
      jsonrpc: "2.0",
      id: 101,
      method: "initialize",
      params: {protocolVersion: "2025-11-25"},
    })}\n`,
  );
  await satelliteReader.waitFor((message) => message.id === 101);
  satellite.stdin.write(
    `${JSON.stringify({
      jsonrpc: "2.0",
      id: 102,
      method: "tools/call",
      params: {
        name: "mediaclaw_scan_keyword",
        arguments: {keyword: "露营", limit: 80},
      },
    })}\n`,
  );
  const proxiedResponse = await satelliteReader.waitFor(
    (message) => message.id === 102,
  );
  assert.equal(
    proxiedResponse.result.structuredContent.result.count,
    1,
  );
  assert.equal(
    proxiedResponse.result.structuredContent.result.records[0].normalizedPayload
      .items[0].title,
    "露营装备清单",
  );

  child.stdin.write(
    `${JSON.stringify({
      jsonrpc: "2.0",
      id: 3,
      method: "tools/call",
      params: {
        name: "mediaclaw_scan_account",
        task: {ttl: 60000},
        arguments: {
          profileUrl: "https://www.xiaohongshu.com/user/profile/test",
          async: true,
        },
      },
    })}\n`,
  );
  const asyncResponse = await reader.waitFor((message) => message.id === 3);
  assert.match(
    asyncResponse.result.structuredContent.task.taskId,
    /^capture_/,
  );
  assert.equal(
    asyncResponse.result.structuredContent.task.status,
    "working",
  );

  child.stdin.write(
    `${JSON.stringify({
      jsonrpc: "2.0",
      id: 31,
      method: "tools/call",
      params: {
        name: "mediaclaw_scan_account",
        task: {ttl: 60000},
        arguments: {
          profileUrl: "https://www.xiaohongshu.com/user/profile/native-task",
        },
      },
    })}\n`,
  );
  const nativeTaskResponse = await reader.waitFor(
    (message) => message.id === 31,
  );
  assert.match(nativeTaskResponse.result.task.taskId, /^capture_/);
  assert.equal(nativeTaskResponse.result.task.status, "working");

  socket.send(
    JSON.stringify({
      type: "task.result",
      taskId: "capture-recovered",
      task: {
        mode: "search_results",
        platform: "xiaohongshu",
        keyword: "露营",
        limit: 80,
      },
      response: {
        ok: true,
        data: {
          records: [
            {
              basic: {
                noteId: "recovered-1",
                title: "断线后恢复的结果",
                url: "https://www.xiaohongshu.com/explore/recovered-1",
                likes: 99,
              },
            },
          ],
        },
      },
    }),
  );
  const ack = await recoveredAck;
  assert.equal(ack.recovered, true);

  child.stdin.write(
    `${JSON.stringify({
      jsonrpc: "2.0",
      id: 5,
      method: "tools/call",
      params: {
        name: "mediaclaw_task_status",
        arguments: {taskId: "capture-recovered"},
      },
    })}\n`,
  );
  const recoveredStatus = await reader.waitFor((message) => message.id === 5);
  assert.equal(
    recoveredStatus.result.structuredContent.task.status,
    "completed",
  );
  assert.equal(
    recoveredStatus.result.structuredContent.result.records[0].title,
    "断线后恢复的结果",
  );

  child.stdin.write(
    `${JSON.stringify({
      jsonrpc: "2.0",
      id: 4003,
      method: "tools/call",
      params: {
        name: "mediaclaw_manage_agent_update",
        arguments: {
          decision: "approve",
          approvalId:
            connectionStatus.result.structuredContent.agentUpdate.approvalId,
          originalGoal: "继续完成真实采集任务",
        },
      },
    })}\n`,
  );
  const approvedUpdate = await reader.waitFor((message) => message.id === 4003);
  assert.equal(approvedUpdate.result.structuredContent.ok, true);
  assert.equal(
    approvedUpdate.result.structuredContent.agentUpdate.installedVersion,
    "0.3.2",
  );
  assert.equal(
    approvedUpdate.result.structuredContent.agentUpdate.oldSessionFenced,
    true,
  );
  assert.equal(
    approvedUpdate.result.structuredContent.agentUpdate.restartHostRequired,
    true,
  );
  assert.equal(
    approvedUpdate.result.structuredContent.continuation.createNewTask,
    false,
  );
  assert.equal(
    approvedUpdate.result.structuredContent.continuation.originalGoal,
    "继续完成真实采集任务",
  );

  child.stdin.write(
    `${JSON.stringify({
      jsonrpc: "2.0",
      id: 4004,
      method: "tools/call",
      params: {
        name: "mediaclaw_list_paired_devices",
        arguments: {},
      },
    })}\n`,
  );
  const fencedCall = await reader.waitFor((message) => message.id === 4004);
  assert.equal(fencedCall.result.isError, true);
  assert.equal(
    fencedCall.result.structuredContent.error.code,
    "OLD_SESSION_FENCED",
  );

  child.stdin.write(
    `${JSON.stringify({
      jsonrpc: "2.0",
      id: 4005,
      method: "tools/call",
      params: {
        name: "mediaclaw_connection_status",
        arguments: {},
      },
    })}\n`,
  );
  const fencedStatus = await reader.waitFor((message) => message.id === 4005);
  assert.equal(
    fencedStatus.result.structuredContent.agentUpdate.status,
    "installed_restart_required",
  );
});

test("shared Broker isolates Codex and WorkBuddy device identities and task results", async (t) => {
  const port = 19000 + Math.floor(Math.random() * 1000);
  const serverPath = path.resolve("plugins/mediaclaw/scripts/mcp-server.mjs");
  const agentStateDir = await mkdtemp(
    path.join(tmpdir(), "mediaclaw-agent-multihost-"),
  );
  t.after(() => rm(agentStateDir, {recursive: true, force: true}));
  const baseEnv = {
    ...process.env,
    MEDIACLAW_AGENT_PORT: String(port),
    MEDIACLAW_AGENT_STATE_DIR: agentStateDir,
    MEDIACLAW_AGENT_ADAPTER_TTL_MS: "500",
    MEDIACLAW_AGENT_ADAPTER_SWEEP_MS: "100",
    MEDIACLAW_AGENT_BROKER_IDLE_MS: "500",
  };
  const codex = spawn(process.execPath, [serverPath], {
    env: {
      ...baseEnv,
      MEDIACLAW_AGENT_HOST: "codex",
      MEDIACLAW_AGENT_DEVICE_NAME: "MediaClaw Agent (Codex)",
    },
    stdio: ["pipe", "pipe", "pipe"],
  });
  const workbuddy = spawn(process.execPath, [serverPath], {
    env: {
      ...baseEnv,
      MEDIACLAW_AGENT_HOST: "workbuddy",
      MEDIACLAW_AGENT_DEVICE_NAME: "MediaClaw Agent (WorkBuddy)",
    },
    stdio: ["pipe", "pipe", "pipe"],
  });
  t.after(() => codex.kill("SIGTERM"));
  t.after(() => workbuddy.kill("SIGTERM"));
  const codexReader = createLineReader(codex.stdout);
  const workbuddyReader = createLineReader(workbuddy.stdout);
  await Promise.all([
    waitForText(codex.stderr, /Adapter connected/),
    waitForText(workbuddy.stderr, /Adapter connected/),
  ]);

  const socket = new WebSocket(`ws://127.0.0.1:${port}/extension`);
  t.after(() => socket.close());
  const devicesByHost = new Map();
  const authenticatedDeviceIds = new Set();
  const announcedDeviceIds = new Set();

  function challengeDevice(device) {
    if (!device?.deviceId || announcedDeviceIds.has(device.deviceId)) return;
    announcedDeviceIds.add(device.deviceId);
    devicesByHost.set(device.host, device);
    socket.send(
      JSON.stringify({
        type: "session.challenge",
        challenge: {
          purpose: "pairing",
          deviceId: device.deviceId,
          challengeId: `challenge-${device.host}`,
          nonce: `nonce-${device.host}`,
          extensionId: "test-extension",
          protocolVersion: "3",
          expiresAt: Date.now() + 60_000,
        },
      }),
    );
  }

  socket.addEventListener("message", (event) => {
    const message = JSON.parse(String(event.data));
    if (message.type === "broker.hello") {
      for (const device of message.devices || []) challengeDevice(device);
      return;
    }
    if (message.type === "device.hello") {
      challengeDevice(message.device);
      return;
    }
    if (message.type === "session.proof") {
      authenticatedDeviceIds.add(message.deviceId);
      socket.send(
        JSON.stringify({
          type: "extension.hello",
          protocolVersion: "3",
          deviceId: message.deviceId,
          sessionId: `session-${message.deviceId}`,
          extensionId: "test-extension",
          extensionVersion: "0.3.0",
        }),
      );
      return;
    }
    if (message.type !== "task.start") return;
    const host = [...devicesByHost.entries()].find(
      ([, device]) => device.deviceId === message.deviceId,
    )?.[0];
    socket.send(
      JSON.stringify({
        type: "task.result",
        taskId: message.taskId,
        deviceId: message.deviceId,
        response: {
          ok: true,
          data: {
            records: [
              {
                basic: {
                  noteId: `${host}-note`,
                  title: `${host} isolated result`,
                  url: `https://www.xiaohongshu.com/explore/${host}-note`,
                },
              },
            ],
          },
        },
      }),
    );
  });

  const handshakeDeadline = Date.now() + 5_000;
  while (
    (authenticatedDeviceIds.size < 2 || devicesByHost.size < 2) &&
    Date.now() < handshakeDeadline
  ) {
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.equal(devicesByHost.size, 2);
  assert.equal(authenticatedDeviceIds.size, 2);
  assert.notEqual(
    devicesByHost.get("codex").deviceId,
    devicesByHost.get("workbuddy").deviceId,
  );

  for (const [child, id] of [
    [codex, 1],
    [workbuddy, 2],
  ]) {
    child.stdin.write(
      `${JSON.stringify({
        jsonrpc: "2.0",
        id,
        method: "initialize",
        params: {protocolVersion: "2025-11-25"},
      })}\n`,
    );
  }
  await Promise.all([
    codexReader.waitFor((message) => message.id === 1),
    workbuddyReader.waitFor((message) => message.id === 2),
  ]);

  codex.stdin.write(
    `${JSON.stringify({
      jsonrpc: "2.0",
      id: 11,
      method: "tools/call",
      params: {
        name: "mediaclaw_capture_search_basic",
        arguments: {keyword: "codex", limit: 1},
      },
    })}\n`,
  );
  workbuddy.stdin.write(
    `${JSON.stringify({
      jsonrpc: "2.0",
      id: 12,
      method: "tools/call",
      params: {
        name: "mediaclaw_capture_search_basic",
        arguments: {keyword: "workbuddy", limit: 1},
      },
    })}\n`,
  );
  const [codexResult, workbuddyResult] = await Promise.all([
    codexReader.waitFor((message) => message.id === 11),
    workbuddyReader.waitFor((message) => message.id === 12),
  ]);
  assert.equal(
    codexResult.result.structuredContent.result.records[0].title,
    "codex isolated result",
  );
  assert.equal(
    workbuddyResult.result.structuredContent.result.records[0].title,
    "workbuddy isolated result",
  );

  const workbuddyTaskId = workbuddyResult.result.structuredContent.task.taskId;
  codex.stdin.write(
    `${JSON.stringify({
      jsonrpc: "2.0",
      id: 13,
      method: "tools/call",
      params: {
        name: "mediaclaw_task_status",
        arguments: {taskId: workbuddyTaskId},
      },
    })}\n`,
  );
  const crossHostRead = await codexReader.waitFor((message) => message.id === 13);
  assert.equal(
    crossHostRead.result.structuredContent.error.code,
    "TASK_NOT_FOUND",
  );
});

test("local asset tasks expire instead of blocking the queue across restarts", async (t) => {
  const port = 20000 + Math.floor(Math.random() * 1000);
  const serverPath = path.resolve("plugins/mediaclaw/scripts/mcp-server.mjs");
  const agentStateDir = await mkdtemp(
    path.join(tmpdir(), "mediaclaw-agent-expiry-test-"),
  );
  const taskStatePath = path.join(agentStateDir, "tasks-v1.json");
  const staleAt = new Date(Date.now() - 60_000).toISOString();
  await writeFile(
    taskStatePath,
    JSON.stringify({
      version: 1,
      tasks: [
        {
          taskId: "capture_legacy_local_asset_read",
          kind: "capture",
          status: "running",
          message: "legacy read",
          input: {},
          idempotencyKey: "",
          captureTask: {
            mode: "data_pool_assets",
            options: {
              operation: "get",
              assetId: "local.data_pool|capture_record|legacy",
            },
          },
          owner: {
            hostKey: "codex",
            deviceId: "legacy-device",
            displayName: "MediaClaw Agent (Codex)",
          },
          progress: null,
          result: null,
          error: null,
          childTaskIds: [],
          currentChildTaskId: "",
          createdAt: staleAt,
          updatedAt: staleAt,
          ttlMs: 24 * 60 * 60 * 1000,
        },
      ],
    }),
    "utf8",
  );
  t.after(() => rm(agentStateDir, {recursive: true, force: true}));

  const child = spawn(process.execPath, [serverPath], {
    env: {
      ...process.env,
      MEDIACLAW_AGENT_PORT: String(port),
      MEDIACLAW_AGENT_STATE_DIR: agentStateDir,
      MEDIACLAW_AGENT_BROKER_IDLE_MS: "5000",
      MEDIACLAW_LOCAL_ASSET_QUEUE_TIMEOUT_MS: "200",
      MEDIACLAW_LOCAL_ASSET_EXECUTION_TIMEOUT_MS: "200",
      MEDIACLAW_TASK_WATCHDOG_INTERVAL_MS: "50",
      MEDIACLAW_AGENT_UPDATE_MANIFEST_URL:
        "data:application/json,%5B%7B%22tag_name%22%3A%22v0.3.1%22%2C%22draft%22%3Afalse%7D%5D",
    },
    stdio: ["pipe", "pipe", "pipe"],
  });
  t.after(() => child.kill("SIGTERM"));
  const reader = createLineReader(child.stdout);
  await waitForText(child.stderr, /Adapter connected/);

  const migratedState = await waitForJsonFile(
    taskStatePath,
    (value) => value.tasks?.[0]?.status === "failed",
  );
  assert.equal(
    migratedState.tasks[0].error.code,
    "LEGACY_LOCAL_ASSET_READ_REPLACED",
  );

  child.stdin.write(
    `${JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {protocolVersion: "2025-11-25"},
    })}\n`,
  );
  await reader.waitFor((message) => message.id === 1);
  child.stdin.write(
    `${JSON.stringify({
      jsonrpc: "2.0",
      id: 2,
      method: "tools/call",
      params: {
        name: "mediaclaw_list_assets",
        arguments: {
          source: "local.data_pool",
          type: "capture_record",
          limit: 5,
          async: true,
        },
      },
    })}\n`,
  );
  const queuedRead = await reader.waitFor((message) => message.id === 2);
  const queuedTaskId = queuedRead.result.structuredContent.task.taskId;
  assert.equal(queuedRead.result.structuredContent.task.status, "working");
  assert.match(
    queuedRead.result.structuredContent.task.statusMessage,
    /本地数据库.*不会访问作品页/,
  );

  await new Promise((resolve) => setTimeout(resolve, 350));
  child.stdin.write(
    `${JSON.stringify({
      jsonrpc: "2.0",
      id: 3,
      method: "tools/call",
      params: {
        name: "mediaclaw_task_status",
        arguments: {taskId: queuedTaskId},
      },
    })}\n`,
  );
  const expiredRead = await reader.waitFor((message) => message.id === 3);
  assert.equal(expiredRead.result.structuredContent.task.status, "failed");
  assert.equal(
    expiredRead.result.structuredContent.error.code,
    "LOCAL_ASSET_READ_QUEUE_EXPIRED",
  );
  assert.match(
    expiredRead.result.structuredContent.task.statusMessage,
    /自动终止/,
  );
});
