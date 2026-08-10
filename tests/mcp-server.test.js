import assert from "node:assert/strict";
import {spawn} from "node:child_process";
import {mkdtemp, readFile, rm, stat} from "node:fs/promises";
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
    waitFor(predicate, timeoutMs = 5000) {
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
  t.after(() => rm(agentStateDir, {recursive: true, force: true}));
  const child = spawn(process.execPath, [serverPath], {
    env: {
      ...process.env,
      MEDIACLAW_AGENT_PORT: String(port),
      MEDIACLAW_AGENT_STATE_DIR: agentStateDir,
    },
    stdio: ["pipe", "pipe", "pipe"],
  });
  t.after(() => {
    child.kill("SIGTERM");
  });
  const reader = createLineReader(child.stdout);
  await waitForText(child.stderr, /listening on/);
  if (process.platform !== "win32") {
    assert.equal((await stat(agentStateDir)).mode & 0o777, 0o700);
    assert.equal(
      (await stat(path.join(agentStateDir, "device-identity.json"))).mode & 0o777,
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
  assert.equal(initialized.result.serverInfo.name, "mediaclaw-codex-bridge");
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

  const socket = new WebSocket(`ws://127.0.0.1:${port}/extension`);
  t.after(() => socket.close());
  let resolveRecoveredAck;
  let resolveHandshake;
  const recoveredAck = new Promise((resolve) => {
    resolveRecoveredAck = resolve;
  });
  const handshakeCompleted = new Promise((resolve) => {
    resolveHandshake = resolve;
  });
  socket.addEventListener("message", (event) => {
    const message = JSON.parse(String(event.data));
    if (
      message.type === "task.result.ack" &&
      message.taskId === "capture-recovered"
    ) {
      resolveRecoveredAck(message);
      return;
    }
    if (message.type === "server.hello") {
      socket.send(
        JSON.stringify({
          type: "session.challenge",
          challenge: {
            purpose: "pairing",
            deviceId: message.device.deviceId,
            challengeId: "test-challenge",
            nonce: "test-nonce",
            extensionId: "test-extension",
            protocolVersion: "2",
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
          protocolVersion: "2",
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
    if (message.task.mode === "profile_posts") {
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
      socket.send(
        JSON.stringify({
          type: "task.result",
          taskId: message.taskId,
          response: {
            ok: true,
            data: {
              rawCaptureResult: {
                ok: true,
                type: isGet ? "data_pool_record" : "data_pool_query",
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
                  successCount: 1,
                  failedCount: 0,
                  recordIds: message.task.options.recordIds,
                  records: [
                    {
                      id: message.task.options.recordIds[0],
                      recordType: "single_note",
                      status: "ready",
                      normalizedPayload: {
                        title: "增强采集后的完整笔记",
                        content: "完整正文",
                        imageUrls: ["https://example.com/enhanced.jpg"],
                        likes: 321,
                      },
                      rawPayload: {source: "plugin-detail-owner"},
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
    if (
      message.task.mode === "extract_image_text" ||
      message.task.mode === "extract_video_transcript"
    ) {
      assert.deepEqual(message.task.resultSinks, ["local_agent"]);
      const isVideo = message.task.mode === "extract_video_transcript";
      const isQuote = isVideo && message.task.options.meteredAction === "quote";
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
                      recordIds: message.task.options.recordIds,
                      totalDurationMs: 60_000,
                      estimatedCredits: 2,
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
      if (id.startsWith("deep-")) {
        assert.equal(message.task.featureKey, "capture.detail_batch");
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
                      noteType: "image",
                      imageUrls: [
                        "https://example.com/1.jpg",
                        "https://example.com/2.jpg",
                      ],
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
                  normalizedPayload: {items: comments},
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
  assert.ok(toolNames.includes("mediaclaw_research_benchmark_accounts"));
  assert.ok(toolNames.includes("mediaclaw_research_single_note"));
  assert.ok(toolNames.includes("mediaclaw_capture_comments_full"));
  assert.ok(toolNames.includes("mediaclaw_query_data_pool"));
  assert.ok(toolNames.includes("mediaclaw_get_data_pool_record"));
  assert.ok(toolNames.includes("mediaclaw_extract_image_text"));
  assert.ok(toolNames.includes("mediaclaw_quote_video_transcript"));
  assert.ok(toolNames.includes("mediaclaw_confirm_video_transcript"));
  assert.ok(toolNames.includes("mediaclaw_list_assets"));
  assert.ok(toolNames.includes("mediaclaw_get_asset"));
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
        },
      },
    })}\n`,
  );
  const singleNoteResponse = await reader.waitFor(
    (message) => message.id === 21,
  );
  const singleNote = singleNoteResponse.result.structuredContent.result;
  assert.equal(singleNote.recommendedMethodId, "single-note-breakdown-v1");
  assert.equal(singleNote.recommendedMethodVersion, "2.0.0");
  assert.equal(singleNote.coverage.commentCount, 60);
  assert.equal(singleNote.mediaText.text, "图片中的文案");
  assert.equal(singleNote.coverage.recordId, "rec-note-single-research");

  const satellite = spawn(process.execPath, [serverPath], {
    env: {...process.env, MEDIACLAW_AGENT_PORT: String(port)},
    stdio: ["pipe", "pipe", "pipe"],
  });
  t.after(() => {
    satellite.kill("SIGTERM");
  });
  const satelliteReader = createLineReader(satellite.stdout);
  await waitForText(satellite.stderr, /proxying through existing bridge/);
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
});
