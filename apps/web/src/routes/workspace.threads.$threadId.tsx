import { createFileRoute } from "@tanstack/react-router";

import { ThreadProductScreen } from "../product-cloud/ProductScreens.tsx";

export const Route = createFileRoute("/workspace/threads/$threadId")({
  component: ThreadProductScreen,
});
