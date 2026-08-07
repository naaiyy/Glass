import { useState } from "react";
import { Pressable, StyleSheet, Text, TextInput, View } from "react-native";
import { useCSSVariable } from "uniwind";
import {
  defaultMobileExecutionDraft,
  mobileExecutionOperations,
  type MobileExecutionDraft,
  type MobileExecutionKind,
} from "./cloud/execution-console.ts";

const Button = ({
  disabled = false,
  label,
  onPress,
}: {
  disabled?: boolean;
  label: string;
  onPress: () => void;
}) => {
  return (
    <Pressable
      accessibilityRole="button"
      className="border-border bg-secondary"
      disabled={disabled}
      onPress={onPress}
      style={[styles.button, disabled && styles.disabled]}
    >
      <Text className="text-secondary-foreground" style={styles.buttonText}>
        {label}
      </Text>
    </Pressable>
  );
};

const Input = ({
  label,
  multiline = false,
  onChangeText,
  value,
}: {
  label: string;
  multiline?: boolean;
  onChangeText: (value: string) => void;
  value: string;
}) => {
  const resolvedPlaceholder = useCSSVariable("--color-muted-foreground");
  const placeholderTextColor =
    typeof resolvedPlaceholder === "string" ? resolvedPlaceholder : undefined;

  return (
    <View style={styles.field}>
      <Text className="text-foreground" style={styles.label}>
        {label}
      </Text>
      <TextInput
        autoCapitalize="none"
        autoCorrect={false}
        className="border-input bg-background text-foreground"
        multiline={multiline}
        onChangeText={onChangeText}
        placeholderTextColor={placeholderTextColor}
        style={[styles.input, multiline && styles.multiline]}
        value={value}
      />
    </View>
  );
};

export const MobileExecutionConsole = ({
  active,
  disabled,
  onCancel,
  onRun,
}: {
  active: boolean;
  disabled: boolean;
  onCancel: () => void;
  onRun: (draft: MobileExecutionDraft) => void;
}) => {
  const [draft, setDraft] = useState<MobileExecutionDraft>(defaultMobileExecutionDraft);
  const set = <Key extends keyof MobileExecutionDraft>(
    key: Key,
    value: MobileExecutionDraft[Key],
  ) => setDraft((current) => ({ ...current, [key]: value }));
  const operation = draft.operation;
  const terminalOperation = operation.startsWith("terminal.");

  return (
    <View className="border-border" style={styles.console}>
      <Text className="text-foreground" style={styles.heading}>
        Native execution console
      </Text>
      <Text className="text-muted-foreground" style={styles.help}>
        Machine actions require this environment to be online. Cloud projects and artifacts remain
        available independently.
      </Text>
      <View style={styles.operationGrid}>
        {mobileExecutionOperations.map((candidate) => (
          <Button
            key={candidate}
            label={`${candidate}${candidate === operation ? " · selected" : ""}`}
            onPress={() => set("operation", candidate as MobileExecutionKind)}
          />
        ))}
      </View>

      {operation.startsWith("file.") ? (
        <Input
          label="Workspace-relative path"
          onChangeText={(value) => set("path", value)}
          value={draft.path}
        />
      ) : null}
      {operation === "file.write" ? (
        <>
          <Input
            label="UTF-8 file content"
            multiline
            onChangeText={(value) => set("content", value)}
            value={draft.content}
          />
          <Button
            label={`Create parent directories · ${draft.createParents ? "yes" : "no"}`}
            onPress={() => set("createParents", !draft.createParents)}
          />
        </>
      ) : null}

      {operation === "command.run" ? (
        <>
          <Input
            label="Command"
            onChangeText={(value) => set("command", value)}
            value={draft.command}
          />
          <Input
            label="Working directory"
            onChangeText={(value) => set("cwd", value)}
            value={draft.cwd}
          />
          <Input
            label="Arguments · one per line"
            multiline
            onChangeText={(value) => set("args", value)}
            value={draft.args}
          />
          <Input
            label="Timeout (milliseconds)"
            onChangeText={(value) => set("timeoutMs", value)}
            value={draft.timeoutMs}
          />
        </>
      ) : null}

      {terminalOperation ? (
        <Input
          label="Terminal ID"
          onChangeText={(value) => set("terminalId", value)}
          value={draft.terminalId}
        />
      ) : null}
      {operation === "terminal.open" ? (
        <>
          <Input
            label="Working directory"
            onChangeText={(value) => set("cwd", value)}
            value={draft.cwd}
          />
          <Input
            label="Shell (blank uses default)"
            onChangeText={(value) => set("shell", value)}
            value={draft.shell}
          />
        </>
      ) : null}
      {operation === "terminal.input" ? (
        <Input
          label="Terminal input"
          multiline
          onChangeText={(value) => set("data", value)}
          value={draft.data}
        />
      ) : null}
      {operation === "terminal.open" || operation === "terminal.resize" ? (
        <View style={styles.row}>
          <Input label="Columns" onChangeText={(value) => set("cols", value)} value={draft.cols} />
          <Input label="Rows" onChangeText={(value) => set("rows", value)} value={draft.rows} />
        </View>
      ) : null}

      {operation === "git.diff" ? (
        <Button
          label={`Diff staged changes · ${draft.gitStaged ? "yes" : "no"}`}
          onPress={() => set("gitStaged", !draft.gitStaged)}
        />
      ) : null}
      {operation === "git.run" ? (
        <>
          <Text className="text-foreground" style={styles.label}>
            Allowed Git subcommand
          </Text>
          <View style={styles.operationGrid}>
            {(["add", "branch", "checkout", "commit", "restore", "switch"] as const).map(
              (subcommand) => (
                <Button
                  key={subcommand}
                  label={`${subcommand}${draft.gitSubcommand === subcommand ? " · selected" : ""}`}
                  onPress={() => set("gitSubcommand", subcommand)}
                />
              ),
            )}
          </View>
          <Input
            label="Git arguments · one per line"
            multiline
            onChangeText={(value) => set("args", value)}
            value={draft.args}
          />
        </>
      ) : null}

      {operation === "checkpoint.create" ? (
        <Input
          label="Checkpoint label (optional)"
          onChangeText={(value) => set("checkpointLabel", value)}
          value={draft.checkpointLabel}
        />
      ) : null}
      {operation === "checkpoint.restore" ? (
        <Input
          label="Checkpoint ID"
          onChangeText={(value) => set("checkpointId", value)}
          value={draft.checkpointId}
        />
      ) : null}

      <Button
        disabled={disabled || active}
        label={active ? "Operation active…" : `Run ${operation}`}
        onPress={() => onRun(draft)}
      />
      {active ? <Button label="Cancel active operation" onPress={onCancel} /> : null}
    </View>
  );
};

const styles = StyleSheet.create({
  button: {
    borderRadius: 10,
    borderWidth: 1,
    paddingHorizontal: 10,
    paddingVertical: 9,
  },
  buttonText: { fontSize: 12, fontWeight: "600" },
  console: { borderRadius: 14, borderWidth: 1, gap: 10, padding: 12 },
  disabled: { opacity: 0.45 },
  field: { flex: 1, gap: 5 },
  heading: { fontSize: 16, fontWeight: "700" },
  help: { fontSize: 12, lineHeight: 18 },
  input: {
    borderRadius: 9,
    borderWidth: 1,
    minWidth: 96,
    paddingHorizontal: 10,
    paddingVertical: 9,
  },
  label: { fontSize: 12, fontWeight: "600" },
  multiline: { minHeight: 86, textAlignVertical: "top" },
  operationGrid: { flexDirection: "row", flexWrap: "wrap", gap: 7 },
  row: { flexDirection: "row", gap: 8 },
});
