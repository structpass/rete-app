import { describe, expect, it } from 'vitest';
import {
  HOME_PERMISSIONS,
  NO_HOME_GROUP_PERMISSIONS,
  NO_HOME_PERMISSIONS,
  type HomeGroupPermissions,
  type HomePermissions,
} from './home-permissions';

/**
 * Home の編集許可の正本（d816）。許可は「解決した値」と「管理グループの設定値」の 2 つに同じ数だけ
 * 現れなければならない。片方だけ足すと、画面・入口・DB のどれかが静かにずれる。
 */
describe('HomePermissions（正本）', () => {
  it('解決した許可と管理グループの設定値が同じ数を同じ対応で持つ', () => {
    expect(Object.keys(HOME_PERMISSIONS).sort()).toEqual(Object.keys(NO_HOME_PERMISSIONS).sort());
    expect(Object.values(HOME_PERMISSIONS).map((p) => p.groupFlagKey)).toEqual(
      Object.keys(NO_HOME_GROUP_PERMISSIONS),
    );
  });

  it('設定値の名前は解決した許可の名前と重ならない（取り違えを型で止める前提）', () => {
    const resolved = new Set(Object.keys(HOME_PERMISSIONS));
    for (const { groupFlagKey } of Object.values(HOME_PERMISSIONS)) {
      expect(resolved.has(groupFlagKey)).toBe(false);
    }
  });

  it('既定値はどちらも全 OFF', () => {
    expect(Object.values(NO_HOME_PERMISSIONS).every((value) => value === false)).toBe(true);
    expect(Object.values(NO_HOME_GROUP_PERMISSIONS).every((value) => value === false)).toBe(true);
  });

  it('正本と同じ名前だけを型として受け付ける', () => {
    // 型の網羅性そのものを型検査で確かめる。名前を足すのは正本の 1 か所だけになる。
    const resolved: HomePermissions = { ...NO_HOME_PERMISSIONS };
    const groupFlags: HomeGroupPermissions = { ...NO_HOME_GROUP_PERMISSIONS };
    expect(Object.keys(resolved).sort()).toEqual(Object.keys(HOME_PERMISSIONS).sort());
    expect(Object.keys(groupFlags).sort()).toEqual(
      Object.values(HOME_PERMISSIONS)
        .map((p) => p.groupFlagKey)
        .sort(),
    );
  });
});
