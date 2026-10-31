'use client';
import type { HomeTagKind } from '@rete/shared';

import { useCallback } from 'react';
import { useTagMaster, type UseTagMasterResult } from '@/hooks/use-tag-master';
import {
  fetchAnnouncementTags,
  createAnnouncementTag,
  updateAnnouncementTag,
  deleteAnnouncementTag,
} from '../lib/api';

/**
 * お知らせタグマスタ hook（rete-home-0043 / kind 対応・hom-0074 / includeArchived 対応・hom-0084）。
 * 汎用 useTagMaster に お知らせタグ API を kind（'board'|'faq'）でバインドする。
 * kind 省略時は 'board'（既存呼び出し元との後方互換・hom-0073 が Context 経由の kind 指定へ移行するまでの橋渡し）。
 * includeArchived は タグ管理オーバーレイのアーカイブ表示切替（hom-0084）用。true にすると
 * アーカイブ済みタグも含めて返す（既定は除外・hom-0083）。値が変わるたび fetch の identity が変わり
 * useTagMaster 内の mount useEffect が再発火して再フェッチする（cmn-0044 と同じ仕組み）。
 * update / remove は id 単位の操作で kind を必要としない（backend も未受理）。
 * File タグの useFileTagMaster と同パターン（rete-home-0043 共有化設計）。
 * AnnouncementTagMasterProvider が board/faq 2 インスタンスを生成し、フィルタバー / マスタ管理 / 付与フォームで共有する。
 */
export function useAnnouncementTagMaster(
  kind: HomeTagKind = 'board',
  includeArchived = false,
): UseTagMasterResult {
  // cmn-0044: fetch/create は useTagMaster 内で reload の identity 依存になるため、kind を deps にした
  // useCallback で安定参照にする（inline arrow だと毎レンダー再生成され mount useEffect が無限再発火する）。
  const fetch = useCallback(
    () => fetchAnnouncementTags(kind, includeArchived),
    [kind, includeArchived],
  );
  const create = useCallback(
    (name: string, icon: string, color: string) => createAnnouncementTag(kind, name, icon, color),
    [kind],
  );
  return useTagMaster({
    fetch,
    create,
    update: updateAnnouncementTag,
    remove: deleteAnnouncementTag,
  });
}
