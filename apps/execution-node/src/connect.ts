import type { ConnectNodeDispatch, ConnectNodeReply } from "@glass/contracts/connect";

export type NodeConnectStatus =
  | Readonly<{ status: "idle" }>
  | Readonly<{ connectedAt: string; status: "online" }>
  | Readonly<{ attempt: number; retryAt: string; status: "reconnecting" }>
  | Readonly<{ status: "stopped" }>;

export type ConnectNodeHandler = (
  dispatch: ConnectNodeDispatch,
  reply: (reply: ConnectNodeReply) => void,
) => void | Promise<void>;
