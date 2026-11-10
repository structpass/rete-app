---
id: 0094
title: チャット投稿時の親テーマ更新を、FOR NO KEY UPDATE の行ロックで直列化する
date: 2026-11-03
status: active
category: 逸脱
affected: packages/backend/src/modules/chat/repositories/chat.repository.ts
revisit: Prisma が「非キー更新の行ロック」を公式に提供した時、または chat_themes の表名・主キー構成を変える時
---

## Context

チャットに投稿すると、親テーマの `lastMessageAt` を「最後の投稿時刻」へ進める。一覧はこの値で並ぶため、値が後退すると表示順とページ位置が崩れる。

同時投稿では、古いメッセージの親更新が新しいものより後に完了しうる。READ COMMITTED では後勝ちになるため、無条件の代入だと `lastMessageAt` が過去へ戻る。投稿の INSERT は外部キー検査のために親行の `KEY SHARE` を保持しており、この競合を素朴に `FOR UPDATE` で解こうとすると、`KEY SHARE` から `UPDATE` への昇格待ちが互いに噛み合ってデッドロックになり、片方の投稿が失われる。

[構造の不変条件](../architecture/architecture-invariants.md)は、raw SQL を Repository 内へ閉じたうえで、必要性と安全性を ADR へ記録することを求めている。この箇所は Repository 内にあるが記録が無かった。

## Decision

親行の更新の前に、`FOR NO KEY UPDATE` で行ロックを取る。

```sql
SELECT id FROM chat_themes WHERE id = ${themeId} FOR NO KEY UPDATE
```

ロックの後に現在値を読み直し、新しい投稿の時刻がそれより後の時だけ進める（単調増加）。

## Reason（こういう理由で）

- **`FOR NO KEY UPDATE` を選ぶ**: このロックはキー以外を更新する意図を表し、`KEY SHARE` と両立する。投稿の INSERT が外部キー検査で保持する `KEY SHARE` を妨げないため、昇格待ちの循環が起きない。
- **`FOR UPDATE` を採らない**: キーまで更新しうる強いロックで、`KEY SHARE` と衝突する。同時投稿で互いを待ち合い、デッドロックで投稿が失われることを実測で確認した（d726）。
- **読み直してから進める**: ロックは直列化するが、待っている間に別の投稿が進めている可能性がある。読んだ現在値と比べて新しい時だけ書き換えることで、順序が入れ替わっても値は後退しない。
- **表名を直書きする理由**: Prisma の `findUnique` などでは行ロックの指定ができないため、`@@map` の実テーブル名を SQL に書いている。`schema.prisma` でテーブル名を変えた時はこの行も追従させる（コードにも同じ注意を書いてある）。
- **逸脱の範囲**: raw SQL はこのロック取得の 1 文のみ。読み直しと更新は Prisma の API を使っており、`Controller -> Service -> Repository -> Prisma` の依存方向は保たれている。
