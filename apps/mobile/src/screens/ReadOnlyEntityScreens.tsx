import type { ArtifactId, ThreadId } from "@glass/contracts/ids";
import type { NativeStackScreenProps } from "@react-navigation/native-stack";
import { Text, View } from "react-native";

import { decodeRouteId } from "../navigation/decode-route-id.ts";
import type { RootStack } from "../navigation/routes.ts";
import { useProductCloudState } from "../product-cloud/ProductCloudProvider.tsx";
import { DetailLayout } from "../ui/primitives.tsx";

export const ThreadScreen = ({ route }: NativeStackScreenProps<RootStack, "Thread">) => {
  const snapshot = useProductCloudState().view.snapshot;
  const threadId = decodeRouteId<ThreadId>(route.params.threadId, "$threadId");
  const thread = snapshot?.threads.find((item) => item.id === threadId);
  const messages = snapshot?.messages.filter((item) => item.threadId === threadId) ?? [];
  return (
    <DetailLayout title={thread?.title ?? "Thread"}>
      <Text className="text-sm text-muted-foreground">{messages.length} message(s)</Text>
      {messages.map((message) => (
        <View className="mt-2 rounded-xl border border-border bg-card p-4" key={message.id}>
          <Text className="text-[15px] leading-6 text-card-foreground">{message.body}</Text>
          <Text className="mt-1 text-sm text-muted-foreground">
            Author {message.authorUserId.slice(0, 8)}
          </Text>
        </View>
      ))}
    </DetailLayout>
  );
};

export const ArtifactScreen = ({ route }: NativeStackScreenProps<RootStack, "Artifact">) => {
  const snapshot = useProductCloudState().view.snapshot;
  const artifactId = decodeRouteId<ArtifactId>(route.params.artifactId, "$artifactId");
  const artifact = snapshot?.artifacts.find((item) => item.id === artifactId);
  return (
    <DetailLayout title={artifact?.name ?? "Artifact unavailable"}>
      <Text className="text-sm text-muted-foreground">{artifact?.kind ?? "Unknown kind"}</Text>
      <Text className="mt-3 font-mono text-sm leading-5 text-foreground">
        {artifact === undefined || artifact.kind !== "agent-output"
          ? "This artifact is not in the validated projection."
          : JSON.stringify(artifact.body, null, 2)}
      </Text>
    </DetailLayout>
  );
};
