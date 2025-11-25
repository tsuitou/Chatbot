# Agent Workflow Overview / エージェント構成概要

## Pipeline / フロー
- **PRE_CHECK** (finalModel): 判断だけ。`start_agent`を呼ぶか即答するかを決定。ツール無し。
- **CLARIFY** (baseModel): 用語/バージョン確認。必ずツール使用。出力 `<CLARIFY_OUTPUT>`.
- **PLAN** (baseModel): CLARIFYを信用し未知とリサーチ目的を整理（Stage1前提→Stage2本命）。ツール不要。出力 `<PLAN_OUTPUT>`.
- **RESEARCH** (baseModel, ループ): Stage1サブクエリ→Stage2メインを実行。googleSearch/urlContext必須。出力 `<RESEARCH_NOTES>`.
- **CONTROL** (baseModel, ループ): カバレッジ/品質を見て `control_step` で `research` or `final` を決定。出力 `<CONTROL_DECISION>`.
- **FINAL** (finalModel): ユーザー向け回答のみ。必要なら FINAL_URLS を urlContext で確認可。エージェントタグなし。

## Models / モデル
- `AGENT_BASE_MODEL` → baseModel（PRE_CHECK/CLARIFY/PLAN/RESEARCH/CONTROL）例: `gemini-2.5-flash`
- `finalModel` → FINAL（ユーザー回答用）
- 思考設定は共通 (`baseThinking`)。

## Tools / ツール
- googleSearch, urlContext: CLARIFY/PLAN/RESEARCH で利用可（PLANは必要時のみ）。RESEARCHは必須で使う。FINALも urlContext 使用可。
- CONTROLは `control_step` のみ。

## Tags & Thoughts / タグ・思考規律
- 内部ステップは必須タグ内のみ出力、タグ外文字ゼロ。思考は `Thinking Process:<AGENT>` で開始。
- FINALはタグ/AGENTマーカーなしのユーザー向け。

## Grounding Summary Toggle / グラウンディング要約
- `AGENT_INCLUDE_GROUNDING` (default `false`): `true` なら収集済み sources/queries の要約をプロンプトに注入。`false` なら省いてトークン節約（ノートは渡る）。

## Date / 日付
- 各ステップにローカル日付 `YYYY-MM-DD` を渡す。鮮度判断に利用。

## Research Stages / リサーチ段階
- Stage1: サブクエリで前提（バージョン/互換/機能）確認。
- Stage2: 本命クエリでユーザー要求に回答。
- PLANにサブクエリがあれば Stage1/Stage2 各1回以上。なければ Stage2のみ1回以上。

## FINAL_URLS
- RESEARCHは `FINAL_URLS` を出力（タイトル + URL + authority）。公式/高信頼を優先。
- FINALは必要に応じて urlContext で内容確認可。出力はタイトル/IDのみでURLは出さない。

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
