import { afterEach, describe, expect, it } from "vitest";
import { consumeManualUnreadMark, markAgentUnread } from "@/workspace/mark-unread";

const SERVER_ID = "mark-unread-test";
const AGENT_ID = "agent-1";
const AGENT = { serverId: SERVER_ID, agentId: AGENT_ID };

function deferred(): {
  promise: Promise<void>;
  resolve: () => void;
  reject: (error: unknown) => void;
} {
  let resolve: () => void = () => {};
  let reject: (error: unknown) => void = () => {};
  const promise = new Promise<void>((promiseResolve, promiseReject) => {
    resolve = promiseResolve;
    reject = promiseReject;
  });
  return { promise, resolve, reject };
}

function createClient(response: Promise<void>) {
  const markedAgentIds: string[] = [];
  return {
    markedAgentIds,
    client: {
      markAgentUnread: (agentId: string) => {
        markedAgentIds.push(agentId);
        return response;
      },
    },
  };
}

afterEach(() => {
  consumeManualUnreadMark(AGENT);
});

describe("markAgentUnread", () => {
  it("records the manual mark before the daemon accepts it", async () => {
    const response = deferred();
    const { client, markedAgentIds } = createClient(response.promise);

    const mark = markAgentUnread({ ...AGENT, getClient: () => client });

    expect(markedAgentIds).toEqual([AGENT_ID]);
    expect(consumeManualUnreadMark(AGENT)).toBe(true);

    response.resolve();
    await mark;
  });

  it("lets the mark be consumed once", async () => {
    const { client } = createClient(Promise.resolve());

    await markAgentUnread({ ...AGENT, getClient: () => client });

    expect(consumeManualUnreadMark(AGENT)).toBe(true);
    expect(consumeManualUnreadMark(AGENT)).toBe(false);
  });

  it("keeps marks separate per host and agent", async () => {
    const { client } = createClient(Promise.resolve());

    await markAgentUnread({ ...AGENT, getClient: () => client });

    expect(consumeManualUnreadMark({ serverId: "other-host", agentId: AGENT_ID })).toBe(false);
    expect(consumeManualUnreadMark({ serverId: SERVER_ID, agentId: "agent-2" })).toBe(false);
    expect(consumeManualUnreadMark(AGENT)).toBe(true);
  });

  it("removes the mark and rethrows when the daemon rejects it", async () => {
    const rejection = new Error("Agent is not read");
    const { client } = createClient(Promise.reject(rejection));

    await expect(markAgentUnread({ ...AGENT, getClient: () => client })).rejects.toBe(rejection);

    expect(consumeManualUnreadMark(AGENT)).toBe(false);
  });

  it("keeps an accepted mark when a repeat is rejected", async () => {
    const accepted = createClient(Promise.resolve());
    await markAgentUnread({ ...AGENT, getClient: () => accepted.client });

    const rejection = new Error("Agent is no longer finished and read");
    const repeat = createClient(Promise.reject(rejection));
    await expect(markAgentUnread({ ...AGENT, getClient: () => repeat.client })).rejects.toBe(
      rejection,
    );

    expect(consumeManualUnreadMark(AGENT)).toBe(true);
  });

  it("throws without recording a mark when the host is disconnected", async () => {
    await expect(markAgentUnread({ ...AGENT, getClient: () => null })).rejects.toThrow(
      "Host is not connected",
    );

    expect(consumeManualUnreadMark(AGENT)).toBe(false);
  });
});
