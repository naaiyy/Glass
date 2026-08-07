import type { LinkingOptions } from "@react-navigation/native";
import * as Linking from "expo-linking";

export type RootStack = {
  Auth: undefined;
  Artifact: { artifactId: string };
  Bootstrap: undefined;
  Environments: undefined;
  Note: { noteId: string };
  Project: { projectId: string };
  Thread: { threadId: string };
  Workspace: undefined;
};

export const mobileLinking: LinkingOptions<RootStack> = {
  prefixes: [Linking.createURL("/"), "dev.glass.mobile://"],
  config: {
    screens: {
      Artifact: "artifacts/:artifactId",
      Auth: "auth",
      Bootstrap: "",
      Environments: "settings/environments",
      Note: "notes/:noteId",
      Project: "projects/:projectId",
      Thread: "threads/:threadId",
      Workspace: "workspace",
    },
  },
};
