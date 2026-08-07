import type { ArtifactId, ThreadId } from "@glass/contracts/ids";
import type { NativeStackScreenProps } from "@react-navigation/native-stack";
import { useState } from "react";
import { Text, View } from "react-native";

import { errorMessage } from "../lib/errors.ts";
import { decodeRouteId } from "../navigation/decode-route-id.ts";
import type { RootStack } from "../navigation/routes.ts";
import { useMobileCloud, useProductCloudState } from "../product-cloud/ProductCloudProvider.tsx";
import { ActionButton, AppInput, DetailLayout } from "../ui/primitives.tsx";

export const ThreadScreen = ({ route }: NativeStackScreenProps<RootStack, "Thread">) => {
  const cloud = useMobileCloud();
  const snapshot = cloud.view.snapshot;
  const threadId = decodeRouteId<ThreadId>(route.params.threadId, "$threadId");
  const thread = snapshot?.threads.find((item) => item.id === threadId);
  const messages = snapshot?.messages.filter((item) => item.threadId === threadId) ?? [];
  const [body, setBody] = useState("");
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
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
      {thread === undefined ? null : (
        <>
          <AppInput
            editable={!sending}
            maxLength={1_000_000}
            multiline
            onChangeText={setBody}
            placeholder="Write a message"
            value={body}
          />
          <ActionButton
            disabled={sending}
            label={sending ? "Sending…" : "Send"}
            onPress={() => {
              const message = body.trim();
              if (message.length === 0) {
                setError("Enter a message.");
                return;
              }
              setSending(true);
              setError(null);
              void cloud
                .createMessage(thread.projectId, thread.id, message)
                .then(() => setBody(""))
                .catch((cause: unknown) => setError(errorMessage(cause)))
                .finally(() => setSending(false));
            }}
          />
          {error === null ? null : <Text className="text-sm text-destructive">{error}</Text>}
        </>
      )}
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
