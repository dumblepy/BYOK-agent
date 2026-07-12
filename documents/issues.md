# Issue一覧

## Milestone 0: プロジェクト基盤

- [Core] VS Code拡張プロジェクトの初期構成を作成する

  - TypeScript、ESLint、Prettier、テスト環境を設定する
  - `src`、`resources`、`tests`の基本ディレクトリを作成する
  - 開発用Extension Hostから起動できる状態にする
  - 完了条件: 空の拡張機能がVS Code上で正常に有効化される

- [Core] 拡張機能のContribution Pointsを定義する

  - Activity Barアイコンを登録する
  - Agent用View ContainerとViewを登録する
  - コマンド、設定項目、キーバインドの初期定義を追加する
  - 完了条件: サイドバーからAgent Viewを開ける

- [Core] アプリケーションサービスの初期化機構を実装する

  - Extension activation時のサービス生成を整理する
  - サービスの依存関係を明示する
  - deactivate時のリソース解放を実装する
  - 完了条件: Provider、Storage、Agent、UIの各サービスを一元的に初期化できる

- [Legal] OSSライセンスとNOTICE管理方針を整備する

  - MITライセンスを配置する
  - Copilot Chat由来コードを利用する場合の記録形式を定義する
  - `NOTICE.md`と依存ライセンス一覧を作成する
  - 完了条件: コピーまたは改変したコードの出典を追跡できる

---

## Milestone 1: UI基盤

- [UI] Agent SidebarのWebview View Providerを実装する

  - `WebviewViewProvider`を実装する
  - HTML、JavaScript、CSSを安全に読み込む
  - Webviewの再表示時に状態を復元する
  - 完了条件: サイドバーにAgent UIの初期画面が表示される

- [UI] WebviewのContent Security Policyを実装する

  - nonce付きスクリプト読み込みを実装する
  - `unsafe-inline`、`unsafe-eval`を禁止する
  - `localResourceRoots`を最小範囲に限定する
  - 完了条件: CSP違反なしでUIが動作する

- [UI] Extension HostとWebview間の通信プロトコルを定義する

  - UI→ExtensionとExtension→UIのメッセージ型を定義する
  - ZodまたはJSON Schemaで受信メッセージを検証する
  - プロトコルバージョンを持たせる
  - 完了条件: 型安全に双方向メッセージを送受信できる

- [UI] スレッド表示コンポーネントを実装する

  - ユーザー発言とエージェント発言を表示する
  - Markdownとコードブロックを表示する
  - ストリーミング中のテキスト更新に対応する
  - 完了条件: 複数メッセージからなる会話を表示できる

- [UI] メッセージ入力Composerを実装する

  - 複数行入力に対応する
  - 送信、停止、入力中状態を実装する
  - Enterと修飾キーの挙動を定義する
  - 完了条件: UIからユーザーメッセージを送信できる

- [UI] モデル選択UIを実装する

  - 利用可能なモデル一覧を表示する
  - 現在のモデルを表示する
  - スレッド単位でモデルを変更できるようにする
  - 完了条件: 選択したモデルが次回リクエストに反映される

- [UI] 権限プロファイル選択UIを実装する

  - `read-only`、`confirm-writes`、`workspace-write`を選択できるようにする
  - 現在の権限状態を常時表示する
  - 危険なモードへの切り替え時に説明を表示する
  - 完了条件: 権限プロファイルがAgent実行時に反映される

- [UI] VS Codeテーマ対応を実装する

  - VS CodeのCSS変数を使用する
  - Light、Dark、High Contrastで表示を確認する
  - Codiconを使用し、独自画像依存を減らす
  - 完了条件: 主要テーマで視認性が維持される

---

## Milestone 2: モデル設定とBYOK

- [Models] モデル設定JSON Schemaを定義する

  - Provider、Model、Capabilities、Agent設定のSchemaを作成する
  - 必須項目、列挙値、数値範囲を定義する
  - 不正な設定に明確なエラーを返す
  - 完了条件: 設定ファイルをSchema検証できる

- [Models] モデル設定ローダーを実装する

  - 組み込み設定、ユーザー設定、ワークスペース設定を読み込む
  - 設定の優先順位とマージ規則を実装する
  - ファイル変更時の再読み込みに対応する
  - 完了条件: 複数の設定ソースから最終設定を生成できる

- [Models] ワークスペース由来モデル設定の安全制約を実装する

  - ワークスペース設定からのAPIキー指定を拒否する
  - 未信頼ワークスペースでは外部URL設定を無効化する
  - 任意HTTPヘッダーの危険な上書きを制限する
  - 完了条件: 悪意あるリポジトリから送信先や認証情報を変更できない

- [Models] Model Catalogを実装する

  - モデルIDからProvider、APIモデル名、能力を解決する
  - 既定モデルを管理する
  - 無効なモデル設定をUIへ通知する
  - 完了条件: モデル選択から実際のProvider設定を取得できる

- [Models] モデルCapabilities管理を実装する

  - Tool Calling、Streaming、Vision、Reasoningなどを定義する
  - モデル名による推測ではなく設定値を優先する
  - 能力不足時に機能を無効化する
  - 完了条件: モデル能力に応じてツールやUIが適切に切り替わる

- [Security] SecretStorageによるAPIキー管理を実装する

  - ProviderごとのAPIキー保存、取得、削除を実装する
  - APIキー入力コマンドを追加する
  - キーを設定ファイルやログへ出力しない
  - 完了条件: APIキーが`ExtensionContext.secrets`にのみ保存される

- [UI] Provider認証設定画面を実装する

  - APIキーの登録状態を表示する
  - APIキー設定、更新、削除を操作できるようにする
  - キー本体は再表示しない
  - 完了条件: UIまたはCommand Paletteから認証情報を管理できる

---

## Milestone 3: Provider層

- [Provider] Provider共通インターフェースを定義する

  - `ProviderAdapter`、`ProviderRequest`、`ProviderEvent`を定義する
  - ストリーミング、Tool Call、Usage、Errorの共通表現を作る
  - AbortSignalに対応する
  - 完了条件: Provider固有実装をAgentから分離できる

- [Provider] Provider Routerを実装する

  - Model Catalogから適切なAdapterを選択する
  - Provider未登録時のエラー処理を実装する
  - Providerごとの初期化と再利用を管理する
  - 完了条件: モデルIDからProvider呼び出しまで解決できる

- [Provider] OpenAI Responses Adapterを実装する

  - メッセージ、システム指示、ツール定義を変換する
  - ストリーミングイベントを内部形式へ正規化する
  - Tool CallとTool Resultを処理する
  - UsageとStop Reasonを取得する
  - 完了条件: Responses互換APIでストリーミング会話とTool Callingが動作する

- [Provider] OpenAI互換Chat Completions Adapterを実装する

  - OpenAI互換エンドポイントへ対応する
  - Provider差異を吸収する設定を用意する
  - 不完全なTool Callストリームを安全に結合する
  - 完了条件: 一般的なOpenAI互換サーバーで利用できる

- [Provider] Providerエラー正規化を実装する

  - 認証、Rate Limit、Timeout、Bad Requestを分類する
  - Retry-Afterを扱う
  - ユーザー向け情報と技術情報を分離する
  - 完了条件: API固有エラーを共通エラーコードとして処理できる

- [Provider] Providerリトライ方針を実装する

  - 一時的エラーだけを再試行する
  - 指数バックオフと上限を設定する
  - Tool Callを伴う重複リクエストを防止する
  - 完了条件: 安全に再試行可能なエラーだけが自動再試行される

- [Test] Provider Contract Test基盤を作成する

  - 保存済みストリームイベントによるテストを作成する
  - Text、Tool Call、Usage、Error、Cancelを検証する
  - 実APIテストは明示設定時だけ実行する
  - 完了条件: 各Provider Adapterが同じ契約を満たすことを自動検証できる

---

## Milestone 4: 会話と永続化

- [Storage] Thread Storeを実装する

  - スレッド作成、取得、一覧、更新、アーカイブを実装する
  - スレッドごとのモデルと権限プロファイルを保存する
  - 完了条件: VS Code再起動後もスレッド一覧を復元できる

- [Storage] 追記型Event Storeを実装する

  - `events.jsonl`へAgent Eventを追記する
  - 破損行が存在しても可能な範囲で復元する
  - 定期的にスナップショットを作成する
  - 完了条件: Agent実行履歴を順序付きで永続化できる

- [Storage] 会話アーティファクト保存機構を実装する

  - 長大なTool Resultやコマンド出力を別ファイルへ保存する
  - `artifact://`形式の参照IDを発行する
  - 保存容量と削除方針を設定する
  - 完了条件: 巨大出力を会話履歴へ直接保存せず参照できる

- [Storage] スレッドタイトル生成を実装する

  - 最初のユーザーメッセージから仮タイトルを作成する
  - ユーザーが編集できるようにする
  - LLMによる自動命名は任意設定とする
  - 完了条件: スレッド一覧を識別可能な名前で表示できる

---

## Milestone 5: コンテキスト管理

- [Context] ContextItem共通型を定義する

  - 種別、優先度、Token推定値、URI、Range、Hashを定義する
  - sensitive、volatile属性を追加する
  - 完了条件: すべてのコンテキストを共通形式で扱える

- [Context] Context Provider基盤を実装する

  - Context Provider共通インターフェースを定義する
  - 並列収集、タイムアウト、キャンセルを実装する
  - Provider単位の失敗を全体失敗にしない
  - 完了条件: 複数ソースからコンテキストを収集できる

- [Context] アクティブエディタと選択範囲を収集する

  - アクティブファイル、言語、カーソル位置を取得する
  - 選択範囲を最優先コンテキストとして追加する
  - Untitledファイルに対応する
  - 完了条件: 現在の編集対象をモデルへ渡せる

- [Context] 明示的なファイル添付機能を実装する

  - Composerからファイルを追加、削除できるようにする
  - 添付ファイルをContext Chipとして表示する
  - ファイルサイズ上限とバイナリ判定を実装する
  - 完了条件: ユーザー指定ファイルを優先的にコンテキストへ含められる

- [Context] Diagnostics Context Providerを実装する

  - 現在のファイルとワークスペースの診断を取得する
  - Severity、位置、メッセージを構造化する
  - 重複した診断を除去する
  - 完了条件: コンパイルエラーや警告をモデルへ渡せる

- [Context] Git Context Providerを実装する

  - 現在のブランチ、変更ファイル、差分概要を取得する
  - Git未導入環境では無効化する
  - 差分量が多い場合は要約する
  - 完了条件: 作業ツリーの状態をコンテキストとして利用できる

- [Context] Workspace概要Context Providerを実装する

  - ワークスペースルート、主要ディレクトリ、主要設定ファイルを収集する
  - 除外パターンとサイズ上限を適用する
  - 完了条件: 会話開始時にプロジェクト構造の概要を生成できる

- [Context] 指示ファイル探索を実装する

  - `AGENTS.md`などの指示ファイルを探索する
  - ディレクトリ階層に応じた適用範囲を判定する
  - 指示ファイルを信頼できない入力として扱う
  - 完了条件: リポジトリ固有指示を安全にプロンプトへ追加できる

- [Context] コンテキスト重複排除を実装する

  - URI、Range、Content Hashで重複を検出する
  - 同一内容に複数の出典がある場合は優先度を統合する
  - 完了条件: 同じコードが重複してモデルへ送信されない

- [Context] Token Budgeterを実装する

  - モデルのContext Windowから利用可能量を算出する
  - システム、履歴、明示添付、検索結果、Tool Resultへ配分する
  - 予算超過時に低優先度項目を削除する
  - 完了条件: リクエストがモデルのContext Windowを超えない

- [Context] Token推定インターフェースを実装する

  - 厳密Token Counterがない場合の推定方式を実装する
  - Provider固有Token Counterを差し込めるようにする
  - 完了条件: Providerに依存せず予算計算ができる

---

## Milestone 6: プロンプトシステム

- [Prompt] Prompt Module基盤を実装する

  - `PromptModule`インターフェースを定義する
  - 優先順位、適用条件、レンダリングを実装する
  - 完了条件: システムプロンプトを複数モジュールから構築できる

- [Prompt] 基本コーディングエージェントプロンプトを作成する

  - 調査、編集、検証、報告の基本規則を定義する
  - 未確認情報を断定しない規則を含める
  - 完了条件: 読み取り専用ツールを使ってコード調査を進められる

- [Prompt] ツール利用規則モジュールを作成する

  - Tool Call前後の振る舞いを定義する
  - 同じ失敗を無限反復しない規則を追加する
  - 読み取りと変更ツールの使い分けを明示する
  - 完了条件: Tool Calling時の基本動作が安定する

- [Prompt] 編集規則モジュールを作成する

  - 関連コードを読んでから編集する
  - 変更範囲を最小化する
  - 既存スタイルを維持する
  - テストを更新する
  - 完了条件: パッチ生成時の編集方針が一貫する

- [Prompt] 完了報告モジュールを作成する

  - 変更ファイル、主要変更、テスト結果、未解決事項を報告させる
  - 実行していない検証を実行済みと表現させない
  - 完了条件: タスク終了時の報告形式が一定になる

- [Prompt] モデルファミリー別Prompt Profileを実装する

  - 共通モジュールとProvider固有差分を分離する
  - JSON設定からProfileを選択できるようにする
  - 完了条件: モデルごとにTool Calling上の指示を調整できる

- [Prompt] Promptのデバッグ表示機能を実装する

  - 開発モードで構築済みPromptを確認できるようにする
  - Secretや機密コンテキストをマスクする
  - 完了条件: Prompt構成問題を追跡できる

---

## Milestone 7: ツール基盤

- [Tools] ToolDefinitionとToolResultの共通型を定義する

  - 名前、説明、入力Schema、Category、権限情報を定義する
  - 成功、失敗、切り詰め、Artifact参照を表現する
  - 完了条件: 組み込みツールを共通形式で登録できる

- [Tools] Tool Registryを実装する

  - ツール登録、取得、一覧、重複検出を実装する
  - モデル能力と実行環境に応じて利用可能ツールを絞る
  - 完了条件: リクエスト単位でモデルへ渡すツールを決定できる

- [Tools] Tool入力JSON Schema検証を実装する

  - AJVでモデル生成引数を検証する
  - 不正入力をTool Result形式でモデルへ返す
  - 不明な追加プロパティの扱いを定義する
  - 完了条件: 不正なTool Callが実行処理へ到達しない

- [Tools] Tool Executorを実装する

  - 実行、Timeout、Abort、例外捕捉を共通化する
  - 実行時間と結果サイズを計測する
  - Tool Eventを発行する
  - 完了条件: すべてのツールが共通の実行経路を通る

- [Tools] Tool Result圧縮を実装する

  - ANSI除去、最大長制限、先頭・末尾保持を行う
  - 完全出力をArtifactへ退避する
  - Secretらしき文字列をマスクする
  - 完了条件: 巨大な出力でContext Windowを消費しない

- [UI] Tool Activity表示を実装する

  - queued、running、succeeded、failedを表示する
  - 引数と結果を折りたたみ表示する
  - 実行時間を表示する
  - 完了条件: ユーザーがエージェントのツール使用状況を追跡できる

---

## Milestone 8: 読み取りツール

- [Tool] `read_file`を実装する

  - ファイル全体または行範囲を読み取る
  - 文字コード、サイズ上限、バイナリ判定に対応する
  - 行番号付き出力を返す
  - 完了条件: ワークスペース内のテキストファイルを安全に読める

- [Tool] `list_files`を実装する

  - ディレクトリ直下または再帰列挙に対応する
  - 除外設定と件数上限を適用する
  - 完了条件: ワークスペース構造をモデルが探索できる

- [Tool] `search_text`を実装する

  - VS Code Workspace Search APIを使用する
  - Glob、件数上限、Context行数を指定できるようにする
  - 完了条件: 文字列または正規表現でコードを検索できる

- [Tool] `get_symbols`を実装する

  - Document SymbolとWorkspace Symbolを取得する
  - Symbol種別、位置、コンテナ名を返す
  - 完了条件: モデルがコード構造を効率的に把握できる

- [Tool] `get_references`を実装する

  - 定義、実装、参照の取得に対応する
  - Language Server未対応時のエラーを明確にする
  - 完了条件: シンボルの使用箇所をモデルが追跡できる

- [Tool] `get_diagnostics`を実装する

  - ファイル指定とワークスペース全体に対応する
  - Severityでフィルタできるようにする
  - 完了条件: モデルが現在のエラー状態を取得できる

- [Tool] `git_status`を実装する

  - Git拡張APIまたは安全なGit呼び出しを使用する
  - 変更、未追跡、競合状態を返す
  - 完了条件: モデルが作業ツリー状態を確認できる

- [Tool] `git_diff`を実装する

  - ファイル単位、ステージ済み、未ステージ差分を取得する
  - 大きな差分を制限する
  - 完了条件: 既存変更を上書きせず考慮できる

---

## Milestone 9: Agent Loop

- [Agent] Agent State Machineを実装する

  - idleからcompleted、failed、cancelledまでの状態を定義する
  - 不正な状態遷移を防ぐ
  - 状態変更イベントをUIへ通知する
  - 完了条件: Agent実行状態を一貫して管理できる

- [Agent] Agent Runtimeの基本実行フローを実装する

  - モデル解決、コンテキスト収集、Prompt構築、Provider呼び出しを接続する
  - ストリーミングイベントをUIへ中継する
  - 完了条件: ツールなしの会話をAgent Runtime経由で実行できる

- [Agent] Tool Calling Loopを実装する

  - モデルのTool Callを取得する
  - Tool実行結果を履歴へ追加する
  - 結果を含めてモデルを再呼び出しする
  - 完了条件: 複数回の連続Tool Callを処理できる

- [Agent] 並列Tool Call処理を実装する

  - 読み取り専用で並列可能なツールを同時実行する
  - 書き込みや依存関係のあるツールは直列化する
  - Providerが並列呼び出し非対応の場合は無効化する
  - 完了条件: 独立した読み取りツールを安全に並列実行できる

- [Agent] Agent停止条件を実装する

  - 最大反復回数、最大Tool Call数、連続失敗数を監視する
  - 上限到達時に理由を表示する
  - 完了条件: 無限ループや過剰なAPI利用を防止できる

- [Agent] Agentキャンセル処理を実装する

  - Provider、Context Provider、Tool ExecutorへAbortSignalを伝播する
  - キャンセル後のイベント発行を停止する
  - 完了条件: UIの停止操作で処理全体を中断できる

- [Agent] Usage集計を実装する

  - 入力、出力、キャッシュTokenを集計する
  - スレッド単位とRun単位で記録する
  - ProviderがUsageを返さない場合を扱う
  - 完了条件: 利用量をUIまたはログで確認できる

- [Tool] `complete_task`を実装する

  - タスク完了理由と最終サマリーを受け取る
  - 未適用ChangeSetや未確認操作がある場合は警告する
  - 完了条件: モデルが明示的にエージェントループを終了できる

- [Tool] `update_plan`を実装する

  - 作業ステップと状態を更新する
  - UIに現在の作業計画を表示する
  - 完了条件: 長いタスクの進行状況を追跡できる

---

## Milestone 10: 権限と承認

- [Permissions] Permission Policy Engineを実装する

  - Tool Categoryと権限プロファイルから実行可否を判定する
  - always allow、confirm、denyを返す
  - 完了条件: すべてのTool Callが権限判定を通る

- [Permissions] 承認要求モデルを実装する

  - 操作内容、対象、理由、リスクを構造化する
  - 単発許可と同一Run内許可を区別する
  - 完了条件: 危険操作前に必要情報をユーザーへ提示できる

- [UI] Tool承認ダイアログを実装する

  - Approve、Rejectを提供する
  - コマンド、対象ファイル、外部接続先を表示する
  - 完了条件: UIからTool実行を承認または拒否できる

- [Permissions] 常時確認対象操作を定義する

  - 削除、外部通信、Git push、公開、デプロイを常時確認にする
  - 権限プロファイルで上書きできない操作を定義する
  - 完了条件: 高リスク操作が自動実行されない

- [Security] Workspace Trust連携を実装する

  - `workspace.isTrusted`を監視する
  - 未信頼時は実行、書き込み、MCPを無効化する
  - `restrictedConfigurations`を定義する
  - 完了条件: Restricted Modeでコード実行が発生しない

---

## Milestone 11: 変更管理と差分レビュー

- [Changes] PendingChangeSetモデルを実装する

  - modify、create、delete、renameを表現する
  - 元ファイルのHashを保存する
  - スレッドおよびRunと関連付ける
  - 完了条件: 未適用変更を一つの単位として管理できる

- [Changes] Unified Diff Parserを実装する

  - Unified Diffを解析する
  - 複数ファイル、複数Hunkを扱う
  - 不正なPatchを明確に拒否する
  - 完了条件: モデル生成Patchを安全に構造化できる

- [Changes] Patch適用シミュレーションを実装する

  - ディスクへ書き込まず、提案後テキストを生成する
  - Context不一致と競合を検出する
  - 完了条件: ChangeSet作成時点ではファイルが変更されない

- [Tool] `apply_patch`を実装する

  - PatchをPendingChangeSetへ追加する
  - 対象ファイルの範囲とHashを検証する
  - 完了条件: モデルが差分として変更を提案できる

- [Tool] `create_file`を実装する

  - 新規ファイルをPendingChangeSetへ追加する
  - 既存ファイルとの衝突を検出する
  - 完了条件: モデルが新しいファイルを提案できる

- [Tool] `delete_file`を実装する

  - 削除対象をPendingChangeSetへ追加する
  - 削除は常に明示確認対象とする
  - 完了条件: ディスクへ即時反映せず削除案を提示できる

- [Tool] `rename_file`を実装する

  - 元パスと新パスを検証する
  - 新パスの競合とワークスペース外移動を拒否する
  - 完了条件: リネーム案をChangeSetとして保持できる

- [Changes] Virtual Document Providerを実装する

  - 変更前と提案後の仮想ドキュメントを提供する
  - `vscode.diff`から参照できるURIを生成する
  - 完了条件: 提案変更をVS Code標準Diff Editorで開ける

- [UI] ChangeSet一覧を実装する

  - 変更ファイル、変更種別、追加削除行数を表示する
  - ファイル単位でDiffを開ける
  - 完了条件: サイドバーから変更内容を把握できる

- [UI] ChangeSetのAccept／Reject操作を実装する

  - ファイル単位とChangeSet全体の操作を提供する
  - 削除や競合を明確に表示する
  - 完了条件: ユーザーが提案変更の採否を選択できる

- [Changes] WorkspaceEditによる変更適用を実装する

  - 承認された変更を一括適用する
  - 適用前にBase Hashを再検証する
  - 部分失敗時に整合性を保つ
  - 完了条件: 承認済みChangeSetだけがディスクへ反映される

- [Changes] 変更競合処理を実装する

  - 編集中に元ファイルが変化した場合を検出する
  - 自動上書きを禁止する
  - 再生成または手動解決を選べるようにする
  - 完了条件: ユーザーの並行編集を失わない

---

## Milestone 12: コマンドとテスト実行

- [Execution] Command Requestモデルを定義する

  - command、args、cwd、env、reason、timeoutを分離する
  - シェル文字列依存を最小化する
  - 完了条件: コマンド実行内容を構造的に検査できる

- [Security] コマンドリスク判定を実装する

  - `sudo`、削除、ネットワーク、リダイレクト、Git書き込みを検出する
  - Allow ListとDeny Listを実装する
  - 完了条件: 危険コマンドが承認なしで実行されない

- [Tool] `run_command`を実装する

  - 非対話コマンドを子プロセスとして実行する
  - Timeout、Cancel、出力上限を実装する
  - Exit Codeと要約を返す
  - 完了条件: 承認済みコマンドを安全に実行できる

- [Tool] `run_tests`を実装する

  - package.jsonや設定ファイルからテスト候補を推定する
  - 実行するコマンドを事前表示する
  - 失敗箇所を要約する
  - 完了条件: 変更後のテストをモデルが実行できる

- [Tool] `run_task`を実装する

  - VS Code Task一覧から指定Taskを実行する
  - 存在しないTaskを明確に扱う
  - 完了条件: 既存のビルドまたはテストTaskを利用できる

- [Execution] Terminal表示連携を実装する

  - ユーザー確認が必要な実行をTerminalへ表示する
  - 実行中コマンドと終了状態をUIへ反映する
  - 完了条件: コマンド実行をユーザーがVS Code上で追跡できる

---

## Milestone 13: 長期セッションとコンパクション

- [Context] 会話要約データモデルを定義する

  - 目的、要件、決定、変更ファイル、テスト、未解決事項を構造化する
  - 完了条件: 古い会話を構造化サマリーへ置換できる

- [Context] 会話履歴コンパクションを実装する

  - Token使用率が閾値を超えた場合に要約する
  - 直近ターンは原文を維持する
  - 要約失敗時のフォールバックを実装する
  - 完了条件: 長時間セッションでもContext Window超過を防げる

- [Prompt] 会話要約専用プロンプトを作成する

  - 事実、決定、未完了作業を保持する
  - 不要な会話表現や重複を削除する
  - 完了条件: 再開に必要な情報を失わない要約を生成できる

- [Context] 静的コンテキストキャッシュを実装する

  - OS、Workspace概要、指示ファイルをキャッシュする
  - ファイル変更時に該当キャッシュを無効化する
  - 完了条件: 各ターンで同じ静的情報を再生成しない

- [Agent] モデル変更時の履歴変換を実装する

  - Provider固有メッセージを内部形式から再構築する
  - 非互換Tool Call履歴をサマリーへ変換する
  - 完了条件: スレッド途中でモデルを変更して継続できる

---

## Milestone 14: 追加Provider

- [Provider] Anthropic Messages Adapterを実装する

  - System、Content Block、Tool Use、Tool Resultを変換する
  - ストリーミングとUsageを正規化する
  - 完了条件: Anthropic APIでAgent Loopが動作する

- [Provider] Gemini Adapterを実装する

  - Content、Function Declaration、Function Callを変換する
  - Tool Resultの順序制約を吸収する
  - 完了条件: Gemini APIでAgent Loopが動作する

- [Provider] Provider固有ヘッダーと追加パラメーターを実装する

  - 許可された追加ヘッダーを設定できるようにする
  - Authorizationなどの予約ヘッダーを禁止する
  - 完了条件: 企業Gateway固有設定へ安全に対応できる

---

## Milestone 15: MCP

- [MCP] MCP Server設定Schemaを定義する

  - Transport、Command、URL、Environment、許可Toolを定義する
  - ワークスペース設定の安全制約を追加する
  - 完了条件: MCP接続先をJSONで定義できる

- [MCP] MCP Client Managerを実装する

  - MCP Serverの起動、接続、再接続、停止を管理する
  - Serverごとの状態をUIへ通知する
  - 完了条件: 複数MCP Serverを独立して管理できる

- [MCP] MCP Tool Adapterを実装する

  - MCP Toolを内部`ToolDefinition`へ変換する
  - 名前空間を付与する
  - 入出力Schemaを検証する
  - 完了条件: MCP ToolをAgent Loopから呼び出せる

- [MCP] MCP権限ポリシーを実装する

  - Server単位とTool単位の許可を実装する
  - 外部通信や書き込み操作を承認対象にする
  - 完了条件: MCP Toolが組み込みツールと同じ権限管理を通る

- [UI] MCP接続状態表示を実装する

  - Connected、Disconnected、Errorを表示する
  - Serverと提供Tool一覧を確認できるようにする
  - 完了条件: ユーザーが利用中のMCP Serverを把握できる

---

## Milestone 16: セキュリティ強化

- [Security] ワークスペース内パス検証を実装する

  - `..`、絶対パス、UNC、デバイスパスを検査する
  - OSごとのCase Sensitivityを扱う
  - 完了条件: Toolからワークスペース外へアクセスできない

- [Security] Symlink Escape対策を実装する

  - Real Pathを解決してワークスペース内か再確認する
  - 存在しない新規パスでは親ディレクトリを検証する
  - 完了条件: Symlink経由で外部ファイルへアクセスできない

- [Security] Secret Redactorを実装する

  - APIキー、Token、Authorization、`.env`形式を検出する
  - ログ、Tool Result、エラー表示へ適用する
  - 完了条件: 既知形式の秘密情報がログやUIへ露出しない

- [Security] Provider URL検証を実装する

  - HTTPSを必須とする
  - localhostだけ明示設定でHTTPを許可する
  - URL内認証情報を禁止する
  - リダイレクト先も再検証する
  - 完了条件: 意図しない外部送信先を使用できない

- [Security] コンテキスト送信前の機密ファイル判定を実装する

  - `.env`、秘密鍵、認証設定を既定除外する
  - 明示添付時は警告する
  - 完了条件: 機密ファイルを無意識にモデルへ送信しない

- [Security] 大量変更の検出と承認を実装する

  - 変更ファイル数、総行数、削除率の閾値を設定する
  - 閾値超過時は権限にかかわらず確認する
  - 完了条件: 大規模な意図しない変更を防止できる

---

## Milestone 17: ログと観測性

- [Observability] Agent Loggerを実装する

  - Run ID、Thread ID、Provider、Model、Tool名を記録する
  - Prompt本文とファイル内容は既定で記録しない
  - 完了条件: 問題発生時に処理経路を追跡できる

- [Observability] Trace Eventモデルを実装する

  - Context収集、Prompt構築、Provider呼び出し、Tool実行を計測する
  - 各処理の所要時間を記録する
  - 完了条件: Agent実行のボトルネックを分析できる

- [Observability] ローカルデバッグTrace Viewerを実装する

  - 開発モード限定でRun単位のイベントを表示する
  - Secret Redactorを適用する
  - 完了条件: 開発者がAgent Loopの流れを確認できる

- [Privacy] テレメトリーポリシーを定義する

  - 初期版では外部テレメトリーを無効とする
  - 将来導入時のオプトイン条件を文書化する
  - 完了条件: 収集データの有無と範囲が明確になる

---

## Milestone 18: テストと品質保証

- [Test] Model Configの単体テストを作成する

  - 正常設定、不正設定、マージ、既定値を検証する
  - 完了条件: 設定変更による回帰を検出できる

- [Test] Context Budgeterの単体テストを作成する

  - 優先順位、重複排除、予算超過、明示添付保持を検証する
  - 完了条件: Token予算の決定性を保証できる

- [Test] Tool RegistryとSchema検証の単体テストを作成する

  - 重複登録、不正入力、利用不可Toolを検証する
  - 完了条件: Tool基盤の契約を自動検証できる

- [Test] Path TraversalとSymlink Escapeのテストを作成する

  - Linux、macOS、Windows形式のパスを検証する
  - 完了条件: 代表的なパス脱出攻撃を防止できる

- [Test] Patch Parserと競合検出のテストを作成する

  - 複数Hunk、新規、削除、改名、Context不一致を検証する
  - 完了条件: Patch適用の回帰を検出できる

- [Test] Fake ModelによるAgent Simulation基盤を作成する

  - あらかじめ定義したTextとTool Callを返すFake Providerを実装する
  - 完了条件: 実APIを使わずAgent Loopを再現できる

- [Test] 読み取りエージェントのシナリオテストを作成する

  - 検索、ファイル読み取り、診断取得、完了までを検証する
  - 完了条件: 複数Tool Callの順序と結果伝播を保証できる

- [Test] 編集エージェントのシナリオテストを作成する

  - 調査、Patch作成、Diff確認、Applyまでを検証する
  - 完了条件: 承認前にディスクが変更されないことを保証できる

- [Test] Agent上限とキャンセルのシナリオテストを作成する

  - 無限Tool Call、連続失敗、ユーザー停止を検証する
  - 完了条件: Agentが必ず停止可能であることを保証できる

- [Test] Extension Integration Testを作成する

  - Webview、SecretStorage、WorkspaceEdit、再起動復元を検証する
  - 完了条件: VS Code Extension Host上で主要機能が動作する

- [Test] Remote Development環境の検証を行う

  - Dev Container、SSH、WSLでProvider通信とファイル操作を確認する
  - SecretStorageとパス処理の差異を確認する
  - 完了条件: 対応対象のRemote環境を明文化できる

---

## Milestone 19: ドキュメントとリリース

- [Docs] モデル設定ガイドを作成する

  - Provider追加、Model定義、Capabilities、APIキー設定を説明する
  - 設定例を複数掲載する
  - 完了条件: ユーザーがコード変更なしでモデルを追加できる

- [Docs] セキュリティとデータ送信仕様を文書化する

  - モデルへ送信される情報を説明する
  - 除外ファイル、Workspace Trust、権限モードを説明する
  - 完了条件: ユーザーがデータ送信範囲を理解できる

- [Docs] Toolと権限プロファイルの仕様を文書化する

  - 各Toolの動作とリスクを説明する
  - 権限プロファイルごとの差を表にする
  - 完了条件: 自動実行範囲が明確になる

- [Docs] 開発者向けProvider実装ガイドを作成する

  - Adapter契約、イベント形式、Contract Testを説明する
  - 完了条件: 外部開発者がProviderを追加できる

- [Docs] 開発者向けTool実装ガイドを作成する

  - Schema、権限、Timeout、Result圧縮を説明する
  - 完了条件: 新しい組み込みToolを安全に追加できる

- [Release] Marketplace向けpackage.jsonを整備する

  - 表示名、説明、カテゴリ、アイコン、Repositoryを設定する
  - CodexやCopilotとの誤認を避ける名称と説明にする
  - 完了条件: Marketplace検証を通過できる

- [Release] CIパイプラインを構築する

  - Lint、型検査、Unit Test、Integration Test、Buildを実行する
  - VSIX生成を自動化する
  - 完了条件: Pull Requestごとに品質チェックが実行される

- [Release] 初回VSIXリリースを作成する

  - Changelogを作成する
  - 既知の制約を記載する
  - 署名またはChecksumを提供する
  - 完了条件: MVPをVSIXとしてインストールして利用できる

---

# 推奨する最初のMVP対象Issue

以下を最初のリリース対象とする。

- VS Code拡張プロジェクトの初期構成
- Contribution Points
- Agent Sidebar
- Webview通信
- スレッド表示
- Composer
- モデル設定JSON Schema
- モデル設定ローダー
- Model Catalog
- SecretStorage
- Provider共通インターフェース
- OpenAI Responses Adapter
- Thread Store
- Context Provider基盤
- アクティブエディタ・選択範囲Context
- Context Token Budgeter
- Prompt Module基盤
- 基本エージェントプロンプト
- Tool Registry
- Tool入力検証
- Tool Executor
- `read_file`
- `list_files`
- `search_text`
- `get_diagnostics`
- Agent State Machine
- Agent Runtime
- Tool Calling Loop
- Agent停止・キャンセル
- Permission Policy Engine
- PendingChangeSet
- Unified Diff Parser
- `apply_patch`
- Virtual Document Provider
- ChangeSet一覧
- ChangeSet Accept／Reject
- WorkspaceEdit適用
- `run_command`
- Commandリスク判定
- 基本Unit Test
- Agent Simulation
- モデル設定ガイド
- セキュリティ仕様書
- CIとVSIX生成
