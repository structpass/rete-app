# model-guardrails — ランチャーが system prompt 末尾へ注入する操作作法（brd-0253）

**このファイルは本文の唯一の正本**。`launch-claude-common.ps1` が起動時に読み、`--append-system-prompt` へ
識別子の一文と連結して渡す（DeepSeek / MiniMax / Qwen の全入口へ共通適用）。

- **他所へ再掲しない**。rete/CLAUDE.md からは pointer だけを張る（規範の再掲禁止・rules/common/workflow-core.md）。
  複製が起きるのは起動時の配信だけなので、「片側だけ更新されて矛盾する」という禁止理由が成立しない。
- **本文（下の fenced block の中身）だけが注入される**。この見出しと注記は注入されない。
- 5 行を大きく増やさない。長くするほど末尾配置の効き（信号強度）が落ちる。
- **Cline 系統（`launch-cline.ps1`）へは注入されない**。あちらは共通 launcher（`launch-claude-common.ps1`）を
  経由せず起動するため（意図どおり＝Cline は `.clinerules/` を常時ロードする別系統）。CL 側で同じ減衰が
  観測されたら、`.clinerules/` 側へ同等の再掲を置く判断になる（brd-0255 LOW 5）。

背景: セッション優勢モデル別の実測（maint-log digest 2026-08-06 の軸1-c）で、軽量モデルほど
常時ロードの奥にある細目（Bash 作法・編集前 Read・横断検索）を保持し切れず、系統エラーと重複 Read が
突出した。見出し級の規約（レビュー agent の起動等）は守れているので、**規約の不在ではなく位置による減衰**。
そこで細目だけを system prompt 末尾へ再掲して信号を立て直す。

```guardrails
ツール操作の鉄則（違反すると必ず失敗する）:
1. Edit と Write（既存ファイルの上書きを含む）の前に対象ファイルを必ず Read する。old_string は直前の Read 出力から一字一句コピーする（記憶や推測で書かない。行番号プレフィックスは除く）。
2. Bash は Git Bash（POSIX）。PowerShell/cmd 構文（Select-Object・Get-ChildItem・2>$null・dir /s /b 等）は書かない。パスは D:\ でなく /d/Claude/... の forward slash。git のパス指定も同様。
3. 横断検索は Grep/Glob ツールを使う。Bash での rg・grep -r・find -name は使わない。
4. 一時ファイルはリポジトリ直下の tmp/ の絶対パスに置く。
5. 自分が Edit/Write した直後のファイルは再 Read しない（成功していれば内容は把握済み）。
```
