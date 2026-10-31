export const HOME_TAG_KINDS = ['board', 'calendar', 'faq'] as const;
export type HomeTagKind = (typeof HOME_TAG_KINDS)[number];

/**
 * Home の編集許可の正本（d816）。許可は「管理グループごとの設定値（HomeGroupPermissions＝DB の列）」と
 * 「本人に解決した結果（HomePermissions＝画面と入口が見る値）」の 2 つの形を持ち、前者を OR で畳んだ
 * ものが後者になる（backend の home-permissions.service）。増減は必ずこの 1 か所で行う。
 */
export const HOME_PERMISSIONS = {
  boardEdit: { groupFlagKey: 'canEditHomeBoard' },
  calendarEdit: { groupFlagKey: 'canEditHomeCalendar' },
  faqEdit: { groupFlagKey: 'canEditHomeFaq' },
  tagManage: { groupFlagKey: 'canManageHomeTags' },
} as const;

/** 解決後の許可の名前（画面と入口が見る値）。 */
export type HomePermissionKey = keyof typeof HOME_PERMISSIONS;

/** 管理グループが持つ Home の設定値の名前（DB の列と応答の項目）。 */
export type HomeGroupPermissionKey = (typeof HOME_PERMISSIONS)[HomePermissionKey]['groupFlagKey'];

export interface HomePermissions extends Record<HomePermissionKey, boolean> {}
export const NO_HOME_PERMISSIONS: HomePermissions = {
  boardEdit: false,
  calendarEdit: false,
  faqEdit: false,
  tagManage: false,
};
export interface HomeGroupPermissions {
  canEditHomeBoard: boolean;
  canEditHomeCalendar: boolean;
  canEditHomeFaq: boolean;
  canManageHomeTags: boolean;
}
export const NO_HOME_GROUP_PERMISSIONS: HomeGroupPermissions = {
  canEditHomeBoard: false,
  canEditHomeCalendar: false,
  canEditHomeFaq: false,
  canManageHomeTags: false,
};
