import { createFileRoute } from "@tanstack/react-router";

import { NoteProductScreen } from "../product-cloud/ProductScreens.tsx";

export const Route = createFileRoute("/workspace/notes/$noteId")({
  component: NoteProductScreen,
});
