import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createServer, type Server, type Socket } from "node:net";
import { BrowserWindow } from "electron";
import { WebSocket, type RawData } from "ws";

interface LocalTransportTarget {
  transportType: "socket" | "pipe";
  transportPath: string;
}

export interface SshTransportTarget {
  transportType: "ssh";
  host: string;
  sshPort?: number;
  identityFile?: string;
}

type TransportTarget = LocalTransportTarget | SshTransportTarget;

interface TransportEventPayload {
  sessionId: string;
  kind: "open" | "message" | "close" | "error";
  text?: string | null;
  binaryBase64?: string | null;
  code?: number | null;
  reason?: string | null;
  error?: string | null;
}

interface Session {
  id: string;
  ws: WebSocket;
  state: "opening" | "open" | "closing" | "closed";
  closeTarget: () => void;
}

interface TransportEndpoint {
  url: string;
  close: () => void;
  failureDetail: () => string | null;
}

const WS_ENDPOINT_PATH = "/ws";
const REMOTE_DAEMON_ENDPOINT = "127.0.0.1:6767";
const SSH_STDERR_LIMIT = 8192;

let nextSessionId = 0;
const sessions = new Map<string, Session>();

function emitTransportEvent(payload: TransportEventPayload): void {
  for (const win of BrowserWindow.getAllWindows()) {
    win.webContents.send("paseo:event:local-daemon-transport-event", payload);
  }
}

/**
 * Build a WebSocket URL that connects through a Unix domain socket or Windows
 * named pipe.  The `ws` library supports these via the `ws+unix://` scheme:
 *
 *   ws+unix:///path/to/socket:/ws
 *   ws+unix://./pipe/paseo:/ws        (Windows named pipe)
 *
 * The part before `:` is the IPC path, the part after is the HTTP request
 * path used during the WebSocket upgrade handshake.
 */
function buildLocalWebSocketUrl(target: LocalTransportTarget): string {
  const ipcPath = target.transportPath;
  return `ws+unix://${ipcPath}:${WS_ENDPOINT_PATH}`;
}

function describeTransportTarget(target: TransportTarget): string {
  if (target.transportType === "ssh") {
    return `Remote SSH host ${target.host}`;
  }
  return target.transportType === "pipe" ? "local daemon pipe" : "local daemon socket";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function parseTransportTarget(value: unknown): TransportTarget {
  if (!isRecord(value)) {
    throw new Error("Desktop transport target must be an object.");
  }

  if (value.transportType === "socket" || value.transportType === "pipe") {
    const transportPath = typeof value.transportPath === "string" ? value.transportPath.trim() : "";
    if (!transportPath) {
      throw new Error("Local transport path is required.");
    }
    return { transportType: value.transportType, transportPath };
  }

  if (value.transportType !== "ssh") {
    throw new Error("Unsupported desktop transport type.");
  }

  const host = typeof value.host === "string" ? value.host.trim() : "";
  if (!host) {
    throw new Error("SSH host is required.");
  }
  if (/\s/.test(host) || host.startsWith("-")) {
    throw new Error("SSH host is invalid.");
  }

  const sshPort = value.sshPort;
  if (
    sshPort !== undefined &&
    (typeof sshPort !== "number" || !Number.isInteger(sshPort) || sshPort < 1 || sshPort > 65535)
  ) {
    throw new Error("SSH port must be between 1 and 65535.");
  }

  const identityFile =
    typeof value.identityFile === "string" ? value.identityFile.trim() || undefined : undefined;
  return {
    transportType: "ssh",
    host,
    ...(sshPort !== undefined ? { sshPort } : {}),
    ...(identityFile ? { identityFile } : {}),
  };
}

export function buildSshArgs(target: SshTransportTarget): string[] {
  const args = [
    "-T",
    "-o",
    "BatchMode=yes",
    "-o",
    "ConnectTimeout=10",
    "-o",
    "ClearAllForwardings=yes",
    "-o",
    "ExitOnForwardFailure=yes",
  ];
  if (target.sshPort !== undefined) {
    args.push("-p", String(target.sshPort));
  }
  if (target.identityFile) {
    args.push("-i", target.identityFile);
  }
  args.push("-W", REMOTE_DAEMON_ENDPOINT, target.host);
  return args;
}

function formatSshFailure(
  stderr: string,
  code: number | null,
  signal: NodeJS.Signals | null,
): string {
  const detail = stderr.trim();
  if (detail) return detail;
  if (signal) return `ssh exited with signal ${signal}`;
  return `ssh exited with code ${code ?? "unknown"}`;
}

function createSshProxy(target: SshTransportTarget): Promise<TransportEndpoint> {
  let server: Server | null = null;
  let socket: Socket | null = null;
  let child: ChildProcessWithoutNullStreams | null = null;
  let stderr = "";
  let failure: string | null = null;

  function close(): void {
    server?.close();
    server = null;
    socket?.destroy();
    socket = null;
    if (child && !child.killed) {
      child.kill();
    }
    child = null;
  }

  return new Promise((resolve, reject) => {
    server = createServer((acceptedSocket) => {
      socket = acceptedSocket;
      server?.close();
      server = null;

      child = spawn("ssh", buildSshArgs(target), {
        stdio: ["pipe", "pipe", "pipe"],
        windowsHide: true,
      });
      child.stderr.on("data", (chunk: Buffer | string) => {
        stderr = `${stderr}${chunk.toString()}`.slice(-SSH_STDERR_LIMIT);
      });
      child.on("error", (error) => {
        failure = error.message;
        acceptedSocket.destroy(error);
      });
      child.on("exit", (code, signal) => {
        if (code !== 0 || signal) {
          failure = formatSshFailure(stderr, code, signal);
        }
        acceptedSocket.destroy(failure ? new Error(failure) : undefined);
      });

      acceptedSocket.on("error", () => undefined);
      acceptedSocket.on("close", () => {
        if (child && !child.killed) {
          child.kill();
        }
      });
      acceptedSocket.pipe(child.stdin);
      child.stdout.pipe(acceptedSocket);
    });
    server.once("error", (error) => {
      close();
      reject(error);
    });
    server.listen(0, "127.0.0.1", () => {
      const address = server?.address();
      if (!address || typeof address === "string") {
        close();
        reject(new Error("Failed to allocate the Remote SSH proxy port."));
        return;
      }
      resolve({
        url: `ws://127.0.0.1:${address.port}${WS_ENDPOINT_PATH}`,
        close,
        failureDetail: () => failure,
      });
    });
  });
}

async function resolveTransportEndpoint(target: TransportTarget): Promise<TransportEndpoint> {
  if (target.transportType === "ssh") {
    return createSshProxy(target);
  }
  return {
    url: buildLocalWebSocketUrl(target),
    close: () => undefined,
    failureDetail: () => null,
  };
}

function decodeTransportMessage(input: { text?: string; binaryBase64?: string }): string | Buffer {
  if (typeof input.text === "string") {
    return input.text;
  }

  if (typeof input.binaryBase64 === "string") {
    return Buffer.from(input.binaryBase64, "base64");
  }

  throw new Error("Local transport send requires text or binary payload.");
}

export async function openLocalTransportSession(rawTarget: unknown): Promise<string> {
  const target = parseTransportTarget(rawTarget);
  const sessionId = `local-session-${++nextSessionId}`;
  const endpoint = await resolveTransportEndpoint(target);

  return new Promise((resolve, reject) => {
    const ws = new WebSocket(endpoint.url);
    const session: Session = {
      id: sessionId,
      ws,
      state: "opening",
      closeTarget: endpoint.close,
    };
    sessions.set(sessionId, session);

    let openSettled = false;

    const finalizeOpenFailure = (message: string): void => {
      if (openSettled) {
        return;
      }

      openSettled = true;
      session.state = "closed";
      sessions.delete(sessionId);
      endpoint.close();
      reject(new Error(message));
    };

    ws.once("open", () => {
      openSettled = true;
      session.state = "open";
      resolve(sessionId);
      emitTransportEvent({ sessionId, kind: "open" });
    });

    ws.on("message", (data: RawData, isBinary: boolean) => {
      if (isBinary || data instanceof Buffer) {
        const buf = Buffer.isBuffer(data) ? data : Buffer.from(data as ArrayBuffer);
        emitTransportEvent({
          sessionId,
          kind: "message",
          binaryBase64: buf.toString("base64"),
        });
        return;
      }

      emitTransportEvent({
        sessionId,
        kind: "message",
        text: data.toString(),
      });
    });

    ws.on("close", (code: number, reason?: Buffer | string) => {
      const shouldEmitClose = session.state === "open" || session.state === "closing";
      session.state = "closed";
      sessions.delete(sessionId);
      endpoint.close();

      if (!openSettled) {
        finalizeOpenFailure(
          `${describeTransportTarget(target)} closed before the session became ready.`,
        );
        return;
      }

      if (shouldEmitClose) {
        emitTransportEvent({
          sessionId,
          kind: "close",
          code,
          reason: reason ? String(reason) : "",
        });
      }
    });

    ws.on("error", (err: Error) => {
      const failureDetail = endpoint.failureDetail();
      const detail = failureDetail ? `${err.message}: ${failureDetail}` : err.message;
      if (!openSettled) {
        finalizeOpenFailure(`Failed to connect to ${describeTransportTarget(target)}: ${detail}`);
        return;
      }

      emitTransportEvent({
        sessionId,
        kind: "error",
        error: detail,
      });
    });
  });
}

export async function sendLocalTransportMessage(input: {
  sessionId: string;
  text?: string;
  binaryBase64?: string;
}): Promise<void> {
  const session = sessions.get(input.sessionId);
  if (!session) {
    throw new Error(`Local transport session not found: ${input.sessionId}`);
  }

  if (session.state !== "open" || session.ws.readyState !== WebSocket.OPEN) {
    throw new Error(
      session.state === "opening"
        ? "Local transport session is not open yet."
        : "Local transport session is closed.",
    );
  }

  const payload = decodeTransportMessage(input);
  await new Promise<void>((resolve, reject) => {
    session.ws.send(payload, (error) => {
      if (error) {
        reject(new Error(`Local transport write failed: ${error.message}`));
        return;
      }
      resolve();
    });
  });
}

export function closeLocalTransportSession(sessionId: string): void {
  const session = sessions.get(sessionId);
  if (!session) return;

  try {
    if (session.ws.readyState === WebSocket.CONNECTING) {
      session.state = "closed";
      session.ws.terminate();
    } else {
      session.state = "closing";
      session.ws.close();
    }
  } catch {
    // ignore close errors
  }
  session.closeTarget();
  sessions.delete(sessionId);
}

export function closeAllTransportSessions(): void {
  for (const [id] of sessions) {
    closeLocalTransportSession(id);
  }
}
