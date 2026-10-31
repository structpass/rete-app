import { describe, it, expect } from 'vitest';
import { resolveFavoriteLink, resolveTabs, SHELL_TABS, type ShellTab } from '../nav-config';
import type { HubMenuItem } from '@/features/hub';

const referenceItem: HubMenuItem = {
  key: 'reference',
  label: 'Struct Pass リファレンス',
  description: '...',
  category: 'system',
  type: 'external',
  href: 'http://localhost:3000',
  available: true,
};

describe('resolveTabs', () => {
  it('internal タブ（Home）は href をそのまま使い、active を反映する', () => {
    const tabs = resolveTabs(SHELL_TABS, [], 'home');
    const home = tabs.find((t) => t.key === 'home')!;
    expect(home).toMatchObject({ active: true, disabled: false, href: '/hub', external: false });
  });

  it('external タブ（システム）は hub menu が available なら href を解決し external=true にする', () => {
    const tabs = resolveTabs(SHELL_TABS, [referenceItem], 'home');
    const system = tabs.find((t) => t.key === 'system')!;
    expect(system).toMatchObject({
      disabled: false,
      href: 'http://localhost:3000',
      external: true,
    });
  });

  it('external タブは対応 item が無い / available=false なら灰色（disabled・href=null）にフォールバックする', () => {
    const unavailable = { ...referenceItem, available: false };
    expect(resolveTabs(SHELL_TABS, [], 'home').find((t) => t.key === 'system')).toMatchObject({
      disabled: true,
      href: null,
      external: false,
    });
    expect(
      resolveTabs(SHELL_TABS, [unavailable], 'home').find((t) => t.key === 'system'),
    ).toMatchObject({ disabled: true, href: null });
  });

  it('available でも reference 実到達不能（reachable=false）ならシステムタブは灰色（rete-files-0037 / common-0018）', () => {
    const system = resolveTabs(SHELL_TABS, [referenceItem], 'home', false).find(
      (t) => t.key === 'system',
    )!;
    expect(system).toMatchObject({ disabled: true, href: null, external: false });
  });

  it('reachable=true / undefined（未確認）は available のみで判定し有効化する（グレー点滅回避）', () => {
    const onTrue = resolveTabs(SHELL_TABS, [referenceItem], 'home', true).find(
      (t) => t.key === 'system',
    )!;
    const onUndef = resolveTabs(SHELL_TABS, [referenceItem], 'home').find(
      (t) => t.key === 'system',
    )!;
    expect(onTrue).toMatchObject({
      disabled: false,
      href: 'http://localhost:3000',
      external: true,
    });
    expect(onUndef).toMatchObject({ disabled: false, external: true });
  });

  it('reachable=false でも env が available=false ならそのまま灰色（reachable に依存せず disabled）', () => {
    const unavailable = { ...referenceItem, available: false };
    const system = resolveTabs(SHELL_TABS, [unavailable], 'home', false).find(
      (t) => t.key === 'system',
    )!;
    expect(system).toMatchObject({ disabled: true, href: null });
  });

  it('internal タブ（デスク）は href をそのまま使い有効化される', () => {
    const tabs = resolveTabs(SHELL_TABS, [referenceItem], 'home');
    expect(tabs.find((t) => t.key === 'desk')).toMatchObject({
      disabled: false,
      href: '/desk',
      external: false,
    });
  });

  it('internal タブ（モデル）は href をそのまま使い有効化される', () => {
    const tabs = resolveTabs(SHELL_TABS, [referenceItem], 'home');
    expect(tabs.find((t) => t.key === 'model')).toMatchObject({
      disabled: false,
      href: '/model',
      external: false,
    });
  });

  it('Board 廃止に伴い Backlog タブは無い（タブの並びは Model で終わる）', () => {
    const keys = SHELL_TABS.map((t) => t.key);
    expect(keys).not.toContain('backlog');
    expect(keys[keys.length - 1]).toBe('model');
  });

  it('未実装タブ（モック）は常に灰色（disabled・href=null）', () => {
    const tabs = resolveTabs(SHELL_TABS, [referenceItem], 'home');
    expect(tabs.find((t) => t.key === 'mock')).toMatchObject({ disabled: true, href: null });
  });

  it('ファイルタブは内部ルート /files へ遷移可能（① 見た目シェル移植済・e9c9475）', () => {
    const tabs = resolveTabs(SHELL_TABS, [referenceItem], 'home');
    expect(tabs.find((t) => t.key === 'files')).toMatchObject({ disabled: false, href: '/files' });
  });

  it('設定タブは内部ルート /settings へ遷移可能（ST-1 シェル先行移植）', () => {
    const tabs = resolveTabs(SHELL_TABS, [referenceItem], 'home');
    expect(tabs.find((t) => t.key === 'settings')).toMatchObject({
      disabled: false,
      href: '/settings',
    });
  });

  it('モデルタブは内部ルート /model へ遷移可能（共通仕様カタログ）', () => {
    const tabs = resolveTabs(SHELL_TABS, [referenceItem], 'home');
    expect(tabs.find((t) => t.key === 'model')).toMatchObject({
      disabled: false,
      href: '/model',
      external: false,
    });
  });

  it('モデルタブは並びの末尾に置かれる（Board 廃止でバックログの直前という条件は消えた）', () => {
    const keys = SHELL_TABS.map((t) => t.key);
    expect(keys[keys.length - 1]).toBe('model');
  });

  it('activeKey に一致するタブだけ active=true になる', () => {
    const tabs = resolveTabs(SHELL_TABS, [referenceItem], 'system');
    expect(tabs.filter((t) => t.active).map((t) => t.key)).toEqual(['system']);
  });

  it('結果の件数・順序は入力 SHELL_TABS と一致する', () => {
    const custom: ShellTab[] = [
      { key: 'home', label: 'Home', kind: 'internal', href: '/hub' },
      { key: 'desk', label: 'デスク', kind: 'disabled' },
    ];
    expect(resolveTabs(custom, [], 'home').map((t) => t.key)).toEqual(['home', 'desk']);
  });
});

describe('resolveFavoriteLink', () => {
  it('folder は targetRef を folderId クエリに乗せて /files へ精密ジャンプする（HM-1-4）', () => {
    expect(resolveFavoriteLink('folder', 'F1', [])).toEqual({
      href: '/files?folderId=F1',
      external: false,
    });
  });

  it('folder の targetRef は URL エンコードされる（クエリ injection 防止）', () => {
    expect(resolveFavoriteLink('folder', 'a b/c', [])).toEqual({
      href: '/files?folderId=a%20b%2Fc',
      external: false,
    });
  });

  it('file は targetRef を fileId クエリに乗せて /files へ deep link する（FF・DL＆編集導線）', () => {
    expect(resolveFavoriteLink('file', 'X1', [])).toEqual({
      href: '/files?fileId=X1',
      external: false,
    });
  });

  it('file の targetRef は URL エンコードされる（クエリ injection 防止）', () => {
    expect(resolveFavoriteLink('file', 'a b/c', [])).toEqual({
      href: '/files?fileId=a%20b%2Fc',
      external: false,
    });
  });

  it('system は reference が available かつ既知プリセット種別なら複数形ルートへ外部遷移する（hom-0067）', () => {
    const productType = { key: 'product', name: '商品', icon: 'package', isPreset: true };
    expect(resolveFavoriteLink('system', 'product', [referenceItem], true, [productType])).toEqual({
      href: 'http://localhost:3000/dashboard/products',
      external: true,
    });
  });

  it('system は reference が未接続なら href=null（灰色）', () => {
    expect(
      resolveFavoriteLink('system', 'product', [], undefined, [
        { key: 'product', name: '商品', icon: null, isPreset: true },
      ]),
    ).toEqual({ href: null, external: false });
  });

  it('system は available でも実到達不能（reachable=false）なら href=null（タブと同じ probe gating / rete-files-0037）', () => {
    expect(
      resolveFavoriteLink('system', 'product', [referenceItem], false, [
        { key: 'product', name: '商品', icon: null, isPreset: true },
      ]),
    ).toEqual({ href: null, external: false });
  });

  it('system は objectTypes 未取得（縮退・空）でも既知プリセット key は静的に解決する（後方互換）', () => {
    expect(resolveFavoriteLink('system', 'product', [referenceItem], true, [])).toEqual({
      href: 'http://localhost:3000/dashboard/products',
      external: true,
    });
  });

  it('system は自由定義台帳（isPreset=false）なら /dashboard/custom/<key> へ外部遷移する', () => {
    const custom = {
      key: 'supplier-score',
      name: '仕入先評価',
      icon: 'clipboard-check',
      isPreset: false,
    };
    expect(
      resolveFavoriteLink('system', 'supplier-score', [referenceItem], true, [custom]),
    ).toEqual({
      href: 'http://localhost:3000/dashboard/custom/supplier-score',
      external: true,
    });
  });

  it('system は現存 ObjectType 一覧に一致しないスラッグ（旧 randomUUID 含む）は遷移不可（灰色・criteria【4】）', () => {
    const known = [{ key: 'product', name: '商品', icon: null, isPreset: true }];
    expect(resolveFavoriteLink('system', 'ref', [referenceItem], true, known)).toEqual({
      href: null,
      external: false,
    });
    expect(resolveFavoriteLink('system', 'a-random-uuid', [referenceItem], true, known)).toEqual({
      href: null,
      external: false,
    });
  });

  it('chat / task はデスクルート（/desk）へ寄せる', () => {
    expect(resolveFavoriteLink('chat', 'c1', [])).toEqual({ href: '/desk', external: false });
    expect(resolveFavoriteLink('task', 't1', [])).toEqual({ href: '/desk', external: false });
  });

  it('space は ?spaceId= deep-link で /desk の該当器を開く（CM-2 / ADR 0037）', () => {
    expect(resolveFavoriteLink('space', 'sp1', [])).toEqual({
      href: '/desk?spaceId=sp1',
      external: false,
    });
  });

  it('space の targetRef は URL エンコードされる（クエリ injection 防止）', () => {
    expect(resolveFavoriteLink('space', 'a b/c', [])).toEqual({
      href: '/desk?spaceId=a%20b%2Fc',
      external: false,
    });
  });

  it('org / project は desk からは生成されず遷移先未定義（default で灰色 / deferred）', () => {
    expect(resolveFavoriteLink('organization', 'o1', [])).toEqual({ href: null, external: false });
    expect(resolveFavoriteLink('project', 'pr1', [])).toEqual({ href: null, external: false });
  });
});
