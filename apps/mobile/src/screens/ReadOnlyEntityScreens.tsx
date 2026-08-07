import type { ArtifactId, ThreadId } from "@glass/contracts/ids";
import type { NativeStackScreenProps } from "@react-navigation/native-stack";
import { Text, View } from "react-native";

import { decodeRouteId } from "../navigation/decode-route-id.ts";
import type { RootStack } from "../navigation/routes.ts";
import { useProductCloudState } from "../product-cloud/ProductCloudProvider.tsx";
import { DetailLayout } from "../ui/primitives.tsx";
import { styles } from "../ui/styles.ts";

export const ThreadScreen = ({ route }: NativeStackScreenProps<RootStack, "Thread">) => {
  const snapshot = useProductCloudState().view.snapshot;
  const threadId = decodeRouteId<ThreadId>(route.params.threadId, "$threadId");
  const thread = snapshot?.threads.find((item) => item.id === threadId);
  const messages = snapshot?.messages.filter((item) => item.threadId === threadId) ?? [];
  return (
    <DetailLayout title={thread?.title ?? "Thread"}>
      <Text style={styles.muted}>{messages.length} message(s)</Text>
      {messages.map((message) => (
        <View key={message.id} style={styles.listCard}>
          <Text style={styles.body}>{message.body}</Text>
          <Text style={styles.muted}>Author {message.authorUserId.slice(0, 8)}</Text>
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
      <Text style={styles.muted}>{artifact?.kind ?? "Unknown kind"}</Text>
      <Text style={styles.body}>
        {artifact === undefined || artifact.kind !== "agent-output"
          ? "This artifact is not in the validated projection."
          : JSON.stringify(artifact.body, null, 2)}
      </Text>
    </DetailLayout>
  );
};
