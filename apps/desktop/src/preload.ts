import type { DesktopHostDescriptor } from "@glass/contracts/architecture";
import { contextBridge } from "electron";

const bridge: DesktopHostDescriptor = Object.freeze({
  executionConnection: "optional",
  platform: process.platform,
});

contextBridge.exposeInMainWorld("glassDesktop", bridge);
