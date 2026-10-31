'use client';

import { useState } from 'react';
import { Heart, HeartPlus } from 'lucide-react';
import toast from 'react-hot-toast';
import type { FavoriteDto } from '@rete/shared';
import { FAVORITE_KIND_LABELS } from '@rete/shared';
import { cn } from '@/lib/utils';
import { useOptionalFavoritesContext } from '../hooks/favorites-context';

/** お気に入りトグルの対象リソース（FavoriteDto の登録用最小集合）。targetRef は精密 id（files=フォルダ id / desk=mock:type:id）。 */
export type FavoriteTarget = Pick<FavoriteDto, 'kind' | 'targetRef' | 'label'>;

/**
 * 横断お気に入りのトグル（HM-1-4）。お気に入りの「2 つ目の入口」で、各タブの現在コンテキスト
 * （files=現在フォルダ / desk=選択中チャネル・グループ・DM）を共有 state に add/remove する。
 * 登録判定は共有 state の items に対する kind+targetRef の精密一致。処理中は多重送信を禁じる。
 *
 * v2-505: 2 点だけ直した。
 *   1. 読み上げ・ツールチップに登録対象（種別＋名前）を出す。kind は 8 種あるため、file 以外を
 *      一律「フォルダ」と呼ばず shared の全 kind 網羅 Record から引く。
 *   2. FavoritesProvider の外では何も描かない（mount 漏れの早期検出が要る画面は throw 版を使う）。
 *
 * d524: アイコンを★からハートへ変えた。ファイル一覧のタグ列にも★が出るため、同じ★では
 * 「どちらがお気に入りか」が見分けられなかった。未登録＝ハート＋、登録済み＝塗りハート（解除）。
 *
 * showLabel: パンくずの現在フォルダのように「何に係っているか」を並べて見せたい場所で使う。
 * ラベルをボタンの内側へ入れることで、ラベルとアイコンが 1 つのクリック対象・1 つのホバー帯になる
 * （要件: 右端のフォルダ名とお気に入りアイコンを一つのオブジェクトとして扱う）。
 */
export function FavoriteToggle({
  target,
  showLabel = false,
}: {
  target: FavoriteTarget;
  /** 対象名をボタン内に並べる（パンくずの現在フォルダ用）。既定はアイコンのみ。 */
  showLabel?: boolean;
}) {
  const favorites = useOptionalFavoritesContext();
  const [busy, setBusy] = useState(false);
  if (!favorites) return null;
  const { items, add, remove } = favorites;

  const existing = items.find((f) => f.kind === target.kind && f.targetRef === target.targetRef);
  const favorited = existing != null;

  const handleClick = async () => {
    if (busy) return;
    setBusy(true);
    try {
      if (existing) {
        await remove(existing.id);
      } else {
        await add({ kind: target.kind, targetRef: target.targetRef, label: target.label });
      }
    } catch {
      // useFavorites.add/remove は失敗時に error state を立てず例外を投げるため、
      // このトグルには表示スロットが無い。プロジェクト共通の toast でフィードバックする。
      toast.error('お気に入りの更新に失敗しました');
    } finally {
      setBusy(false);
    }
  };

  const actionLabel = `${FAVORITE_KIND_LABELS[target.kind]}「${target.label}」を${
    favorited ? 'お気に入りから削除' : 'お気に入りに追加'
  }`;

  return (
    <button
      type="button"
      className={cn('fav-toggle', favorited && 'active', showLabel && 'with-label')}
      aria-pressed={favorited}
      aria-label={actionLabel}
      title={actionLabel}
      disabled={busy}
      onClick={() => void handleClick()}
    >
      {showLabel && <span className="fav-toggle-label">{target.label}</span>}
      {favorited ? (
        <Heart aria-hidden="true" fill="currentColor" />
      ) : (
        <HeartPlus aria-hidden="true" />
      )}
    </button>
  );
}
