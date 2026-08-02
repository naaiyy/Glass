import { setupRenderer } from "@better-auth/electron/preload";
import type {
  DesktopHostDescriptor,
  DesktopProductRequest,
  DesktopProductResponse,
} from "@glass/contracts/architecture";
import { contextBridge } from "electron";
import { ipcRenderer } from "electron";

setupRenderer();

const bridge: DesktopHostDescriptor = Object.freeze({
  executionConnection: "optional",
  platform: process.platform,
  productCloudOrigin: process.env.GLASS_CLOUD_ORIGIN ?? "",
  requestProduct: (request: DesktopProductRequest) =>
    ipcRenderer.invoke("glass:product-request", request) as Promise<DesktopProductResponse>,
});

contextBridge.exposeInMainWorld("glassDesktop", bridge);
