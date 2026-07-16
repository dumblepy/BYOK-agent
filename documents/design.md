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

### 2.4 OSSライセンス・NOTICE設計

#### 2.4.1 成果物と責務

OSS表示に関する成果物はリポジトリルートに置き、次の責務を分離する。

| 成果物 | 責務 | 管理方法 |
|---|---|---|
| `LICENSE` | 本プロジェクトのMITライセンス全文 | OSI公認の本文を変更せず固定管理する |
| `NOTICE.md` | 本プロジェクトの著作権表示、Copilot Chat由来コードの出典、第三者の追加表示 | コード由来の記録をファイル単位で追記する |
| `THIRD_PARTY_LICENSES.md` | 直接・間接依存のライセンス台帳 | `pnpm-lock.yaml`を入力に生成し、生成元と検査日を記録する |

`package.json`の`license: "MIT"`はパッケージメタデータとして維持するが、`LICENSE`の代替にはしない。依存パッケージのライセンスは本プロジェクトのMITライセンスへ包括せず、各パッケージの表示と条件を保持する。

#### 2.4.2 Copilot Chat由来コードの出典台帳

特定のコード、テスト、プロンプト断片、アルゴリズム実装をコピーまたは改変して利用した場合は、`NOTICE.md`に一意な記録IDを付けたファイル単位のレコードを作成する。設計思想や一般的な責務分割を参考にしただけで、特定の表現やコードを移植していない場合は、コード出典レコードの対象外とする。

レコードの必須項目は次のとおりとする。

```text
## CCH-0001: <短い識別名>
- Source repository: <リポジトリURL>
- Source commit: <完全なコミットSHA>
- Source license: <ライセンス識別子>
- Source file: <原ファイルパス>
- Source range: <行範囲または関数・シンボル名>
- Destination file: <本リポジトリ内の移植先>
- Usage: copied | modified
- Retrieved/verified on: <YYYY-MM-DD>
- Changes: <変更内容>
- Review notes: <表示保持と差分確認>
```

`Source commit`は短縮SHAを使わず、取得元を再現できる完全SHAを記録する。原ファイルまたは移植先が複数ある場合はファイルごとにレコードを分ける。コミット時点の`LICENSE`、対象ファイルのライセンスヘッダー、必要なNOTICEを確認し、確認できない出典コードは取り込まない。

#### 2.4.3 依存ライセンス台帳

`THIRD_PARTY_LICENSES.md`は`pnpm-lock.yaml`に現れる直接・間接依存を対象とし、runtime依存とdevelopment依存を`Scope`列で区別する。同一パッケージに複数バージョンが存在する場合は、解決バージョンごとに記録する。

台帳の冒頭には、対象ロックファイル、生成または検査コマンド、検査日、ライセンス検出方式を記録する。各行には次の情報を持たせる。

| Package | Version | Scope | License | License text / notice | Source |
|---|---|---|---|---|---|
| `<name>` | `<version>` | `runtime` / `development` | `<SPDX ID or expression>` | `<相対パスまたはURL>` | `<配布元URL>` |

ライセンス本文またはNOTICEの同梱が必要な依存は、台帳からリポジトリ内の第三者表示へ辿れるようにする。ライセンス不明、複数条件の選択未確定、本文取得失敗、ロックファイルとの差分は検査失敗とし、一覧を完成扱いにしない。

#### 2.4.4 検査と更新タイミング

依存追加・更新・削除、Copilot Chat由来コードの取り込み、リリース用パッケージ生成の各時点で台帳を更新する。検査では次を確認する。

1. `LICENSE`の存在、MIT本文、著作権者表記、`package.json`のメタデータが整合している。
2. Copilot Chat由来コードの移植先ファイルごとに、完全コミットSHA・原ファイル・原範囲・変更内容のレコードがある。
3. `pnpm-lock.yaml`の全解決パッケージが`THIRD_PARTY_LICENSES.md`に一度以上現れ、重複バージョンが欠落していない。
4. 未解決ライセンス、ライセンス表記の矛盾、必要な著作権表示・NOTICEの欠落がない。
5. `NOTICE.md`および依存ライセンス台帳の変更がレビュー対象になっている。

自動検査スクリプトやCI連携は後続フェーズで追加するが、本ブランチでは成果物を作成し、生成元、検査結果、失敗条件を台帳とNOTICEから追跡できる状態にする。

#### 2.4.5 初回監査結果

2026-07-12の初回監査では、`LICENSE`、`NOTICE.md`、`THIRD_PARTY_LICENSES.md`をリポジトリルートへ配置した。`package.json`のプロジェクトライセンスは`MIT`であり、runtime依存は`preact@10.29.7`の1件、development依存はロックファイル上の401件だった。

Copilot Chatの特定コミットからコピーまたは改変した実装コードは確認されなかった。既存ドキュメントのCopilot Chatへの言及は設計上の参照であり、コード出典レコードの対象外とした。`@vscode/vsce-sign`系の2パッケージは、パッケージ内`LICENSE.txt`にあるMicrosoft Software License Termsを確認し、ライセンス不明として残していない。

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

モデル設定はユーザー共通設定ファイルだけから読み込む。

```text
~/.byok-agent/models.json
```

`resources/default-models.json`は、`models.json`が存在しない初回起動時の生成テンプレートとしてだけ使用する。VS Code User Settingsやワークスペース設定からモデル定義を読み込まない。

推奨ファイル名：

```text
~/.byok-agent/models.json
<workspace>/.vscode/byok-agent.models.json
```

ワークスペース側からAPIキー参照先、任意ヘッダー、外部URLを上書きすることは、原則禁止する。悪意あるリポジトリが外部送信先を変更するのを防ぐためである。

### 5.1.1 設定ローダーの責務

`ModelConfigLoader`は設定ソースを読み込み、検証済みの最終設定スナップショットをModel Catalogへ渡すExtension Host側のコンポーネントとする。Webviewは設定ファイルを直接読まず、ローダーが生成した安全なモデル要約だけを受け取る。

#### 設定ソースと優先順位

実行時は`~/.byok-agent/models.json`だけを読み込む。ファイルが存在しない場合だけ、組み込みテンプレートをコピーしてから読み込む。

存在しない任意ソースは空設定として扱う。読み込み対象のパスは固定の解決規則で決定し、ワークスペース設定から任意のファイルパスを追加指定できない。

#### マージ規則

- Providerのマージキーは`name`、ModelのマージキーはProvider内の`id`とする。キーが異なる定義は別エントリとして扱う。
- Provider配列とModel配列は単純な配列連結をせず、キー単位で順序を保ちながらマージする。同一キーは低優先エントリを基礎に高優先エントリを重ねる。
- 同一オブジェクト内のオブジェクト値は再帰的にマージする。スカラー値は高優先ソースの値で置換する。
- 配列値は原則として高優先ソースの配列で置換し、要素の暗黙的な結合や重複排除は行わない。ただしProvider／Model配列だけは上記の識別子マージを適用する。
- 高優先ソースにないProvider／Modelは低優先ソースから引き継ぐ。削除操作やnullによる削除はSchema契約に含めず、将来の明示的なSchema拡張で定義する。
- マージ後にProvider名またはModel IDが重複する状態を残さず、参照整合性、Token上限、Capabilities、URL、スコープ安全性を最終設定として再検証する。

#### 検証と公開単位

各ソースを、JSON構文、JSON Schema、意味検証、スコープ別セキュリティポリシーの順に個別検証する。いずれかの検証に失敗したソースは部分採用せず、直前の有効スナップショットを維持する。全ソースの読み込みと検証が完了した場合だけ、マージ済み設定を一つの不変スナップショットとして原子的に公開する。

ワークスペース設定は、APIキー参照先、Authorizationを含む任意ヘッダー、外部URL、認証方式を追加・変更できない。Workspace Trustが無効な場合、ワークスペース由来の外部接続設定は採用せず、組み込み・ユーザー側の安全な設定だけで再計算する。エラー通知にはソース種別、ファイルパスの安全な識別子、構造化エラーコードだけを含め、秘密情報や設定値全体を含めない。

#### ファイル変更時の再読み込み

ユーザー共通設定とワークスペース設定はファイル監視対象とする。変更・作成・削除イベントは短時間のデバウンス後に対象ソースを再読み込みし、同時発生した複数イベントを一回の再計算へまとめる。読み込み中の中間結果は公開せず、再読み込み完了後にスナップショットを置き換える。

再読み込みが成功した場合は設定変更イベントに新しいrevisionと変更されたソース種別だけを含める。JSON構文または検証に失敗した場合は最後の有効設定を維持し、診断イベントを通知する。削除された任意設定ファイルは空設定として再計算し、組み込みデフォルトまでフォールバックする。監視解除時にはファイルディスクリプターとイベント購読を解放し、同じ変更を二重に通知しない。

### 5.1.2 ワークスペース由来設定の安全制約

#### 脅威モデル

ワークスペース設定ファイルはリポジトリから取得され得るため、ユーザーの明示的な設定と同じ信頼境界で扱わない。攻撃者が設定ファイルを追加・変更することで、ユーザーが登録したAPIキーを攻撃者のサーバーへ送信する、送信先を差し替える、Authorization等の認証・転送ヘッダーを追加・上書きする、といった操作を防ぐ。

設定ロード時点でソーススコープを付与し、各フィールドの変更権限を検証する。`Workspace Trust` は信頼状態を表す入力であり、APIキーや認証ヘッダーの禁止を解除する権限ではない。

#### スコープ別ポリシー

| 設定項目 | 組み込み・ユーザー側 | ワークスペース側 | 未信頼ワークスペース |
|---|---|---|---|
| Provider／Modelの表示情報・能力 | 許可 | 許可 | 許可（Schema検証後） |
| `apiKey`本体 | 禁止 | 禁止 | 禁止 |
| SecretStorageのキーID・参照先 | Host内部でのみ管理 | 禁止 | 禁止 |
| 環境変数・入力変数による秘密参照 | 許可（定義した方式のみ） | 禁止 | 禁止 |
| Provider／Modelの外部URL | 許可（ネットワーク規則に従う） | 既存値の変更・新規追加とも禁止 | ワークスペース由来は不採用 |
| 任意HTTPヘッダー | 許可範囲のみ | 禁止 | 禁止 |

ワークスペース設定で禁止項目が見つかった場合は、該当フィールドだけを黙って落とさず、ソース全体を無効化する。Provider名やModel IDだけを採用して別の認証情報と組み合わせる意図しない昇格を防ぐためである。

#### APIキーと認証情報

ワークスペース設定の`apiKey`は、平文、`${input:...}`、`secret://...`、環境変数展開など形式に関係なく拒否する。既存のユーザー側SecretのID、Providerの認証方式、Authorization値、Cookieを指定・変更することも拒否する。APIキーの解決はExtension HostのSecretStorage責務とし、設定由来の識別子を解決関数へ渡さない。

#### URLとWorkspace Trust

URLは正規化・解析後に、URL内ユーザー情報、許可されないスキーム、HTTPS要件、localhostのHTTP例外を検証する。ワークスペース設定はURLを新規追加できず、既存ProviderのURLも変更できない。Workspace Trustが無効な場合は、ワークスペースソースに含まれる外部URLを全て不採用とし、組み込み・ユーザー側ソースだけで最終スナップショットを再計算する。

Trust状態が変更された場合は、設定ファイルの変更がなくても全ソースを再評価する。HTTPリダイレクトが発生した場合も、最終URLに対して同じ検証を再実行する。

#### HTTPヘッダー

任意HTTPヘッダーはリクエストへそのまま追加する自由形式の辞書として扱わない。許可する場合はユーザー側設定に限定し、ヘッダー名をASCII小文字へ正規化して、空白、制御文字、重複名、CR/LFを拒否する。次の予約カテゴリは明示的な許可リストに入れない。

- `authorization`、`proxy-authorization`、`cookie`、`set-cookie`
- `host`、`content-length`、`transfer-encoding`
- `origin`、`referer`、`forwarded`、`via`、`proxy-*`、`x-forwarded-*`

ワークスペース設定では任意ヘッダーを一件も許可しない。ユーザー側の非予約ヘッダーも、Providerの固定認証ヘッダーやHTTPクライアント管理のHop-by-hopヘッダーを上書きできないよう、固定値を優先する。最終リクエスト生成前に再検証し、検証済みの不変マップだけをProvider Adapterへ渡す。

#### 検証順序と失敗時動作

設定ソースごとに、(1) UTF-8 JSON解析とJSON Schema、(2) Provider／Modelの意味検証、(3) ソーススコープとWorkspace TrustによるAPIキー・Secret参照・URL・認証方式・ヘッダーのポリシー検証、(4) 全ソースの安全なマージ、の順で処理する。いずれかが失敗した場合はソース全体を部分採用せず、直前の有効スナップショットを維持する。初回ロードでは失敗ソースを除いた組み込み設定へフォールバックする。

診断にはソース種別、安定したファイル識別子、構造化エラーコード、JSON Pointerだけを含める。APIキー、Secret ID、Authorization値、URL全体、ヘッダー値、環境変数展開結果はログ・診断・UI通知に出力しない。

#### 実装・テスト方針

実装は、`ConfigSourceScope`を保持する読み込み結果、スコープポリシー検証、URL検証、ヘッダー正規化・検証、原子的なスナップショット公開を分離する。Provider Adapterは検証済み設定だけを受け取り、ワークスペース由来かどうかを推測して独自に認可しない。

最低限、平文・SecretStorage参照・環境変数参照の拒否、ユーザーProviderのURL・認証方式変更の拒否、未信頼状態での外部URL不採用とTrust変更時の再評価、大文字小文字違い・重複・前後空白・CR/LF・予約名・`x-forwarded-*`による上書き拒否、禁止項目を含むソース全体の無効化、リダイレクト先の再検証、診断やWebviewデータへの秘密値非出力をテストする。

完了条件は、悪意あるリポジトリの設定だけでは送信先、Secret参照先、認証情報、任意HTTPヘッダーを変更できず、ユーザーが明示的に登録した安全な設定のみによってProviderリクエストが構成されることである。

#### ローダーの完了条件

- 複数ソースから優先順位どおりのProvider／Model最終設定を決定できる。
- 同一Provider／Modelの部分更新、配列置換、未指定項目の継承が規則どおりに再現できる。
- 無効なソースを部分採用せず、直前の有効スナップショットを維持できる。
- ファイル変更・作成・削除後にデバウンスされた一回の再読み込みで新しいスナップショットを公開できる。
- ワークスペース設定から秘密情報・外部送信先・任意ヘッダーを変更できない。

## 5.2 JSON例

```json
{
  "providers": [
  {
    "name": "OpenRouter",
    "vendor": "customendpoint",
    "apiType": "chat-completions",
    "models": [
      {
        "id": "grok-4.5",
        "name": "Grok 4.5(1.6)",
        "vendor": "xAI",
        "url": "https://openrouter.ai/api/v1/chat/completions",
        "toolCalling": true,
        "vision": false,
        "maxInputTokens": 1000000,
        "maxOutputTokens": 131072
      },
      {
        "id": "glm-5.2",
        "name": "GLM 5.2(1.12)",
        "url": "https://openrouter.ai/api/v1/chat/completions",
        "toolCalling": true,
        "vision": false,
        "thinking": true,
        "supportsReasoningEffort": ["high", "xhigh"],
        "maxInputTokens": 1000000,
        "maxOutputTokens": 131072
      },
      {
        "id": "qwen3.7-plus",
        "name": "Qwen3.7 Plus(0.32)",
        "url": "https://openrouter.ai/api/v1/chat/completions",
        "toolCalling": true,
        "vision": true,
        "thinking": true,
        "maxInputTokens": 991800,
        "maxOutputTokens": 65500
      }
    ]
  }
  ]
}
```

### 5.2.1 モデル設定JSON Schemaの設計

モデル設定ファイルは、ルートに`providers`を持つドキュメントオブジェクトとし、Providerの中にModel配列を持つ構造にする。Provider固有の接続設定とModel固有の能力・Token上限を分離し、Modelの選択やAgent実行設定はModel IDを基準に解決する。Copilot固有の認証実装やサービスエンドポイントは流用しない。入力形式はドキュメントオブジェクトに限定する。

この構造上の互換性と、プロジェクト固有の意味を分離する。

- ルートは`type: "object"`、必須の`providers`はProvider配列、ProviderとModelは`type: "object"`で定義し、設定項目を`properties`に列挙する。`defaultModelId`は任意の既定モデル指定である。ルート配列は許可しない。
- Providerの識別子は`name`、Modelの識別子はModelオブジェクトの`id`を正本とする。IDはModel Catalogの解決とエラー表示に利用する。
- 各オブジェクトは`additionalProperties: false`を基本とし、未知のキーを黙って無視しない。将来の拡張はSchemaのversion更新と明示的な移行で行う。
- 配列は空を許可しない。Provider名とModel IDの重複、Model間のURL不整合はJSON Schema検証後の意味検証で確認する。
- Agent設定は提示例に存在しないため、Model内の任意の`agent`拡張として定義する。省略時は組み込みの安全な既定値を使用し、提示例を有効な最小設定として扱う。

#### Schemaのトップレベル契約

```text
ModelConfigDocument
├─ providers: Provider[]
└─ defaultModelId?: string
Provider
├─ name: string
├─ vendor: string
├─ apiType: chat-completions | responses | messages
└─ models: Model[]
Model
├─ id: string
├─ name: string
├─ vendor?: string
├─ url: URI
├─ toolCalling: boolean
├─ vision: boolean
├─ thinking?: boolean
├─ supportsReasoningEffort?: ReasoningEffort[]
├─ maxInputTokens: integer
├─ maxOutputTokens: integer
└─ agent?: AgentSettings
```

#### Provider

必須項目は`name`、`vendor`、`apiType`、`models`とする。APIキーやSecret参照の項目は定義しない。認証情報はProvider名からExtension HostのSecretStorageで解決する。

- `name`、`vendor`: 1〜128文字の非空文字列
- `apiType`: `chat-completions`、`responses`、`messages`のいずれか。`chat-completions`はOpenAI互換、`responses`はOpenAI Responses、`messages`はAnthropic Messagesを表す
- `models`: 1件以上のModel配列

Providerの設定で許可するプロトコルは、プロジェクトルールの初期対応範囲と一致させる。Gemini等の第2段階プロトコルは、Schema version 1の列挙値へ追加しない。API URLはProviderではなくModelごとの`url`に置く。

#### Model

必須項目は`id`、`name`、`url`、`toolCalling`、`vision`、`maxInputTokens`、`maxOutputTokens`とする。提示例にない`vendor`、`thinking`、`supportsReasoningEffort`、`agent`は任意とする。

- `id`、`name`、`vendor`: 1〜128文字の非空文字列。IDは`^[a-z0-9][a-z0-9._-]*$`に限定する
- `url`: URI。`https`を既定とし、`http`は`localhost`またはループバックアドレスに限定する
- `maxInputTokens`: 整数、`1,024`以上`10,000,000`以下
- `maxOutputTokens`: 整数、`1`以上`1,000,000`以下。`maxInputTokens`以下であることは意味検証で確認する
- `toolCalling`、`vision`、`thinking`: boolean
- `supportsReasoningEffort`: `none`、`low`、`medium`、`high`、`xhigh`からなる重複なし配列。`thinking`がtrueの場合だけ指定を許可する

Provider内のModel ID重複、URLの不正、`maxOutputTokens`と`maxInputTokens`の関係、`supportsReasoningEffort`と`thinking`の整合性は、JSON Schemaの型検証だけでは表現しにくいため、Schema検証後の意味検証エラーとして扱う。

#### Capabilities

Capabilitiesはモデル名から推測せず、設定値を正の情報源とする。提示例の能力項目をModel直下に置き、`toolCalling`と`vision`を必須、`thinking`と`supportsReasoningEffort`を任意とする。未指定時の暗黙の有効化は行わない。

```text
toolCalling        boolean
vision             boolean
thinking           boolean
supportsReasoningEffort  ReasoningEffort[]
```

Providerの`apiType`が`chat-completions`でも、Modelごとに`toolCalling`や`vision`を指定できる。能力不足時のUI・Tool・Agent挙動は後続のModel Catalog／Provider実装で利用する。

#### Agent設定

Agent設定はModel単位の任意オブジェクトとし、指定された場合は実行上限をSchemaの数値範囲で制限する。提示例のように省略した場合は、組み込みの安全な既定値を使用する。

- `promptProfile`: 1〜64文字のProfile ID
- `contextProfile`: `compact`、`balanced`、`extended`のいずれか
- `toolProfile`: `read-only`、`workspace`、`full`のいずれか。これは権限プロファイルではなく、利用可能Toolの集合を選ぶ設定とする
- `maxIterations`: 整数、`1`以上`100`以下
- `maxToolCalls`: 整数、`1`以上`500`以下
- `maxConsecutiveFailures`: 整数、`1`以上`10`以下

`toolProfile`で`full`を指定しても権限確認を省略できない。権限は`Permission Profile`とWorkspace Trustで別途判定し、`autonomous`は既定設定の列挙値に含めない。

#### スコープとCopilot系設定構造の適用範囲

設定ファイルの構造はCopilot系設定と同じく、グローバル設定とリポジトリ／ワークスペース設定を別ファイルに置き、同じキーを後のスコープで上書きできる形にする。ただし本プロジェクトの優先順位は既存ルールを優先し、次の順序を固定する。

```text
User Settings > ユーザー共通モデル設定 > ワークスペースモデル設定 > 組み込みデフォルト
```

JSON Schemaは設定ファイル全体の形を検証する。スコープごとの安全性は別のポリシーとして適用し、ワークスペース設定から外部URL、認証情報を変更できないようにする。互換性のため`apiKey`項目だけは受け付けるが、値を検証・解決・保存せず、正規化済み設定から直ちに除去する。Secret参照、Authorization値など他の認証項目は拒否する。

#### 検証エラーの契約

検証結果は例外文字列ではなく、すべての違反をパス付きの構造化エラーとして返す。エラーの順序はJSON Pointerのパス順で安定させ、複数エラーを一度に表示できるようにする。

```ts
interface ModelConfigValidationIssue {
  code:
    | "CONFIG_INVALID_JSON"
    | "CONFIG_SCHEMA_INVALID"
    | "CONFIG_UNKNOWN_PROPERTY"
    | "CONFIG_INVALID_REFERENCE"
    | "CONFIG_SEMANTIC_INVALID"
    | "CONFIG_WORKSPACE_POLICY_VIOLATION";
  path: string;
  keyword?: string;
  message: string;
  expected?: string;
  actual?: string;
}
```

メッセージには、例えば`/0/models/0/toolCalling`、期待値`boolean`、実際値`"yes"`のように、対象パス・期待値・実際値を含める。APIキーやAuthorization値などの秘密情報は`actual`、ログ、UI通知のいずれにも出力しない。ユーザー向け表示は安全な概要、開発者向け診断はSchema keywordと位置情報、ログは設定ファイルの種別とエラーコードだけに分離する。

検証段階は次の順序とする。

1. UTF-8 JSONとして解析する。解析不能なら`CONFIG_INVALID_JSON`を返す。
2. JSON Schema Draft 2020-12で型、必須項目、列挙値、数値範囲、形式、未知プロパティを検証する。
3. Provider／Modelの構造、ID重複、能力間の関係、Token上限を意味検証する。
4. ファイルのスコープに応じたSecret、URL、ヘッダー、Workspace Trustのポリシーを検証する。
5. 1〜4の違反があれば設定全体を無効とし、部分的なProviderやModelを実行経路へ渡さない。

#### 実装時の検証とテスト方針

Schemaは`resources/model-config.schema.json`として配置し、Draft 2020-12対応のAJVバリデーターで検証する。検証コードは`src/models/model-config-validator.ts`に置き、JSON構文、Schema、意味、スコープポリシーを順番に検証する。

実装時は、正常な最小設定、全項目を含む設定、未知プロパティ、必須項目欠落、列挙値外、各数値範囲の境界値、URI不正、Provider／Model参照不整合、重複Model ID、秘密情報混入、ワークスペースポリシー違反を`tests/unit/`で検証する。完了条件は、設定ファイルをSchema検証し、失敗時に上記のパス付きエラーを取得できることである。

### 5.3 APIキー

APIキー本体はJSON、VS Code設定、環境変数、ワークスペース、会話保存、ログ、Webview状態のいずれにも新規保存しない。旧設定に残る`apiKey`項目は互換性のため読み飛ばし、正規化済み設定から除去する。APIキーの新しい保存先は、Extension Hostが保持する`ExtensionContext.secrets`（`SecretStorage`）だけとする。

```ts
interface SecretStore {
  get(providerId: string): Promise<string | undefined>;
  set(providerId: string, value: string): Promise<void>;
  delete(providerId: string): Promise<void>;
}
```

`SecretStore`は`ExtensionContext.secrets`をラップするExtension Host専用サービスである。Provider Adapter、コマンドハンドラー、Catalogの認証状態判定はこのサービスを介し、Webview、Thread Store、設定ローダー、ログ出力層には依存を公開しない。VS Codeの`SecretStorage`は機密情報を暗号化して保存し、端末間同期を行わない。

#### 5.3.1 ProviderとSecretStorageキーの対応

Provider設定の`name`を正規化した値をProvider IDとして扱う。正規化は前後空白除去、英字の小文字化、制御文字・パス区切り文字の拒否を行い、別名への自動変換や曖昧なフォールバックは行わない。空白を含むProvider名は許可し、SecretStorageキーのProvider ID部分へURIエンコードして格納する。正規化後に衝突するProvider定義は設定エラーとする。

SecretStorageのキーは次の固定形式とする。

```text
byokAgent.secret.v1.apiKey.<encodeURIComponent(providerId)>
```

キー名は設定ファイルへ書き戻さず、Provider設定にSecret IDを指定させない。`set`は空文字または前後空白だけの値を拒否し、保存前に入力値の前後空白を除去するかどうかはコマンド契約で明示的に統一する。推奨動作は、意図しないキー変更を防ぐため入力値を加工せず、空白だけを拒否することである。

#### 5.3.2 保存・取得・削除の契約

- `set(providerId, value)`: Provider IDを検証し、非空のAPIキーを該当キーへ保存する。成功・失敗のログに値を含めない。
- `get(providerId)`: Provider IDを検証し、該当ProviderのAPIキーまたは`undefined`をHost内部へ返す。呼び出し元は返却値をリクエスト生成のスコープ内に限定する。
- `delete(providerId)`: Provider IDを検証し、該当キーを削除する。未登録状態でも冪等に成功として扱う。
- SecretStorageの読み書き失敗は認証設定エラーへ分類し、内部例外や値をそのままUI・ログへ渡さない。

Provider通信では、実行開始時にCatalogがProvider IDを解決し、Adapterへ渡す直前にHost内で`get`を呼び出す。APIキーを`ModelDefinition`、`ProviderSummary`、`ProviderRequest`の永続化可能な形式へ含めず、Provider Adapterの認証ヘッダー生成処理のローカルスコープだけで使用する。リトライやストリームイベントへAPIキーを引き継がない。

#### 5.3.3 APIキー入力コマンド

Extension Hostに次のコマンドを登録する。

| コマンド | 動作 | UIへ返す情報 |
|---|---|---|
| `byokAgent.setApiKey` | Providerを選択し、パスワード入力欄でAPIキーを受け取りSecretStorageへ保存 | Providerの表示名と保存成功状態のみ |
| `byokAgent.deleteApiKey` | Providerを選択し、対応するSecretStorageエントリを削除 | Providerの表示名と削除成功状態のみ |

Provider選択は検証済みCatalogのProvider表示名・IDだけを使う。入力欄はパスワード入力、フォーカス外クリックでの誤送信を抑制する設定、キャンセル処理を備える。APIキーをコマンド引数、コマンドURI、クリップボード経由、Webviewメッセージへ含めない。設定済み状態の一覧はbooleanだけをWebviewへ通知し、キーの存在そのものを診断ログへ記録しない。

#### 5.3.4 非出力・非保存規則

APIキーおよびAuthorizationヘッダーは、次のすべてから除外する。

- モデル設定JSON、ワークスペース設定、`globalStorage`のmeta/events/summary/artifacts
- OutputChannel、Debug Console、例外メッセージ、テレメトリ、診断、クラッシュ情報
- Webview初期状態、IPCメッセージ、UIイベント、ProviderEvent、Agent履歴
- URL、HTTPリクエストのダンプ、リトライ記録、テストのスナップショット

ネットワーククライアントや共通ロガーに認証ヘッダーを渡す場合は、値を出力可能な汎用オブジェクトへ格納しない。エラーをユーザーへ表示する場合は、Provider名、モデルID、構造化エラーコードなどの安全な概要だけに変換する。

#### 5.3.5 テスト設計と完了条件

実装時はFakeの`SecretStorage`を注入し、次を検証する。

1. Provider A/Bの保存・取得・削除が相互に干渉しない。
2. 空文字、未知Provider、正規化衝突、削除済みProviderを拒否または安全に未設定扱いにする。
3. `setApiKey`の入力値が設定JSON、ログ、Webviewメッセージ、会話イベントに現れない。
4. Providerリクエスト成功、認証失敗、通信失敗、リトライ、キャンセルの全経路でAPIキーが記録されない。
5. SecretStorage障害時にAPIキーを代替保存せず、再入力可能な安全なエラーを返す。
6. 実際の`ExtensionContext.secrets`以外の永続化先にAPIキーが書き込まれていない。

完了条件は、APIキーの保存・取得・削除と入力コマンドがProvider単位で動作し、APIキー本体が`ExtensionContext.secrets`にのみ保存されることである。本節では設計のみを定義し、実装は別タスクで行う。

### 5.4 モデル能力

モデル能力はModel Definitionに属する明示的な設定値であり、正の情報源は検証済みJSON設定とする。モデル名、Provider名、URL、APIレスポンスの名称規則から能力を推測して実行可否を決めてはならない。未指定・不正・不明な能力は利用不可として扱う。

```ts
type ReasoningEffort = "none" | "low" | "medium" | "high" | "xhigh";

interface ModelCapabilities {
  toolCalling: boolean;
  streaming: boolean;
  vision: boolean;
  reasoning: boolean;
  reasoningEfforts: readonly ("none" | "low" | "medium" | "high" | "xhigh")[];
}
```

`reasoning`は推論機能を利用できるか、`reasoningEfforts`は設定可能な強度の集合を表す。`reasoning=false`の場合、`reasoningEfforts`は空でなければならず、空でない設定は能力矛盾としてモデルを利用不可にする。`reasoning=true`でも強度が空の場合は、Provider既定の推論だけを許可し、UIに強度選択を表示しない。`none`は推論機能を無効化した明示値として扱う。

推論強度がUIまたは実行要求で明示されていない場合は、Copilotの公開実装に合わせて解決する。対応値が1件だけならその値を選択し、複数値に`high`が含まれる場合は`high`を既定値とする。複数値に`high`がなく、単一値でもない場合は値を指定せずProvider既定へ委ねる。要求値が対応集合に含まれない場合も、未指定と同じ規則で解決する。Copilot公開ソースでは設定Schemaの既定値を`high`（対応時のみ）とし、単一対応値はその値、その他は未指定としている。

既存設定の`thinking`は旧名称であり、Capabilitiesの正規化後に実行経路から参照しない。移行処理を導入する場合は、設定ファイルのバージョンと明示的な変換診断を追加し、`thinking`をモデル名推測の代替にしない。

### 5.4.1 設定値から実効能力への解決

設定値は能力の許可上限であり、実効能力は次の順でHost内に一度だけ解決する。

```text
configuredCapabilities
  ∩ providerAdapterCapabilities
  ∩ requestEnvironmentCapabilities
  = effectiveCapabilities
```

ただし、明示的な`false`は常に`false`を維持する。Provider Adapterが能力を宣言していない場合も`false`とし、モデル名やAPIエラーから`true`へ昇格させない。設定値とAdapterの能力が矛盾する場合は診断を残し、そのモデルを利用可能一覧から除外するか、該当能力だけを無効化するかをエラー分類に従って決定する。少なくともTool CallingとStreamingのように実行プロトコルへ影響する能力は、矛盾時にRun開始を拒否する。

解決済みスナップショットは次の境界を越えて共有する。

```ts
interface EffectiveCapabilities {
  readonly toolCalling: boolean;
  readonly streaming: boolean;
  readonly vision: boolean;
  readonly reasoning: boolean;
  readonly reasoningEfforts: readonly ReasoningEffort[];
  readonly revision: number;
}

interface CapabilityResolution {
  readonly configured: ModelCapabilities;
  readonly effective: EffectiveCapabilities;
  readonly disabledReasons: Readonly<Record<string, string>>;
}
```

`revision`はCatalogのスナップショットと同じ更新単位で採番する。Agent Run開始時に解決結果をコピーし、Run中は同じ値をProvider Request、Tool選定、Prompt構築、UIイベントへ使用する。

### 5.4.2 能力不足時の機能切り替え

| 能力 | `true`の場合 | `false`または不明の場合 |
|---|---|---|
| `toolCalling` | 利用可能かつ権限条件を満たすTool定義をリクエストへ含める | Tool定義を送らず、Tool Callを要求するAgent経路を開始しない |
| `streaming` | `ProviderEvent`を受信するたびにUIへ逐次反映する | 完了応答を待って一括表示し、ストリーム専用の中断・進捗表示を無効にする |
| `vision` | 画像入力をモデル入力へ変換し、添付UIを有効にする | 画像添付を無効にし、既存の画像入力は送信前に安全なエラーにする |
| `reasoning` | 設定可能な`reasoningEfforts`だけを選択肢として表示・送信する | Reasoning設定UIとReasoning専用プロンプトを無効にする |

能力不足を黙って別能力へ置き換えない。例えばTool Calling非対応モデルに対してテキスト内のTool記法を有効にするフォールバックはMVPでは提供しない。UIの無効状態は色だけに依存せず、理由を表示し、送信前にHostでも再検証する。Webviewから能力フラグを受け取っても正本とはせず、Hostの実効能力を再計算する。

### 5.4.3 設定Schemaと診断

将来のSchemaでは、Modelの`capabilities`オブジェクトに各能力を必須Booleanとして定義する。Reasoningの強度は`reasoningEfforts`配列で定義し、`reasoning=false`と非空配列の組み合わせを意味検証で拒否する。既存のフラットな`toolCalling`・`vision`から移行する場合は、読み込み時に新旧形式を混在させず、明示的なSchemaバージョンを用いる。

診断には少なくとも次を含める。

* `MODEL_CAPABILITY_MISSING`: 必須能力が未指定
* `MODEL_CAPABILITY_CONFLICT`: 能力とReasoning設定が矛盾
* `MODEL_CAPABILITY_ADAPTER_UNSUPPORTED`: 設定された能力をAdapterが提供できない
* `MODEL_CAPABILITY_REQUEST_UNSUPPORTED`: 現在のリクエスト形式または環境で能力を利用できない

診断はURL、ヘッダー、Secret、プロンプト本文を含めない。利用可能モデル一覧には実効能力を反映したモデルだけを含め、能力不足で無効化された機能は構造化診断とUIの安全な説明へ変換する。

VS CodeのLanguage Model Chat Provider APIも、一つのプロバイダーから複数モデルを公開し、コンテキスト長、出力長、画像入力、Tool Callingなどのメタデータを提供する構造を採用している。

ただし、本拡張の中核はVS CodeのLanguage Model APIに依存させない。管理者ポリシーやAPI変更の影響を避け、BYOK通信を直接制御するためである。

### 5.5 Model Catalog

#### 5.5.1 目的と責務境界

`ModelCatalog`は、`ModelConfigLoader`が公開した検証済み設定スナップショットを、実行可能なモデルの解決結果へ変換するExtension Host側のレジストリである。UIやThread Storeは論理的な`modelId`だけを保持し、Provider URL、SecretStorage、APIキー、任意ヘッダーを直接参照しない。

Model Catalogの責務は次のとおりとする。

* 論理モデルIDを一意に解決する
* Provider Adapterの識別子とProviderの接続設定を解決する
* APIへ送るモデル名としてModelの`id`をProviderリクエストへ渡す
* JSONで定義されたCapabilitiesとAgent設定を解決する
* 既定モデルを決定し、利用可能モデル一覧を決定的な順序で返す
* 無効設定、重複、参照不能、Secret未設定を利用可能一覧から除外する
* 設定変更時に新しい不変スナップショットを原子的に公開する

次の責務は持たない。

* Provider APIへの接続、モデル一覧のリモート取得、リトライ
* APIキーの入力、保存、Webviewへの返却
* Toolの実行、権限判定、Agent Loopの判断
* モデル名やProvider名からのCapabilitiesの推測

#### 5.5.2 識別子と解決モデル

設定上の`id`はUI・Thread Storeが扱う論理モデルIDであり、Provider APIのリクエストへ渡すモデル名も同じ`id`を使用する。論理IDとAPIモデル名を別フィールドへ分離しない。

Providerの識別子は設定の`name`とし、Adapter選択には`apiType`を使う。接続先URLと許可済みヘッダーはProvider設定として解決結果に含めるが、Webview向けの`ModelSummary`には含めない。SecretStorageのキーや認証状態はCatalogのモデル定義へ含めない。

```ts
interface ModelDefinition {
  readonly id: string;
  readonly label: string;
  readonly provider: {
    readonly id: string;
    readonly vendor: string;
    readonly apiType: "chat-completions" | "responses" | "messages";
    readonly url: string;
    readonly headers: Readonly<Record<string, string>>;
  };
  readonly capabilities: ModelCapabilities;
  readonly agent: ResolvedAgentSettings;
}

interface ModelCatalog {
  list(): readonly ModelDefinition[];
  listAvailable(): readonly ModelDefinition[];
  resolve(modelId: string): ModelDefinition | undefined;
  getDefault(): ModelDefinition | undefined;
  diagnostics(): readonly ModelCatalogDiagnostic[];
}
```

Catalogが外部へ返す`ModelDefinition`は認証情報を保持しない。Provider Adapterへ渡す直前にProviderサービスがSecretStorageから解決し、ログ・UI・保存データへ逆流させない。

#### 5.5.3 Catalog構築と利用可能性

設定スナップショットのProviderを入力順に走査し、Provider内の各Modelを正規化してCatalogを構築する。次の条件をすべて満たすものだけを利用可能とする。

1. ProviderとModelの必須項目、Model ID、URL、Capabilities、Agent設定が検証済みである。
2. 論理モデルIDがCatalog全体で一意である。
3. Providerの`apiType`に対応するAdapterがRegistryに存在する。
4. Provider IDがSecretStorageのキー規則に適合している。
5. Provider URLがネットワーク安全規則を満たし、解決結果のヘッダーがポリシー検証済みである。

一つのModelが不正でも、同一ソース全体を無効化するLoaderの規則を優先する。Catalog構築後に利用不能となった項目は診断対象として保持するが、実行可能一覧や既定モデルには含めない。表示順は`label`、同名時はProvider ID、最後に論理IDの昇順で固定する。

#### 5.5.4 既定モデルの管理

既定モデルは、ユーザーが明示選択していない新規Threadで使用するモデルである。解決優先順位は次のとおりとする。

1. User Settingsで指定された`defaultModelId`
2. ユーザー共通設定で指定された`defaultModelId`
3. 組み込みデフォルトの`defaultModelId`
4. 既定値指定がない場合の、利用可能一覧の先頭

ワークスペース設定は、ユーザーのSecretや送信先を間接的に切り替え得るため、既定モデルの変更権限を持たせない。ワークスペースで定義されたモデルを一覧へ表示することと、既定モデルに昇格させることを分離する。指定された既定モデルが存在しない、重複する、または利用不能な場合は自動的に別モデルへ黙って切り替えず、診断を出したうえで安全な未選択状態とする。ただし初回起動時に組み込みデフォルト以外がない場合の先頭フォールバックは許可する。

Threadに保存された`modelId`は既定モデルより優先する。保存値を解決できない場合はRunを開始せず、UIへモデル再選択を要求する。既定モデルはThreadの保存値を上書きしない。

#### 5.5.5 無効設定の診断とUI通知

設定不備は例外文字列ではなく、Catalogのrevisionに紐づく構造化診断として扱う。

```ts
interface ModelCatalogDiagnostic {
  readonly source: "builtin" | "user-file" | "workspace-file" | "user-settings";
  readonly path: string;
  readonly code:
    | "MODEL_DUPLICATE_ID"
    | "MODEL_PROVIDER_NOT_FOUND"
    | "MODEL_ADAPTER_UNSUPPORTED"
    | "MODEL_SECRET_UNAVAILABLE"
    | "MODEL_NOT_AVAILABLE"
    | "MODEL_DEFAULT_INVALID";
  readonly severity: "warning" | "error";
  readonly userMessage: string;
}
```

UIへは診断コード、表示可能なモデルラベルまたはProvider名、設定ソースの安全な種別、修正の案内だけを送る。Secret値、Secret ID、Authorization値、URL全体、ヘッダー値、設定JSON全文は送らない。`model-list`には利用可能モデルだけを含め、無効なモデルは`diagnostics`通知で別に伝える。無効化後も直前の有効Catalogを使い続け、初回ロードに有効なCatalogがない場合は選択・送信を無効化する。

#### 5.5.6 更新と一貫性

Loaderが新しい検証済みスナップショットを公開すると、Catalogは全エントリ、既定モデル、診断、revisionを一度に再構築する。構築途中の一覧をUIやAgentへ公開しない。実行開始時にはThread Storeから取得した`modelId`を同一revisionで解決し、Run中は解決済み`ModelDefinition`を固定する。設定変更によって次回Runの解決結果が変わっても、実行中のProvider設定を途中で差し替えない。

モデル選択の`modelId`はHostでCatalogに対して再検証する。Webviewから送られたIDをそのままProviderへ渡さず、Catalogで解決できない場合は保存せず、安全なエラーと最新一覧を返す。これにより、UIが古い一覧を保持していても実行経路が未知モデルへ到達しない。

#### 5.5.7 実装単位とテスト方針

実装時は次の単位へ分割する。

* `src/models/model-catalog.ts`: 正規化済み設定からの構築、解決、一覧、既定値、診断
* `src/models/model-config-loader.ts`: 設定ソースの読み込み、検証、マージ、スナップショット公開
* `src/models/model-types.ts`: `ModelDefinition`、Capabilities、Agent設定、診断の共有型
* Extension HostのUIルーター: Catalogの一覧・診断をWebview契約へ変換
* Agent Service: Threadの`modelId`をCatalogで解決し、Run要求へ渡す

単体テストでは、Model IDのProvider／Adapter解決、能力値の保持、重複ID、Provider不在、無効既定値、優先順位、決定的な一覧順を検証する。SecretStorageの保存・取得・削除と認証状態の検証はProviderサービスのテストで行う。統合テストでは、モデル選択成功後の次回`send-message`がHost側Thread StoreのIDから実際のProvider設定を取得すること、設定再読み込み中に中間状態が公開されないこと、無効設定がUIへ安全な診断として届くことを検証する。実APIは呼ばず、Provider RegistryとSecretStorageをFakeで差し替える。

完了条件は、モデル選択で得たModel IDから、Host内で一意な`ModelDefinition`を解決し、その`provider.apiType`、接続設定、Model ID、Capabilitiesを使って対象Provider Adapterへ渡せることである。

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

### 6.0 共通契約の詳細設計

Provider層は「内部の正規化済み入力をProvider APIへ変換し、Provider APIの応答を正規化済みイベントへ変換する」境界とする。Agent RuntimeはProviderのHTTP方式、認証ヘッダー、メッセージ配置、ストリームイベント名を知らず、`ProviderRequest`を渡して`ProviderEvent`だけを消費する。共通型にはAPIキー、Authorizationヘッダー、生環境変数、プロンプト全文のログ用複製、生レスポンスを含めない。

```ts
type ProviderRole = "system" | "user" | "assistant" | "tool";

interface ProviderMessage {
  readonly role: ProviderRole;
  readonly content: readonly ProviderContentPart[];
  readonly toolCallId?: string;
}

type ProviderContentPart =
  | { readonly type: "text"; readonly text: string }
  | { readonly type: "image"; readonly mediaType: string; readonly data: string };

interface ProviderToolDefinition {
  readonly name: string;
  readonly description?: string;
  readonly inputSchema: unknown;
}

interface ProviderRequest {
  readonly requestId: string;
  readonly modelId: string;
  readonly messages: readonly ProviderMessage[];
  readonly tools: readonly ProviderToolDefinition[];
  readonly options: {
    readonly temperature?: number;
    readonly maxOutputTokens?: number;
    readonly reasoningEffort?: "none" | "low" | "medium" | "high" | "xhigh";
  };
  readonly metadata?: Readonly<Record<string, string>>;
}
```

`ProviderRequest`の`modelId`はCatalogで検証済みの値とし、URLや認証情報は含めない。`metadata`は相関ID等の非秘密情報に限定し、Provider Adapterは許可されていない任意ヘッダーを生成してはならない。Tool定義の`inputSchema`は送信前にAgent側で選定済みだが、Provider側でもAPI形式への変換時に構造を壊さない。

イベントはストリーム順序を保った判別共用体とし、断片と確定値を明確に分ける。

```ts
type ProviderEvent =
  | { readonly type: "text-delta"; readonly text: string }
  | { readonly type: "reasoning-delta"; readonly text: string }
  | { readonly type: "tool-call-start"; readonly id: string; readonly name: string }
  | { readonly type: "tool-call-delta"; readonly id: string; readonly argumentsDelta: string }
  | {
      readonly type: "tool-call";
      readonly id: string;
      readonly name: string;
      readonly arguments: unknown;
    }
  | {
      readonly type: "usage";
      readonly inputTokens: number;
      readonly outputTokens: number;
      readonly cachedTokens?: number;
      readonly reasoningTokens?: number;
    }
  | {
      readonly type: "completed";
      readonly stopReason: "end-turn" | "tool-call" | "max-tokens" | "content-filter" | "unknown";
    }
  | { readonly type: "error"; readonly error: ProviderError }
  | { readonly type: "cancelled" };

type ProviderErrorCode =
  | "auth-failed"
  | "rate-limited"
  | "timeout"
  | "bad-request"
  | "context-exceeded"
  | "unsupported"
  | "network"
  | "cancelled"
  | "unknown";

interface ProviderError {
  readonly code: ProviderErrorCode;
  readonly message: string;
  readonly retryable: boolean;
  readonly retryAfterMs?: number;
  readonly status?: number;
  readonly requestId?: string;
}
```

AdapterはProvider固有のTool Call断片を内部バッファで`id`単位に結合し、JSONとして完全に解析できた場合だけ`tool-call`を発行する。`tool-call-start`や`tool-call-delta`をAgentが再結合する設計にはしない。ストリーム終了時に未完了の引数、ID欠落、名前欠落、同一IDの矛盾が残った場合は`completed`を発行せず、`bad-request`または`unknown`の非再試行エラーとして終了する。並列Tool Callは複数のIDを独立して保持し、受信順を壊さない。

`usage`はProviderが明示的に返した値だけを設定し、未提供の値を0や推定値で埋めない。`completed`は最終イベントとして扱う。ErrorまたはCancelledの後に別の完了イベントを発行してはならず、Agent側はErrorを`AgentErrorCode`へ変換する。Provider固有の生エラー本文はユーザー向けメッセージへ直接渡さず、安全な分類と短い説明に置き換える。

### 6.0.1 AbortSignalとAsyncIterableの契約

`stream(request, signal)`は呼び出し時点で`signal.aborted`を検査し、Abort済みなら通信を開始せず`cancelled`として終了する。実行中にAbortされた場合はHTTPリクエスト、Reader、Provider SDKの購読を中断し、Adapterが所有する一時バッファを破棄する。Abort後に到着したネットワークデータはイベントへ変換しない。Abortがユーザー操作に由来する場合、`cancelled`は失敗ではなくAgentの`cancelled`状態へ変換する。

`AsyncIterable`のconsumerが早期終了した場合も、Adapterは可能な範囲で内部リソースを解放する。各AdapterはレスポンスReader、タイマー、購読解除を`finally`で解放し、再利用されるAdapterインスタンスにRun固有のTool CallバッファやUsageを残さない。

### 6.0.2 責務境界とエラー変換

Provider Adapterが担当するのはメッセージ・Tool定義・Tool Resultの変換、イベント正規化、Call ID保持、Usage正規化、Providerエラー分類、キャンセル、リトライ可否の判定だけである。Tool実行、引数Schema検証、権限確認、履歴保存、コンテキスト圧縮、リトライの実行、停止条件の判断はAgentまたは各専門サービスが担当する。

`ProviderError`は`AgentError`へ変換する際に、`auth-failed`、`rate-limited`、`timeout`、`bad-request`、`context-exceeded`、`cancelled`を既存の`AgentErrorCode`へ対応付ける。`retryAfterMs`はProviderが返した安全な数値だけを保持し、バックオフの実行判断は上位層で行う。Errorイベント、ログ、永続化にはAPIキー、Authorization、URL全体、プロンプト、Tool Result、生レスポンスを含めない。

### 6.0.3 実装単位と契約テスト

実装時は、共通型（`ProviderRequest`、`ProviderEvent`、`ProviderError`）、Adapter境界、Providerエラー変換、Contract Test Fixtureを分離する。Adapterごとのテストは同じ入力と期待される共通イベント列を使用し、Provider固有のJSON形式をAgentテストへ持ち込まない。

最低限、Text delta、Reasoning delta、単一・並列Tool Call、断片結合、Usage、Stop Reason、認証・Rate Limit・Timeout・Bad Request、Retry-After、Abort前後、Abort後イベント抑止、不完全Tool Call、Error後の完了イベント抑止を検証する。実APIテストは明示的な環境変数がある場合だけ実行し、通常のContract Testは保存済みストリームFixtureとFake HTTP層で完結させる。

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

### 6.3 Provider Router

`ProviderRouter`は、Agentが指定した論理`modelId`をModel Catalogで解決し、解決結果の`provider.apiType`に対応する`ProviderAdapter`を選択して呼び出しへ渡すExtension Host側のComposition層である。AgentはProvider名、URL、認証方式、Adapter実装を参照しない。

#### 6.3.1 責務と依存

Routerは次を担当する。

* 呼び出し開始時のCatalog revisionで`modelId`を`ModelDefinition`へ解決する
* `apiType`をキーにProvider Adapter Registry／Factoryを選択する
* Provider設定の検証済みURL・ヘッダーとProvider Serviceの認証情報をAdapter初期化境界へ渡す
* Provider構成ごとのAdapter初期化を共有し、同一構成の呼び出しで再利用する
* `ProviderRequest`のmodel IDとCatalog解決結果を検証してAdapterへ委譲する
* 未解決Model、未登録Adapter、認証情報未設定、初期化失敗を構造化エラーへ分類する
* Catalog更新中もRun単位の解決結果とAdapterを固定し、次のRunへ新しい構成を適用する

RouterはHTTP通信、Provider固有のメッセージ変換、イベント正規化、Tool実行、引数検証、権限判定、履歴保存、コンテキスト圧縮、リトライ実行、停止条件を担当しない。これらはModel Catalog、Provider Adapter、Agentまたは各専門サービスの責務とする。

```text
Agent Service
  │ modelId + ProviderRequest
  ▼
ProviderRouter ── ModelCatalog.resolve(modelId)
  │              └─ ModelDefinition(provider.apiType, provider settings)
  ├─ ProviderAdapterRegistry.get(apiType)
  ├─ ProviderAdapterFactory.create(provider settings, credential)
  └─ adapter.stream(request, signal) → AsyncIterable<ProviderEvent>
```

Factoryは`apiType`、Provider ID、Vendor、URL、検証済みヘッダーを初期化入力として受け取る。APIキー等のSecret実値は初期化境界の内側に限定し、`ProviderRequest`、`ProviderEvent`、Catalog、ログ、永続化へ含めない。既存の`DefaultProviderService`が持つSecretStorageと実行中リクエストのライフサイクル境界を再利用する。

#### 6.3.2 解決とAdapter再利用

Routerの解決手順は次のとおりとする。

1. Catalogの同一revisionで`modelId`を解決する。利用可能でない場合は`model-not-found`／`MODEL_NOT_AVAILABLE`相当で終了する。
2. `provider.apiType`をRegistryで検索する。登録がない場合は`adapter-not-registered`／`MODEL_ADAPTER_UNSUPPORTED`相当の非再試行エラーとする。
3. Provider Serviceから認証情報を解決し、未設定・取得不能を`credential-unavailable`／`MODEL_SECRET_UNAVAILABLE`相当とする。
4. Provider ID、apiType、URL、検証済み設定revision、credential revisionを組み合わせた構成キーでキャッシュを検索する。Secret実値そのものはキーやログに含めない。
5. キャッシュがなければFactoryを一度だけ実行し、同一キーの並行初期化は同じPromiseを共有する。初期化失敗はキャッシュへ保存しない。
6. 解決済みModel IDと`ProviderRequest.modelId`を一致検証し、Adapterの`stream`または`countTokens`へ委譲する。

AdapterはRun固有のバッファ、Usage、Abort状態をインスタンスへ保存しない。Catalog更新後も実行中のAsyncIterableを差し替えず、旧構成のAdapterは新規Runから隔離する。破棄可能なAdapterは参照がなくなった後に一度だけ破棄し、Router破棄時は新規呼び出しを拒否して進行中Runを停止する。

#### 6.3.3 Routerエラーとテスト

Router固有の分類は少なくとも`model-not-found`、`adapter-not-registered`、`provider-initialization-failed`、`credential-unavailable`、`request-model-mismatch`を持つ。ユーザー向けメッセージは安全な固定文言または分類済み短文とし、ログにはProvider ID、apiType、Model ID、revision、分類だけを記録する。URL全体、ヘッダー値、Secret ID、APIキー、生レスポンスは記録しない。

Unit TestではModel ID解決、apiTypeごとのFactory選択、未登録Adapter、初期化失敗の再試行、同一Provider構成の初期化共有、credential revision・Catalog revision変更時の隔離、request model ID不一致を検証する。Provider Contract TestではRouter経由でも共通`ProviderEvent`契約が保たれることをFake Adapterで検証する。Extension Integration TestではModel選択後のHost側呼び出しが実際のAdapterへ到達し、実APIを使わずSecretStorageとAdapter RegistryをFakeへ差し替えられることを検証する。

完了条件は、利用可能なモデルIDから同一Catalog revisionのProvider設定とAdapterを解決し、共通`ProviderRequest`を対象Adapterへ渡して`ProviderEvent`をAgentへ返せることである。未登録Provider、未解決Model、認証情報未設定、初期化失敗は安全なエラーとして扱えることも含む。

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

### 14.2.1 スレッド表示コンポーネント詳細設計

`ThreadView`は、Extension Hostが保持する会話のうち、ユーザー発言とエージェント発言を時系列に表示するWebview専用の投影コンポーネントとする。会話の正本、Agent実行、Provider通信、保存、権限判定は担当しない。`ThreadView`へは検証済みの表示モデルだけを渡し、Webview APIや生の通信メッセージをコンポーネント内部から直接参照しない。

#### 責務と境界

担当する責務は次のとおりとする。

* 複数メッセージを入力順に表示する
* `user`と`assistant`を視覚・アクセシビリティ上区別する
* Markdownを安全な表示ノードへ変換し、コードブロックを専用レイアウトで表示する
* ストリーミング中のテキスト差分を同一メッセージへ反映する
* 新しい内容が増えたときのスクロール位置を、ユーザーの閲覧を妨げない範囲で更新する
* 空状態、ストリーミング状態、完了状態、失敗状態を表示する

次の責務は持たせない。

* Extension Hostへの直接`postMessage`
* Providerイベントの解釈、Agent状態機械、会話永続化
* Markdown内HTMLの実行、任意URIの実行、外部スクリプトの読み込み
* Tool Activity、ChangeSet、Approval、Composerの操作本体（それぞれ別コンポーネントの責務）

#### 表示モデル

通信イベントをそのままJSXへ渡さず、UI専用の正規化モデルへ変換する。`id`はストリーム中も変化しないメッセージ単位の識別子であり、時刻だけで並び替えない。配列順はHostから受け取ったスナップショットおよびイベントの順序を正本とする。

```ts
type ThreadMessageRole = "user" | "assistant";
type ThreadMessagePhase = "streaming" | "complete" | "failed";

interface ThreadMessageViewModel {
  id: string;
  role: ThreadMessageRole;
  text: string;
  phase: ThreadMessagePhase;
  createdAt: number;
  errorMessage?: string;
}

interface ThreadViewProps {
  messages: readonly ThreadMessageViewModel[];
  isRestoring?: boolean;
}
```

ユーザー発言は受信した本文を一つの`complete`メッセージとして追加する。エージェント発言は開始時に空文字または初回差分で一つだけ作成し、後続差分を同じ`id`へ連結する。`failed`へ遷移したメッセージは本文を保持したまま、エラー表示を付加する。表示モデルの文字列上限は通信スキーマの上限を超えないよう、Host側とWebview側の両方で検査する。

#### ストリーミング更新とReducer

Extension HostからWebviewへ渡すストリーミングイベントは、安定した`messageId`、単調増加する`sequence`、本文差分`delta`、終端フラグ`done`を持つ正規化イベントとする。スナップショットには差分適用済みの全文を含め、再接続時に同じ表示結果を再構成できるようにする。

```ts
type ThreadViewEvent =
  | {
      kind: "message-added";
      message: ThreadMessageViewModel;
    }
  | {
      kind: "assistant-text-delta";
      messageId: string;
      delta: string;
      done: boolean;
      sequence: number;
    }
  | {
      kind: "message-failed";
      messageId: string;
      errorMessage: string;
      sequence: number;
    };
```

Reducerの規則は次のとおりとする。

1. スナップショット受信時は表示モデルを置き換え、保持中のストリーム差分を再適用しない。
2. `message-added`は未知の`id`だけを追加し、同じ`id`の再送は無視する。
3. `assistant-text-delta`は存在する`assistant`メッセージにだけ適用し、`delta`を既存本文の末尾へ一度だけ追加する。
4. `done: true`で`phase`を`complete`へ変更する。完了後の差分やroleが異なる差分は適用せず、スナップショット再取得を要求する。
5. `message-failed`は対象本文を維持して`failed`へ変更し、ユーザー向けの安全なエラー文だけを表示する。
6. 欠番、古い`sequence`、未知のメッセージIDはReducerで黙って補完せず、通信クライアントへ正本再同期を通知する。

これにより、1ターン中のエージェント本文だけが更新され、過去のメッセージのDOMキーやスクロール位置が不必要に変化しない。差分を受信するたびに全文を再構成するため、UIは常に現在の本文をMarkdownとして描画できる。MVPでは仮想スクロールを導入せず、メッセージ数・本文長の上限は通信およびStorageの上限に従う。

#### Markdownとコードブロック

Markdownは文字列を直接`innerHTML`へ渡さず、Markdown ASTまたは同等の安全な中間表現からPreactノードへ変換する。次の設定を必須とする。

* raw HTMLノードを無効化または破棄する
* `javascript:`、`data:`、`command:`などの実行可能なURIをリンクにしない
* URLは表示テキストとリンク先を検証し、許可しないURIはプレーンテキストで表示する
* ユーザー入力、モデル出力、Tool ResultをHTML属性、CSS、スクリプトとして解釈しない
* Markdownの解析失敗時は本文をエスケープ済みプレーンテキストとして表示する

コードフェンスは`<pre><code>`相当の専用ノードとして描画し、言語指定は表示用のクラス名へ検査済みの値だけを渡す。未指定または未知の言語はプレーンコードとして表示し、初期実装では動的な外部シンタックスハイライトを読み込まない。コード本文は空白と改行を保持し、横方向のオーバーフローを許容する。コピー操作は別Issueとし、本タスクの完了条件に含めない。

#### レイアウト、スクロール、アクセシビリティ

メッセージ一覧は`role="log"`相当の読み上げ領域とし、各メッセージを`article`として、roleと連番または時刻をアクセシブルなラベルに含める。ストリーミング中のエージェントメッセージだけに`aria-busy="true"`を設定し、全文の再読み上げを避ける。色だけでuser/assistantや状態を区別しない。

末尾から一定距離以内を閲覧している場合だけ新しい差分で末尾へ追従する。ユーザーが上へスクロールしている場合は位置を保持し、新着状態を表示する。初回スナップショットの復元中はローディング表示を出し、空のスレッドはComposerとは独立した空状態を表示する。テーマカラーはVS Code標準トークンを使い、固定色や独自画像に依存しない。

#### 実装単位

実装時は次の単位へ分割する。

* `src/ui/webview/components/ThreadView.tsx`: メッセージ一覧、空状態、ストリーミング表示、スクロール境界
* `src/ui/webview/thread-view-model.ts`: 表示モデル、イベント型、Reducer、スナップショット再同期判断
* `src/ui/webview/markdown/MarkdownRenderer.tsx`: 安全なMarkdownノードとコードブロックの描画
* `src/ui/styles.css`: VS Codeテーマトークンに基づくメッセージ・コードブロック・状態表示（既存Webviewスタイルへ統合）

`ThreadView`は`thread-view-model.ts`のReducer結果だけを受け取り、通信クライアント・Extension Host・Storageをimportしない。既存のWebviewプロトコルを拡張する場合も、差分イベントの検証は通信境界で完了させ、コンポーネントへ`unknown`を渡さない。

#### 完了条件

1. ユーザー発言とエージェント発言を含む3件以上のメッセージを、受信順のまま表示できる。
2. 見出し、段落、箇条書き、インラインコード、コードフェンスを安全に表示できる。
3. エージェント本文の複数の差分を同じメッセージへ順序どおりに反映し、終端後に`complete`表示へ遷移できる。
4. スナップショット再同期後も、ストリーミング中・完了済みを含む表示結果が正本と一致する。
5. raw HTML、危険なURI、過大な本文、未知のイベントを実行せず、安全なフォールバックまたは再同期へ移行できる。
6. Light、Dark、High Contrastテーマで本文とコードブロックの視認性を維持できる。
7. ユニットテストでReducerとMarkdown変換を、コンポーネントテストで複数メッセージ・ストリーミング・空状態を検証できる。

### 14.2.2 メッセージ入力Composer詳細設計

`Composer`は、ユーザーのテキスト入力を検証済みのUIメッセージへ変換し、Extension Hostへ送信するWebview専用コンポーネントとする。下書きの一時保存、入力欄の操作、送信・停止操作、操作可能状態の表示だけを担当し、会話の正本、Agentの開始・停止判断、Provider通信、権限判定、添付コンテキストの収集は担当しない。

#### 責務と境界

Composerが担当する責務は次のとおりとする。

* 複数行のプレーンテキストを入力できる`textarea`を提供する
* 下書きをWebview状態へ保存し、Webview再生成時に復元する
* 入力内容を送信可能性と文字数上限に照らして検査する
* Enterおよび修飾キーの操作を決定的に処理する
* 送信中、Agent実行中、停止要求中、入力エラーを表示する
* 既存の検証済み`send-message`および`cancel-run`通信を呼び出す

Composerが担当しない責務は次のとおりとする。

* WebviewからExtension Hostへ直接`postMessage`すること（`WebviewProtocolClient`へ集約する）
* `threadId`、`runId`、現在の実行状態を推測すること
* ユーザー入力をMarkdown、HTML、CSS、コマンド、プロンプトとして解釈すること
* Agent Runtime、Provider、Storage、Permission Profileの実装
* ファイル添付、選択範囲、診断、画像、`/`コマンド、`@`検索の実装（後続Issue）

#### 状態モデル

表示状態とAgent実行状態を混在させず、Composerのローカル状態とHost由来の状態を分けて保持する。

```ts
type ComposerPhase =
  | "idle"
  | "inputting"
  | "submitting"
  | "running"
  | "stopping"
  | "error";

interface ComposerState {
  phase: ComposerPhase;
  draft: string;
  activeRunId?: string;
  errorMessage?: string;
  pendingMessageId?: string;
}
```

各状態の意味と操作可否は次のとおりとする。

| 状態 | 意味 | 入力欄 | 送信 | 停止 |
|---|---|---:|---:|---:|
| `idle` | 下書きが空で、実行もない | 可 | 不可 | 非表示 |
| `inputting` | 下書きが空白だけではなく、送信可能 | 可 | 可 | 非表示 |
| `submitting` | `send-message`を送信済みでHostの状態通知待ち | 不可 | 不可 | 非表示 |
| `running` | Hostが実行中であることを通知済み | 不可 | 不可 | 可 |
| `stopping` | `cancel-run`を送信済みで停止完了待ち | 不可 | 不可 | 不可 |
| `error` | 直前の操作が失敗し、再試行可能 | 可 | 入力が有効なら可 | 実行中なら可 |

`inputting`は入力イベントを受けたことだけでなく、正規化後の下書きに非空白文字があることを条件とする。フォーカスの有無やキー入力速度を状態の根拠にしない。`submitting`から`running`、`completed`、`cancelled`、`failed`への遷移は`run-state`または相関した`error`を検証して決定する。Hostから実行状態を受け取る前にUIが`running`を推測してはならない。

MVPでは1つのComposerから同時に複数の送信を行わない。実行中に別メッセージをキューへ積まず、Agentが完了またはキャンセルされるまで入力と送信を無効化する。入力欄を再度有効化した際、送信済み本文を下書きとして復元しない。

#### 入力値の検査と下書き

入力値は次の順序で扱う。

1. `textarea`の値を取得し、CRLFおよびCRをLFへ正規化する。
2. `MAX_COMPOSER_DRAFT_LENGTH`（現在の設計値は100,000文字）を超える値を入力状態へ採用しない。UIでは上限到達を表示し、Host側でも同じ上限を再検証する。
3. 送信可否は`draft.trim().length > 0`で判定する。ただし送信する本文から前後の空白や改行を自動削除せず、ユーザーが入力した改行と本文を保持する。
4. 下書き保存は検証済みの`{ version: 1, composerDraft }`だけを`setState`へ渡す。APIキー、Thread、Run、送信履歴、ファイル内容、エラー詳細は保存しない。
5. 送信要求の作成に成功した時点で下書きを空にする。送信失敗時は、ユーザーが新しい入力を開始していない場合に限り、保留していた本文を復元できるようにする。

下書きの復元は`acquireVsCodeApi().getState()`を初期化時に一度だけ呼び出し、既存の`parseAgentWebviewState`で検証する。`composerDraft`以外の値、未知のバージョン、上限超過値は破棄する。送信済み本文や`activeRunId`をWebview状態へ保存しないため、Webview再生成時はHostから取得したスレッド状態を正本とする。

#### Enterと修飾キー

`keydown`でEnterを処理する。ただし`event.isComposing === true`またはIMEの変換中はComposerが送信を抑止し、ブラウザとIMEの確定処理へ委譲する。

| 操作 | 動作 |
|---|---|
| Enter | 下書きが送信可能なら送信する。送信不可なら何もしない |
| Shift+Enter | 改行を挿入する |
| Ctrl+Enter（Windows/Linux） | 送信する |
| Cmd+Enter（macOS） | 送信する |
| Alt+Enter | 改行を挿入する |
| Ctrl/Cmd+Shift+Enter、その他の未定義組み合わせ | 送信せず、textareaの通常の改行動作へ委譲する |

Shiftを含む組み合わせは改行を優先し、Ctrl/Cmd単独の送信ショートカットより先に判定する。Enter以外のキー、IME確定キー、貼り付け、ドラッグ＆ドロップは入力値の検査と下書き保存だけを行う。フォーム送信の既定動作は抑止し、送信処理が二重に実行されないようにする。

#### 送信・停止フロー

送信は次のフローとする。

```text
入力イベント
  └─ 正規化・上限検査・下書き保存
       └─ Enter / 送信ボタン
            └─ 空白判定・phase判定
                           └─ 検証済み send-message(threadId, text)
                      └─ phase=submitting
                           ├─ thread-event(user-message, correlationId) → idle
                           ├─ run-state(requesting-model以降) → running
                           ├─ run-state(completed) → idle
                           ├─ run-state(cancelled) → idle
                           └─ error → error（再試行可能）
```

`send-message`のEnvelopeが持つ`messageId`を要求の重複排除キーとして扱い、Composer側で同じ送信操作を再発行しない。`threadId`は現在のHostスナップショットまたは画面状態から与えられた値を使い、Composerが固定値や履歴から推測しない。送信ボタンとEnterは同じ`submit`コマンドへ接続し、片方だけに特別な処理を持たせない。

Agent Runtimeがまだ接続されていないMVPでは、HostのComposerルーティングが受け付けたユーザー本文を`thread-event`の`user-message`として返し、Envelopeの`correlationId`へ元の`send-message.messageId`を設定する。Webviewはこの相関付きイベントを送信受付として扱い、ThreadViewへ同じイベントを渡してからComposerを`idle`へ戻す。Agent Runtime接続後も、受付イベントの相関契約は維持し、実行状態は別の`run-state`で通知する。

Agent実行中は、Hostが通知した有効な`activeRunId`を表示状態へ保持する。停止ボタンは`activeRunId`がある`running`状態でだけ有効とし、押下時に`cancel-run`を一度だけ送信して`stopping`へ遷移する。停止はベストエフォートであり、UIの非表示・再生成だけではキャンセルしない。Hostから`cancelled`または終了エラーを受け取るまで停止中表示を維持し、二重クリックや古い`runId`の停止要求は送信しない。

Host側では、受信メッセージをZodスキーマで検証し、現在のThread、client session、Agent実行、権限状態を再確認してから処理する。ComposerはHostからの受付成否を推測せず、相関ID付きの状態通知またはエラーだけで状態を更新する。ユーザー本文をログ、HTML属性、URL、例外文へ反射しない。

#### UIとアクセシビリティ

* `textarea`には可視ラベルまたは`aria-label`、文字数上限とキー操作を説明する`aria-describedby`を付ける。
* 送信・停止ボタンはテキストまたはVS Code標準Codiconを使い、アイコンだけの場合も固有の`aria-label`を付ける。独自画像や製品固有の外観は使用しない。
* `inputting`、`submitting`、`running`、`stopping`、`error`の状態は色だけで表現せず、ラベルと`aria-live="polite"`で伝える。
* `submitting`、`running`、`stopping`では、入力欄と送信ボタンの無効状態を視覚・アクセシビリティAPIの両方へ反映する。
* エラー表示はユーザー向けの固定文言または安全に分類した短い文言とし、Providerの生レスポンス、秘密情報、内部スタックを表示しない。
* スタイルはVS Code標準テーマトークンを使用し、Light、Dark、High Contrastでフォーカス表示と無効状態のコントラストを維持する。

#### 実装単位

実装時は次の単位へ分割する。

* `src/ui/webview/components/Composer.tsx`: textarea、送信・停止ボタン、状態ラベル、キー操作、アクセシビリティ属性
* `src/ui/webview/composer-state.ts`: `ComposerState`、状態遷移、入力正規化、送信可否、Enter判定の純粋ロジック
* `src/ui/main.tsx`: Composerと既存`WebviewProtocolClient`、Thread状態、Webview状態Storeの接続
* `src/ui/styles.css`: Composerのレイアウト、フォーカス、上限表示、状態表示、テーマ対応
* `src/ui/extension-webview-protocol.ts`およびUIサービス境界: 検証済み`send-message`／`cancel-run`のHost側ルーティング（Agent実行そのものは別Issue）

既存の`webview-protocol.ts`にある`send-message`、`cancel-run`、`run-state`、`error`の型とZod検証を再利用する。Composerコンポーネントへ`Webview API`や`unknown`を渡さず、型付けしたコールバックまたはComposer用Controllerを通して通信する。`ThreadView`、Provider、Agent Runtime、StorageへComposerから直接依存しない。

#### テストと完了条件

実装時は次を検証する。

* 入力値のCRLF正規化、空白のみ、上限境界、上限超過、改行保持をユニットテストする。
* Enter、Shift+Enter、Ctrl/Cmd+Enter、Alt+Enter、IME変換中、未定義の修飾キー組み合わせをユニットテストする。
* `idle`→`inputting`→`submitting`→`running`→`idle`の正常系、停止、エラー、再試行、重複送信抑止をReducerまたは状態ロジックで検証する。
* 下書きが初期化時に一度だけ復元され、入力ごとに検証済みの最小状態だけが保存されることを検証する。
* UIテストで送信ボタン、Enter送信、停止ボタン、状態ラベル、無効状態、エラー表示を検証する。
* 通信テストで`send-message`と`cancel-run`のEnvelope、相関ID、Host側の受信検証、重複排除を検証する。
* `pnpm typecheck`、`pnpm lint`、`pnpm format:check`、`pnpm test`、`pnpm check:webview-security`を実行する。実APIへ接続するテストは明示的な環境変数がある場合だけ許可する。

完了条件は、空白だけの入力を送信せず、複数行本文を保持したユーザーメッセージをComposerから検証済み`send-message`としてHostへ一度だけ送信できること、実行中に停止要求を検証済み`cancel-run`として一度だけ送信できること、入力中・送信中・実行中・停止中・失敗時の状態がユーザーと支援技術へ明確に伝わることとする。Composer以外のThreadView、Provider、AgentLoop、Storage、添付機能の完了を本Issueの条件に含めない。

### 14.2.3 モデル選択UI詳細設計

モデル選択UIは、現在表示しているスレッドに紐づくモデルを確認・変更するWebview専用のUIとする。モデル一覧の正本、モデル設定の解決、利用可能性の判定、スレッドメタデータの更新、次回リクエストへの適用はExtension Hostが担当する。WebviewはHostから受け取った検証済みの要約を表示し、選択要求を送るだけにする。

#### 目的と責務境界

モデル選択UIの責務は次のとおりとする。

* Hostから受け取った利用可能なモデル一覧を表示する
* 現在のスレッドの`selectedModelId`を表示する
* モデルの表示名とProvider名を区別して表示する
* 選択中、成功、失敗、利用可能なモデルがない状態を表示する
* 選択要求を現在の`threadId`と既知のスレッドrevision付きでHostへ送る
* Hostからの確定通知を受けて表示を更新する

次の責務はWebviewへ持たせない。

* JSONモデル設定、Provider URL、APIキー、SecretStorage、Provider接続の読み込み
* モデル名からの能力推測や、モデルが利用可能かどうかの独自判定
* `threadId`、選択済みモデル、スレッドrevisionの履歴からの推測
* 選択モデルを`send-message`へ直接埋め込むこと
* Webview状態、`localStorage`、URL、Cookieへのモデル設定の永続化

#### モデル一覧の情報源と表示契約

Extension HostはModel CatalogとModel Configuration Loaderで設定優先順位を解決し、構成が有効で、ProviderとSecretStorageの利用条件を満たし、Agent実行に利用できるモデルだけを`models`へ含める。APIキー本体、認証ヘッダー、外部URLの詳細、モデル能力の不要な内部設定はWebviewへ渡さない。モデル要約は次の最小情報とする。

```ts
interface ModelSummary {
  id: string;
  label: string;
  provider: string;
}

interface ModelListState {
  threadId: string;
  threadRevision: number;
  models: readonly ModelSummary[];
  selectedModelId?: string;
}
```

`models`の順序はHost側で決定的に並べる。既定では表示名、同名の場合はモデルIDの昇順とし、Webview側で並べ替えない。`selectedModelId`は現在のスレッドメタデータに保存されたモデルが利用可能な場合だけ設定し、常に`models`内のIDと一致させる。利用可能なモデルがない、または保存済みモデルが解決不能な場合は`selectedModelId`を省略し、UIは安全な空状態を表示して送信操作を許可しない。この状態でWebviewが任意のモデルIDを補ってはならない。

モデル要約を受け取ったUIは、モデルIDを表示用ラベルとして扱わず、必ず`label`を表示する。ただし同じ`label`が複数ある場合は、識別可能性のためProvider名を併記する。Provider名は設定内の識別子であり、認証情報や接続先を意味しない。

#### UI状態と表示

モデル選択の状態はComposerの状態へ混在させず、`ModelSelectorState`として管理する。

```ts
type ModelSelectorPhase = "loading" | "ready" | "selecting" | "error";

interface ModelSelectorState {
  phase: ModelSelectorPhase;
  threadId?: string;
  threadRevision?: number;
  models: readonly ModelSummary[];
  selectedModelId?: string;
  pendingModelId?: string;
  errorMessage?: string;
}
```

ヘッダーでは現在のモデル名を常時表示し、選択UIはネイティブ`select`または同等のキーボード操作可能な単一選択UIとする。選択肢にはモデル名を表示し、必要な場合だけProvider名を補助情報として表示する。`loading`ではプレースホルダー、`ready`では現在のモデルと選択肢、`selecting`では選択中のモデルと操作不能状態、`error`では以前に確定していたモデルを維持した上で安全なエラー文を表示する。選択確定前にUIだけを新しいモデルへ切り替えない。

利用可能なモデルが空の場合は「利用可能なモデルがありません」と表示し、選択UIを無効化する。現在のモデルが未選択の場合は「モデル未選択」と表示する。固定色や独自画像を使わず、VS Code標準テーマトークンとCodiconを必要最小限使用する。現在のモデル、選択中、エラー、無効状態は色だけで区別せず、可視ラベルとアクセシブルな状態通知を併用する。

#### スレッド単位の変更と適用タイミング

モデル変更はスレッドメタデータの`modelId`を更新する操作であり、Webview全体の既定値やユーザー設定を書き換えない。Hostは選択要求を受信した時点で、次を順番に検証する。

1. 通信Envelope、`threadId`、`modelId`、`expectedThreadRevision`を検証する。
2. 現在のWebviewセッションと、操作対象スレッドが一致することを確認する。
3. Model Catalog上に同じモデルIDが一つだけ存在し、利用可能なモデルであることを確認する。
4. `expectedThreadRevision`が現在のスレッドrevisionと一致することを確認する。不一致なら保存せず、最新のモデル一覧を再送する。
5. 実行中のRunがないことを確認し、Thread Storeの`meta.json`へ`modelId`を原子的に保存する。
6. 保存成功後にrevisionを進め、更新後の`model-list`を要求の`messageId`に対応する`correlationId`付きでWebviewへ送る。

選択要求が成功するまで、現在のモデル表示は変更しない。失敗時もスレッドの保存値を変更せず、Hostが返す安全なエラーを表示して最新状態を再取得する。実行中の変更はUIで無効化し、Host側でも拒否する。これにより、実行中のRunが使用するモデルと、次回リクエストに使用するモデルが混在しない。

Composerの`send-message`にはモデルIDを含めない。Hostは送信要求の`threadId`から最新の`meta.json.modelId`を取得し、その時点で解決したModel Definitionを`AgentRunRequest`へ渡す。したがって、選択成功通知を受けた後の次の`send-message`だけでなく、UIが古い表示を持っていても、実際のリクエストはHostのスレッド正本に従う。保存済みモデルが解決できない場合はRunを開始せず、モデル選択を促す安全なエラーを返す。

#### 通信契約

既存のバージョン付きEnvelopeとZod検証を再利用し、モデル選択の要求と応答を次の形へ揃える。

```ts
type SelectModelPayload = {
  threadId: string;
  modelId: string;
  expectedThreadRevision: number;
};

type ModelListPayload = {
  threadId: string;
  threadRevision: number;
  models: readonly ModelSummary[];
  selectedModelId?: string;
};
```

`select-model`はUIからHostへの要求、`model-list`はHostからUIへの一覧・確定状態の通知とする。`model-list`は`ui-ready`後、スレッドスナップショットの復元後、スレッド切り替え後、モデル変更の成功または競合後に送信する。UIは現在表示中の`threadId`と異なる`model-list`を適用せず、スレッド切り替え処理へ委譲する。

`model-list`は現在のモデルの確定通知を兼ねるため、モデル変更専用の楽観的なUIイベントは追加しない。要求の`messageId`は`correlationId`として使用し、重複した`select-model`は既存のHostセッションの重複排除規則で一度だけ処理する。`select-model`の検証失敗、モデル不在、revision競合、実行中拒否は、既存の`error`またはプロトコルエラーの安全な分類で返し、Providerの生レスポンスや設定内容を表示しない。

#### 永続化とセキュリティ

選択結果は`globalStorage/threads/<thread-id>/meta.json`の`modelId`へ保存する。保存対象はモデルID、更新時刻、revisionなどスレッドメタデータに必要な値だけとし、APIキー、Authorizationヘッダー、Provider応答、プロンプト、ファイル内容を保存しない。保存は現在値との競合検査後に原子的に行い、失敗時に部分的な`meta.json`を残さない。

Webviewへ渡すのは`ModelSummary`とスレッド識別・revisionだけである。モデル選択UIはSecretStorage、ファイルシステム、Provider Adapter、Storage実装へ直接依存しない。受信値は通信境界で検証してから状態Reducerへ渡し、モデルラベルやエラー文をHTML、URL、ログ、スクリプトとして解釈しない。

#### 実装単位と検証方針

実装時は次の単位へ分割する。

* `src/ui/webview/components/ModelSelector.tsx`: モデル名、Provider補助情報、選択UI、状態表示、アクセシビリティ
* `src/ui/webview/model-selector-state.ts`: 一覧適用、選択要求、確定通知、競合・エラーの純粋な状態遷移
* `src/ui/main.tsx`: 現在のスレッド状態とModel Selector、`WebviewProtocolClient`の接続
* `src/ui/styles.css`: ヘッダー内のレイアウト、フォーカス、無効状態、Light/Dark/High Contrast対応
* `src/ui/webview-protocol.ts`: `select-model`と`model-list`のスレッドID・revisionを含むスキーマ更新
* Extension HostのUIルーティング、Model Catalog、Thread Store境界: 検証、利用可能性判定、原子的な保存、確定通知

テストでは、モデル一覧の決定的表示、現在モデルの反映、空一覧、選択中の二重操作抑止、未知モデルの拒否、スレッドID不一致、revision競合、実行中拒否、保存成功後の確定通知、次の`send-message`でThread Storeのモデルが使われることを検証する。通信テストでは、Envelope、payload上限、相関ID、重複排除、古い`model-list`の無視を検証する。実APIを呼ぶテストは追加せず、明示的な環境変数がある場合だけ既存の実APIテスト方針に従う。

完了条件は、利用可能なモデル一覧と現在のモデルを表示でき、現在のスレッドに対する選択を安全に保存でき、選択確定後の次回`send-message`がHostのスレッドメタデータから選択モデルを解決して`AgentService.prepareRunRequest`へ渡すこととする。Provider呼び出しと実行ループへの接続はAgent Runtimeの責務とする。

### 14.2.4 権限プロファイル選択UI詳細設計

権限プロファイル選択UIは、現在のスレッドでAgentが利用できる権限プロファイルを確認・変更するWebview専用のUIとする。権限判定、Workspace Trustの評価、スレッドメタデータの更新、Agent実行への反映はExtension Hostが担当する。WebviewはHostから受け取った権限要約を表示し、検証済みの選択要求を送るだけにする。

#### 目的と責務境界

UIの選択肢は`read-only`、`confirm-writes`、`workspace-write`の3つに限定する。`autonomous`は内部の`PermissionProfile`型に残るが、このUIの一覧、既定値、説明、ショートカットには含めず、明示的な別設定がない限り利用できない。

Webviewが担当するのは次の表示・操作だけとする。

* 現在の要求プロファイル、実効プロファイル、Workspace Trust、適用中の制限を常時表示する
* 3つの選択肢の名称、許可される代表的な操作、常時確認対象を表示する
* 書き込み能力を広げる切り替え前に説明と確認を表示する
* 確認済みの選択要求を現在のスレッドとrevision付きでHostへ送る
* Hostの確定通知、競合、拒否、エラーを表示する

次の責務はWebviewへ持たせない。

* Permission Policy、Tool Category、Workspace Trust、Thread Storeの独自判定
* APIキー、認証ヘッダー、Provider URL、ファイルシステム、環境変数へのアクセス
* UI状態や`localStorage`への権限の永続化
* `send-message`へプロファイルを埋め込むこと、またはUI表示だけでAgent実行を許可すること
* ワークスペース内の指示ファイルやユーザー入力を理由に安全制約を緩和すること

#### 状態モデルと表示契約

HostからUIへ渡す権限情報は、表示に必要な最小要約とする。

```ts
type PermissionProfile =
  | "read-only"
  | "confirm-writes"
  | "workspace-write"
  | "autonomous";

type UserSelectablePermissionProfile = Exclude<PermissionProfile, "autonomous">;
type WorkspaceTrustState = "trusted" | "restricted";
type PermissionRestriction =
  | "commands-disabled"
  | "automatic-writes-disabled"
  | "workspace-provider-disabled"
  | "workspace-mcp-disabled";

interface PermissionSummary {
  threadId: string;
  threadRevision: number;
  requestedProfile: UserSelectablePermissionProfile;
  effectiveProfile: UserSelectablePermissionProfile;
  workspaceTrust: WorkspaceTrustState;
  restrictions: readonly PermissionRestriction[];
}

type PermissionSelectorPhase =
  | "loading"
  | "ready"
  | "confirming"
  | "updating"
  | "error";

interface PermissionSelectorState {
  phase: PermissionSelectorPhase;
  summary?: PermissionSummary;
  pendingProfile?: UserSelectablePermissionProfile;
  errorMessage?: string;
}
```

`requestedProfile`はスレッドに保存されたユーザーの選択、`effectiveProfile`はWorkspace Trustと安全制約を加味して実際に利用可能な権限を表す。両者が異なる場合は「選択中」と「実効」のラベルを分け、理由となる`restrictions`を説明する。これにより、表示上は`workspace-write`でもRestricted Modeにより自動書き込みやコマンドが使えない状態を、権限昇格と誤認させない。

`loading`では選択操作を無効化し、`ready`では確定状態を表示する。`confirming`では危険モードの説明と承認・キャンセルを表示し、`updating`では要求を一度だけ送信する。`error`では最後にHostが確定した状態を維持し、安全なエラー文だけを表示して再試行可能にする。UIは通知を受ける前に要求プロファイルを確定状態として表示してはならない。

#### プロファイルの説明と危険モード確認

選択肢には、権限名だけでなく、許可される代表操作と制限を併記する。

| プロファイル | UIで説明する内容 | 危険度の扱い |
|---|---|---|
| `read-only` | 読み取り、検索、診断取得。編集とコマンドは不可 | 基準となる安全側の状態 |
| `confirm-writes` | 読み取りとChangeSet作成。ディスク反映とコマンドは毎回確認 | 書き込み操作を伴うため確認を表示 |
| `workspace-write` | ワークスペース内の変更をChangeSetへ追加。ディスク反映は確認。安全なテストは事前ルールにより自動実行可能 | より広い書き込み・実行能力のため確認を表示 |

現在のプロファイルより書き込み・実行能力を広げる選択では、次の情報を確認UIに表示する。

* 変更前後のプロファイル
* 新たに可能になる操作（ChangeSet作成、ワークスペース内変更、許可されたテスト実行など）
* 引き続き常に確認が必要な操作（削除、大量変更、Git書き込み、外部通信、秘密情報操作、破壊的コマンド、設定変更など）
* Workspace Trustが制限する操作
* 実行中のAgentには適用されず、次回Runから適用されること

`read-only`への切り替えなど、権限を狭める変更もHostの検証と確定通知を必要とする。確認ダイアログを閉じた場合やキャンセルした場合は、現在の確定状態を維持する。確認UIはWebview内のキーボード操作可能なダイアログとし、初期フォーカス、Escape、承認・キャンセル、`aria-describedby`、`aria-live`を定義する。ブラウザの任意コードを実行する確認や、確認文にユーザー入力・ファイル内容をそのまま反射することは禁止する。

#### 選択要求、保存、競合

選択要求は次の契約でHostへ送る。

```ts
interface SetPermissionPayload {
  threadId: string;
  profile: UserSelectablePermissionProfile;
  expectedThreadRevision: number;
}
```

Hostは次の順序で検証する。

1. Envelope、プロトコルバージョン、プロファイル列挙値、`threadId`、`expectedThreadRevision`を検証する。
2. 現在のWebviewセッション、表示中のスレッド、Thread Store上のスレッドが一致することを確認する。
3. Agent Runが実行中でないことを確認する。実行中はプロファイルを変更せず、安全なエラーを返す。
4. Workspace TrustとPermission Policyを評価し、要求プロファイルを許可できるか確認する。Restricted Modeで無効になる能力を要求プロファイル自体に混ぜない。
5. `expectedThreadRevision`と現在のrevisionを比較する。不一致なら保存せず、最新の`permission-updated`を返す。
6. `meta.json.permissionProfile`とrevisionを一時ファイル経由で原子的に保存する。
7. 保存成功後にだけ、再計算した`PermissionSummary`を`permission-updated`として送る。

保存失敗、競合、Workspace Trustによる拒否、未知のプロファイルでは、UIの確定表示を変更しない。複数のWebview要求や同じ`messageId`の再送はHostの重複排除規則で一度だけ処理し、古い通知や別スレッドの通知をReducerへ適用しない。

#### Workspace Trustと実効権限

`workspace.isTrusted`の変化はHostが監視し、変化時に現在のスレッドの`PermissionSummary`を再計算してUIへ通知する。Restricted Modeでは、少なくともコマンド実行、自動ファイル変更、ワークスペース定義の外部モデルURL、ワークスペース定義のMCPサーバー、リポジトリ内スクリプト実行を無効化する。要求プロファイルの保存値を勝手に書き換えず、`effectiveProfile`と`restrictions`で実効状態を表す。

実行中にWorkspace Trustが変化した場合、現在のRunが持つ権限コンテキストを次のTool Callから再評価する。既に開始した危険操作をUIの表示だけで取り消したことにはせず、必要なキャンセルや承認の扱いはAgent RuntimeとPermission Policyの責務とする。UIはHostから通知された実効状態を表示する。

#### Agent実行への反映

`send-message`にはプロファイルを含めない。Hostは送信要求を受けた時点で、次の情報から`PermissionContext`を構築して`AgentRunRequest`へ渡す。

```ts
interface PermissionContext {
  requestedProfile: UserSelectablePermissionProfile;
  effectiveProfile: UserSelectablePermissionProfile;
  workspaceTrust: WorkspaceTrustState;
  restrictions: readonly PermissionRestriction[];
  threadRevision: number;
}
```

Agent RuntimeはRun開始時にこのContextを保持し、Tool Callごとに現在のWorkspace Trust、Threadの権限revision、Permission Policyを再評価する。`read-only`では編集・コマンドToolを候補から除外または拒否し、`confirm-writes`ではChangeSet作成とコマンドを確認経由にし、`workspace-write`では設計済みのワークスペース内自動処理だけを許可する。常に確認する操作はプロファイルで上書きしない。

選択確定後の次回Agent実行で、Thread Storeの`permissionProfile`が`AgentRunRequest`の権限Contextへ反映されることを完了条件とする。Webviewの表示値、古い`set-permission`要求、ユーザー入力、ワークスペース指示ファイルを権限の根拠にしない。

#### 通信契約

既存の判別共用体へ次の形で組み込む。

```ts
type UiToExtensionPermissionMessage = MessageEnvelope<"set-permission", SetPermissionPayload>;

type ExtensionToUiPermissionMessage = MessageEnvelope<"permission-updated", {
  summary: PermissionSummary;
}>;
```

実際のプロトコルでは、既存の`permission-updated`のpayloadを`PermissionSummary`へ拡張し、`set-permission`を`threadId`、`profile`、`expectedThreadRevision`付きへ更新する。`ui-ready`後、スレッド切り替え後、Workspace Trust変更後、選択成功または競合後にHostが現在の要約を送る。両方向の受信境界でZodの`safeParse`を実行し、検証前の値をDOM、ログ、永続化、権限判定へ渡さない。

#### 実装単位と検証方針

実装時は次の単位へ分割する。

* `src/ui/webview/components/PermissionProfileSelector.tsx`: 選択肢、現在状態、制限、危険モード確認、アクセシビリティ
* `src/ui/webview/permission-profile-state.ts`: 状態、確認、更新中、確定通知、競合・エラーの純粋な状態遷移
* `src/ui/main.tsx`: Permission Selectorと既存`WebviewProtocolClient`、現在のスレッド状態の接続
* `src/ui/styles.css`: 権限表示、確認ダイアログ、フォーカス、無効状態、Light/Dark/High Contrast対応
* `src/ui/webview-protocol.ts`: `set-permission`と`permission-updated`のpayload、Zodスキーマ、型定義
* Extension HostのUIルーティング、Permission Policy、Thread Store、Agent Service境界: 再検証、原子的保存、実効権限計算、次回Runへの反映

テストでは、3選択肢の表示、`autonomous`の非表示、現在状態の常時表示、危険モードの説明・承認・キャンセル、更新中の二重操作抑止、未知プロファイル、別スレッド、revision競合、Run中拒否、Restricted Mode、Workspace Trust変更、原子的保存、次回Agent実行への反映を検証する。通信テストではEnvelope、payload上限、列挙値、相関ID、重複排除、古い通知の無視を検証する。実APIを呼ぶテストは追加せず、明示的な環境変数がある場合だけ既存の実APIテスト方針に従う。

完了条件は、3つのプロファイルを安全に選択でき、現在の要求・実効権限を常時表示し、書き込み能力を広げる前に説明と確認を行い、選択確定後の次回Agent実行がHostのThread Storeから解決した権限Contextを用いてToolごとの権限判定を行うこととする。`autonomous`の有効化、承認ダイアログそのものの一般化、Permission Policyの全操作定義は本UI設計の完了条件に含めない。

### 14.2.5 Provider認証設定UI詳細設計

Provider認証設定UIは、検証済みModel Catalogに存在するProviderの認証状態を確認し、APIキーの登録・更新・削除を開始するためのWebview UIとする。APIキーの保存・取得・削除、入力UIの起動、Providerの存在確認、状態の正本管理はExtension Hostが担当する。Webviewは認証状態の表示と操作要求の送信だけを担当し、APIキー本体を扱わない。

#### 責務と表示契約

HostからUIへ渡すProvider認証要約は、次の情報に限定する。

```ts
type ProviderCredentialStatus =
  | "configured"
  | "not-configured"
  | "unavailable";

interface ProviderCredentialSummary {
  providerId: string;
  displayName: string;
  vendor: string;
  status: ProviderCredentialStatus;
  canEdit: boolean;
}
```

`configured`はSecretStorageに非空の値が存在することだけを表す。キーの一部、マスク値、長さ、更新日時、SecretStorageキー名は返さない。`unavailable`はProvider設定が不正、Providerが解決不能、またはSecretStorageの読み取りに失敗した場合の安全な表示状態であり、内部例外の詳細は含めない。UIはProvider URL、認証ヘッダー、Model設定JSONを直接読まない。

Provider一覧はHostが表示名の昇順、同名の場合は正規化済みProvider IDの昇順で決定する。Webview側で任意のProviderを追加したり、受信したIDを表示ラベルへ変換したりしない。Providerが0件の場合は設定対象がない旨を表示し、操作を無効にする。

#### 操作と状態遷移

入力フォーム下のツールバー左端に`＋`ボタンを置き、クリックでメニューバーを開く。メニューバーには「Provider認証設定」ボタンを置き、このボタンからProvider認証パネルを開く。パネル上部右端には`✕`ボタンを置き、押下時はパネルだけを閉じる。パネルではProviderごとに状態ラベルと、登録・更新・削除の操作を表示する。未設定時は「APIキーを設定」、設定済み時は「APIキーを更新」「APIキーを削除」を表示する。キー本体を再表示する操作、コピー操作、マスク値の表示は提供しない。

状態は`loading`、`ready`、`updating`、`error`で管理する。`updating`中は対象Providerの操作を無効にし、同一要求の二重送信を防ぐ。保存または削除が成功するまで確定表示を変更せず、成功後にHostから届いた新しい一覧で更新する。キャンセル、失敗、Webview再生成時はHostの最後の確定状態を表示する。

設定・更新はHostがProviderを検証した後、VS Codeのパスワード入力UIを開き、非空の入力だけをSecretStorageへ保存する。更新操作も同じ保存経路を使う。削除はHostがProvider IDを再検証してSecretStorageから冪等に削除する。Webviewから送るのはProvider IDと操作種別だけであり、入力値をpayloadへ含めない。

Command Paletteには次のコマンドを登録する。

| コマンド | 動作 | 成功時の通知 |
|---|---|---|
| `byokAgent.manageProviderCredentials` | Provider一覧を選択し、設定済み状態を確認して設定・更新・削除を実行 | 保存・削除されたことだけを表示 |
| `byokAgent.setProviderApiKey` | Providerを選択し、Hostのパスワード入力UIから設定・更新 | Provider表示名と完了状態だけを表示 |
| `byokAgent.deleteProviderApiKey` | Providerを選択し、削除確認後に削除 | Provider表示名と完了状態だけを表示 |

Command PaletteとWebviewから同時に要求が来た場合はHost側でProvider単位に直列化し、後から完了した操作の結果を新しい状態一覧として配信する。コマンド引数にProvider IDを受け付ける場合も、Catalogに存在するIDとの完全一致をHostで検証し、表示名や任意文字列から解決しない。

#### Webview通信

既存の共通エンベロープを使い、UIからHostへの要求を次のように追加する。

```ts
type UiToExtensionMessage =
  // 既存のメンバー
  | MessageEnvelope<"request-provider-credentials", {
      providerId?: string;
    }>
  | MessageEnvelope<"set-provider-credential", {
      providerId: string;
    }>
  | MessageEnvelope<"delete-provider-credential", {
      providerId: string;
    }>;
```

`request-provider-credentials`は全Providerまたは指定Providerの状態再取得要求、`set-provider-credential`はHostの入力UI起動要求、`delete-provider-credential`は削除確認を経た削除要求である。`set-provider-credential`の完了は、Hostが入力UIを閉じてSecretStorageへの保存結果を確定した後に返す。

HostからUIへは次の通知を追加する。

```ts
type ExtensionToUiMessage =
  // 既存のメンバー
  | MessageEnvelope<"provider-credentials", {
      providers: readonly ProviderCredentialSummary[];
    }>
  | MessageEnvelope<"provider-credential-operation", {
      providerId: string;
      operation: "set" | "delete";
      status: "succeeded" | "cancelled" | "failed";
    }>;
```

操作結果の`failed`には構造化エラーコードだけを含め、SecretStorageの例外、APIキー、入力値、Providerの生レスポンスは含めない。UIは操作結果を受け取った後に`provider-credentials`を正本として適用し、古い`messageId`や別セッションの通知を無視する。

#### セキュリティ、アクセシビリティ、実装単位

Webviewの通信受信時は既存のZod判別共用体へ追加したスキーマで検証し、検証前の値をDOM、ログ、コマンド実行、SecretStorageへ渡さない。Provider表示名やエラー文はテキストとして表示し、HTML、URL、Command URIとして解釈しない。UIはVS Code標準テーマトークンとCodiconを使用し、状態を色だけで表現しない。操作ボタンにはProvider名と操作内容を含むアクセシブルな名前を付け、更新中は`aria-busy`、成功・失敗は`aria-live`で通知する。削除はキーボード操作可能な確認ダイアログを必須とする。

実装単位は、Host側の`ProviderCredentialService`、Command Paletteのコマンド登録、認証状態を返すUIルーター、Webview側の`ProviderCredentialPanel`、通信スキーマ・Reducerとする。`ProviderCredentialService`は`SecretStore`、`ModelCatalog`、入力UIを依存先とし、WebviewやThread StoreへSecretStorageを公開しない。

#### テストと完了条件

単体テストではProviderごとの状態判定、保存・更新・削除、未知Provider、空入力、キャンセル、SecretStorage障害、同時操作の直列化を検証する。UIテストでは未設定・設定済み・利用不能・更新中・失敗の表示、キー本体非表示、二重操作抑止、削除確認、キーボード操作、`aria-live`通知を検証する。通信テストではpayloadにAPIキー本体・マスク値・長さが存在しないこと、Zod検証、相関ID、古い通知の無視を検証する。Command Paletteの統合テストではWebviewを開かずに設定・更新・削除が完了することを検証する。

完了条件は、UIまたはCommand PaletteからProviderを選び、登録状態を確認し、APIキーを設定・更新・削除できること、かつ操作後もAPIキー本体が再表示されずSecretStorage以外へ保存・送信・記録されないことである。Provider APIの有効性確認は本UIの完了条件に含めない。

## 14.3 Webview通信

Extension HostとWebviewの通信は、VS Code Webview APIの`postMessage`を搬送路とし、その上に本拡張専用のバージョン付きメッセージプロトコルを定義する。WebviewはUI状態の投影とユーザー操作を担当し、会話・Agent実行・権限・変更の正本はExtension Hostが保持する。

### 14.3.1 共通エンベロープ

すべてのメッセージは、方向に関係なく同じエンベロープを持つ。`type`が判別子であり、`payload`は`type`ごとに異なる判別共用体の要素である。

```ts
type ProtocolVersion = "1.0";

interface MessageEnvelope<TType extends string, TPayload> {
  protocolVersion: ProtocolVersion;
  messageId: string;       // UUID。送信側が生成する一意なID
  type: TType;
  sentAt: number;           // Unix epoch milliseconds
  correlationId?: string;  // 要求と応答・イベントを関連付けるID
  payload: TPayload;
}
```

`protocolVersion`は互換性のあるメジャー・マイナー表記とする。MVPでは`"1.0"`だけを受け付け、メジャー番号が異なるメッセージは処理せず、プロトコルエラーとして扱う。後方互換なマイナー更新を行う場合は、受信側が未知の任意フィールドを無視できるようにし、既存の必須フィールドや既存の`type`の意味を変更しない。互換性を壊す変更はメジャー番号を上げる。

`messageId`は再送・重複排除とログ相関に使う。`correlationId`は要求に対する状態通知やエラーを関連付けるために使い、UI入力の`messageId`をそのまま実行IDとして扱わない。時刻は表示・診断用途に限り、認証や認可の根拠にしない。

### 14.3.2 UIからExtension Hostへのメッセージ

```ts
type UiToExtensionMessage =
  | MessageEnvelope<"ui-ready", {
      clientInstanceId: string;
      supportedProtocolVersions: readonly ProtocolVersion[];
    }>
  | MessageEnvelope<"send-message", {
      threadId: string;
      text: string;
    }>
  | MessageEnvelope<"cancel-run", {
      runId: string;
    }>
  | MessageEnvelope<"approve-tool", {
      approvalId: string;
    }>
  | MessageEnvelope<"reject-tool", {
      approvalId: string;
      reason?: string;
    }>
  | MessageEnvelope<"apply-change-set", {
      changeSetId: string;
    }>
  | MessageEnvelope<"discard-change-set", {
      changeSetId: string;
    }>
  | MessageEnvelope<"select-model", {
      threadId: string;
      modelId: string;
      expectedThreadRevision: number;
    }>
  | MessageEnvelope<"set-permission", {
      threadId: string;
      profile: Exclude<PermissionProfile, "autonomous">;
      expectedThreadRevision: number;
    }>
  | MessageEnvelope<"request-provider-credentials", {
      providerId?: string;
    }>
  | MessageEnvelope<"set-provider-credential", {
      providerId: string;
    }>
  | MessageEnvelope<"delete-provider-credential", {
      providerId: string;
    }>
  | MessageEnvelope<"request-thread-snapshot", {
      threadId: string;
    }>;
```

`ui-ready`はWebviewの初期化完了時に一度だけ送信する。Extension Hostはこれを契機に現在のUI向けスナップショットを返す。`send-message`、承認、ChangeSet適用などの操作は、Extension Host側で現在のスレッド・実行・権限・`baseHash`を再確認する。メッセージに含まれるIDの存在だけを根拠に操作を許可してはならない。

### 14.3.3 Extension HostからUIへのメッセージ

```ts
type ExtensionToUiMessage =
  | MessageEnvelope<"host-ready", {
      clientInstanceId: string;
      protocolVersion: ProtocolVersion;
    }>
  | MessageEnvelope<"thread-snapshot", {
      threadId: string;
      revision: number;
      events: readonly ThreadEvent[];
    }>
  | MessageEnvelope<"thread-event", {
      threadId: string;
      sequence: number;
      event: ThreadEvent;
    }>
  | MessageEnvelope<"run-state", {
      runId: string;
      threadId: string;
      state: AgentRuntimeState;
      sequence: number;
    }>
  | MessageEnvelope<"approval-requested", {
      approvalId: string;
      action: ProposedActionSummary;
      expiresAt?: number;
    }>
  | MessageEnvelope<"change-set-updated", {
      changeSetId: string;
      status: ChangeSetStatus;
      files: readonly ChangeFileSummary[];
    }>
  | MessageEnvelope<"model-list", {
      threadId: string;
      threadRevision: number;
      models: readonly ModelSummary[];
      selectedModelId?: string;
    }>
  | MessageEnvelope<"permission-updated", {
      summary: PermissionSummary;
    }>
  | MessageEnvelope<"provider-credentials", {
      providers: readonly ProviderCredentialSummary[];
    }>
  | MessageEnvelope<"provider-credential-operation", {
      providerId: string;
      operation: "set" | "delete";
      status: "succeeded" | "cancelled" | "failed";
    }>
  | MessageEnvelope<"protocol-error", {
      code: "UNSUPPORTED_VERSION" | "INVALID_MESSAGE" | "MESSAGE_TOO_LARGE";
      message: string;
      rejectedMessageId?: string;
    }>
  | MessageEnvelope<"error", {
      code: AgentErrorCode;
      message: string;
      retryable: boolean;
    }>;
```

`thread-event`と`run-state`は、それぞれの`threadId`または`runId`単位で単調増加する`sequence`を持つ。UIは古いイベントや重複イベントを適用せず、欠番を検出した場合は`request-thread-snapshot`で正本を再取得する。Extension HostからのイベントはUIを直接操作せず、検証済みの状態更新としてUIのReducerに渡す。

上記の`*Summary`型は表示に必要なメタデータだけを含む。APIキー、Authorizationヘッダー、生の環境変数、秘密情報、不要なファイル内容、非公開推論内容をメッセージへ含めない。ファイル変更はChangeSetのID・ファイル名・差分要約を基本とし、詳細は権限確認済みのExtension Host処理から必要最小限だけ公開する。

### 14.3.4 型定義と受信検証

Zodスキーマをメッセージプロトコルの単一の正本とし、`z.infer`からTypeScript型を導出する。手書きの型だけを信頼してはならない。

```ts
const uiToExtensionMessageSchema = z.discriminatedUnion("type", [
  uiReadySchema,
  sendMessageSchema,
  cancelRunSchema,
  approveToolSchema,
  rejectToolSchema,
  applyChangeSetSchema,
  discardChangeSetSchema,
  selectModelSchema,
  setPermissionSchema,
  requestProviderCredentialsSchema,
  setProviderCredentialSchema,
  deleteProviderCredentialSchema,
  requestThreadSnapshotSchema,
]);

type UiToExtensionMessage = z.infer<typeof uiToExtensionMessageSchema>;
```

実装時は次の2つの境界で必ず`safeParse`を実行する。

1. Extension Hostの`onDidReceiveMessage`で、Webviewから届いた`unknown`を検証してからDispatcherへ渡す。
2. Webview側の`window`メッセージ受信処理で、Extension Hostから届いた値を検証してからReducerへ渡す。

検証では、エンベロープ、プロトコルバージョン、`type`、payloadの型、文字列長、ID形式、列挙値、配列上限を確認する。JSON以外の値、未知の`type`、未対応バージョン、必須フィールド欠損、過大なペイロードは拒否する。受信した値を検証前にDOM、ログ、ファイル操作、権限判定へ渡してはならない。拒否理由はユーザー入力やファイル内容を反射せず、診断に必要な最小限の情報だけを`protocol-error`として返す。

### 14.3.5 送受信・ライフサイクル

```text
Webview起動
  └─ ui-ready(protocolVersion: "1.0")
       └─ Extension Hostが検証・接続状態を確立
            ├─ host-ready
            ├─ thread-snapshot / model-list / permission-updated
            └─ 以後、thread-event / run-state / approval-requested を配信

UI操作
  └─ UIメッセージ(messageId, correlationId)
       └─ Hostで検証 → 権限・状態を再評価 → 正本を更新
            └─ 応答イベントまたは error(correlationId) を配信
```

Webviewの破棄・再生成は通信セッションの再接続として扱う。古い`clientInstanceId`からの操作を新しいUIセッションへ引き継がず、再生成後は`ui-ready`からスナップショットを再取得する。実行中のAgentをUIの破棄だけでキャンセルせず、キャンセルは明示的な`cancel-run`と権限・ライフサイクル上の安全な停止処理で行う。

送信処理は、JSONシリアライズ可能な検証済みメッセージだけを渡す共通`MessageTransport`へ集約する。送信失敗、破棄済みWebview、サイズ超過は呼び出し元へ返し、黙って捨てない。初期実装では要求の再送を自動化せず、重複排除は`messageId`、状態の整合は`sequence`とスナップショットで行う。

### 14.3.6 設計上の制約と完了条件

- UI→Extension、Extension→UIの全メッセージが共通エンベロープと判別共用体を持つ。
- 両方向の受信境界でZodの実行時検証を通過した値だけを内部処理へ渡す。
- `protocolVersion: "1.0"`、`messageId`、必要な`correlationId`、イベントの`sequence`をテストで検証する。
- 未知のメッセージ、異なるメジャーバージョン、必須フィールド欠損、誤った型、過大ペイロードを安全に拒否する。
- UI再生成後に`ui-ready`→スナップショット取得で正本と表示を再同期できる。
- 操作要求と状態通知を相関付け、重複イベントや欠番をUIが安全に処理できる。
- メッセージを経由して秘密情報や不要なワークスペース情報がWebviewへ渡らない。

```ts
interface MessageTransport {
  sendToHost(message: UiToExtensionMessage): Promise<void>;
  sendToUi(message: ExtensionToUiMessage): Promise<void>;
  dispose(): void;
}
```

## 14.4 Webview状態の保持と再表示

WebviewのDOM保持とUI状態の保持は別の責務として扱う。メモリ使用量を抑えるため、`WebviewViewProvider`の登録では`retainContextWhenHidden: false`を基本とし、Webviewが非表示になってDOMが破棄されても、必要な一時状態をVS Code Webview APIで復元できるようにする。

### 14.4.1 状態の責務境界

Webview状態は、Webviewが再表示または再生成されたときに画面を元の操作位置へ戻すための一時的なUI状態だけを保持する。会話、スレッド、Agent実行、モデル設定、権限設定などの正本はExtension Host側に置く。

初期バージョンで保存する状態はComposerの未送信テキストだけとする。

```ts
interface AgentWebviewStateV1 {
  version: 1;
  composerDraft: string;
}
```

次の情報はWebview状態へ保存してはならない。

* APIキー、Authorizationヘッダー、認証トークン
* 生の環境変数、`.env`内容
* ファイル内容、選択範囲、Tool Result
* プロンプト、非公開推論内容
* 会話やスレッドの正本

会話やスレッドをVS Code再起動後も復元する要件は、`globalStorage/threads/<id>/`配下のStorage設計で扱い、Webview状態復元と混同しない。

### 14.4.2 復元ライフサイクル

Webviewアプリの初期化時に`acquireVsCodeApi()`を一度だけ呼び出し、取得したAPIから`getState()`を呼び出す。戻り値は外部から渡された不確かな値として検証し、`version: 1`かつ`composerDraft`が文字列の状態だけを採用する。それ以外は空の初期状態へフォールバックする。

```text
WebviewViewProvider.resolveWebviewView
  └─ HTML/CSP/アセットを設定
       └─ Webview Appを起動
            ├─ acquireVsCodeApi()（一度だけ）
            ├─ getState() → 検証 → Composer初期値
            └─ Composer変更 → setState(検証済みの状態)

Webview非表示・再生成
  └─ retained stateをgetState()から取得して画面を再構築
```

状態の保存は`beforeunload`や表示イベントに依存せず、Composerの値が変化した時点で行う。`getState()`はレンダーごとに呼び出さず、初期化時の一回だけ呼び出す。状態形式を変更する場合は`version`を更新し、移行できない値は破棄して初期状態から開始する。未知のフィールドは無視する。

この仕組みの保証範囲は、同一拡張機能セッション中のWebview非表示・Webview再生成からの復元である。VS Code再起動後や拡張機能再起動後の永続復元はStorageServiceの責務とする。

### 14.4.3 セキュリティと容量

Webview状態はJSONにシリアライズできる最小のデータだけに限定し、秘密情報やワークスペース内容を渡さない。状態の読み込み時は型とバージョンを検証し、不正値をUIへ直接展開しない。状態復元の追加によって、CSP、スクリプトnonce、`localResourceRoots`限定、外部スクリプト禁止の要件を緩和してはならない。

### 14.4.4 検証項目

次をテストおよびExtension Development Hostで確認する。

1. 状態なしの初回表示では空のComposerが表示される。
2. 入力中のComposerを非表示にして再表示すると、入力内容が復元される。
3. Webviewが再生成されても、保存済みの有効な状態から初期化される。
4. `null`、欠損フィールド、誤った型、未知のバージョンでは空の初期状態へフォールバックする。
5. `setState()`へ秘密情報、ファイル内容、会話の正本が渡されない。
6. `retainContextWhenHidden: false`と既存のWebviewセキュリティ設定が維持される。

### 14.5 Webview資産読み込みとContent Security Policy

Webviewは表示とユーザー操作だけを担当するサンドボックスであり、実行可能な資産と読み込み元を最小限に限定する。CSPはHTMLの`meta`要素で設定し、HTML生成時に作成したnonceをスクリプト実行の唯一の許可根拠とする。nonceはWebviewのHTMLを生成するたびに暗号学的に安全な乱数から新しく生成し、他の状態やメッセージへ公開しない。

#### 14.5.1 許可する資産

初期UIで許可するローカル資産は、拡張機能の`out/webview`配下にあるビルド済みの`main.js`と`main.css`だけとする。URIは既知の相対パスから`webview.asWebviewUri`で生成し、外部URL、CDN、ワークスペースの資産、ユーザー入力から組み立てたURIは使用しない。

```text
ExtensionContext.extensionUri
└── out/
    └── webview/
        ├── main.js
        └── main.css
```

`webview.options.localResourceRoots`には`extensionUri/out/webview`の単一URIだけを設定する。拡張機能全体、ワークスペース、ホームディレクトリをルートにしない。これにより、`asWebviewUri`を使用する場合でもWebviewが参照できるローカルファイルの範囲を資産ディレクトリに閉じ込める。

#### 14.5.2 CSPポリシー

現行UIの最小ポリシーは次のとおりとする。`${webview.cspSource}`は`main.css`の読み込みに必要なWebviewのリソース元だけに使用し、`script-src`には含めない。

```text
default-src 'none';
base-uri 'none';
object-src 'none';
frame-src 'none';
form-action 'none';
connect-src 'none';
img-src 'none';
font-src 'none';
style-src ${webview.cspSource};
script-src 'nonce-${nonce}';
```

次を明示的に禁止する。

* `unsafe-inline`および`unsafe-eval`
* インライン`<script>`、インラインイベントハンドラー、`javascript:` URI
* nonceのないスクリプト、外部スクリプト、CDN読み込み
* `eval`、`new Function`、実行時コード生成
* 現行UIで不要なネットワーク接続、画像、フォント、フレーム、フォーム送信

スクリプト要素はnonce付きの`main.js`一つだけとする。CSSは外部の`main.css`へ置き、スタイル属性や`<style>`要素を追加するためにインライン許可を緩和しない。画像、フォント、通信などを将来追加する場合は、用途・取得元・サイズ・権限を設計書へ記録し、必要な最小のCSPディレクティブだけを追加する。

#### 14.5.3 HTML生成と境界

```text
WebviewViewProvider.resolveWebviewView
  ├─ webview.options
  │    ├─ enableScripts: true
  │    └─ localResourceRoots: [extensionUri/out/webview]
  └─ webview.html
       ├─ CSP meta（nonceを含む）
       ├─ asWebviewUri(out/webview/main.css)
       └─ nonce付き asWebviewUri(out/webview/main.js)
```

HTML属性へ値を埋め込む場合は、nonceと資産URIが属性境界を壊さないことを保証する。ユーザー入力、APIキー、Authorizationヘッダー、ファイル内容、プロンプト、Tool ResultなどをHTMLや資産URIへ埋め込まない。WebviewとExtension Host間のメッセージはHTML生成と別の境界で扱い、後続の通信実装で受信検証を必須とする。

#### 14.5.4 検証と完了条件

自動検証では、HTMLに必須CSPディレクティブがあること、`unsafe-inline`と`unsafe-eval`がないこと、CSPのnonceとscript要素のnonceが一致すること、既知の`main.js`と`main.css`だけが参照されること、`localResourceRoots`が`out/webview`の単一URIであることを確認する。ビルド済み`main.js`には`eval`、`new Function`、外部リソースを示すHTTP(S) URL、インライン実行コードを混入させない。ただし、DOM名前空間判定に必要な固定の`www.w3.org`名前空間URIは通信先ではないため、静的検査で明示的に許可する。

Extension Development Hostでは、初回表示、入力操作、Webview再生成を確認し、開発者ツールのコンソールにCSP違反がないことを確認する。CSP違反を無視する設定や、違反発生時だけポリシーを緩める分岐は認めない。初回表示から再生成までUIがCSP違反なしで動作し、自動検証と静的検査が成功することを本タスクの完了条件とする。

### 14.6 VS Codeテーマ対応とCodicon移行

WebviewのUIはVS Code標準テーマトークンとCodiconを使用し、独自画像依存を排除する。Light、Dark、High Contrastの各テーマで視認性を維持する。

#### 14.6.1 現状と対応方針

`src/ui/styles.css` では既に `--vscode-*` CSS変数が広く使用されており、Light/Darkテーマでの表示は問題ない。不足している対応は次の2点である。

1. **High Contrastモード未対応**: `@media (forced-colors: active)` の記述がない。`box-shadow` に依存した境界表現はHigh Contrastモードで機能しない。
2. **Codicon未使用**: すべてのアイコンがインラインSVGで実装されており、VS Code標準のCodiconが使われていない。

#### 14.6.2 High Contrastモード対応

VS CodeのHigh Contrastテーマでは `forced-colors` メディアクエリが有効になる。WindowsのHigh Contrastモードでは `--vscode-*` CSS変数がシステム色で上書きされるため、次の対応を行う。

```css
/* High Contrastモードではシステム色を使用 */
@media (forced-colors: active) {
  .model-selector-menu,
  .model-selector-inline-menu,
  .permission-selector-menu,
  .permission-confirmation-panel,
  .composer,
  .welcome-card,
  .thread-message {
    border: 1px solid CanvasText;
    box-shadow: none;
  }

  .composer-input {
    border: 1px solid CanvasText;
  }

  .composer-input:focus,
  .model-selector-button:focus,
  .model-selector-inline-button:focus,
  .composer-toolbar-button:focus {
    outline: 2px solid Highlight;
    outline-offset: -2px;
  }

  .composer-send-button {
    border: 1px solid ButtonText;
  }

  .permission-confirmation {
    background: Canvas;
  }

  .model-selector-menu-item:hover,
  .model-selector-inline-menu-item:hover,
  .permission-selector-menu-item:hover {
    background: Highlight;
    color: HighlightText;
  }

  .model-selector-menu-item-selected,
  .model-selector-inline-menu-item-selected,
  .permission-selector-menu-item-selected {
    background: Highlight;
    color: HighlightText;
  }
}
```

対応方針：

* `box-shadow` を `none` にし、代わりに `border` で境界を明示する
* フォーカス表示は `outline: 2px solid Highlight` でシステムのフォーカス色を使用する
* ホバー・選択状態は `Highlight`/`HighlightText` のシステム色を使用する
* 背景のオーバーレイ（権限確認ダイアログ）は `Canvas` を使用する
* アイコンや状態表示が色だけに依存しないよう、`aria-label` やテキストラベルを併用する

#### 14.6.3 Codiconへの移行

VS Codeに標準搭載されているCodicon（`@vscode/codicon` パッケージ）を使用し、現在のインラインSVGを置き換える。

##### 14.6.3.1 Codiconの読み込み

Webview HTMLの生成時に、CodiconのCSSを `<link>` 要素で読み込む。CSPの `style-src` にCodiconのURIを追加する必要がある。

```ts
// agent-webview-provider.ts
const codiconUri = webview.asWebviewUri(
  Uri.joinPath(extensionUri, "node_modules", "@vscode/codicon", "dist", "codicon.css")
);
```

CSPの更新：

```text
style-src ${webview.cspSource} ${codiconUri};
font-src ${webview.cspSource} ${codiconUri};
```

Codiconはフォントファイル（`woff2`）を同梱するため、`font-src` の追加が必要になる。フォントの読み込み元は `localResourceRoots` で許可された `out/webview` 配下にバンドルするか、`node_modules/@vscode/codicon/dist/` を `localResourceRoots` へ追加する。

推奨方式：ビルド時にCodiconのCSSとフォントを `out/webview/` 配下へコピーし、`localResourceRoots` を拡張しない。

##### 14.6.3.2 アイコン置き換え対応表

| 現在の実装 | Codiconクラス | コンポーネント |
|---|---|---|
| 添付ファイルSVGパス | `codicon codicon-attach` | `Composer.tsx` |
| モデル選択チェブロン（下向き） | `codicon codicon-chevron-down` | `ModelSelector.tsx` |
| モデル選択チェブロン（上向き） | `codicon codicon-chevron-up` | `ModelSelector.tsx` |
| インラインモデル選択チェブロン（下向き） | `codicon codicon-chevron-down` | `ModelSelectorInline.tsx` |
| インラインモデル選択チェブロン（上向き） | `codicon codicon-chevron-up` | `ModelSelectorInline.tsx` |
| 送信ボタン（円形+矢印） | `codicon codicon-send` | `Composer.tsx` |
| 停止ボタン | `codicon codicon-stop` | `Composer.tsx` |
| チェックマーク（選択状態） | `codicon codicon-check` | `ModelSelector.tsx`、`ModelSelectorInline.tsx`、`PermissionProfileSelector.tsx` |
| ウェルカムマーク（星） | `codicon codicon-sparkle` | `styles.css`（`.welcome-mark`） |

##### 14.6.3.3 実装パターン

置き換え前（インラインSVG）：

```tsx
<svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
  <path d="M8 3V13M3 8H13" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
</svg>
```

置き換え後（Codicon）：

```tsx
<i class="codicon codicon-add" aria-hidden="true" />
```

アイコンのみのボタン：

```tsx
<button type="button" class="composer-toolbar-button" aria-label="添付ファイルを追加">
  <i class="codicon codicon-attach" aria-hidden="true" />
</button>
```

Codiconのサイズ調整が必要な場合、CSSで `font-size` を指定する：

```css
.composer-toolbar-button .codicon {
  font-size: 16px;
}
```

#### 14.6.4 テーマ別視認性の確認

完了条件として、次のテーマで全UI要素が視認可能であることを確認する。

| テーマカテゴリ | 確認するテーマ |
|---|---|
| Light | `Default Light+`、`Light Modern` |
| Dark | `Default Dark+`、`Dark Modern` |
| High Contrast | `Default High Contrast`、`Default High Contrast Light` |

確認対象のUI要素：

* ヘッダー（モデル選択ボタン、権限選択ボタン、ステータス表示）
* メッセージスレッド（ユーザー発言、エージェント発言、コードブロック）
* Composer（入力欄、送信ボタン、停止ボタン、状態ラベル）
* 権限確認ダイアログ（説明文、承認ボタン、キャンセルボタン）
* モデル選択メニュー（一覧、選択状態、ホバー状態）
* 空状態・エラー状態の表示

#### 14.6.5 完了条件

1. すべてのアイコンがCodiconに置き換わり、インラインSVGが残っていない
2. High Contrastテーマ（`forced-colors: active`）で全UI要素が識別可能
3. Light、Dark、High Contrastの主要テーマで視認性が維持される
4. アイコンのみのボタンに適切な `aria-label` が設定されている
5. Codiconのフォント読み込みがCSP違反を発生させない
6. `pnpm typecheck`、`pnpm lint`、`pnpm format:check`、`pnpm test`、`pnpm check:webview-security` が成功する

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
  revision: number;
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
* Capabilitiesの設定値優先（モデル名・Provider名による推測が実行結果へ影響しないこと）
* `false`・未指定・能力矛盾・Adapter非対応時の実効能力
* Tool Calling、Streaming、Vision、Reasoningごとの機能無効化マトリクス
* Run開始時のCapabilitiesスナップショット固定とCatalog revision更新
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
* Webview非表示・再表示時のComposer状態復元
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

### Phase 0：OSSライセンスとNOTICE

* `LICENSE`の配置とMITメタデータの整合
* `NOTICE.md`の著作権表示とCopilot Chat由来コード台帳
* `THIRD_PARTY_LICENSES.md`の生成・検査方針
* 未解決ライセンスと第三者表示の検出

完了条件：

* 本プロジェクトのライセンス本文、コード出典、依存ライセンスをリポジトリ上で追跡できる
* コピーまたは改変したコードについて、完全コミットSHA、原ファイル、原範囲、移植先、変更内容を確認できる
* 依存のライセンス不明・台帳不一致・必要なNOTICE欠落を検査で失敗させられる

### Phase 1：基盤

* Extension activation
* Sidebar Webview
* Webview再表示時の一時UI状態復元
* Model JSON
* SecretStorage
* Provider認証設定UI（Webview / Command Palette）
* OpenAI互換Provider
* ストリーミングチャット
* スレッド保存

完了条件：

* BYOKキーで通常チャットが動作する
* モデルをJSONで追加できる
* APIキーが設定ファイルやログへ出ない
* UIまたはCommand PaletteからProviderごとのAPIキーを設定・更新・削除できる

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
