import {
  Building2,
  CalendarDays,
  FileText,
  LogIn,
  Network,
  Palette,
  Upload,
  UserCog,
  UserPlus,
  Users,
  type LucideIcon,
} from 'lucide-react';

/**
 * 設定タブ左サイドバーのメニュー定義（SSOT）。モック settings/index.html のサイドバー
 * （アカウント / 権限 / セキュリティ / テナント の 4 グループ）に対応する。
 * href は app/settings 配下のネストルートを指す（メンバーは /settings がインデックス）。
 * adminOnly=true の項目は system Role=ADMIN のみ表示（SettingsSidebar でフィルタ）。
 */

export interface SettingsNavItem {
  key: string;
  label: string;
  href: string;
  icon: LucideIcon;
  /** true の場合、system Role=ADMIN のみ表示（既定 false = 全員表示）。 */
  adminOnly?: boolean;
}

export interface SettingsNavGroup {
  label: string;
  items: SettingsNavItem[];
}

export const SETTINGS_NAV: SettingsNavGroup[] = [
  {
    label: 'アカウント',
    items: [
      { key: 'members', label: 'メンバー', href: '/settings', icon: Users, adminOnly: true },
      {
        key: 'invites',
        label: '招待管理',
        href: '/settings/invites',
        icon: UserPlus,
        adminOnly: true,
      },
    ],
  },
  {
    label: 'セキュリティ',
    items: [
      {
        key: 'audit-log',
        label: '操作ログ',
        href: '/settings/audit-log',
        icon: FileText,
        adminOnly: true,
      },
      {
        key: 'login-settings',
        label: 'ログイン設定',
        href: '/settings/login-settings',
        icon: LogIn,
      },
    ],
  },
  {
    label: 'テナント',
    items: [
      {
        key: 'calendar-holidays',
        label: '祝日設定',
        href: '/settings/calendar-holidays',
        icon: CalendarDays,
        adminOnly: true,
      },
      {
        key: 'tenant-settings',
        label: 'テナント設定',
        href: '/settings/tenant-settings',
        icon: Building2,
        adminOnly: true,
      },
      {
        key: 'organizations',
        label: '組織管理',
        href: '/settings/organizations',
        icon: Building2,
        adminOnly: true,
      },
      {
        key: 'groups',
        label: '管理グループ',
        href: '/settings/groups',
        icon: UserCog,
        adminOnly: true,
      },
      {
        key: 'memberships',
        label: '所属管理',
        href: '/settings/memberships',
        icon: Network,
        adminOnly: true,
      },
      {
        key: 'file-upload',
        label: 'アップロード設定',
        href: '/settings/file-upload',
        icon: Upload,
        adminOnly: true,
      },
    ],
  },
  {
    label: '個人設定',
    items: [{ key: 'display', label: '表示設定', href: '/settings/display', icon: Palette }],
  },
];
