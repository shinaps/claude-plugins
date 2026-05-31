---
name: tech-survey
description: 技術選定特化の調査スキル。WebSearch / WebFetch で最新情報を集め、ライブラリ・フレームワーク・サービスの候補を観点別に比較する。spec.md / 自由記述 / /zeus:spec からの橋渡しに対応。選択結果を spec.md に追記してそのまま /zeus:dev へ進める
argument-hint: <なし | spec.md パス | 自由記述の要望>
---

# Zeus Tech Survey スキル（技術選定担当）

要件は固まっているが「どの言語・ライブラリ・サービスを使うか」が未確定なフェーズで、**最新情報をもとに候補を比較してくれる調査スキル**。
`zeus-tech-surveyor`（一次調査）と `zeus-survey-validator`（妥当性検証）の二段構成で、情報の鮮度と出典の正確性を担保する。

zeus プラグインの主要スキルは:

- **`/zeus:spec`**: 要件定義・仕様策定
- **`/zeus:tech-survey`**（このスキル）: 技術選定の調査・比較
- **`/zeus:dev`**: 仕様や明確なタスクから「計画策定 → 実装 → セルフレビュー」を一気通貫で実行
- **`/zeus:review`**: 単独レビュー（修正計画への橋渡し可能）

## 引数仕様と動作モード

| 呼び出し | モード | 動作 |
|---|---|---|
| `/zeus:tech-survey` | **interactive モード** | `AskUserQuestion` で「何を選定したいか」「制約」を聞いてから開始 |
| `/zeus:tech-survey <spec.md パス>` | **spec モード** | spec.md を読み込み、未確定の技術論点を抽出して調査 |
| `/zeus:tech-survey <自由記述>` | **freeform モード** | 自由記述の要望をそのまま調査依頼として扱う |

引数判定:
- 引数なし → interactive モード
- `.md` で終わるかつファイルが存在する → spec モード
- それ以外の文字列 → freeform モード

## 使用エージェント

| エージェント | subagent_type | 役割 |
|---|---|---|
| Zeus Tech Surveyor | `zeus-tech-surveyor` | WebSearch/WebFetch で候補を集めて観点別比較レポートを作成 |
| Zeus Survey Validator | `zeus-survey-validator` | 出典・鮮度・主張の妥当性を検証 |

## ディレクトリ規約

調査結果は以下に保存:

```
.claude/zeus/tech-surveys/{YYYYMMDD-HHMMSS}-{slug}/
├── input.md                ← 調査対象のサマリ（モード、対象、制約）
├── survey.md               ← zeus-tech-surveyor の生レポート
├── survey-validated.md     ← zeus-survey-validator の検証済みレポート
├── tech-decision.md        ← 採用決定の記録（独立保存選択時のみ）
└── plan-handoff.md         ← /zeus:dev への引き継ぎ（橋渡し時のみ）
```

`{slug}` は調査対象の短い英語スラッグ（kebab-case, 30 文字以内）。

## 実行フロー

### Phase 1: 引数判定と入力収集

引数を判定し、モード別に入力を集める:

#### interactive モード（引数なし）
1. `AskUserQuestion` で対象領域を聞く（例: フロントエンドフレームワーク / 認証 / DB / ORM / メール送信サービス など）
2. 続けて制約を聞く（言語・既存スタック・予算・自前ホスト可否など）
3. 必要に応じて 2〜3 段階まで深掘り

#### spec モード（引数が `.md` パスかつ存在）
1. spec.md を Read
2. **未確定の技術論点** を抽出:
   - 「[未解決]」マークのある項目
   - 制約セクションで「{言語/ライブラリ}: 未定」となっている項目
   - 機能要件から逆算して必要な技術カテゴリ（認証が必要なら認証ライブラリなど）
3. 抽出結果が曖昧なら `AskUserQuestion` で「どれを優先的に調査するか」を確認

#### freeform モード（その他文字列）
1. 引数文字列をそのまま入力に
2. 内容が曖昧で調査範囲が確定できない場合のみ `AskUserQuestion` で 1 回だけ確認

### Phase 2: input.md 保存

`input.md` に以下を保存:

```markdown
# 調査対象

- モード: {interactive / spec / freeform}
- 取得時刻: {YYYY-MM-DD HH:MM:SS}
- 元入力: {引数文字列または "なし"}

## 調査対象

{何を選定するか。spec モードなら spec.md からの抽出箇所も併記}

## 既知の制約

- 言語/ランタイム: {...}
- 既存スタック: {...}
- ライセンス制約: {...}
- 予算/コスト: {...}
- 自前ホスト可否: {...}
- その他: {...}

## 関連 spec.md

{spec モードの場合のみ: spec.md のパスと該当セクションの引用}
```

### Phase 3: zeus-tech-surveyor 起動（一次調査）

`zeus-tech-surveyor` を 1 体起動する。
プロンプトには以下を含める:

- `input.md` の全文
- プロジェクト `CLAUDE.md` の関連抜粋（既存スタック制約があれば）
- 「観点別の比較レポートを作成せよ。WebSearch/WebFetch で公式情報を必ず確認すること」

`zeus-tech-surveyor` は出力ガイダンスに従ってレポートを返す。

応答を **省略せず全文** 以下に保存:

```
.claude/zeus/tech-surveys/{ts}-{slug}/survey.md
```

### Phase 4: zeus-survey-validator 起動（妥当性検証）

`zeus-survey-validator` を 1 体起動する。
プロンプトには以下を含める:

- `input.md` の全文
- `survey.md` の全文
- 「出典 URL を WebFetch で再確認し、鮮度・正確性を検証せよ。outdated / inaccurate / unverifiable に分類し、補正版レポートを返せ」

`zeus-survey-validator` は検証済みレポートを返す。

応答を **省略せず全文** 以下に保存:

```
.claude/zeus/tech-surveys/{ts}-{slug}/survey-validated.md
```

### Phase 5: 結果提示

ユーザーに **検証済み** の最終結果を提示する:

```
## /zeus:tech-survey 完了

- モード: {interactive / spec / freeform}
- 調査対象: {対象}
- 一次調査: .claude/zeus/tech-surveys/{ts}-{slug}/survey.md
- 検証済み: .claude/zeus/tech-surveys/{ts}-{slug}/survey-validated.md

### 候補数: {N}

### 第一推奨
- 候補: {名前 / バージョン}
- 主な理由: {要件と制約に照らした要約}

### 検証結果
- confirmed: {N} / outdated: {N} / inaccurate: {N} / unverifiable: {N}
- 追加発見: {N} 件
```

### Phase 6: 採用候補の決定

候補が 1 つしかない場合 or 推奨が明確な場合:
- 「採用候補 / 選定理由 / 実装上の注意点 / 次のステップ」をテキストで提示し、そのまま Phase 7 へ進む
- `EnterPlanMode` は使わない（bypassPermissions モードと両立させるため）

候補が 2 つ以上で判断が割れる場合:
- `AskUserQuestion` で「どの候補を採用するか」を選ばせる
- 選択後、採用理由・注意点をテキストでまとめて Phase 7 へ進む

ユーザーが修正要望を出した場合は、Phase 1 の入力収集に戻って観点や制約を再確認する。

### Phase 7: 次アクション選択

候補決定後、`AskUserQuestion` で次のアクションを確認:

- **A. spec.md に追記して `/zeus:dev` に進む（橋渡し）** — spec モード時の Recommended
- **B. tech-decision.md として独立保存して `/zeus:dev` に進む** — spec モード以外の Recommended
- **C. 保存のみで終了** — 後で別途 `/zeus:dev` を呼ぶ

### Phase 8: 橋渡し実行

#### A 選択時（spec.md 追記）

1. spec.md を Read
2. 「## 5. 制約」セクション末尾に以下を追加（既存内容は保持）:

```markdown
### 技術スタック（/zeus:tech-survey で確定）

- 採用: {候補名 vX.Y.Z}
- 選定日: {YYYY-MM-DD}
- 調査レポート: .claude/zeus/tech-surveys/{ts}-{slug}/survey-validated.md
- 主な理由: {1〜2 文}
- 採用時の注意点: {重要な注意点があれば}
```

3. `plan-handoff.md` を生成（後述）
4. `Skill` ツールで `zeus:dev` を起動

#### B 選択時（独立保存）

1. `tech-decision.md` を生成:

```markdown
# 技術選定決定記録

- 選定日: {YYYY-MM-DD}
- 調査レポート: .claude/zeus/tech-surveys/{ts}-{slug}/survey-validated.md

## 採用候補
- 名称: {候補名}
- バージョン: {vX.Y.Z}
- 公式: {URL}

## 選定理由
{要件・制約に照らした選定理由}

## 採用時の注意点
{バージョン互換性、依存、ライセンス、運用上の注意など}

## 代替案（採用条件）
{第二候補とその採用条件}
```

2. `plan-handoff.md` を生成
3. `Skill` ツールで `zeus:dev` を起動

#### A / B 共通の plan-handoff.md

```markdown
# /zeus:dev への引き継ぎ

- 元調査: .claude/zeus/tech-surveys/{ts}-{slug}/survey-validated.md
- 採用技術: {候補名 vX.Y.Z}
- 関連 spec: {spec.md パス、ある場合のみ}

## 実装タスク

{採用技術を使ってどんな機能を実装するか。spec.md があれば機能要件をそのまま転記}

## 技術上の制約・注意点

{採用時の注意点、依存関係、互換性、ライセンスなど}

## 未解決の論点（dev での計画策定で判断が必要）

{調査で解消できなかった項目、実装段階で判断が必要な項目}
```

`Skill` 起動時の引数例:
> 「以下の技術選定結果に基づき実装する。詳細は `.claude/zeus/tech-surveys/{ts}-{slug}/plan-handoff.md` を参照: {1 行サマリ}」

#### C 選択時

`tech-decision.md` のみ生成して終了。

## 動作原則

- **二段検証**: surveyor → validator で情報の鮮度・正確性を担保
- **公式情報を必ず確認**: surveyor も validator も公式サイト/GitHub を WebFetch で直接見る
- **生レポート保存厳守**: 両エージェントの応答は省略せず全文保存
- **選択を求める時は AskUserQuestion を使う**: テキストで「どれにしますか」と聞かず、構造化された選択肢を提示する
- **EnterPlanMode は使わない**: bypassPermissions モードと両立させるため、承認 UI（プランモード）は呼ばない
- **既存スタック適合度を最優先**: プロジェクト CLAUDE.md / package.json 等を踏まえる
- **断定しすぎない**: 「圧倒的に良い」ではなく、要件・制約に応じた条件付き推奨

## 他スキルとの使い分け

| スキル | 用途 |
|---|---|
| `/zeus:spec` | 要望が曖昧な状態で、要件を対話的に詰めたい時 |
| **`/zeus:tech-survey`** | **要件は固まっているが、使う技術が未定の時** |
| `/zeus:dev` | 要件 + 技術が固まった状態で、計画策定 → 実装まで一気通貫で進めたい時 |
| `/zeus:review` | 既存コード・PR・diff のレビュー |

要件と技術の両方が決まっているなら、このスキルをスキップして直接 `/zeus:dev` を呼ぶ方が速い。
逆に「技術選定で迷っている」「最新のライブラリ事情を踏まえたい」場合に使う。
