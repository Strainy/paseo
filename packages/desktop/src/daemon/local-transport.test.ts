import { describe, expect, it } from "vitest";
import { buildSshArgs, parseTransportTarget } from "./local-transport";

describe("Remote SSH desktop transport", () => {
  it("builds a batch-mode SSH stdio tunnel with optional connection settings", () => {
    expect(
      buildSshArgs({
        transportType: "ssh",
        host: "deploy@example.com",
        sshPort: 2222,
        identityFile: "/Users/example/.ssh/paseo",
      }),
    ).toEqual([
      "-T",
      "-o",
      "BatchMode=yes",
      "-o",
      "ConnectTimeout=10",
      "-o",
      "ClearAllForwardings=yes",
      "-o",
      "ExitOnForwardFailure=yes",
      "-p",
      "2222",
      "-i",
      "/Users/example/.ssh/paseo",
      "-W",
      "127.0.0.1:6767",
      "deploy@example.com",
    ]);
  });

  it("rejects unsafe SSH targets at the IPC boundary", () => {
    expect(() =>
      parseTransportTarget({ transportType: "ssh", host: "-oProxyCommand=bad" }),
    ).toThrow("SSH host is invalid");
    expect(() =>
      parseTransportTarget({ transportType: "ssh", host: "build-box", sshPort: 0 }),
    ).toThrow("SSH port must be between 1 and 65535");
  });
});
