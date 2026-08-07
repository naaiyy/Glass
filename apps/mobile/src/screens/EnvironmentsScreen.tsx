import type { NativeStackScreenProps } from "@react-navigation/native-stack";
import { useState } from "react";
import { Text, View } from "react-native";

import { approveEnvironmentPairing, revokeEnvironment } from "../cloud/environments.ts";
import { useEnvironmentDirectory } from "../execution/EnvironmentDirectoryProvider.tsx";
import { errorMessage } from "../lib/errors.ts";
import type { RootStack } from "../navigation/routes.ts";
import { useMobileCloud } from "../product-cloud/ProductCloudProvider.tsx";
import { ActionButton, AppInput, DetailLayout, StateCard } from "../ui/primitives.tsx";

const setupCommand = "npx glass-connect@latest";

export const EnvironmentsScreen = (_props: NativeStackScreenProps<RootStack, "Environments">) => {
  const { view } = useMobileCloud();
  const directory = useEnvironmentDirectory();
  const organizationId = view.scope?.organizationId ?? null;
  const apiBaseUrl = directory.apiBaseUrl;
  const [pairingCode, setPairingCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  if (organizationId === null)
    return (
      <DetailLayout title="Environments">
        <Text className="text-muted-foreground">Choose an organization first.</Text>
      </DetailLayout>
    );

  return (
    <DetailLayout title="Environments">
      <Text className="text-[15px] leading-6 text-muted-foreground">
        Publish computers with Glass Connect and use them from every signed-in Glass device.
      </Text>
      <StateCard title="Publish a computer">
        <Text className="text-sm leading-5 text-muted-foreground">
          {`1. From the project folder on that computer, run ${setupCommand}.`}
        </Text>
        <Text className="text-sm leading-5 text-muted-foreground">
          2. Enter the one-time code here. Glass Connect handles the rest and stays online.
        </Text>
        <Text className="mt-2 text-sm font-semibold text-foreground">
          Code shown by Glass Connect
        </Text>
        <AppInput
          accessibilityLabel="Code shown by Glass Connect"
          autoCapitalize="characters"
          autoCorrect={false}
          maxLength={11}
          onChangeText={setPairingCode}
          placeholder="ABCDE-FGHIJ"
          value={pairingCode}
        />
        <ActionButton
          disabled={busy || pairingCode.trim().length !== 11}
          label={busy ? "Publishing…" : "Publish computer"}
          onPress={() => {
            setBusy(true);
            setMessage(null);
            void approveEnvironmentPairing(
              apiBaseUrl,
              organizationId,
              pairingCode.trim().toUpperCase(),
            )
              .then(async () => {
                setPairingCode("");
                setMessage(
                  "Approved. Glass Connect is publishing the computer and bringing it online.",
                );
                await directory.refresh();
              })
              .catch((cause: unknown) => setMessage(errorMessage(cause)))
              .finally(() => setBusy(false));
          }}
        />
      </StateCard>

      <Text className="mb-1 mt-7 text-xl font-semibold text-foreground">Published computers</Text>
      {directory.environments.length === 0 ? (
        <StateCard title="No computers published">
          <Text className="text-sm text-muted-foreground">
            Run Glass Connect on a computer, then approve its code above.
          </Text>
        </StateCard>
      ) : (
        directory.environments.map((environment) => {
          const status =
            environment.revokedAt !== null
              ? "Revoked"
              : directory.presence[environment.id]?.status === "online"
                ? "Online"
                : "Offline";
          return (
            <StateCard key={environment.id} title={environment.displayName}>
              <View className="flex-row items-center justify-between">
                <Text className="text-sm text-muted-foreground">{environment.platform}</Text>
                <Text
                  className={
                    status === "Online"
                      ? "text-sm font-semibold text-emerald-600"
                      : "text-sm font-semibold text-muted-foreground"
                  }
                >
                  {status}
                </Text>
              </View>
              <Text className="text-sm text-muted-foreground">
                Available to all organization projects
              </Text>
              {environment.revokedAt === null ? (
                <ActionButton
                  disabled={busy}
                  label="Revoke environment"
                  onPress={() => {
                    setBusy(true);
                    void revokeEnvironment(apiBaseUrl, environment.id)
                      .then(directory.refresh)
                      .catch((cause: unknown) => setMessage(errorMessage(cause)))
                      .finally(() => setBusy(false));
                  }}
                />
              ) : null}
            </StateCard>
          );
        })
      )}
      <ActionButton
        disabled={busy}
        label="Refresh status"
        onPress={() =>
          void directory.refresh().catch((cause: unknown) => setMessage(errorMessage(cause)))
        }
      />
      {message === null ? null : (
        <Text accessibilityLiveRegion="polite" className="mt-3 text-sm text-muted-foreground">
          {message}
        </Text>
      )}
    </DetailLayout>
  );
};
