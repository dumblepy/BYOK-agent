# BYOK専用 VS Code コーディングエージェント

## 実装方針・詳細設計書

## 1. 目的

ユーザー自身が用意したAPIキーのみを使用する、独立したVS Codeコーディングエージェントを開発する。

主要要件は次のとおりとする。

1. 複数プロバイダー・複数モデルをJSONで定義できる。
2. エディタ、ワークスペース、会話履歴、ツール結果を適切にコンテキスト化する。
3. モデルのネイティブTool Callingを使用してエージェントループを実行する。
4. ファイル編集、コード検索、診断取得、テスト実行、ターミナル実行をツールとして提供する。
5. システムプロンプトをモデルファミリーごとに差し替えられる。
6. Codex拡張機能に近い、サイドバー中心のUI、コンテキスト添付、変更差分レビューを提供する。
7. APIキー、ファイル変更、コマンド実行を安全に管理する。

Codex IDE拡張の公開仕様では、サイドバーから操作し、開いているファイルや選択範囲をコンテキストとして追加し、変更差分をエディタ横で確認する構成が採られている。本設計でも、この操作モデルを参考にする。外観や商標、アイコン、固有文言は複製せず、VS Code標準のテーマトークンとCodiconで独自UIを構築する。

---

## 2. Copilotソースコードの利用方針

### 2.1 直接フォークではなく縮小再実装とする

公開されている`microsoft/vscode-copilot-chat`はMITライセンスであり、著作権表示とライセンス表示を維持すれば、利用、変更、再配布が認められている。

ただし、Copilot Chat本体は以下を含む大規模なシステムである。

* 独自DIコンテナ
* 実験フラグ
* GitHub認証
* Copilot固有エンドポイント
* テレメトリー
* VS Code Proposed API
* シミュレーション基盤
* インライン補完
* Notebook、PR、クラウドエージェント連携

公開コード自身も、`conversation`、`context`、`prompts`、`endpoint`、`tools`、`byok`、`mcp`などの機能別構造を採用している。

そのため、クラスをそのまま抽出すると大量の内部依存を引き込む。基本方針は次のとおりとする。

> Copilotの責務分割、状態遷移、プロンプト構成、コンテキスト圧縮、ツール検証方式を参考にし、独立した小規模実装として書き直す。

### 2.2 採用する設計概念

| Copilot側の概念                           | 本拡張での実装                            |
| ------------------------------------- | ---------------------------------- |
| `endpoint` / `byok`                   | `ModelCatalog`、`ProviderAdapter`   |
| `ToolCallingLoop`                     | `AgentLoop`                        |
| `IToolsService`                       | `ToolRegistry`、`ToolExecutor`      |
| `prompt-tsx`                          | `PromptComposer`、プロンプトモジュール        |
| `context` / `ChatVariablesCollection` | `ContextManager`、`ContextItem`     |
| Global Agent Context                  | 会話開始時の静的コンテキスト                     |
| Summarized Conversation History       | 履歴コンパクション                          |
| Tool schema validation                | AJVによるJSON Schema検証                |
| Tool enable filtering                 | モデル能力・権限・Workspace Trustによるフィルタリング |

Copilotのツールサービスは、登録済みツールの列挙、モデル別ツール、ツール名解決、JSON Schema検証、リクエスト単位の有効化を分離している。本設計も同じ責務境界を採用する。

Copilotの公開リポジトリは2026年5月20日時点でアーカイブされているため、現在の製品実装そのものではなく、参照スナップショットとして扱う。

### 2.3 直接流用しないもの

以下は再利用対象外とする。

* GitHub Copilotの名称、ロゴ、アイコン、商標
* GitHub認証とCopilot API
* 非公開または製品固有のエンドポイント
* テレメトリ識別子
* 実験管理コード
* Copilot製品のシステムプロンプト全文
* Codex拡張のCSS、DOM構造、ブランドアセット
* VS Code本体の内部APIに依存する実装

Copilotコードを部分的にコピーした場合は、ファイル単位で出典コミット、原ファイル、変更内容を`NOTICE.md`に記録する。

---

## 3. 全体アーキテクチャ

```text
┌──────────────────────────────────────────────────────┐
│ VS Code                                               │
│                                                      │
│  ┌──────────────────┐       ┌─────────────────────┐  │
│  │ Webview Sidebar  │◀─────▶│ Extension Host      │  │
│  │                  │ IPC   │                     │  │
│  │ Thread / Diff    │       │ SessionController   │  │
│  │ Composer / Tools │       │ AgentRuntime        │  │
│  └──────────────────┘       └──────────┬──────────┘  │
│                                       │             │
│       ┌───────────────────────────────┼──────────┐  │
│       │                               │          │  │
│  ContextManager                PromptComposer  ToolRegistry
│       │                               │          │  │
│       └───────────────────────┬───────┴──────────┘  │
│                               │                     │
│                        ProviderRouter                │
└───────────────────────────────┼─────────────────────┘
                                │ HTTPS
             ┌──────────────────┼──────────────────┐
             │                  │                  │
       OpenAI互換API       Anthropic API       Gemini API
```

### 3.1 基本原則

Webviewは表示とユーザー操作だけを担当する。

以下はすべてExtension Host側で実行する。

* APIキー取得
* LLM API通信
* ファイル読み書き
* ターミナル実行
* Git操作
* プロンプト構築
* Tool Calling
* 会話保存
* 権限判定

VS CodeのWebviewは複雑なUIを構築でき、Extension Hostとはメッセージパッシングで通信する。秘密情報やファイルアクセス権をWebviewに渡さない構造にする。

---

## 4. ディレクトリ構成

```text
src/
  extension/
    activate.ts
    commands.ts
    contributions.ts

  ui/
    AgentViewProvider.ts
    protocol.ts
    webview/
      main.tsx
      components/
        ThreadView.tsx
        Composer.tsx
        ContextChips.tsx
        ToolActivity.tsx
        ChangeSetView.tsx
        ModelPicker.tsx
        PermissionPicker.tsx

  agent/
    AgentRuntime.ts
    AgentLoop.ts
    AgentState.ts
    AgentEvents.ts
    StopConditions.ts

  models/
    ModelCatalog.ts
    ModelConfigLoader.ts
    ModelCapabilities.ts
    ProviderRouter.ts
    schema.json

  providers/
    ProviderAdapter.ts
    openai/
      OpenAIResponsesAdapter.ts
      OpenAICompatibleAdapter.ts
    anthropic/
      AnthropicMessagesAdapter.ts
    gemini/
      GeminiAdapter.ts

  context/
    ContextManager.ts
    ContextBudgeter.ts
    ContextItem.ts
    ContextDeduplicator.ts
    ContextCompactor.ts
    providers/
      ActiveEditorContext.ts
      SelectionContext.ts
      DiagnosticsContext.ts
      WorkspaceContext.ts
      GitContext.ts
      SymbolContext.ts
      SearchContext.ts
      InstructionContext.ts

  prompts/
    PromptComposer.ts
    PromptRegistry.ts
    PromptModule.ts
    profiles/
      base.ts
      openai.ts
      anthropic.ts
      gemini.ts
    modules/
      identity.ts
      safety.ts
      environment.ts
      workflow.ts
      toolRules.ts
      editRules.ts
      completionRules.ts

  tools/
    ToolRegistry.ts
    ToolExecutor.ts
    ToolDefinition.ts
    ToolResult.ts
    ToolPolicy.ts
    builtin/
      ReadFileTool.ts
      ListFilesTool.ts
      SearchTextTool.ts
      GetSymbolsTool.ts
      GetDiagnosticsTool.ts
      GitStatusTool.ts
      GitDiffTool.ts
      ApplyPatchTool.ts
      CreateFileTool.ts
      DeleteFileTool.ts
      RunCommandTool.ts
      RunTestsTool.ts
      CompleteTaskTool.ts
    mcp/
      McpClientManager.ts
      McpToolAdapter.ts

  changes/
    ChangeSetManager.ts
    PatchParser.ts
    VirtualDocumentProvider.ts
    WorkspaceEditApplier.ts

  permissions/
    ApprovalService.ts
    PermissionProfile.ts
    WorkspaceTrustPolicy.ts

  storage/
    ThreadStore.ts
    EventStore.ts
    SecretStore.ts
    SettingsStore.ts

  observability/
    AgentLogger.ts
    TraceWriter.ts
    Redactor.ts

resources/
  prompts/
  model-config.schema.json
  default-models.json

tests/
  unit/
  provider-contract/
  agent-simulation/
  extension-integration/
```

---

## 5. モデル設定

## 5.1 設定ファイル

ユーザー設定は次の優先順位で読み込む。

1. VS Code User Settings
2. ユーザー共通設定ファイル
3. ワークスペース設定ファイル
4. 組み込みデフォルト

推奨ファイル名：

```text
~/.config/byok-agent/models.json
<workspace>/.vscode/byok-agent.models.json
```

ワークスペース側からAPIキー参照先、任意ヘッダー、外部URLを上書きすることは、原則禁止する。悪意あるリポジトリが外部送信先を変更するのを防ぐためである。

## 5.2 JSON例

```json
{
  "$schema": "./model-config.schema.json",
  "version": 1,

  "providers": {
    "primary-openai": {
      "type": "openai-responses",
      "baseUrl": "https://api.example.com/v1",
      "apiKeyRef": "secret://primary-openai",
      "timeoutMs": 120000,
      "headers": {}
    },

    "company-gateway": {
      "type": "openai-compatible",
      "baseUrl": "https://llm-gateway.example.net/v1",
      "apiKeyRef": "secret://company-gateway",
      "timeoutMs": 120000,
      "headers": {
        "X-Client-Name": "byok-vscode-agent"
      }
    }
  },

  "models": [
    {
      "id": "coding-primary",
      "displayName": "Coding Primary",
      "provider": "primary-openai",
      "apiModel": "provider-model-id",
      "family": "openai",
      "contextWindow": 200000,
      "maxOutputTokens": 16000,

      "capabilities": {
        "streaming": true,
        "toolCalling": true,
        "parallelToolCalls": true,
        "vision": false,
        "reasoning": true,
        "systemMessage": true,
        "promptCaching": false,
        "strictJsonSchema": true
      },

      "request": {
        "temperature": null,
        "topP": null,
        "reasoningEffort": "medium"
      },

      "agent": {
        "promptProfile": "default-coding",
        "contextProfile": "balanced",
        "toolProfile": "workspace",
        "maxIterations": 30,
        "maxToolCalls": 80,
        "maxConsecutiveFailures": 3
      }
    }
  ],

  "defaults": {
    "model": "coding-primary",
    "permissionProfile": "confirm-writes"
  }
}
```

### 5.3 APIキー

APIキー本体はJSONに保存しない。

```ts
interface SecretStore {
  get(providerId: string): Promise<string | undefined>;
  set(providerId: string, value: string): Promise<void>;
  delete(providerId: string): Promise<void>;
}
```

実装には`ExtensionContext.secrets`を使用する。VS Codeの`SecretStorage`は機密情報を暗号化して保存し、端末間同期を行わない。

### 5.4 モデル能力

モデル名から能力を推測する実装は補助的なものに留める。

正の情報源はJSON設定とする。

```ts
interface ModelCapabilities {
  streaming: boolean;
  toolCalling: boolean;
  parallelToolCalls: boolean;
  vision: boolean;
  reasoning: boolean;
  systemMessage: boolean;
  promptCaching: boolean;
  strictJsonSchema: boolean;
}
```

VS CodeのLanguage Model Chat Provider APIも、一つのプロバイダーから複数モデルを公開し、コンテキスト長、出力長、画像入力、Tool Callingなどのメタデータを提供する構造を採用している。

ただし、本拡張の中核はVS CodeのLanguage Model APIに依存させない。管理者ポリシーやAPI変更の影響を避け、BYOK通信を直接制御するためである。

---

## 6. Provider Adapter

すべてのモデルAPIを、内部の共通イベント形式に変換する。

```ts
interface ProviderAdapter {
  readonly type: string;

  stream(
    request: ProviderRequest,
    signal: AbortSignal
  ): AsyncIterable<ProviderEvent>;

  countTokens?(
    input: TokenCountInput
  ): Promise<number>;
}
```

```ts
type ProviderEvent =
  | { type: "text-delta"; text: string }
  | { type: "reasoning-delta"; text: string }
  | {
      type: "tool-call";
      id: string;
      name: string;
      arguments: unknown;
    }
  | {
      type: "usage";
      inputTokens: number;
      outputTokens: number;
      cachedTokens?: number;
    }
  | { type: "completed"; stopReason: string }
  | { type: "error"; error: ProviderError };
```

### 6.1 対応プロトコル

初期対応は次の三つとする。

* OpenAI Responses形式
* OpenAI互換Chat Completions形式
* Anthropic Messages形式

Geminiは第2段階で追加する。

各APIはTool Callingの表現が異なるが、共通する処理は、ツール定義をモデルへ渡し、構造化されたツール要求を受け、アプリケーション側で実行し、その結果を次のモデル入力へ返すループである。OpenAIの公式資料もこの処理を複数段階のTool Callingフローとして説明している。

AnthropicとGeminiも、モデルが関数の実行そのものを行うのではなく、呼び出す関数と引数を返し、アプリケーション側が処理する方式を採用している。

### 6.2 Provider Adapterの責務

Provider Adapterは次だけを担当する。

* 内部メッセージからAPI固有形式への変換
* ツール定義の変換
* ストリーミングイベントの正規化
* Tool Call IDの保持
* Tool ResultのAPI固有形式への変換
* APIエラーの分類
* 利用量の正規化
* キャンセル処理
* リトライ可能性の判定

エージェントの判断、ツール実行、権限管理、履歴圧縮はProvider Adapterに入れない。

---

## 7. エージェント実行方式

## 7.1 状態機械

```ts
type AgentState =
  | "idle"
  | "preparing-context"
  | "building-prompt"
  | "requesting-model"
  | "waiting-for-approval"
  | "executing-tools"
  | "compacting-context"
  | "reviewing-changes"
  | "completed"
  | "cancelled"
  | "failed";
```

### 7.2 実行フロー

```text
ユーザー送信
   ↓
セッション取得
   ↓
モデル・権限プロファイル決定
   ↓
コンテキスト収集
   ↓
トークン予算配分
   ↓
システムプロンプト構築
   ↓
有効ツール選定
   ↓
モデル呼び出し
   ↓
 ┌─────────────────────────────┐
 │ テキスト応答のみ             │──▶ 完了
 │ Tool Callあり                │
 └──────────────┬──────────────┘
                ↓
        引数JSON Schema検証
                ↓
          権限ポリシー判定
                ↓
       必要ならユーザー確認
                ↓
             ツール実行
                ↓
       Tool Resultを履歴へ追加
                ↓
          モデルを再呼び出し
```

Copilotの公開実装でも、プロンプト構築、利用可能ツール取得、Tool Calling、ツール結果保持、履歴、継続要求、停止フックを一つのループとして管理している。

### 7.3 停止条件

以下のいずれかで停止する。

* モデルが通常回答で終了
* `complete_task`が呼ばれた
* 最大反復回数到達
* 最大Tool Call数到達
* 同一ツールの連続失敗
* コンテキスト生成不能
* ユーザーが停止
* API課金上限到達
* Workspace Trustまたは権限違反
* Providerの回復不能エラー

```ts
interface AgentLimits {
  maxIterations: number;
  maxToolCalls: number;
  maxConsecutiveFailures: number;
  maxElapsedMs?: number;
  maxInputTokensTotal?: number;
  maxOutputTokensTotal?: number;
}
```

ツール上限到達時は、自動的に続行しない。ユーザーへ、停止、追加回数を許可、読み取り専用で継続、の選択肢を表示する。

---

## 8. コンテキスト管理

## 8.1 コンテキストの分類

### 静的コンテキスト

会話開始時に作成し、同一スレッド内で原則固定する。

* OS
* ワークスペースルート
* リポジトリ一覧
* Gitブランチ
  -主要言語
* プロジェクト構造の概要
* ユーザー指示ファイル
* エージェント設定
* 有効ツール概要

### ターン単位コンテキスト

各ユーザー入力時に更新する。

* アクティブファイル
* 選択範囲
* カーソル位置
* 表示中タブ
* 診断情報
* Git差分
* 直近変更ファイル
* ユーザーが添付したファイル
* ユーザー入力

### 実行中コンテキスト

エージェントループ中に増える。

* Tool Call
* Tool Result
* 作成中のChangeSet
* テスト結果
* コマンド結果
* 中間サマリー

Copilotのプロンプト実装も、会話開始時のGlobal Agent Contextと、毎ターン更新されるユーザーメッセージ周辺コンテキストを分け、静的内容を再利用している。

## 8.2 ContextItem

```ts
interface ContextItem {
  id: string;
  kind:
    | "instruction"
    | "workspace"
    | "file"
    | "selection"
    | "symbol"
    | "diagnostic"
    | "git"
    | "tool-result"
    | "conversation-summary";

  source: string;
  content: string;
  uri?: string;
  range?: SerializedRange;
  priority: number;
  estimatedTokens: number;
  contentHash: string;
  volatile: boolean;
  sensitive: boolean;
}
```

## 8.3 優先順位

コンテキスト採用順は次とする。

1. ユーザーが明示添付した内容
2. 現在の選択範囲
3. 現在のファイル
4. ユーザー指示・ワークスペース指示
5. 直近Tool Result
6. 関連シンボルと参照
7. 診断情報
8. Git差分
9. テキスト検索結果
10. ワークスペース構造
11. 古い会話履歴

同じファイル内容が、明示添付、現在のファイル、検索結果として重複した場合は、URI、範囲、内容ハッシュで統合する。

## 8.4 トークン予算

モデルのコンテキスト上限をそのまま使用しない。

```text
usableBudget =
  contextWindow
  - reservedOutputTokens
  - toolSchemaTokens
  - safetyMargin
```

標準配分：

| 用途           |  比率 |
| ------------ | --: |
| システム・指示      | 15% |
| 会話履歴・サマリー    | 20% |
| 明示コンテキスト     | 20% |
| 検索・コードコンテキスト | 30% |
| Tool Result  | 15% |

比率は固定ではなく、明示添付、Tool Result、履歴量に応じて再配分する。

## 8.5 履歴コンパクション

以下の条件で会話を要約する。

```text
estimatedPromptTokens >
usableBudget × 0.85
```

要約結果は自由文だけでなく、構造化して保存する。

```ts
interface ConversationSummary {
  objective: string;
  userRequirements: string[];
  decisions: string[];
  filesRead: string[];
  filesChanged: string[];
  commandsExecuted: string[];
  testResults: string[];
  unresolvedIssues: string[];
  currentPlan: string[];
  lastToolResults: string[];
}
```

直近2～4ラウンドは原文を残し、それより古い履歴を要約に置き換える。

Copilotの公開コードにも、履歴、Tool Call、Tool Result、変更ファイル、直前状態を保存する会話要約処理があり、要約用プロンプトと通常エージェントプロンプトを分離している。

### 8.6 Tool Resultの圧縮

ツール結果は次の順で処理する。

1. ANSIエスケープ除去
2. 機密情報のマスク
3. バイナリ判定
4. 最大文字数制限
5. 先頭・末尾保持
6. 重要行抽出
7. 完全出力をローカルアーティファクトへ保存
8. モデルには要約と参照IDだけを渡す

例：

```text
Command exited with code 1.

Summary:
- 3 tests failed
- 41 tests passed
- Main failure: src/parser.test.ts:82

Full output reference:
artifact://thread-123/tool-result-48
```

---

## 9. システムプロンプト

## 9.1 モジュール構造

システムプロンプトは単一文字列にハードコードしない。

```text
SystemPrompt
  ├─ IdentityModule
  ├─ SafetyModule
  ├─ EnvironmentModule
  ├─ WorkflowModule
  ├─ ToolRulesModule
  ├─ EditingRulesModule
  ├─ CompletionModule
  ├─ UserInstructionsModule
  └─ WorkspaceInstructionsModule
```

```ts
interface PromptModule {
  id: string;
  priority: number;
  appliesTo(context: PromptBuildContext): boolean;
  render(context: PromptBuildContext): Promise<string>;
}
```

## 9.2 基本プロンプトの責務

基本プロンプトには次だけを含める。

* VS Code内で動作するコーディングエージェントであること
* 推測よりツールで確認すること
* 読んでいないファイルの内容を断定しないこと
* 編集前に関連コードを調査すること
* 変更を最小化すること
* 既存スタイルと規約に従うこと
* テスト可能なら検証すること
* ツール失敗を隠さないこと
* ユーザー未承認の危険操作を行わないこと
* 完了時に変更内容と検証結果を要約すること

## 9.3 モデルファミリー別オーバーレイ

```ts
interface PromptProfile {
  baseModules: string[];
  familyModules: Record<string, string[]>;
}
```

例：

```json
{
  "id": "default-coding",
  "baseModules": [
    "identity",
    "safety",
    "workflow",
    "editing",
    "completion"
  ],
  "familyModules": {
    "openai": ["openai-tool-format"],
    "anthropic": ["anthropic-tool-discipline"],
    "gemini": ["gemini-tool-result-consistency"]
  }
}
```

モデルごとの差は、主として以下に限定する。

* Tool Calling上の注意
* reasoning設定の扱い
* 並列Tool Callの扱い
* システムメッセージ制約
* キャッシュ境界
* Tool Resultの順序制約

## 9.4 ユーザー指示

次を探索する。

```text
AGENTS.md
.github/copilot-instructions.md
.vscode/byok-agent.instructions.md
**/*.instructions.md
```

優先順位：

```text
システム安全規則
  > ユーザーの現在の依頼
  > モード指示
  > ワークスペース指示
  > ユーザー共通指示
  > 既定プロンプト
```

ワークスペース内の指示ファイルは信頼できない入力として扱い、システム安全規則や権限を上書きさせない。

---

## 10. ツールシステム

## 10.1 ToolDefinition

```ts
interface ToolDefinition<TInput = unknown> {
  name: string;
  displayName: string;
  description: string;
  inputSchema: object;

  category: "read" | "write" | "execute" | "network";
  mutatesWorkspace: boolean;
  requiresTrust: boolean;
  supportsParallel: boolean;

  isAvailable(context: ToolAvailabilityContext): boolean;

  execute(
    input: TInput,
    context: ToolExecutionContext,
    signal: AbortSignal
  ): Promise<ToolResult>;
}
```

ツールの説明と入力はJSON Schemaで定義する。VS CodeのLanguage Model Tool APIも、名前、モデル向け説明、ユーザー向け説明、入力JSON Schema、利用条件を宣言する構造を採用している。

## 10.2 初期ツール

### 読み取り

| ツール               | 役割                                   |
| ----------------- | ------------------------------------ |
| `read_file`       | 範囲指定でファイルを読む                         |
| `list_files`      | ディレクトリを列挙                            |
| `search_text`     | ワークスペース内の文字列検索                       |
| `get_symbols`     | Document Symbol / Workspace Symbol取得 |
| `get_references`  | 定義・参照取得                              |
| `get_diagnostics` | エラー・警告取得                             |
| `git_status`      | Git状態取得                              |
| `git_diff`        | 未コミット差分取得                            |

### 書き込み

| ツール           | 役割                       |
| ------------- | ------------------------ |
| `apply_patch` | パッチをPending ChangeSetへ追加 |
| `create_file` | 新規ファイルをChangeSetへ追加      |
| `delete_file` | 削除予定をChangeSetへ追加        |
| `rename_file` | リネーム予定をChangeSetへ追加      |

### 実行

| ツール           | 役割             |
| ------------- | -------------- |
| `run_command` | コマンド実行         |
| `run_tests`   | テスト候補を実行       |
| `run_task`    | VS Code Task実行 |

### 制御

| ツール             | 役割        |
| --------------- | --------- |
| `update_plan`   | 現在の作業計画更新 |
| `complete_task` | タスク完了通知   |

## 10.3 入力検証

モデルが生成した引数はAJVで検証する。

```ts
const validate = ajv.compile(tool.inputSchema);

if (!validate(input)) {
  return {
    ok: false,
    error: {
      code: "INVALID_TOOL_INPUT",
      details: validate.errors
    }
  };
}
```

Copilotの公開実装もAJVを使用し、文字列化されたネストJSONの補正を含めて入力を検証している。

## 10.4 MCP

MCPは組み込みツールと別の名前空間で管理する。

```text
builtin.read_file
builtin.run_command
mcp.github.create_issue
mcp.database.query
```

MCPでは、サーバーが名前、説明、入力スキーマを持つツールを公開する。これを内部の`ToolDefinition`へ変換する。

MCPツールは以下を必須とする。

* サーバー単位の有効化
* ツール単位の許可
* 接続先表示
* 入出力サイズ制限
* タイムアウト
* ネットワークツールの確認
* MCPサーバー設定のWorkspace Trust制限

---

## 11. 権限モデル

## 11.1 Permission Profile

```ts
type PermissionProfile =
  | "read-only"
  | "confirm-writes"
  | "workspace-write"
  | "autonomous";
```

### read-only

* ファイル読み取り可
* 検索可
* 診断取得可
* 編集不可
* コマンド不可

### confirm-writes

* 読み取り可
* ChangeSet作成可
* ディスク反映は確認
* コマンドは毎回確認

### workspace-write

* ワークスペース内の変更を自動でChangeSetへ追加
* ディスク反映はユーザー確認
* 安全なテストコマンドは事前ルールに基づき自動実行可能

### autonomous

* 許可範囲内で編集・テストを継続
* 削除、外部通信、Git push、秘密情報操作は常に確認
* 既定では提供せず、明示的に有効化

## 11.2 常に確認する操作

* ワークスペース外への書き込み
* ファイル削除
* 大量ファイル変更
* `git commit`
* `git push`
* パッケージ公開
* デプロイ
* 外部URLへのデータ送信
* 管理者権限操作
* 秘密情報を含む可能性があるファイルの送信
* 破壊的コマンド
* ユーザー設定の変更

## 11.3 Workspace Trust

エージェントはWorkspace Trustを必須で考慮する。

Restricted Modeでは次を無効化する。

* コマンド実行
* VS Code Task実行
* ワークスペース定義の外部モデルURL
* ワークスペース定義のMCPサーバー
* 自動ファイル変更
* リポジトリ内スクリプトの実行

VS Codeは、未信頼ワークスペースを開いた際の意図しないコード実行を防ぐため、Workspace TrustとRestricted Modeを提供している。拡張機能は`capabilities.untrustedWorkspaces`と`workspace.isTrusted`で機能を制限できる。

```json
{
  "capabilities": {
    "untrustedWorkspaces": {
      "supported": "limited",
      "description": "Reading is available, but editing and command execution require a trusted workspace.",
      "restrictedConfigurations": [
        "byokAgent.modelsFile",
        "byokAgent.mcpServers",
        "byokAgent.commandAllowList"
      ]
    }
  }
}
```

---

## 12. ファイル編集と差分レビュー

## 12.1 モデルから直接ディスクを書き換えない

`apply_patch`、`create_file`、`delete_file`は、即座にディスクへ反映しない。

まず`PendingChangeSet`を作る。

```ts
interface PendingChangeSet {
  id: string;
  threadId: string;
  createdAt: number;
  files: PendingFileChange[];
}

interface PendingFileChange {
  uri: string;
  type: "modify" | "create" | "delete" | "rename";
  baseHash?: string;
  originalText?: string;
  proposedText?: string;
  oldUri?: string;
}
```

## 12.2 差分表示

変更前と変更後をVirtual Documentとして登録し、`vscode.diff`で表示する。

UIには以下を表示する。

* 変更ファイル一覧
* 追加・削除行数
* ファイル単位のAccept / Reject
* ChangeSet全体のApply / Discard
* 競合警告
* 変更理由
* 実行したテスト

## 12.3 適用

承認後に`WorkspaceEdit`を使ってまとめて適用する。

適用前に現在の内容と`baseHash`を比較する。

一致しない場合：

1. 自動上書きしない
2. 競合状態にする
3. 新しい内容を読み直す
4. モデルに再パッチを要求するか、ユーザーに手動解決を求める

Codex IDE拡張も、変更概要と差分をエディタ内で確認し、必要な変更だけを保持する操作を中心にしている。

---

## 13. ターミナル実行

コマンドは構造化して扱う。

```ts
interface CommandRequest {
  command: string;
  args: string[];
  cwd: string;
  env?: Record<string, string>;
  reason: string;
  timeoutMs: number;
}
```

可能な限り、シェル文字列ではなく`command`と`args`を分離する。

以下を検査する。

* `cwd`がワークスペース内か
* 実行ファイル
* シェルメタ文字
* リダイレクト
* パイプ
* `sudo`
* ネットワークコマンド
* 削除系コマンド
* Gitへの書き込み
* パッケージ公開
* 環境変数への秘密情報混入

インタラクティブなコマンドはVS Code Terminalで表示する。非対話コマンドはNode側の`spawn`で実行し、標準出力を制限付きで取得する。

VS CodeのTerminal APIはターミナル作成、コマンド送信、Shell Integrationによる実行状態と出力ストリーム取得を提供している。

---

## 14. UI設計

## 14.1 基本レイアウト

```text
┌──────────────────────────────┐
│ Thread title       New  …    │
│ Model ▼   Permission ▼       │
├──────────────────────────────┤
│ User message                 │
│                              │
│ Agent response               │
│ ┌ Tool: search_text ───────┐ │
│ │ Query: SessionController │ │
│ │ 8 matches               │ │
│ └──────────────────────────┘ │
│                              │
│ ┌ Changes: 3 files ────────┐ │
│ │ src/a.ts       +14 -3    │ │
│ │ src/a.test.ts  +22 -0    │ │
│ │ Review changes           │ │
│ └──────────────────────────┘ │
├──────────────────────────────┤
│ [file.ts] [selection] [+]    │
│                              │
│ Ask the agent...             │
│                      Send ■  │
└──────────────────────────────┘
```

## 14.2 UI構成

### ヘッダー

* 新規スレッド
* スレッド名
* モデル選択
* 権限モード
* コンテキスト使用量
* 停止
* メニュー

### メッセージ

* Markdown
* コードブロック
* Tool Activity
* 承認要求
* エラー
* Usage
* ChangeSet
* テスト結果

### Composer

* 複数行入力
* ファイル添付
* 選択範囲添付
* 診断添付
* Git差分添付
* 画像添付
* `/`コマンド
* `@`ファイル・シンボル選択
* モデル・権限の簡易切替

### Tool Activity

```ts
interface ToolActivityView {
  toolCallId: string;
  name: string;
  status:
    | "queued"
    | "approval-required"
    | "running"
    | "succeeded"
    | "failed"
    | "cancelled";
  summary: string;
  durationMs?: number;
}
```

引数全文や巨大なTool Resultを初期表示しない。折りたたみ表示とする。

## 14.3 Webview通信

すべてのメッセージを判別共用体で定義する。

```ts
type UiToExtensionMessage =
  | { type: "send-message"; threadId: string; text: string }
  | { type: "cancel-run"; runId: string }
  | { type: "approve-tool"; approvalId: string }
  | { type: "reject-tool"; approvalId: string }
  | { type: "apply-change-set"; changeSetId: string }
  | { type: "discard-change-set"; changeSetId: string }
  | { type: "select-model"; modelId: string }
  | { type: "set-permission"; profile: PermissionProfile };
```

受信内容はZodまたはJSON Schemaで必ず検証する。

---

## 15. 会話・イベント保存

## 15.1 保存形式

初期実装はSQLiteではなく、スナップショット＋JSONLとする。

```text
globalStorage/
  threads/
    <thread-id>/
      meta.json
      events.jsonl
      summary.json
      artifacts/
      changes/
```

### meta.json

```ts
interface ThreadMetadata {
  id: string;
  title: string;
  workspaceId?: string;
  modelId: string;
  permissionProfile: PermissionProfile;
  createdAt: number;
  updatedAt: number;
  archived: boolean;
}
```

### events.jsonl

```ts
type AgentEvent =
  | UserMessageEvent
  | AssistantTextEvent
  | ToolCallEvent
  | ToolResultEvent
  | ApprovalEvent
  | ContextSnapshotEvent
  | ChangeSetEvent
  | UsageEvent
  | ErrorEvent;
```

イベントは追記専用にする。一定件数ごとにスナップショットを作成する。

## 15.2 保存しないもの

* APIキー
* Authorizationヘッダー
* 生の環境変数
* `.env`内容
* 認証トークン
* モデルの非公開推論内容
* 明示的に除外されたファイル内容

---

## 16. セキュリティ設計

### 16.1 Webview

* Content Security Policy必須
* スクリプトnonce必須
* `unsafe-eval`禁止
* `unsafe-inline`禁止
* `localResourceRoots`を限定
* 外部スクリプト禁止
* HTMLをサニタイズ
* Markdown内HTMLは無効
* Command URIは既定無効
* Extension Host側でメッセージ検証

### 16.2 パス

* `Uri`を正規化
* `..`による脱出を拒否
* シンボリックリンク解決後もワークスペース内か確認
* UNC、デバイスパスを検査
* 大文字・小文字差異をOSに応じて処理
* ワークスペース外アクセスは確認または拒否

### 16.3 ネットワーク

* HTTPSを既定必須
* `localhost`だけHTTP許可可能
* URL内のユーザー名・パスワード禁止
* リダイレクト先の再検証
* 最大レスポンスサイズ
* タイムアウト
* TLSエラーを無視する設定は提供しない
* 利用するProvider URLをUIに常時表示可能にする

### 16.4 ログ

ログは既定で以下だけを記録する。

* Request ID
* Provider
* Model
* 時間
* Token Usage
* Tool名
* 成否
* エラー分類
* コンテキスト項目数

プロンプト全文、Tool Result全文、ファイル内容は既定で記録しない。

Copilotの公開実装には、LLM呼び出し、ツール実行、Token UsageをOpenTelemetryで観測する仕組みがある。本拡張ではこれを任意機能として採用し、内容を含まないメタデータ中心の設計にする。

---

## 17. 主要インターフェース

```ts
interface AgentRuntime {
  run(request: AgentRunRequest): AsyncIterable<AgentEvent>;
  cancel(runId: string): void;
}
```

```ts
interface ContextManager {
  collect(
    request: ContextRequest,
    signal: AbortSignal
  ): Promise<ContextBundle>;

  compact(
    bundle: ContextBundle,
    model: ModelDefinition
  ): Promise<ContextBundle>;
}
```

```ts
interface PromptComposer {
  compose(input: PromptComposeInput): Promise<ComposedPrompt>;
}
```

```ts
interface ToolRegistry {
  register(tool: ToolDefinition): void;

  listAvailable(
    context: ToolAvailabilityContext
  ): ToolDefinition[];

  invoke(
    name: string,
    input: unknown,
    context: ToolExecutionContext,
    signal: AbortSignal
  ): Promise<ToolResult>;
}
```

```ts
interface ApprovalService {
  evaluate(
    action: ProposedAction,
    context: ApprovalContext
  ): Promise<ApprovalDecision>;

  requestUserApproval(
    request: ApprovalRequest
  ): Promise<boolean>;
}
```

```ts
interface ChangeSetManager {
  create(threadId: string): Promise<PendingChangeSet>;

  addPatch(
    changeSetId: string,
    patch: string
  ): Promise<void>;

  apply(
    changeSetId: string,
    files?: string[]
  ): Promise<ApplyResult>;

  discard(
    changeSetId: string,
    files?: string[]
  ): Promise<void>;
}
```

---

## 18. エラー分類

```ts
type AgentErrorCode =
  | "PROVIDER_AUTH_FAILED"
  | "PROVIDER_RATE_LIMITED"
  | "PROVIDER_TIMEOUT"
  | "PROVIDER_BAD_REQUEST"
  | "MODEL_CONTEXT_EXCEEDED"
  | "MODEL_TOOL_UNSUPPORTED"
  | "INVALID_TOOL_INPUT"
  | "TOOL_NOT_FOUND"
  | "TOOL_EXECUTION_FAILED"
  | "TOOL_PERMISSION_DENIED"
  | "WORKSPACE_NOT_TRUSTED"
  | "PATCH_CONFLICT"
  | "FILE_OUTSIDE_WORKSPACE"
  | "USER_CANCELLED"
  | "AGENT_LIMIT_REACHED";
```

エラーは、ユーザー向けメッセージ、モデルへ返す情報、ログへ保存する情報を分離する。

```ts
interface AgentError {
  code: AgentErrorCode;
  userMessage: string;
  modelMessage?: string;
  technicalDetails?: string;
  retryable: boolean;
}
```

---

## 19. テスト設計

### 19.1 単体テスト

* Model JSON Schema
* Provider設定マージ
* コンテキスト優先順位
* トークン予算配分
* 重複排除
* プロンプトモジュール順序
* Tool Schema検証
* パス脱出防止
* 権限判定
* Patch Parser
* 履歴要約

### 19.2 Provider Contract Test

保存済みストリームイベントを使用し、以下を検証する。

* Text delta
* Tool Call
* 並列Tool Call
* Tool Result
* Usage
* Stop reason
* APIエラー
* キャンセル
* 不完全JSON
* 再接続

実APIを使うテストは明示的な環境変数がある場合だけ実行する。

### 19.3 Agent Simulation

スクリプト化したFake Modelを用意する。

```ts
const scenario = [
  toolCall("search_text", { query: "SessionController" }),
  toolCall("read_file", { path: "src/SessionController.ts" }),
  toolCall("apply_patch", { patch: "..." }),
  text("変更を作成し、テストを実行しました。"),
  toolCall("complete_task", {})
];
```

検証項目：

* Tool Resultが次のモデル入力に入る
* 上限で停止する
* 失敗ツールを無限再試行しない
* キャンセルが全レイヤーへ伝播する
* ChangeSet適用前にディスクが変化しない
* 要約後も目的と未完了事項が保持される

### 19.4 Extension Integration Test

* Webview起動
* メッセージ送受信
* モデル選択
* SecretStorage
* Workspace Trust
* Diff表示
* WorkspaceEdit
* Terminal実行
* Remote Development環境
* 複数ルートワークスペース
* VS Code再起動後のスレッド復元

---

## 20. 実装フェーズ

### Phase 1：基盤

* Extension activation
* Sidebar Webview
* Model JSON
* SecretStorage
* OpenAI互換Provider
* ストリーミングチャット
* スレッド保存

完了条件：

* BYOKキーで通常チャットが動作する
* モデルをJSONで追加できる
* APIキーが設定ファイルやログへ出ない

### Phase 2：読み取り専用エージェント

* AgentLoop
* ToolRegistry
* `read_file`
* `list_files`
* `search_text`
* `get_diagnostics`
* コンテキスト予算
* Tool Activity UI

完了条件：

* モデルが複数回ツールを呼び出してコード調査できる
* Tool Call上限とキャンセルが機能する
* 未信頼ワークスペースでも安全に動作する

### Phase 3：編集とレビュー

* `apply_patch`
* `create_file`
* `delete_file`
* ChangeSet
* Virtual Diff
* Accept / Reject
* WorkspaceEdit
* 競合検知

完了条件：

* モデルがディスクを直接変更しない
* ユーザーが差分確認後に適用できる
* ファイル単位で変更を拒否できる

### Phase 4：実行ツール

* `run_command`
* `run_tests`
* VS Code Task
* Approval UI
* Permission Profile
* コマンド出力圧縮

完了条件：

* コマンド、cwd、理由が実行前に確認できる
* タイムアウトとキャンセルが機能する
* 破壊的操作が自動実行されない

### Phase 5：長期セッション

* 会話要約
* 静的コンテキストキャッシュ
* Tool Resultアーティファクト
* Prompt profile
* Anthropic Provider
* Gemini Provider
* MCP

完了条件：

* 長いTool Callingセッションでもコンテキスト上限を超えない
* 要約後も現在の作業状態を復元できる
* モデル変更時も履歴を継続できる

### Phase 6：ハードニング

* CSP
* Path traversal test
* Symlink escape test
* Secret redaction
* Network policy
* Remote Development
* パフォーマンス測定
* Marketplace向け設定
* OSS attribution

---

## 21. MVPのスコープ

MVPでは以下に限定する。

* デスクトップ版VS Code
* Node Extension Host
* OpenAI ResponsesまたはOpenAI互換API
* テキスト入力
* 単一エージェント
* 読み取りツール
* パッチベース編集
* 差分レビュー
* 確認付きコマンド実行
* JSONモデル設定
* SecretStorage
* JSONL会話保存

MVPから除外する。

* インライン補完
* Inline Chat
* クラウドエージェント
* GitHub認証
* PR作成
* 複数エージェント並列実行
* 自動コミット
* Web版VS Code
* 独自Embeddingインデックス
* 音声
* Notebook編集
* Computer Use

---

## 22. 最終判断

本プロジェクトでは、Copilot Chatをフォークして削るよりも、以下の五つだけを再構成する方が適切である。

1. **モデルカタログ**
   ProviderとModelをJSONで定義し、秘密情報はSecretStorageへ分離する。

2. **コンテキストマネージャー**
   静的、ターン単位、実行中コンテキストを分け、優先順位とトークン予算で選別する。

3. **モジュール式プロンプト**
   共通プロンプトとモデルファミリー固有差分を分離する。

4. **エージェントループとツールレジストリ**
   Tool Call、検証、権限確認、実行、結果返却を明確な状態機械で管理する。

5. **レビュー可能な変更UI**
   モデルに直接ディスクを書き換えさせず、ChangeSetとDiffを通してユーザーが最終決定する。

この構成なら、Copilotの設計上の強みを取り込みながら、GitHub認証、製品固有API、テレメトリー、実験基盤、巨大な内部依存を排除できる。BYOK専用エージェントとして必要な機能だけを維持でき、Provider追加、MCP追加、権限強化、UI変更も独立して行える。
