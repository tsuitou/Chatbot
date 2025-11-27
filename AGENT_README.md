# Agent Workflow Overview / エージェント構成概要

## Pipeline / フロー
- **PRE_CHECK** (finalModel): 判断だけ。`start_agent`を呼ぶか即答するかを決定。ツール無し。
- **CLARIFY** (baseModel): 用語/バージョン確認。必ずツール使用。出力 `<CLARIFY_OUTPUT>`.
- **PLAN** (baseModel): CLARIFYを信用し未知とリサーチ目的を整理。検索/urlContextで対象やクエリを決めるが、事実は出力しない。出力 `<PLAN_OUTPUT>`.
- **FINAL** (finalModel): ユーザー向け回答のみ。必要に応じて googleSearch/urlContext で実際の調査を行い回答する。エージェントタグなし。URLは出力しない。

## Models / モデル
- `AGENT_BASE_MODEL` → baseModel（PRE_CHECK/CLARIFY/PLAN/RESEARCH/CONTROL）例: `gemini-2.5-flash`
- `finalModel` → FINAL（ユーザー回答用）
- 思考設定は共通 (`baseThinking`)。

## Tools / ツール
- googleSearch, urlContext: CLARIFY/PLAN で利用可（PLANは対象・クエリ決定のために使うが事実出力なし）。FINAL でも不足があれば利用可。URLは回答に出さない。

## Tags & Thoughts / タグ・思考規律
- 内部ステップは必須タグ内のみ出力、タグ外文字ゼロ。思考は `Thinking Process:<AGENT>` で開始。
- FINALはタグ/AGENTマーカーなしのユーザー向け。
- 全ステップで「事実」と「推測/仮定」を明示的に分け、怪しいものは「待て、本当に正しいか？」と立ち止まり確認。不明なら不明と記す。

## Grounding Summary Toggle / グラウンディング要約
- `AGENT_INCLUDE_GROUNDING` (default `false`): `true` なら収集済み sources/queries の要約をプロンプトに注入。`false` なら省いてトークン節約（ノートは渡る）。

## Date / 日付
- 各ステップにローカル日付 `YYYY-MM-DD` を渡す。鮮度判断に利用。

## Research Stages / リサーチ段階
- PLANで未知を洗い出し、検索でリサーチ計画とクエリ・対象を決める（事実は出さない）。
- FINALで必要な検索/urlContextを実行し、結果に基づいて回答を仕上げる。

## Source Reliability / 参照の信頼性
- API/ライブラリ/仕様/数学/科学などは urlContext でページ内容を取得し、スニペット頼りにしない。
- 前段結果を尊重し、覆す場合は即ツールで再検証。

## Files / 主なファイル
- `backend/agent/runner.js`: ステップ実行・チャット組み立て・プロンプト注入・grounding転送。
- `backend/agent/prompts.js`: 共通ルール、クリティカルルール、ターン別プロンプト。

## Env / セットアップ
- `AGENT_BASE_MODEL` (例: `gemini-2.5-flash`)
- `finalModel`（設定元に依存）
- `AGENT_INCLUDE_GROUNDING` (default `false`)
- `AGENT_DEBUG=true` でランナーのデバッグログ出力
