---
id: 0095
title: お気に入りの並べ替えを、JSON 配列を渡す raw SQL で 1 往復にまとめる
date: 2026-11-03
status: active
category: 逸脱
affected: packages/backend/src/modules/favorites/repositories/favorites.repository.ts
revisit: Prisma が一括の並べ替え（順序を保った一括更新）を公式に提供した時、または user_favorites の構造を変える時
---

## Context

お気に入りは利用者が並べ替えられる。並び順は `sort_order` 列で持ち、画面から送られた順に振り直す。

素朴に実装すると、件数ぶんの `UPDATE` を往復させることになる。件数が増えるほど往復とバインド数が増え、体感も遅くなる。また並べ替えは「同じ要求が二重に届く」ことがあり、その時に順序が壊れないことも要る。

[構造の不変条件](../architecture/architecture-invariants.md)は、raw SQL を Repository 内へ閉じたうえで、必要性と安全性を ADR へ記録することを求めている。この箇所は Repository 内にあるが記録が無かった。

## Decision

送られた ID の配列を **JSON 1 パラメータ**として渡し、CTE でロックしてから一括更新する。1 往復で全件を処理する。

```sql
WITH ordered AS MATERIALIZED (
  SELECT favorite.id, (requested.position - 1)::integer AS sort_order
  FROM user_favorites AS favorite
  JOIN jsonb_array_elements_text(${jsonIds}::jsonb)
    WITH ORDINALITY AS requested(id, position) ON requested.id = favorite.id
  WHERE favorite.account_id = ${accountId}
  ORDER BY favorite.id
  FOR UPDATE OF favorite
)
UPDATE user_favorites AS favorite ...
```

## Reason（こういう理由で）

- **JSON 1 パラメータにする**: 件数ぶんのバインド変数を並べると、件数に依存して SQL の形が変わり、往復も増える。配列を 1 つの JSON として渡せば、件数が変わっても文の形は同じで、往復は 1 回で済む。
- **`WITH ORDINALITY` で順序を保つ**: 送られた順がそのまま `sort_order` になる。連番は配列の添字から作り、アプリ側で組み立てない。
- **`ORDER BY favorite.id` でロックの順序を固定する**: 同時に並べ替えが走っても、行を掴む順序が全員同じになるため、ロックの待ち合いが循環しない。`FOR UPDATE` をここで使うのは、同じ行を 2 つの要求が同時に書き換えないようにするため。
- **`MATERIALIZED` を付ける**: ロック済みの行を一括更新へ確実に渡す。CTE が最適化で畳まれると、ロックと更新の対象がずれる余地が残る。
- **`@updatedAt` を通らないことを明示する**: raw SQL は Prisma の自動更新を通らないため、更新日時を文の中で明示的に進める。
- **逸脱の範囲**: raw SQL はこの並べ替えの 1 文のみ。取得や削除は Prisma の API を使っており、`Controller -> Service -> Repository -> Prisma` の依存方向は保たれている。
