import type { ProjectId } from "@glass/contracts/ids";
import type { NativeStackScreenProps } from "@react-navigation/native-stack";
import { Text } from "react-native";

import { decodeRouteId } from "../navigation/decode-route-id.ts";
import type { RootStack } from "../navigation/routes.ts";
import { useMobileCloud } from "../product-cloud/ProductCloudProvider.tsx";
import { DetailLayout } from "../ui/primitives.tsx";

export const ProjectScreen = ({ route }: NativeStackScreenProps<RootStack, "Project">) => {
  const cloud = useMobileCloud();
  const snapshot = cloud.view.snapshot;
  const projectId = decodeRouteId<ProjectId>(route.params.projectId, "$projectId");
  const project = snapshot?.projects.find((item) => item.id === projectId);
  if (snapshot === null || project === undefined)
    return (
      <DetailLayout title="Project unavailable">
        <Text className="text-[15px] leading-6 text-foreground">
          This project is not in the validated projection.
        </Text>
      </DetailLayout>
    );
  return (
    <DetailLayout title={project.name}>
      <Text className="text-[15px] leading-6 text-muted-foreground">
        {project.description ?? "No description"}
      </Text>
    </DetailLayout>
  );
};
