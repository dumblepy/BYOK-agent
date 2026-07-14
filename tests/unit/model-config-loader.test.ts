import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { ModelConfigLoader } from "../../src/models/model-config-loader";

const model = (id: string, name = id) => ({
  id,
  name,
  url: "https://api.example.com/v1/responses",
  toolCalling: true,
  vision: false,
  maxInputTokens: 10000,
  maxOutputTokens: 1000,
});

const tempDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    tempDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("ModelConfigLoader", () => {
  it("優先順位とProvider/Model単位の部分マージを適用する", async () => {
    const directory = await mkdtemp(join(tmpdir(), "byok-loader-"));
    tempDirectories.push(directory);
    const userPath = join(directory, "user.json");
    const workspacePath = join(directory, "workspace.json");
    await writeFile(
      userPath,
      JSON.stringify([
        {
          name: "Provider",
          vendor: "user",
          apiType: "responses",
          models: [model("one", "User model")],
        },
      ]),
    );
    await writeFile(
      workspacePath,
      JSON.stringify([{ name: "Provider", models: [{ id: "one", name: "Workspace label" }] }]),
    );

    const loader = new ModelConfigLoader({
      defaultPath: join(directory, "missing-default.json"),
      userCommonPath: userPath,
      workspacePath,
      workspaceTrusted: true,
      userSettings: () => [{ name: "Provider", models: [{ id: "one", name: "Settings label" }] }],
    });
    const snapshot = await loader.load();
    expect(snapshot?.config[0]).toMatchObject({ name: "Provider", vendor: "user" });
    expect(snapshot?.config[0]?.models[0]).toMatchObject({ id: "one", name: "Settings label" });
    loader.dispose();
  });

  it("無効なソースでは直前の有効スナップショットを維持する", async () => {
    const directory = await mkdtemp(join(tmpdir(), "byok-loader-"));
    tempDirectories.push(directory);
    const userPath = join(directory, "user.json");
    await writeFile(
      userPath,
      JSON.stringify([
        { name: "Provider", vendor: "user", apiType: "responses", models: [model("one")] },
      ]),
    );
    const diagnostics: unknown[] = [];
    const loader = new ModelConfigLoader({
      defaultPath: join(directory, "missing-default.json"),
      userCommonPath: userPath,
      onDiagnostic: (diagnostic) => diagnostics.push(diagnostic),
    });
    const first = await loader.load();
    await writeFile(userPath, "{");
    const second = await loader.refresh();
    expect(second).toBe(first);
    expect(diagnostics.length).toBeGreaterThan(0);
    loader.dispose();
  });

  it("信頼されていないWorkspaceの設定を採用しない", async () => {
    const directory = await mkdtemp(join(tmpdir(), "byok-loader-"));
    tempDirectories.push(directory);
    const workspacePath = join(directory, "workspace.json");
    const defaultPath = join(directory, "default.json");
    await writeFile(
      workspacePath,
      JSON.stringify([
        { name: "Workspace", vendor: "x", apiType: "responses", models: [model("workspace")] },
      ]),
    );
    await writeFile(
      defaultPath,
      JSON.stringify([
        { name: "Default", vendor: "x", apiType: "responses", models: [model("default")] },
      ]),
    );
    const loader = new ModelConfigLoader({
      defaultPath,
      workspacePath,
      workspaceTrusted: false,
    });
    const snapshot = await loader.load();
    expect(snapshot?.config[0]?.name).toBe("Default");
    loader.dispose();
  });
});
