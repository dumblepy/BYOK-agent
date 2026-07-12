# Notice

## 本プロジェクト

Copyright (c) 2026 dumblepy

本プロジェクトのソースコードは、リポジトリルートの[`LICENSE`](./LICENSE)に記載されたMIT Licenseで許諾されます。

## Copilot Chat由来コード

2026-07-12時点で、リポジトリ内の実装コード（`src/`、`tests/`、`scripts/`）を監査した結果、Copilot Chatの特定コミットからコピーまたは改変したコードはありません。

`documents/design.md`、`readme.md`およびルールファイルにあるCopilot Chatへの言及は、設計上の参照であり、特定のソースコードの移植ではありません。そのため、現時点の`CCH-xxxx`出典レコードはありません。

今後、Copilot Chat由来コードを利用する場合は、次のファイル単位レコードを追加し、完全なコミットSHA、原ファイル、原範囲、移植先、変更内容を記録します。

```text
## CCH-0001: <短い識別名>
- Source repository: <リポジトリURL>
- Source commit: <完全なコミットSHA>
- Source license: <ライセンス識別子>
- Source file: <リポジトリルートからの原ファイルパス>
- Source range: <行範囲または関数・シンボル名>
- Destination file: <本リポジトリ内の移植先パス>
- Usage: copied | modified
- Retrieved/verified on: <YYYY-MM-DD>
- Changes: <変更内容>
- Review notes: <ライセンス表示の保持と差分確認の記録>
```

## 依存パッケージの追加表示

依存パッケージのライセンス、バージョン、配布元は[`THIRD_PARTY_LICENSES.md`](./THIRD_PARTY_LICENSES.md)に一覧化しています。依存パッケージのライセンスは本プロジェクトのMIT Licenseには含まれません。

### Preact 10.29.7

The VSIX runtime includes Preact, which is distributed under the following MIT License notice:

```text
The MIT License (MIT)

Copyright (c) 2015-present Jason Miller

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

`@vscode/vsce-sign@2.0.9`および`@vscode/vsce-sign-linux-x64@2.0.6`は、パッケージ内の`LICENSE.txt`に記載されたMicrosoft Software License Termsに従います。これらはdevelopment依存であり、拡張機能の配布物には含めません。利用時は同ライセンスのVisual Studio Products and Servicesに関する制限を確認してください。

### Microsoft Software License Terms

`@vscode/vsce-sign`系の正確なライセンス本文は、各パッケージに同梱された`LICENSE.txt`を正本とします。ライセンスはMicrosoft Software License Termsであり、Visual Studio Products and Servicesでの開発・テスト用途、再配布、通知の変更などに制限があります。開発依存としてのみ使用し、拡張機能の配布物には含めません。台帳のリンクから、対象バージョンの配布元とライセンスファイルを確認できます。
